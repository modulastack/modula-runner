import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CAPABILITY_REFRESH_MS,
  CapabilityMonitor,
  DEFAULT_RUNTIME_CATALOG,
  MIN_CAPABILITY_REFRESH_MS,
  probeRuntime as probeRuntimeRaw,
  type RuntimeSpec,
} from '../src/capabilities.js'
import {
  createCapabilityProbeBatchSeam,
  type AuditRecordInputV2,
  type CommandPolicy,
  type RunnerAuditLifecycle,
} from '../src/index.js'
import { denyingSpawnSeam, permissiveSpawnSeam } from './spawnSeamSupport.js'

// Probing now passes the spawn seam; these tests exercise probe behavior, not the allowlist, so
// a permissive seam stands in and the call sites stay unchanged.
const seam = permissiveSpawnSeam()
const probeRuntime = (spec: RuntimeSpec, timeoutMs?: number) => probeRuntimeRaw(spec, seam, timeoutMs)
import { sleep, until } from './helpers.js'

// Stand-in executables throughout, never a real CLI: a suite that passes only on a machine
// with Claude Code installed is a suite that tests the machine. The real CLIs belong to the
// self-QA receipt, which says so out loud.

// Generous against the deadline plus grace a probe is allowed (200 ms + 500 ms here): long
// enough that a busy machine cannot fail it, short enough that "never answers" is caught.
const PROBE_ANSWER_BUDGET_MS = 8_000
// Far longer than any probe deadline in these tests, so a cadence schedule is separable
// from a probe's own timers by its length alone.
const CADENCE_MS = 5_000
const PROBE_TIMERS_BELOW_MS = 3_000

const batchPolicy: CommandPolicy = {
  allowsExecutable: executable => executable === process.execPath,
  recipe: () => null,
  executables: [process.execPath],
  keyId: 'test-batch-anchor',
}

function batchAudit(failAt = -1) {
  const records: AuditRecordInputV2[] = []
  let appends = 0
  const audit: RunnerAuditLifecycle = {
    async append(record) {
      appends += 1
      if (appends === failAt) throw new Error('audit unavailable')
      records.push(record)
    },
    async snapshot() {
      return { state: 'ready', residentSegments: 1, residentBytes: 0, metadataBytes: 0, openSequence: '1' }
    },
    async close() {},
  }
  return { audit, records }
}

const roots: string[] = []
const spawned: (() => number[])[] = []

afterEach(() => {
  // A stand-in that ignores SIGTERM outlives a failed run, and a suite that leaves those
  // behind poisons the machine for every later one — including its own next mutation.
  for (const pids of spawned) {
    for (const pid of pids().filter(alive)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Gone between the check and the signal, which is the outcome being asked for.
      }
    }
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.length = 0
  spawned.length = 0
  vi.restoreAllMocks()
})

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), 'mr-capability-'))
  roots.push(root)
  return root
}

type StandInOptions = {
  version?: string
  authExit?: number
  hangs?: boolean
  // Answers only once stdin reaches EOF, which is what a CLI that would prompt does. With
  // stdin closed it answers at once; with stdin left open it waits forever.
  waitsForStdin?: boolean
  // Traps SIGTERM and keeps running, which is the case a SIGTERM-only deadline never ends.
  ignoresSigterm?: boolean
  // Answers, then exits leaving a background child holding stdout open — the shape that
  // keeps `close` from ever firing while the process we asked about is long gone.
  leavesChildHoldingStdout?: boolean
}

// The stand-in answers `--version` and `auth`, records every invocation and its own pid, and
// can be told to misbehave in the specific ways a real CLI does — which is how a wedged,
// prompting or signal-ignoring runtime is exercised without needing one.
function standIn(root: string, options: StandInOptions = {}) {
  const script = path.join(root, `stand-in-${Math.random().toString(36).slice(2)}.mjs`)
  const log = `${script}.log`
  const pids = `${script}.pids`
  // A timer, not an unsettled promise: Node exits an idle event loop, so a promise that
  // never resolves is a fast exit rather than the wedged CLI this is standing in for.
  const answer = options.hangs
    ? 'setInterval(() => {}, 1000)'
    : `if (process.argv[2] === '--version') { process.stdout.write(${JSON.stringify(options.version ?? '9.9.9 (stand-in)')}); process.exit(0) }
    process.exit(${options.authExit ?? 0})`
  const orphan = `
    import { spawn } from 'node:child_process'
    spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: ['ignore', 'inherit', 'ignore'], detached: true }).unref()
    process.stdout.write(${JSON.stringify(options.version ?? '9.9.9 (stand-in)')})
    process.exit(0)`
  const behaviour = options.leavesChildHoldingStdout
    ? orphan
    : options.waitsForStdin
      ? `process.stdin.resume(); process.stdin.on('end', () => { ${answer} })`
      : answer
  writeFileSync(script, `
    import { appendFileSync } from 'node:fs'
    appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n')
    appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n')
    ${options.ignoresSigterm ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)" : behaviour}
  `)
  writeFileSync(log, '')
  writeFileSync(pids, '')
  const handle = {
    spec: (over: Partial<RuntimeSpec> = {}): RuntimeSpec => ({
      runtime: 'standin',
      command: process.execPath,
      versionArgs: [script, '--version'],
      authArgs: [script, 'auth'],
      access: ['subscription'],
      ...over,
    }),
    invocations: () => readFileSync(log, 'utf8').split('\n').filter(Boolean),
    pids: () => readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number),
  }
  spawned.push(handle.pids)
  return handle
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('runtime probes', () => {
  it('reports the version the runtime reported and the auth state it claims', async () => {
    const runtime = standIn(workspace(), { version: '2.1.219 (stand-in)\nnoise on a second line' })

    expect(await probeRuntime(runtime.spec())).toEqual({
      runtime: 'standin',
      version: '2.1.219 (stand-in)',
      auth: 'authenticated',
      access: ['subscription'],
    })
    expect(runtime.invocations()).toEqual(['--version', 'auth'])
  })

  it('reads a non-zero auth status as unauthenticated and no auth command as unknown', async () => {
    const root = workspace()
    const signedOut = standIn(root, { authExit: 1 })
    const silent = standIn(root)

    expect(await probeRuntime(signedOut.spec())).toMatchObject({ auth: 'unauthenticated' })
    expect(await probeRuntime(silent.spec({ authArgs: null }))).toMatchObject({ auth: 'unknown' })
    expect(silent.invocations()).toEqual(['--version'])
  })

  it('reports absence for a runtime that is not installed', async () => {
    const runtime = standIn(workspace())

    expect(await probeRuntime(runtime.spec({ command: path.join(workspace(), 'not-installed') }))).toBeNull()
  })

  it('costs one unknown answer for a wedged CLI, not a hung probe', async () => {
    const runtime = standIn(workspace(), { hangs: true })

    const capability = await probeRuntime(runtime.spec(), 250)

    // Present, because the executable ran; version and auth unknown, because it never said.
    expect(capability).toEqual({ runtime: 'standin', version: null, auth: 'unknown', access: ['subscription'] })
  })

  it('closes stdin, so a runtime that would prompt reads EOF instead of waiting', async () => {
    // The regression behind this: `execFile` builds its own options object and never
    // forwards `stdio`, so a probe that asked for a closed stdin got a pipe the parent held
    // open — and a prompting CLI blocked until the deadline while the comment claimed
    // otherwise. This stand-in answers only on EOF, so it can tell the two apart.
    const runtime = standIn(workspace(), { waitsForStdin: true })

    const capability = await probeRuntime(runtime.spec(), 2_000)

    expect(capability).toEqual({ runtime: 'standin', version: '9.9.9 (stand-in)', auth: 'authenticated', access: ['subscription'] })
  })

  it('makes a runtime stop when asking does not work', async () => {
    const runtime = standIn(workspace(), { ignoresSigterm: true })

    // Raced rather than simply awaited, so a probe that never answers fails as a statement
    // about the property — "still waiting" — instead of as a bare suite timeout, which on a
    // loaded machine is indistinguishable from slowness.
    const outcome = await Promise.race([
      probeRuntime(runtime.spec(), 200),
      sleep(PROBE_ANSWER_BUDGET_MS).then(() => 'still waiting' as const),
    ])

    // Bounded rather than instant: the answer arrives once the process is actually gone,
    // which is the escalation's whole point. A SIGTERM-only deadline never gets here — the
    // pass stays open, and `refresh()` shares one pass with every later caller.
    expect(outcome).toMatchObject({ version: null, auth: 'unknown' })
    // A probe that answers while leaving the process running is the leak version of the
    // same defect, so the corpse is checked too.
    expect(runtime.pids().filter(alive)).toEqual([])
  }, 20_000)

  it('answers when the runtime exits, not when everyone stops holding its output', async () => {
    // A CLI that forks a background child inheriting stdout: the process the runner asked is
    // gone, but the pipe is still held, so waiting for `close` waits for a stranger. Neither
    // signal reaches that child — it was never ours — so the pass would hang for as long as
    // the child lives, and `refresh()` shares one pass with every later caller.
    const runtime = standIn(workspace(), { leavesChildHoldingStdout: true })

    const outcome = await Promise.race([
      probeRuntime(runtime.spec(), 1_000),
      sleep(PROBE_ANSWER_BUDGET_MS).then(() => 'still waiting' as const),
    ])

    expect(outcome).toMatchObject({ runtime: 'standin', version: '9.9.9 (stand-in)', auth: 'authenticated' })
  }, 20_000)

  it('bounds and cleans what the runtime printed, because it crosses the wire', async () => {
    const runtime = standIn(workspace(), { version: `${'v'.repeat(200)}\r` })

    const capability = await probeRuntime(runtime.spec())

    expect(capability?.version).toBe('v'.repeat(64))
  })

  it('refuses a catalog entry that could not be advertised or could not be run', () => {
    const runtime = standIn(workspace())

    expect(() => new CapabilityMonitor({ seam, runtimes: [runtime.spec({ runtime: 'not a name' })] })).toThrow(/safe identifier/)
    expect(() => new CapabilityMonitor({ seam, runtimes: [runtime.spec({ access: [] })] })).toThrow(/at least one access mode/)
    expect(() => new CapabilityMonitor({ seam, runtimes: [runtime.spec({ keyVariable: 'not a variable' })] })).toThrow(/environment variable name/)
    expect(() => new CapabilityMonitor({ seam, runtimes: [runtime.spec(), runtime.spec()] })).toThrow(/unique/)
  })
})

describe('the capability monitor', () => {
  it('routes one routine refresh through the aggregate seam instead of per-probe audit', async () => {
    const runtime = standIn(workspace())
    const held = batchAudit()
    const batchSeam = createCapabilityProbeBatchSeam({ policy: batchPolicy, audit: held.audit })
    const monitor = new CapabilityMonitor({ seam: denyingSpawnSeam(), batchSeam, runtimes: [runtime.spec()] })

    const snapshot = await monitor.refresh()

    expect(snapshot.runtimes).toHaveLength(1)
    expect(runtime.invocations()).toEqual(['--version', 'auth'])
    expect(held.records.map(record => record.kind)).toEqual(['capability-refresh-admitted', 'capability-refresh-outcome'])
    expect(held.records[1]).toMatchObject({
      runtimeOutcomes: { answered: 2, missing: 0, unanswered: 0, refused: 0 },
      snapshotChanged: true,
    })
  })

  it('does not probe or publish when aggregate admission is unavailable', async () => {
    const runtime = standIn(workspace())
    const held = batchAudit(1)
    const batchSeam = createCapabilityProbeBatchSeam({ policy: batchPolicy, audit: held.audit })
    const monitor = new CapabilityMonitor({ seam: denyingSpawnSeam(), batchSeam, runtimes: [runtime.spec()] })

    await expect(monitor.refresh()).rejects.toThrow('capability refresh audit unavailable')
    expect(runtime.invocations()).toEqual([])
    expect(monitor.snapshot()).toBeNull()
  })

  it('withholds a probed snapshot when aggregate outcome is unavailable', async () => {
    const runtime = standIn(workspace())
    const held = batchAudit(2)
    const batchSeam = createCapabilityProbeBatchSeam({ policy: batchPolicy, audit: held.audit })
    const monitor = new CapabilityMonitor({ seam: denyingSpawnSeam(), batchSeam, runtimes: [runtime.spec()] })

    await expect(monitor.refresh()).rejects.toThrow('capability refresh audit unavailable')
    expect(runtime.invocations()).toEqual(['--version', 'auth'])
    expect(monitor.snapshot()).toBeNull()
    expect(held.records.map(record => record.kind)).toEqual(['capability-refresh-admitted'])
  })

  it('has no snapshot until a probe lands, then holds the last one', async () => {
    const runtime = standIn(workspace())
    const monitor = new CapabilityMonitor({ seam, runtimes: [runtime.spec()] })

    expect(monitor.snapshot()).toBeNull()
    const probed = await monitor.refresh()

    expect(probed).toEqual({ runtimes: [{ runtime: 'standin', version: '9.9.9 (stand-in)', auth: 'authenticated', access: ['subscription'] }], endpoints: [] })
    expect(monitor.snapshot()).toEqual(probed)
  })

  it('shares one pass between concurrent callers rather than spawning two fleets', async () => {
    const runtime = standIn(workspace())
    const monitor = new CapabilityMonitor({ seam, runtimes: [runtime.spec()] })

    await Promise.all([monitor.refresh(), monitor.refresh(), monitor.refresh()])

    expect(runtime.invocations()).toEqual(['--version', 'auth'])
  })

  it('announces a change and stays quiet when nothing changed', async () => {
    const root = workspace()
    const runtime = standIn(root)
    const monitor = new CapabilityMonitor({ seam, runtimes: [runtime.spec()] })
    const announced: unknown[] = []
    monitor.on('capabilities', capabilities => announced.push(capabilities))

    await monitor.refresh()
    await monitor.refresh()

    expect(announced).toHaveLength(1)
  })

  it('polls on its own cadence, clamped, until it is stopped', async () => {
    const runtime = standIn(workspace())
    // Below the floor on purpose: the cadence is the runner's, and a caller asking for
    // five probes a second gets the floor instead.
    const monitor = new CapabilityMonitor({ seam, runtimes: [runtime.spec()], refreshMs: 1 })

    monitor.start()
    await until(() => runtime.invocations().length >= 2)
    monitor.stop()
    const afterStop = runtime.invocations().length
    await sleep(MIN_CAPABILITY_REFRESH_MS + 200)

    expect(runtime.invocations().length).toBe(afterStop)
    expect(MIN_CAPABILITY_REFRESH_MS).toBeLessThan(CAPABILITY_REFRESH_MS)
  })

  // Counts what the loop schedules for itself, told apart from probe deadlines by length:
  // the cadence is five seconds here and every probe timer is under one, so nothing else in
  // the run lands in this range.
  function cadenceSchedules() {
    const delays: number[] = []
    const real = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, ms?: number) => {
      delays.push(ms ?? 0)
      return real(handler, ms)
    }) as typeof setTimeout)
    return () => delays.filter(delay => delay > PROBE_TIMERS_BELOW_MS)
  }

  it('leaves no second cadence behind when it is stopped mid-pass and started again', async () => {
    const runtime = standIn(workspace(), { hangs: true })
    const scheduled = cadenceSchedules()
    const monitor = new CapabilityMonitor({ seam, runtimes: [runtime.spec()], probeTimeoutMs: 300, refreshMs: CADENCE_MS })

    monitor.start()
    // The only window where this can go wrong: the reschedule sits on the far side of an
    // await, and stop() can only clear a timer that already exists — a tick still waiting on
    // its probes has none yet.
    await until(() => runtime.invocations().length >= 1)
    monitor.stop()
    monitor.start()
    await sleep(2_500)
    monitor.stop()

    // Counted rather than measured as a probe rate, and that took two wrong tests to learn:
    // the retired tick and the live one land about twenty milliseconds apart, `refresh()`
    // shares an in-flight pass between them, and the probe count therefore does not double.
    // What the defect actually leaves behind is a timer nothing tracks, so that is the thing
    // to count. Two schedules here is the bug; one is the fix.
    expect(scheduled()).toHaveLength(1)
  }, 30_000)

  it('keeps announcing to the listeners that work, and retries the one that did not', async () => {
    const runtime = standIn(workspace())
    const monitor = new CapabilityMonitor({ seam, runtimes: [runtime.spec()] })
    const healthy: unknown[] = []
    let throwUntilSecondTry = 2
    monitor.on('capabilities', () => {
      throwUntilSecondTry -= 1
      if (throwUntilSecondTry > 0) throw new Error('this subscriber is having a bad day')
    })
    monitor.on('capabilities', capabilities => healthy.push(capabilities))

    await monitor.refresh()
    await monitor.refresh()

    // One listener throwing must not be the end of capability state for everybody: the
    // change stays uncommitted, so the next pass offers the same whole snapshot again, and
    // the listener that works hears it both times rather than never hearing it again.
    expect(healthy).toHaveLength(2)
    expect(monitor.snapshot()).toEqual(healthy[0])
  })

  it('keeps answering for the machine even while a listener never stops throwing', async () => {
    const runtime = standIn(workspace())
    const monitor = new CapabilityMonitor({ seam, runtimes: [runtime.spec()] })
    monitor.on('capabilities', () => {
      throw new Error('this subscriber is never coming back')
    })

    const probed = await monitor.refresh()

    // The resolver reads `snapshot()` and refuses every runtime when it is null, so gating
    // it on delivery turns one broken subscriber into a runner that can launch nothing. What
    // the machine can do and what a peer was told are two facts; only the second waits.
    expect(monitor.snapshot()).toEqual(probed)
    expect(monitor.snapshot()?.runtimes).toHaveLength(1)
    await monitor.refresh()
    expect(monitor.snapshot()).toEqual(probed)
  })

  it('probes nothing it was not given, so an installed CLI is not an ambient dependency', async () => {
    expect(await new CapabilityMonitor({ seam }).refresh()).toEqual({ runtimes: [], endpoints: [] })
  })
})

describe('the shipped runtime catalog', () => {
  it('holds only commands that report, never commands that act', () => {
    // "Detect and guide, never bundle", made structural: no entry names an installer, and
    // nothing here could bill money on a reconnect.
    const forbidden = ['install', 'update', 'upgrade', 'exec', 'run', '-p', '--print']
    for (const spec of DEFAULT_RUNTIME_CATALOG) {
      const args = [...spec.versionArgs, ...(spec.authArgs ?? [])]
      expect(args.filter(argument => forbidden.includes(argument))).toEqual([])
      expect(spec.versionArgs).toEqual(['--version'])
      expect(spec.authArgs?.at(-1)).toBe('status')
    }
  })

  it('is a value, not an ambient default', () => {
    expect(DEFAULT_RUNTIME_CATALOG.map(spec => spec.runtime)).toEqual(['claude', 'codex'])
    expect(DEFAULT_RUNTIME_CATALOG.find(spec => spec.runtime === 'claude')?.access).toEqual(['subscription', 'api-key'])
  })
})

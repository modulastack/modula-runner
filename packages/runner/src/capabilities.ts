import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import {
  MAX_RUNTIME_CAPABILITIES,
  MAX_RUNTIME_VERSION_LENGTH,
  hasControlCharacter,
  isAccessMode,
  isSafeIdentifier,
  type AccessMode,
  type CliAuthState,
  type LocalEndpointCapability,
  type RunnerCapabilities,
  type RuntimeCapability,
} from '@modulastack/runner-protocol'
import type {
  CapabilityProbeBatchSeam,
  CapabilityProbeDecision,
  CapabilityProbeIntent,
  CapabilityRefreshOutcome,
} from './capabilityProbeBatch.js'
import type { LocalEndpointRegistry } from './localEndpoints.js'
import type { SpawnOutcome } from './auditLog.js'
import type { SpawnSeam } from './spawnSeam.js'

// What this machine can actually run, probed rather than assumed, and kept true for as
// long as the connection lasts.
//
// Auth state is asked of the CLI, never read off disk. FR-16 is the runner's headline
// promise and the README states it to the public: the runner's file access excludes CLI
// auth stores by construction, and a test asserts the binary never opens `~/.claude*` or
// `~/.codex*`. Stat-ing an auth file to decide "logged in" would break that promise to
// answer a question the CLI will answer about itself — the doctrine is that Modula drives
// the client and never extracts its token, so the client is who gets asked.
//
// Probe commands come from the runner's local runtime catalog, never from the wire, and
// every probe is deadline-bounded: a wedged CLI costs one `unknown` answer, not a delayed
// handshake or a missed heartbeat.

export const DEFAULT_PROBE_TIMEOUT_MS = 3_000
export const MAX_PROBE_OUTPUT_BYTES = 64 * 1024
// The cadence is the RUNNER'S, not the control plane's. Deriving it from the negotiated
// heartbeat would let a peer whose trust is limited to "schedule work and relay operator
// input" decide how often this machine hammers the operator's own local service — and the
// schema's floor of 200 ms would make five probes a second a compliant instruction. The
// heartbeat policy is bounded for that same class of reason; this constant is the answer to
// the same question one layer down.
//
// Each pass spawns a real probe process per runtime and every such spawn is audited at the seam,
// so a tight cadence floods the append-only log with liveness records that bury actual events. A
// capability changes on human-timescale install/login events, and the access resolver re-probes
// at the moment it spawns — so an advertised capability going stale between passes is corrected
// on use. The cadence is therefore minutes, not seconds: `current()` serves the last probe
// continuously while a fresh, audited probe runs infrequently.
export const CAPABILITY_REFRESH_MS = 60_000
export const MIN_CAPABILITY_REFRESH_MS = 500
// Every probe is a subprocess and the pass runs on a cadence, so the fleet is bounded
// rather than trusted to stay small.
const MAX_CONCURRENT_PROBES = 4
// Codes that mean the executable was not there to be asked. Anything else — a non-zero
// exit, a wedged process, output past the cap — is a runtime that exists and answered
// badly, which is a different fact from absence.
const ABSENT_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR'])
// How long a probe that was asked to stop gets before it is made to.
const PROBE_KILL_GRACE_MS = 500
// How long the answer waits for stdout to finish after the process has gone. Long enough
// for output already in the pipe, short enough that a pipe somebody else is holding open
// costs one late-arriving character rather than the pass.
const STDIO_DRAIN_MS = 50
const ENVIRONMENT_VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/

export type RuntimeSpec = {
  runtime: string
  // Resolved against the runner's local allowlist. A runtime whose command is not
  // allowlisted is not probed and not advertised.
  command: string
  versionArgs: readonly string[]
  // null when the runtime offers no way to ask about its own login state, which reports
  // `unknown` rather than guessing. Reporting a signed-in CLI as signed out renders
  // sign-in guidance at somebody who is already signed in.
  authArgs: readonly string[] | null
  // The access modes this runtime can serve. Claude Code is subscription and api-key only;
  // that is a property of the runtime, not of the architecture.
  access: readonly AccessMode[]
  // Which environment variable this runtime reads a provider key from. Defaults to
  // `<PROVIDER>_API_KEY` — uppercased, hyphens to underscores — which is right for every
  // vendor worth naming and needs no table to drift. The fixed suffix is load-bearing: a
  // derived name can never collide with `PATH`, `LD_PRELOAD` or anything else that matters,
  // so operator-chosen text cannot become an arbitrary variable.
  keyVariable?: string
  // Which environment variable this runtime reads a local endpoint's address from. Defaults
  // by endpoint kind (`ollama` → OLLAMA_HOST, `openai-compatible` → OPENAI_BASE_URL). The
  // variable a CLI actually reads is a property of the runtime, not of the endpoint, so the
  // runtime is what gets to override it.
  endpointVariable?: string
  // How this runtime is told which model to run. Defaults to `--model`.
  modelFlag?: string
  // Arguments this runtime needs for a given access mode — `codex` declares
  // `{ local: ['--oss'] }`, which FR-12 names explicitly. Argument knowledge lives in this
  // local catalog and nowhere else: the wire names a profile, never a command and never an
  // argument vector, which is the preview-recipe rule applied to panes.
  accessArgs?: Partial<Record<AccessMode, readonly string[]>>
}

// The catalog this runner ships. It is a value a caller composes with, never an ambient
// default: a monitor built without one probes nothing, so no test spawns a CLI that merely
// happens to be installed on the machine it runs on.
//
// Only version and status subcommands appear here. A capability probe that bills money on
// every reconnect is a real failure mode, and this catalog is where it is prevented — as is
// "detect and guide, never bundle", since no entry names an installer or a package manager.
export const DEFAULT_RUNTIME_CATALOG: readonly RuntimeSpec[] = [
  { runtime: 'claude', command: 'claude', versionArgs: ['--version'], authArgs: ['auth', 'status'], access: ['subscription', 'api-key'] },
  {
    runtime: 'codex',
    command: 'codex',
    versionArgs: ['--version'],
    authArgs: ['login', 'status'],
    access: ['subscription', 'api-key', 'local'],
    accessArgs: { local: ['--oss'] },
  },
]

export type CapabilityMonitorOptions = {
  // Probing spawns third-party CLIs, so it passes the same allowlist gate every runner-owned
  // spawn does: a runtime whose command is not allowlisted is not probed and not advertised.
  seam: SpawnSeam
  // Present only for the interface-first checkpoint. The implementation checkpoint makes this
  // seam authoritative; omission preserves current behavior until verifier-owned specs exist.
  batchSeam?: CapabilityProbeBatchSeam
  runtimes?: readonly RuntimeSpec[]
  endpoints?: LocalEndpointRegistry
  probeTimeoutMs?: number
  // Clamped at MIN_CAPABILITY_REFRESH_MS. Local configuration only — there is deliberately
  // no path by which the control plane can set it.
  refreshMs?: number
  now?: () => number
}

export declare interface CapabilityMonitor {
  on(event: 'capabilities', listener: (capabilities: RunnerCapabilities) => void): this
}

export class CapabilityMonitor extends EventEmitter {
  private readonly seam: SpawnSeam
  private readonly batchSeam: CapabilityProbeBatchSeam | undefined
  private readonly runtimes: readonly RuntimeSpec[]
  private readonly endpoints: LocalEndpointRegistry | undefined
  private readonly probeTimeoutMs: number
  private readonly refreshMs: number
  private readonly now: () => number
  // The last completed probe: what this machine can do, whatever anyone made of the news.
  private latest: RunnerCapabilities | null = null
  // The last snapshot a notification actually got through for. Change detection compares
  // against this so a failed delivery is retried, and never against `latest`, which must
  // keep advancing for the resolver whether or not a subscriber is healthy.
  private announced: RunnerCapabilities | null = null
  private pass: Promise<RunnerCapabilities> | undefined
  private timer: NodeJS.Timeout | undefined
  private polling = false
  // Which run of the loop is the current one. Advanced by both start() and stop(), so a
  // pass that was in flight across either can tell that it no longer owns the cadence.
  private generation = 0

  constructor(options: CapabilityMonitorOptions) {
    super()
    this.seam = options.seam
    this.batchSeam = options.batchSeam
    const runtimes = options.runtimes ?? []
    // Bounded where it is produced, not only at the validator: a catalog longer than the
    // wire carries would build a snapshot the peer drops whole, and a configuration that
    // refuses to load is better than an advertisement that silently omits half a machine.
    if (runtimes.length > MAX_RUNTIME_CAPABILITIES) throw new Error(`a runner advertises at most ${MAX_RUNTIME_CAPABILITIES} runtimes`)
    for (const spec of runtimes) assertRuntimeSpec(spec)
    if (new Set(runtimes.map(spec => spec.runtime)).size !== runtimes.length) throw new Error('runtime names must be unique')
    this.runtimes = runtimes.map(spec => ({ ...spec }))
    this.endpoints = options.endpoints
    this.probeTimeoutMs = positiveOr(options.probeTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS)
    this.refreshMs = Math.max(MIN_CAPABILITY_REFRESH_MS, positiveOr(options.refreshMs, CAPABILITY_REFRESH_MS))
    this.now = options.now ?? Date.now
  }

  // The last completed probe. Null until the first one lands, which is how a runner that has
  // not yet answered for itself publishes nothing rather than an empty snapshot — "nothing
  // installed" and "did not say" are different facts, and only one of them should hide a
  // runtime from the interface.
  snapshot(): RunnerCapabilities | null {
    return this.latest
  }

  // One full probe pass. Concurrent callers share the pass in flight rather than each
  // spawning their own fleet of subprocesses.
  refresh(): Promise<RunnerCapabilities> {
    if (this.pass) return this.pass
    const pass = this.probeAll().finally(() => {
      if (this.pass === pass) this.pass = undefined
    })
    this.pass = pass
    return pass
  }

  // A capability that stops being true is advertised within one refresh interval. That is
  // the whole timing promise, and it is deliberately weaker than "fails fast at launch",
  // which does not depend on this loop at all: the resolver re-probes before it spawns, so
  // a stale snapshot delays a UI, never a refusal.
  start(): void {
    if (this.polling) return
    this.polling = true
    this.generation += 1
    void this.tick(this.generation)
  }

  stop(): void {
    this.polling = false
    // Advancing here is what retires a pass that is already in flight. Clearing the timer
    // only reaches a tick that has finished; one still awaiting its probes has no timer yet,
    // and would schedule after the stop.
    this.generation += 1
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  // Scheduled from the end of each pass rather than on a fixed interval: a probe slower
  // than the cadence would otherwise stack passes behind each other and turn one wedged CLI
  // into a growing pile of subprocesses.
  //
  // Each run carries the generation it belongs to, because the reschedule sits on the far
  // side of an await and `polling` is shared. A stop() and a start() during one pass would
  // otherwise leave the old tick and the new one both scheduling — two cadences, one of them
  // untracked, and stop() can only ever clear the timer it can see. This is the only
  // self-rescheduling loop in the package that is asynchronous; `liveness.ts` reschedules
  // itself too, but synchronously, so no state can change underneath it.
  private async tick(generation: number) {
    const startedAt = this.now()
    // A failed pass must not end the loop — the next one is the recovery — and a rejection
    // escaping here belongs to no caller, which is how a background failure takes a process
    // down.
    await this.refresh().catch(() => undefined)
    if (!this.polling || generation !== this.generation) return
    this.timer = setTimeout(() => void this.tick(generation), Math.max(0, this.refreshMs - (this.now() - startedAt)))
    this.timer.unref()
  }

  private async probeAll(): Promise<RunnerCapabilities> {
    const snapshot = this.batchSeam
      ? await this.probeAllAsBatch(this.batchSeam)
      : await this.probeAllIndividually()
    // What the machine can do, and what a peer has been told, are two facts. A failed audit batch
    // never reaches this assignment, so an undurable refresh cannot become the current snapshot.
    this.latest = snapshot
    if (JSON.stringify(snapshot) === JSON.stringify(this.announced)) return snapshot
    if (this.announce(snapshot)) this.announced = snapshot
    return snapshot
  }

  private async probeAllIndividually(): Promise<RunnerCapabilities> {
    const [runtimes, endpoints] = await Promise.all([
      probeCatalog(this.seam, this.runtimes, this.probeTimeoutMs),
      this.endpoints ? this.endpoints.probeAll({ timeoutMs: this.probeTimeoutMs }) : Promise.resolve([]),
    ])
    return { runtimes, endpoints }
  }

  private async probeAllAsBatch(batchSeam: CapabilityProbeBatchSeam): Promise<RunnerCapabilities> {
    const batch = {
      refreshId: randomUUID(),
      probes: capabilityIntentions(this.runtimes),
      endpointIntentions: this.endpoints?.list().length ?? 0,
    }
    const result = await batchSeam.run(batch, async decisions => {
      const [runtimeResult, endpoints] = await Promise.all([
        probeCatalogBatch(this.runtimes, decisions, this.probeTimeoutMs),
        this.endpoints ? this.endpoints.probeAll({ timeoutMs: this.probeTimeoutMs }) : Promise.resolve([]),
      ])
      const snapshot: RunnerCapabilities = { runtimes: runtimeResult.capabilities, endpoints }
      return {
        outcome: aggregateOutcome(runtimeResult.outcomes, endpoints, batch.endpointIntentions, snapshot, this.announced),
        value: snapshot,
      }
    })
    if (result.status === 'storage-unavailable') throw new Error('capability refresh audit unavailable')
    return result.value
  }

  private announce(snapshot: RunnerCapabilities) {
    let delivered = true
    for (const listener of this.listeners('capabilities')) {
      try {
        listener(snapshot)
      } catch {
        // A subscriber's failure is the subscriber's to report. What matters here is that it
        // does not become everyone else's, and that this snapshot stays uncommitted so the
        // next pass offers it again.
        delivered = false
      }
    }
    return delivered
  }
}

export async function probeRuntime(spec: RuntimeSpec, seam: SpawnSeam, timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS): Promise<RuntimeCapability | null> {
  assertRuntimeSpec(spec)
  const version = await runProbe(seam, spec.command, spec.versionArgs, timeoutMs)
  // Absence is how a missing runtime is expressed, so the protocol never has to carry a
  // vocabulary of every CLI that might exist. A command the allowlist forbids is absent by the
  // same token: not probed, not advertised.
  if (version.status === 'missing') return null
  return {
    runtime: spec.runtime,
    version: version.status === 'answered' ? reportedVersion(version.stdout) : null,
    auth: await authState(spec, seam, timeoutMs),
    access: [...spec.access],
  }
}

async function probeCatalog(seam: SpawnSeam, specs: readonly RuntimeSpec[], timeoutMs: number): Promise<RuntimeCapability[]> {
  const detected: RuntimeCapability[] = []
  let next = 0
  const worker = async () => {
    for (;;) {
      const index = next
      next += 1
      const spec = specs[index]
      if (!spec) return
      const capability = await probeRuntime(spec, seam, timeoutMs)
      if (capability) detected[index] = capability
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_PROBES, specs.length) }, worker))
  // Written by index so the order is the catalog's; the holes an absent runtime leaves are
  // closed here rather than advertised as gaps.
  return detected.filter(entry => entry !== undefined)
}

type BatchProbeOutcome = ProbeOutcome | { status: 'refused' }
type BatchCatalogResult = { capabilities: RuntimeCapability[]; outcomes: BatchProbeOutcome[] }

function capabilityIntentions(specs: readonly RuntimeSpec[]): CapabilityProbeIntent[] {
  return specs.flatMap(spec => {
    const intent = (check: 'version' | 'auth', args: readonly string[]): CapabilityProbeIntent => ({
      probeId: randomUUID(),
      runtimeId: spec.runtime,
      check,
      request: { kind: 'probe', executable: spec.command, args, cwd: tmpdir(), grantScoped: false },
    })
    return spec.authArgs === null
      ? [intent('version', spec.versionArgs)]
      : [intent('version', spec.versionArgs), intent('auth', spec.authArgs)]
  })
}

async function probeCatalogBatch(
  specs: readonly RuntimeSpec[],
  decisions: readonly CapabilityProbeDecision[],
  timeoutMs: number,
): Promise<BatchCatalogResult> {
  const results = new Array<{ capability: RuntimeCapability | null; outcomes: BatchProbeOutcome[] }>(specs.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const index = next++
      const spec = specs[index]
      if (!spec) return
      results[index] = await probeRuntimeBatch(spec, decisions, timeoutMs)
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_PROBES, specs.length) }, worker))
  return {
    capabilities: results.flatMap(result => result.capability ? [result.capability] : []),
    outcomes: results.flatMap(result => result.outcomes),
  }
}

async function probeRuntimeBatch(
  spec: RuntimeSpec,
  decisions: readonly CapabilityProbeDecision[],
  timeoutMs: number,
): Promise<{ capability: RuntimeCapability | null; outcomes: BatchProbeOutcome[] }> {
  const version = await executeBatchDecision(decisionFor(decisions, spec.runtime, 'version'), timeoutMs)
  const auth = spec.authArgs === null
    ? null
    : version.status === 'missing'
      ? { status: 'missing' as const }
      : await executeBatchDecision(decisionFor(decisions, spec.runtime, 'auth'), timeoutMs)
  const outcomes = auth ? [version, auth] : [version]
  if (version.status === 'missing' || version.status === 'refused') return { capability: null, outcomes }
  return {
    capability: {
      runtime: spec.runtime,
      version: version.status === 'answered' ? reportedVersion(version.stdout) : null,
      auth: auth?.status === 'answered' ? (auth.exitCode === 0 ? 'authenticated' : 'unauthenticated') : 'unknown',
      access: [...spec.access],
    },
    outcomes,
  }
}

function decisionFor(
  decisions: readonly CapabilityProbeDecision[],
  runtimeId: string,
  check: 'version' | 'auth',
): CapabilityProbeDecision {
  const decision = decisions.find(candidate => candidate.runtimeId === runtimeId && candidate.check === check)
  if (!decision) throw new Error('capability batch omitted a probe decision')
  return decision
}

function executeBatchDecision(decision: CapabilityProbeDecision, timeoutMs: number): Promise<BatchProbeOutcome> {
  return decision.status === 'refused'
    ? Promise.resolve({ status: 'refused' })
    : runProbeProcess(decision.vetted.command, decision.vetted.args, timeoutMs)
}

function aggregateOutcome(
  runtimeOutcomes: readonly BatchProbeOutcome[],
  endpoints: readonly LocalEndpointCapability[],
  endpointIntentions: number,
  snapshot: RunnerCapabilities,
  announced: RunnerCapabilities | null,
): CapabilityRefreshOutcome {
  const count = (status: BatchProbeOutcome['status']) => runtimeOutcomes.filter(outcome => outcome.status === status).length
  const available = endpoints.filter(endpoint => endpoint.reachable).length
  return {
    runtimeOutcomes: {
      answered: count('answered'),
      missing: count('missing'),
      unanswered: count('unanswered'),
      refused: count('refused'),
    },
    endpointOutcomes: { available, unavailable: endpointIntentions - available, refused: 0 },
    snapshotChanged: JSON.stringify(snapshot) !== JSON.stringify(announced),
  }
}

// The CLI is asked about itself and only its exit status is read. Its output can carry an
// account address and an organisation name, which is nothing a capability probe has any
// business retaining, let alone reporting.
async function authState(spec: RuntimeSpec, seam: SpawnSeam, timeoutMs: number): Promise<CliAuthState> {
  if (spec.authArgs === null) return 'unknown'
  const outcome = await runProbe(seam, spec.command, spec.authArgs, timeoutMs)
  if (outcome.status !== 'answered') return 'unknown'
  return outcome.exitCode === 0 ? 'authenticated' : 'unauthenticated'
}

type ProbeOutcome =
  | { status: 'missing' }
  | { status: 'unanswered' }
  | { status: 'answered'; exitCode: number; stdout: string }

// Probing is command execution and is governed as such: the command comes from the local
// catalog, the deadline is the runner's, the working directory is neutral so no
// repository's configuration is read, stdin is `/dev/null` so a CLI that would prompt reads
// EOF instead of waiting, stderr goes nowhere so a chatty runtime cannot fill a pipe nobody
// drains, and stdout is capped.
//
// `spawn` rather than `execFile`, and the difference is not stylistic: `execFile` builds its
// own options object and never forwards `stdio`, so asking it to close stdin does nothing
// and says nothing — the prompt-blocks-forever case stays open while the comment claims it
// is shut. Its timeout is also SIGTERM-only, and a runtime that ignores SIGTERM would hold
// the pass open indefinitely; `refresh()` shares one pass, so that stalls every later
// capability update with nothing to say why. The deadline here escalates.
//
// `tmux.ts` keeps `execFile` deliberately: it passes no unsupported option, makes no claim
// its code does not honour, and drives a known binary on a short leash. The risk this
// function answers is specific to spawning third-party CLIs whose behaviour the runner does
// not control.
// The allowlist gate in front of the probe process. A forbidden command never spawns and reads
// as `missing`, the same answer an uninstalled one gives, so the interface offers only what the
// operator's signed allowlist admits. An admitted probe is audited like any runner-owned spawn.
async function runProbe(seam: SpawnSeam, command: string, args: readonly string[], timeoutMs: number): Promise<ProbeOutcome> {
  const result = await seam.run(
    { kind: 'probe', executable: command, args, cwd: tmpdir(), grantScoped: false },
    async vetted => {
      const outcome = await runProbeProcess(vetted.command, vetted.args, timeoutMs)
      return { outcome: probeSpawnOutcome(outcome), value: outcome }
    },
  )
  return result.status === 'refused' ? { status: 'missing' } : result.value
}

function probeSpawnOutcome(outcome: ProbeOutcome): SpawnOutcome {
  if (outcome.status === 'answered') return { exitCode: outcome.exitCode, signal: null }
  return { spawnFailed: true }
}

function runProbeProcess(command: string, args: readonly string[], timeoutMs: number): Promise<ProbeOutcome> {
  return new Promise(resolve => {
    let child: ChildProcess
    try {
      child = spawn(command, [...args], { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      // spawn rejects some inputs synchronously. A command this runner cannot even attempt
      // is not a runtime that answered badly; it is one that is not there.
      return resolve({ status: 'missing' })
    }
    let stdout = ''
    // Counted in bytes, which is what the cap is written in: a character count would let a
    // multi-byte answer past a limit that exists to bound memory.
    let bytes = 0
    let overran = false
    let expired = false
    let settled = false
    const answer = (outcome: ProbeOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(escalation)
      resolve(outcome)
    }
    const deadline = setTimeout(() => {
      expired = true
      child.kill('SIGTERM')
    }, timeoutMs)
    // Asked to stop, then made to. A CLI that traps SIGTERM to tidy up gets the grace; one
    // that ignores it does not get to keep the pass.
    const escalation = setTimeout(() => child.kill('SIGKILL'), timeoutMs + PROBE_KILL_GRACE_MS)
    for (const timer of [deadline, escalation]) timer.unref()
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > MAX_PROBE_OUTPUT_BYTES) {
        // More than this runner will read is not an answer it can trust the shape of.
        overran = true
        child.kill('SIGKILL')
        return
      }
      stdout += chunk
    })
    child.on('error', error => {
      const code = (error as NodeJS.ErrnoException).code
      answer(typeof code === 'string' && ABSENT_CODES.has(code) ? { status: 'missing' } : { status: 'unanswered' })
    })
    // `exit`, not `close`, and the difference is the whole finding: `close` waits for every
    // writer of the pipe to let go, and a CLI that forks a background child inheriting
    // stdout leaves it held after the process we asked has gone. Neither signal reaches that
    // child — it is not the one we spawned — so the pass would stay pending forever, which
    // is the same harm the escalation exists to prevent by a different road.
    //
    // The preview host kills a process group instead, because a preview *is* its tree and
    // the socket may belong to a descendant. A probe is not: it asks one command one
    // question, and detaching every version check into its own session to reap children the
    // runner never wanted is a heavier change than the problem.
    child.on('exit', (code, signal) => {
      // A short drain first, so the ordinary case keeps its output: a version written just
      // before exit usually arrives before the exit does, and when it does not, a few
      // milliseconds are enough. Bounded, because that is the point of not waiting on close.
      drainThen(child, () => {
        // Killed, or ended by something other than its own exit: the runtime exists but did
        // not answer, which is not the same as answering "no".
        if (expired || overran || signal !== null || code === null) return answer({ status: 'unanswered' })
        answer({ status: 'answered', exitCode: code, stdout })
      })
    })
  })
}

// The version the runtime reported, as it reported it. There is no minimum-version rule and
// no compatibility check here; this only makes the string carryable — control characters
// out, bounded to what the wire accepts, null when the runtime said nothing.
function reportedVersion(stdout: string): string | null {
  const [first = ''] = stdout.split('\n')
  const cleaned = [...first.trim()].filter(character => !hasControlCharacter(character)).join('')
  return cleaned.length === 0 ? null : cleaned.slice(0, MAX_RUNTIME_VERSION_LENGTH)
}

function assertRuntimeSpec(spec: RuntimeSpec) {
  if (!isSafeIdentifier(spec.runtime)) throw new Error('a runtime name must be a safe identifier')
  for (const [field, value] of [['command', spec.command], ['modelFlag', spec.modelFlag]] as const) {
    if (value === undefined) continue
    if (typeof value !== 'string' || value.length === 0 || hasControlCharacter(value)) throw new Error(`${field} must be a plain string: ${spec.runtime}`)
  }
  for (const args of [spec.versionArgs, spec.authArgs, ...Object.values(spec.accessArgs ?? {})]) {
    if (args === null || args === undefined) continue
    if (!Array.isArray(args) || args.some(argument => typeof argument !== 'string' || hasControlCharacter(argument))) {
      throw new Error(`runtime arguments must be plain strings: ${spec.runtime}`)
    }
  }
  // An override that is not a variable name would fail at injection, one launch later and
  // one layer away from the configuration that caused it.
  for (const variable of [spec.keyVariable, spec.endpointVariable]) {
    if (variable !== undefined && !ENVIRONMENT_VARIABLE.test(variable)) throw new Error(`not a usable environment variable name: ${variable}`)
  }
  if (!Array.isArray(spec.access) || spec.access.length === 0 || !spec.access.every(isAccessMode)) {
    throw new Error(`a runtime must declare at least one access mode it can serve: ${spec.runtime}`)
  }
  if (new Set(spec.access).size !== spec.access.length) throw new Error(`a runtime declares each access mode once: ${spec.runtime}`)
}

// Waits for the stream to end, but not for whoever else might be holding it: the deadline
// is what makes an inherited pipe a bounded cost instead of an open-ended one.
function drainThen(child: ChildProcess, act: () => void) {
  const stream = child.stdout
  if (!stream || stream.readableEnded || stream.destroyed) return act()
  const deadline = setTimeout(act, STDIO_DRAIN_MS)
  deadline.unref()
  stream.once('end', () => {
    clearTimeout(deadline)
    act()
  })
}

function positiveOr(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : fallback
}

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SecretEnv } from '../src/secretEnv.js'
import { DEFAULT_FLOW, DEFAULT_POLL_MS, DEFAULT_REPLAY_LINES, TerminalSession, UnkillableSessionError } from '../src/terminalSession.js'
import { until } from './helpers.js'

// FR-11's env-only rule, exercised through the real tmux and pty path rather than argued
// about. Three things are being checked, and the second and third are the ones that a
// plausible implementation gets wrong:
//
//   1. the value arrives in the spawned process's environment;
//   2. it appears in no process's argument vector anywhere in the chain;
//   3. it does not reach a second pane on the same tmux server, which is what seeding the
//      server's environment would have done — and one server serves a whole worktree.

const SECRET = `sk-test-${randomBytes(12).toString('hex')}`
const POLICY = { flow: DEFAULT_FLOW, replayLines: DEFAULT_REPLAY_LINES, pollMs: DEFAULT_POLL_MS }
const EVENTS = { send: () => undefined, onExited: () => undefined }

type Lane = { root: string; socket: string; sessions: TerminalSession[] }

const lanes: Lane[] = []

const originalPath = process.env.PATH

afterEach(async () => {
  process.env.PATH = originalPath
  for (const lane of lanes) {
    for (const session of lane.sessions) await session.dispose(true)
    spawnSync('tmux', ['-L', lane.socket, 'kill-server'], { stdio: 'ignore' })
    rmSync(lane.root, { recursive: true, force: true })
  }
  lanes.length = 0
})

function lane(): Lane {
  const created = { root: mkdtempSync(path.join(tmpdir(), 'mr-secret-')), socket: `mr-secret-${randomBytes(4).toString('hex')}`, sessions: [] }
  lanes.push(created)
  return created
}

// Dumps what it was actually given — environment, argv, and whether the hand-off file it
// was told about still exists — then stays alive so the process table can be inspected
// while it is running.
function dumpScript(lane: Lane, name: string) {
  const script = path.join(lane.root, `${name}.mjs`)
  const dump = path.join(lane.root, `${name}.json`)
  // Written beside the real name and renamed onto it. A test that waits for the file to
  // exist and then parses it is otherwise racing the write: the name appears when the file
  // is created, not when it is complete, and under a loaded machine that gap is wide enough
  // to read half a JSON document and call it a failed injection.
  writeFileSync(script, `
    import { existsSync, renameSync, writeFileSync } from 'node:fs'
    const handoff = process.env.MODULA_RUNNER_SECRET_FILE ?? null
    writeFileSync(${JSON.stringify(`${dump}.partial`)}, JSON.stringify({
      env: process.env,
      argv: process.argv,
      handoffStillThere: handoff === null ? null : existsSync(handoff),
    }))
    renameSync(${JSON.stringify(`${dump}.partial`)}, ${JSON.stringify(dump)})
    setInterval(() => {}, 1000)
  `)
  return { script, dump, read: () => JSON.parse(readFileSync(dump, 'utf8')) as { env: Record<string, string>; argv: string[]; handoffStillThere: boolean | null } }
}

async function launch(lane: Lane, name: string, secrets?: SecretEnv) {
  const dumped = dumpScript(lane, name)
  const session = await TerminalSession.launch({
    command: process.execPath,
    args: [dumped.script],
    cwd: lane.root,
    socket: lane.socket,
    ...(secrets ? { secrets } : {}),
  }, POLICY, EVENTS)
  lane.sessions.push(session)
  await until(() => existsSync(dumped.dump))
  return dumped.read()
}

// Every argument vector on the machine this test can read. Sampling, not journalling: the
// durable case is what this proves, and the load-bearing claim is structural — the argv is
// built without the secret in the first place.
function argumentVectors() {
  return readdirSync('/proc')
    .filter(entry => /^\d+$/.test(entry))
    .map(pid => {
      try {
        return readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      } catch {
        // The process exited between the listing and the read, or belongs to another user.
        return ''
      }
    })
    .join('\n')
}

// Any hand-off still on disk anywhere under the temp root that holds this run's secret.
// Matched by content rather than by name, so a file another test left behind can neither
// fail this one nor let it pass.
function leakedHandoffs(secret: string) {
  return readdirSync(tmpdir())
    .filter(entry => entry.startsWith('modula-runner-'))
    .map(entry => path.join(tmpdir(), entry, 'secret-env'))
    .filter(candidate => {
      try {
        return readFileSync(candidate, 'utf8').includes(secret)
      } catch {
        // Not there, or gone between the listing and the read, which is the answer wanted.
        return false
      }
    })
}

// A tmux that fails to start a session and then will not say whether one exists: exit 1 is
// "no session", so a code tmux never uses for that leaves presence unknown, the kill
// unconfirmed, and the launch leaving by the path that skips the ordinary cleanup.
function unhelpfulTmux(lane: Lane) {
  const bin = path.join(lane.root, 'bin')
  mkdirSync(bin)
  writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\ncase " $* " in\n  *" has-session "*) exit 2 ;;\n  *) exit 1 ;;\nesac\n', { mode: 0o755 })
  return bin
}

describe('secret injection', () => {
  it('reaches the command through its environment and through no argument vector', async () => {
    const worktree = lane()

    const dumped = await launch(worktree, 'metered', SecretEnv.of({ ANTHROPIC_API_KEY: SECRET }))

    expect(dumped.env.ANTHROPIC_API_KEY).toBe(SECRET)
    expect(dumped.argv.join(' ')).not.toContain(SECRET)
    if (process.platform === 'linux') expect(argumentVectors()).not.toContain(SECRET)
  })

  it('deletes the hand-off before the command runs, so it does not outlive the launch', async () => {
    const worktree = lane()

    const dumped = await launch(worktree, 'metered', SecretEnv.of({ ANTHROPIC_API_KEY: SECRET }))

    expect(dumped.handoffStillThere).toBe(false)
    // Checked from outside the pane as well: the wrapper deletes it before the command
    // starts, and nothing recreates it for the life of the session.
    expect(existsSync(String(dumped.env.MODULA_RUNNER_SECRET_FILE))).toBe(false)
  })

  it('does not leak into a second pane on the same tmux server', async () => {
    // One tmux server per worktree serves every pane in it, so a key seeded at the server
    // would be inherited here — including by a `local` pane that must never see one.
    const worktree = lane()
    await launch(worktree, 'metered', SecretEnv.of({ ANTHROPIC_API_KEY: SECRET }))

    const neighbour = await launch(worktree, 'local')

    expect(neighbour.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(neighbour.env.MODULA_RUNNER_SECRET_FILE).toBeUndefined()
    expect(JSON.stringify(neighbour.env)).not.toContain(SECRET)
  })

  it('leaves no hand-off behind when the launch fails and the session cannot be confirmed dead', async () => {
    const worktree = lane()
    const dumped = dumpScript(worktree, 'doomed')
    process.env.PATH = `${unhelpfulTmux(worktree)}:${originalPath ?? ''}`

    const launch = TerminalSession.launch({
      command: process.execPath,
      args: [dumped.script],
      cwd: worktree.root,
      socket: worktree.socket,
      secrets: SecretEnv.of({ ANTHROPIC_API_KEY: SECRET }),
    }, POLICY, EVENTS)

    // The path that skips the ordinary cleanup: the kill could not be confirmed, so the
    // launch leaves by throwing rather than by tidying up after itself. That is precisely
    // when a plaintext credential must not be what is left behind.
    await expect(launch).rejects.toThrow(UnkillableSessionError)
    expect(leakedHandoffs(SECRET)).toEqual([])
  })

  it('refuses a secret named after one of the wrapper\'s own variables', async () => {
    const worktree = lane()
    const dumped = dumpScript(worktree, 'hijack')

    // The wrapper reads both of these back by name after sourcing the hand-off. A secret
    // exported under either one redirects those reads: the hand-off survives with plaintext
    // in it, or the exit code is written over a file of the exporter's choosing.
    for (const reserved of ['MODULA_RUNNER_SECRET_FILE', 'MODULA_RUNNER_EXIT_FILE']) {
      const launch = TerminalSession.launch({
        command: process.execPath,
        args: [dumped.script],
        cwd: worktree.root,
        socket: worktree.socket,
        secrets: SecretEnv.of({ [reserved]: '/tmp/somewhere-of-my-choosing' }),
      }, POLICY, EVENTS)

      await expect(launch).rejects.toThrow(/reserves these variable names/)
    }
    // Refused before anything happened: no session, and nothing on disk holding the value.
    expect(existsSync(dumped.dump)).toBe(false)
    expect(leakedHandoffs('/tmp/somewhere-of-my-choosing')).toEqual([])
  })

  it('keeps its own variables when the caller\'s env tries to claim them', async () => {
    const worktree = lane()
    const dumped = dumpScript(worktree, 'reserved-env')

    const session = await TerminalSession.launch({
      command: process.execPath,
      args: [dumped.script],
      cwd: worktree.root,
      socket: worktree.socket,
      // Non-secret `env` reaches tmux by a different route than `secrets`, and today it
      // cannot override these because the runner writes them after the caller's. That is a
      // property of spread order, which is one reordering away from being a second instance
      // of the vulnerability above — so it is pinned here rather than left to be noticed.
      env: { MODULA_RUNNER_EXIT_FILE: '/tmp/not-the-exit-file', MODULA_RUNNER_SECRET_FILE: '/tmp/not-the-handoff' },
      secrets: SecretEnv.of({ ANTHROPIC_API_KEY: SECRET }),
    }, POLICY, EVENTS)
    worktree.sessions.push(session)
    await until(() => existsSync(dumped.dump))

    const observed = dumped.read()
    expect(observed.env.MODULA_RUNNER_EXIT_FILE).toMatch(/modula-runner-.*exit-code$/)
    expect(observed.env.MODULA_RUNNER_SECRET_FILE).not.toBe('/tmp/not-the-handoff')
    expect(observed.env.ANTHROPIC_API_KEY).toBe(SECRET)
  })

  it('carries non-secret orchestration variables the ordinary way, alongside secret ones', async () => {
    const worktree = lane()
    const dumped = dumpScript(worktree, 'both')

    const session = await TerminalSession.launch({
      command: process.execPath,
      args: [dumped.script],
      cwd: worktree.root,
      socket: worktree.socket,
      env: { MODULA_RUNNER_LANE: 'coder' },
      secrets: SecretEnv.of({ OLLAMA_HOST: 'http://127.0.0.1:59137' }),
    }, POLICY, EVENTS)
    worktree.sessions.push(session)
    await until(() => existsSync(dumped.dump))

    const observed = dumped.read()
    expect(observed.env.MODULA_RUNNER_LANE).toBe('coder')
    expect(observed.env.OLLAMA_HOST).toBe('http://127.0.0.1:59137')
    // The endpoint address takes the secret path for the same reason a key does: an
    // argument vector is readable by every process on this machine.
    if (process.platform === 'linux') expect(argumentVectors()).not.toContain('http://127.0.0.1:59137')
  })
})

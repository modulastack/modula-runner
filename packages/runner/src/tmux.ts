import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { SpawnSeam } from './spawnSeam.js'

export type TmuxRef = {
  socket: string
  sessionName: string
}

// tmux is one allowlisted executable driven on a short leash. Every invocation passes the
// seam: the session's own lifecycle — creating it and killing it — is gated and audited like
// any runner-owned spawn, and the high-frequency control calls that operate an
// already-authorized session (presence, status, capture, copy-mode, the poll listing) are
// gated by the cheap `check` so a denied `tmux` policy stops them without flooding the audit
// log with a record per poll.
const TMUX_DENIED = 'tmux is not on the runner command allowlist'

function tmuxAllowed(seam: SpawnSeam) {
  return seam.check('tmux')
}

export type TmuxLaunch = TmuxRef & {
  cwd: string
  file: string
  args: string[]
  env?: Record<string, string>
}

const SCROLLBACK_LINES = 50_000
// Every tmux call is deadline-bounded: a wedged tmux server costs one failed
// command, never a hung runner.
const TMUX_TIMEOUT_MS = 2_000
const CAPTURE_TIMEOUT_MS = 3_000
// A capture is bounded by the lines it asked for, not by a flat ceiling, and
// only a few run at once: peak memory is then a property of the request rather
// than of how many sessions happen to recover together.
const CAPTURE_BYTES_PER_LINE = 4 * 1024
const CAPTURE_MIN_BYTES = 64 * 1024
const CAPTURE_MAX_BYTES = 64 * 1024 * 1024
const MAX_CONCURRENT_CAPTURES = 4
const MAX_QUEUED_CAPTURES = 64
// Socket pollers are per-worktree, so their count grows with active lanes. The
// cadence stays per-socket; what is bounded is how many listings run at once.
const MAX_CONCURRENT_POLLS = 4

// One tmux server per worktree: sessions in different lanes cannot see or name
// each other, and a wedged server takes down one lane, not all of them.
export function worktreeSocket(worktree: string) {
  return `modula-runner-${shortHash(worktree)}`
}

export function tmuxSessionName(worktree: string, sessionId: string) {
  return ['mr', shortHash(worktree), sessionId].join('-')
}

// Server options ride a config file read at server start: an option set after
// `new-session` misses the first pane (tmux applies history-limit at pane
// creation), and configuring a session that already exited is a race. The
// options themselves are the functional floor only — scrollback depth backs
// replay, mouse mode is how a web terminal's wheel enters copy-mode; viewer
// theming stays the control plane's business.
// remain-on-exit keeps a dead pane inspectable: a command that prints and exits
// immediately must not destroy its output before anyone could read it — the
// poller notices the death, reports EXIT, and only then kills the session.
const SERVER_CONFIG = `set-option -g history-limit ${SCROLLBACK_LINES}\nset-option -g mouse on\nset-option -g remain-on-exit on\n`
let serverConfigFile: string | undefined

// A private random directory and an exclusive create: tmux -f executes
// directives (run-shell included) as this process, so a predictable shared-tmp
// path would let another local user feed the runner a config.
function serverConfigPath() {
  if (!serverConfigFile) {
    const dir = mkdtempSync(path.join(tmpdir(), 'modula-runner-tmux-'))
    const file = path.join(dir, 'tmux.conf')
    writeFileSync(file, SERVER_CONFIG, { flag: 'wx', mode: 0o600 })
    serverConfigFile = file
  }
  return serverConfigFile
}

export async function startTmuxSession(launch: TmuxLaunch, seam: SpawnSeam) {
  const envArgs = Object.entries(launch.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`])
  const args = ['-L', launch.socket, '-f', serverConfigPath(), 'new-session', '-d', '-s', launch.sessionName, '-c', launch.cwd, ...envArgs, '--', launch.file, ...launch.args]
  // Session variables ride the per-session `-e` arguments only. Seeding them
  // into the process that may *start* the server would hand every later
  // session on that socket the first session's environment.
  // Creating the session is the audited lifecycle spawn: it runs the pane's command, and a
  // denied allowlist stops it here rather than after the process exists.
  const failure = await runTmuxAudited(seam, args, launch.cwd, process.env)
  if (failure) throw new Error(failure)
  // tmux can exit zero and still not create the session (an unusable socket
  // path reports its error without a failing status); trust the session, not
  // the exit code.
  if (!(await hasTmuxSession(launch, seam))) throw new Error('tmux session was not created')
}

function execTmux(args: string[], env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise(resolve => {
    execFile('tmux', args, { encoding: 'utf8', timeout: TMUX_TIMEOUT_MS, env }, (error, stdout, stderr) => {
      resolve(error ? (stderr || stdout || 'tmux command failed').trim() : null)
    })
  })
}

// A lifecycle tmux command: gated and audited through the seam. Refusal reads as a command
// failure, which is exactly how the callers already treat an unavailable tmux.
async function runTmuxAudited(seam: SpawnSeam, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const result = await seam.run(
    { kind: 'tmux', executable: 'tmux', args, cwd, grantScoped: false },
    async () => {
      const failure = await execTmux(args, env)
      return { outcome: failure ? { spawnFailed: true } : { exitCode: 0, signal: null }, value: failure }
    },
  )
  return result.status === 'refused' ? TMUX_DENIED : result.value
}

export type SessionPresence = 'present' | 'absent' | 'unknown'

// tmux answers "not here" with exit code 1; anything else — a missing binary, a
// timeout, a signal — means the question went unanswered. Collapsing the two
// would let an operational failure masquerade as a dead session and retire a
// command that is still running.
export function tmuxSessionPresence(ref: TmuxRef, seam: SpawnSeam): Promise<SessionPresence> {
  // A poll on an already-created session: gated, not audited. A denied policy makes the
  // answer 'unknown' — the runner cannot ask, which is not the same as the session being gone.
  if (!tmuxAllowed(seam)) return Promise.resolve('unknown')
  return new Promise(resolve => {
    execFile('tmux', ['-L', ref.socket, 'has-session', '-t', `=${ref.sessionName}`], { timeout: TMUX_TIMEOUT_MS }, error => {
      if (!error) return resolve('present')
      resolve(answered(error) ? 'absent' : 'unknown')
    })
  })
}

export async function hasTmuxSession(ref: TmuxRef, seam: SpawnSeam): Promise<boolean> {
  return (await tmuxSessionPresence(ref, seam)) === 'present'
}

function answered(error: unknown) {
  const failure = error as { code?: unknown; killed?: unknown; signal?: unknown }
  return failure.code === 1 && !failure.killed && !failure.signal
}

// The kill is verified, never assumed: a timed-out or failed kill would leave
// the command running while its watcher was torn down, so the caller learns
// whether the session is actually gone.
export async function killTmuxSession(ref: TmuxRef, seam: SpawnSeam): Promise<boolean> {
  const before = await tmuxSessionPresence(ref, seam)
  if (before === 'absent') return true
  // An unanswered question is not a confirmed kill: the caller keeps watching.
  if (before === 'unknown') return false
  // Teardown, not a new workload: gated like the other control operations, never routed through
  // the fail-closed audited spawn. A malicious pane must stay terminable when the audit log is
  // down — a full disk must not become a way to keep a process alive — and the teardown is
  // accounted for by the kill switch's own durable record and the pane's outcome, not a per-kill
  // audit that could refuse. A denied policy leaves the session unconfirmed rather than killed.
  if (!tmuxAllowed(seam)) return false
  await execTmux(['-L', ref.socket, 'kill-session', '-t', `=${ref.sessionName}`], process.env)
  return (await tmuxSessionPresence(ref, seam)) === 'absent'
}

export function tmuxAttachArgs(ref: TmuxRef) {
  return ['-L', ref.socket, 'attach-session', '-t', `=${ref.sessionName}`]
}

// Async and bounded on both axes — time and bytes — because capture output is
// as large as a pane's history: a wedged server or an enormous pane costs one
// failed replay, never a blocked event loop or a silently truncated buffer.
// `stillWanted` is consulted after the wait, not before it: by the time a queued
// capture reaches the front, the session that asked for it may be gone, and
// running it would spend a subprocess on output nobody will read.
export async function captureTmuxScrollback(ref: TmuxRef, lines: number, seam: SpawnSeam, stillWanted: () => boolean = () => true): Promise<string | null> {
  if (!tmuxAllowed(seam)) return null
  if (!(await acquireCaptureSlot())) return null
  try {
    return stillWanted() ? await runCapture(ref, lines) : null
  } finally {
    releaseCaptureSlot()
  }
}

function runCapture(ref: TmuxRef, lines: number): Promise<string | null> {
  const args = ['-L', ref.socket, 'capture-pane', '-p', '-e', '-J', '-S', `-${lines}`, '-E', '-', '-t', paneTarget(ref)]
  const maxBuffer = Math.min(CAPTURE_MAX_BYTES, Math.max(CAPTURE_MIN_BYTES, lines * CAPTURE_BYTES_PER_LINE))
  return new Promise(resolve => {
    execFile('tmux', args, { encoding: 'utf8', timeout: CAPTURE_TIMEOUT_MS, maxBuffer }, (error, stdout) => {
      resolve(error ? null : stdout)
    })
  })
}

let activeCaptures = 0
const captureWaiters: (() => void)[] = []

function acquireCaptureSlot(): Promise<boolean> {
  if (activeCaptures < MAX_CONCURRENT_CAPTURES) {
    activeCaptures += 1
    return Promise.resolve(true)
  }
  // A backlog deeper than this is a runner asking for more recovery than it can
  // consume; refusing is honest, and the caller reports a failed capture.
  if (captureWaiters.length >= MAX_QUEUED_CAPTURES) return Promise.resolve(false)
  return new Promise(resolve => captureWaiters.push(() => {
    activeCaptures += 1
    resolve(true)
  }))
}

function releaseCaptureSlot() {
  activeCaptures -= 1
  captureWaiters.shift()?.()
}

export type PaneStatus = { held: boolean; dead: boolean }

// Async for the same reason capture is: this runs on a poll interval, and a
// slow tmux server must cost one late answer, never a blocked event loop.
export function paneStatus(ref: TmuxRef, seam: SpawnSeam): Promise<PaneStatus | null> {
  if (!tmuxAllowed(seam)) return Promise.resolve(null)
  return new Promise(resolve => {
    execFile('tmux', ['-L', ref.socket, 'display-message', '-p', '-t', paneTarget(ref), '#{pane_in_mode} #{pane_dead}'], { encoding: 'utf8', timeout: TMUX_TIMEOUT_MS }, (error, stdout) => {
      if (error) return resolve(null)
      const [held, dead] = stdout.trim().split(' ')
      resolve({ held: held === '1', dead: dead === '1' })
    })
  })
}

// The pane process's pid, so its actual working directory can be read back after launch and
// re-checked against the grant. A control call on an already-authorized session, gated by the
// cheap `check` like the other polls; null when the pane pid cannot be read.
export function panePid(ref: TmuxRef, seam: SpawnSeam): Promise<number | null> {
  if (!tmuxAllowed(seam)) return Promise.resolve(null)
  return new Promise(resolve => {
    execFile('tmux', ['-L', ref.socket, 'display-message', '-p', '-t', paneTarget(ref), '#{pane_pid}'], { encoding: 'utf8', timeout: TMUX_TIMEOUT_MS }, (error, stdout) => {
      if (error) return resolve(null)
      const pid = Number.parseInt(stdout.trim(), 10)
      resolve(Number.isInteger(pid) && pid > 0 ? pid : null)
    })
  })
}

// Async because it runs on the message path: repeated SCROLL_RESETs against a
// wedged server must not stall every stream and heartbeat. The result is
// honest — a failed cancel must not be reported as a released hold.
export function exitTmuxCopyMode(ref: TmuxRef, seam: SpawnSeam): Promise<boolean> {
  if (!tmuxAllowed(seam)) return Promise.resolve(false)
  return new Promise(resolve => {
    execFile('tmux', ['-L', ref.socket, 'send-keys', '-t', paneTarget(ref), '-X', 'cancel'], { timeout: TMUX_TIMEOUT_MS }, error => resolve(!error))
  })
}

type SocketWatch = {
  timer: NodeJS.Timeout
  intervalMs: number
  inFlight: boolean
  queued: boolean
  observers: Map<string, Set<PaneObserver>>
  // The seam the poll listing passes: stored here because the poll fires from a timer, detached
  // from the caller that set the watch up.
  seam: SpawnSeam
}

export type PaneObserver = (status: PaneStatus) => void

const watches = new Map<string, SocketWatch>()

// One poll per tmux server, not per session: a server with fifty sessions costs
// one `list-panes` per interval instead of fifty `display-message` processes,
// which is the difference between a poll and a fork bomb.
export function watchPane(ref: TmuxRef, intervalMs: number, observer: PaneObserver, seam: SpawnSeam): () => void {
  const watch = ensureWatch(ref.socket, intervalMs, seam)
  const observers = watch.observers.get(ref.sessionName) ?? new Set<PaneObserver>()
  observers.add(observer)
  watch.observers.set(ref.sessionName, observers)
  return () => releaseObserver(ref, observer)
}

export function paneWatcherCount() {
  return watches.size
}

function ensureWatch(socket: string, intervalMs: number, seam: SpawnSeam) {
  const existing = watches.get(socket)
  if (existing && existing.intervalMs <= intervalMs) return existing
  if (existing) clearInterval(existing.timer)
  const watch: SocketWatch = {
    intervalMs,
    inFlight: false,
    queued: false,
    observers: existing?.observers ?? new Map(),
    seam,
    timer: setInterval(() => requestPoll(socket), intervalMs),
  }
  watches.set(socket, watch)
  return watch
}

function releaseObserver(ref: TmuxRef, observer: PaneObserver) {
  const watch = watches.get(ref.socket)
  const observers = watch?.observers.get(ref.sessionName)
  if (!watch || !observers) return
  observers.delete(observer)
  if (observers.size === 0) watch.observers.delete(ref.sessionName)
  if (watch.observers.size > 0) return
  clearInterval(watch.timer)
  watches.delete(ref.socket)
  const queuedAt = pollQueue.indexOf(ref.socket)
  if (queuedAt !== -1) pollQueue.splice(queuedAt, 1)
}

let activePolls = 0
// Sockets whose tick could not get a slot, serviced FIFO as slots free. A
// socket appears at most once (its `queued` flag dedups), so this is bounded by
// the socket count and no socket can be starved by busier ones.
const pollQueue: string[] = []

function requestPoll(socket: string) {
  const watch = watches.get(socket)
  if (!watch || watch.inFlight || watch.queued) return
  if (activePolls >= MAX_CONCURRENT_POLLS) {
    watch.queued = true
    pollQueue.push(socket)
    return
  }
  void runPoll(socket)
}

function drainPollQueue() {
  while (activePolls < MAX_CONCURRENT_POLLS && pollQueue.length > 0) {
    const socket = pollQueue.shift()!
    const watch = watches.get(socket)
    if (!watch) continue
    watch.queued = false
    void runPoll(socket)
  }
}

async function runPoll(socket: string) {
  const watch = watches.get(socket)
  if (!watch) return
  activePolls += 1
  watch.inFlight = true
  // The roster is snapshotted before the listing, not after: a session that
  // registers while the listing is in flight is absent from a snapshot taken
  // before it existed, and reporting it as dead would retire a live command
  // the moment it launched.
  const watched = [...watch.observers.keys()]
  const panes = await listPanes(socket, watch.seam)
  watch.inFlight = false
  activePolls -= 1
  drainPollQueue()
  // An unanswered poll reports nothing: silence is not evidence of death.
  if (!panes) return
  for (const sessionName of watched) {
    const observers = watch.observers.get(sessionName)
    if (!observers) continue
    const status = panes.get(sessionName) ?? { held: false, dead: true }
    for (const observer of [...observers]) observer(status)
  }
}

function listPanes(socket: string, seam: SpawnSeam): Promise<Map<string, PaneStatus> | null> {
  if (!tmuxAllowed(seam)) return Promise.resolve(null)
  const args = ['-L', socket, 'list-panes', '-a', '-F', '#{session_name}\t#{pane_in_mode}\t#{pane_dead}']
  return new Promise(resolve => {
    execFile('tmux', args, { encoding: 'utf8', timeout: TMUX_TIMEOUT_MS }, (error, stdout) => {
      if (error && !answered(error)) return resolve(null)
      // Aggregated across every pane in a session: a session is held when any
      // pane is in copy mode, and dead only when they all are — a command that
      // splits its own window must not be retired by its first pane exiting.
      const panes = new Map<string, PaneStatus>()
      for (const line of stdout.split('\n').filter(Boolean)) {
        const [name, held, dead] = line.split('\t')
        if (!name) continue
        const seen = panes.get(name)
        panes.set(name, {
          held: (seen?.held ?? false) || held === '1',
          dead: (seen?.dead ?? true) && dead === '1',
        })
      }
      resolve(panes)
    })
  })
}

// Window- and pane-level commands need the `=name:` target form: a bare `=name`
// resolves as a session for has/kill/attach but fails pane lookup on tmux 3.4.
function paneTarget(ref: TmuxRef) {
  return `=${ref.sessionName}:`
}

function shortHash(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

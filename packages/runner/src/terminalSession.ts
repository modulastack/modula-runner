import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { constants as osConstants, tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as pty from 'node-pty'
import { isSafeIdentifier, isTerminalProfile, type TerminalClientMessage, type TerminalServerMessage } from '@modulastack/runner-protocol'
import {
  captureTmuxScrollback,
  exitTmuxCopyMode,
  hasTmuxSession,
  killTmuxSession,
  panePid,
  paneStatus,
  tmuxSessionPresence,
  startTmuxSession,
  watchPane,
  tmuxAttachArgs,
  tmuxSessionName,
  worktreeSocket,
  type PaneStatus,
  type TmuxRef,
} from './tmux.js'
import { processCwdReadBackAvailable, workingDirectoryOf } from './listeningSockets.js'
import type { SecretEnv } from './secretEnv.js'
import { completeDurably, type Authorization, type SpawnSeam } from './spawnSeam.js'
import type { SpawnOutcome } from './auditLog.js'

const require = createRequire(import.meta.url)

export type FlowPolicy = { highWaterBytes: number; lowWaterBytes: number; flushMs: number }

// The same watermarks the localhost terminal stack runs today.
export const DEFAULT_FLOW: FlowPolicy = { highWaterBytes: 512 * 1024, lowWaterBytes: 128 * 1024, flushMs: 12 }
export const DEFAULT_REPLAY_LINES = 200
export const DEFAULT_POLL_MS = 1_000
const OUTPUT_CHUNK_CHARS = 16 * 1024
// The same bound the localhost stack keeps per session for detached output.
const PRE_INIT_BUFFER_BYTES = 256 * 1024
// Scrollback captures are rationed by a refilling budget rather than reset per
// INIT. Resetting the allowance on every INIT let a peer mint captures by
// repeating INIT, monopolising the runner-wide capture slots; a budget bounds
// both that and the reset-provoked replay loop with one mechanism.
const REPLAY_BURST = 3
const REPLAY_REFILL_MS = 2_000
// A withheld pane EXIT whose outcome append kept failing is re-driven on this slow cadence until
// the record is durable — a burst inside `completeDurably` is bounded, but the outcome must survive
// an outage that outlasts one burst. Paced well above the burst's own retry so an audit outage
// stays a slow retry, never a tight loop.
const EXIT_OUTCOME_REDRIVE_MS = 1_000
const PANE_LANDING_POLL_MS = 25
const PANE_LANDING_READBACK_MS = 500

const EXIT_FILE_ENV = 'MODULA_RUNNER_EXIT_FILE'
// The wrapper writes the wrapped command's exit code before the tmux session can
// die: the attach client's own exit code is tmux's, never the CLI's.
const EXIT_WRAPPER = `"$0" "$@"; code=$?; printf %s "$code" > "$${EXIT_FILE_ENV}"; exit "$code"`
const SECRET_FILE_ENV = 'MODULA_RUNNER_SECRET_FILE'
// Sourced, then deleted, then checked — in that order, so the file is gone whether or not
// it could be read. A failed source abandons the launch rather than starting a CLI without
// the credential it was configured with: that failure would surface later, further away,
// and look like a provider outage instead of a missing file.
const SECRET_PRELUDE = `. "$${SECRET_FILE_ENV}"; sourced=$?; rm -f "$${SECRET_FILE_ENV}"; [ "$sourced" -eq 0 ] || exit 78; `

export type TerminalLaunchSpec = {
  command: string
  sessionId?: string
  args?: string[]
  cwd: string
  profile?: string
  // Non-secret orchestration variables. These ride tmux's `-e` arguments, which are
  // visible in the process table — fine for a session id, disqualifying for a credential.
  env?: Record<string, string>
  // Secret variables, delivered by a path that puts them in no process's argument vector.
  // FR-11: API keys are injected env-only and never through argv.
  secrets?: SecretEnv
  socket?: string
}

export type TerminalAdoptSpec = {
  sessionId?: string
  cwd: string
  command: string
  profile?: string
}

export type TerminalSessionEvents = {
  send: (message: TerminalServerMessage) => void
  onExited: () => void
}

export type SessionPolicy = {
  flow: FlowPolicy
  replayLines: number
  pollMs: number
}

// One lifecycle, one field. These states were five independent booleans, and
// every ordering defect this file has seen was an illegal combination of them
// (finished while exiting, killing while streaming, exiting after disposal).
// A phase makes those combinations unrepresentable instead of guarded.
type Phase = 'starting' | 'streaming' | 'killing' | 'exiting' | 'finished' | 'disposed'

type SessionInit = {
  id?: string
  spec: { command: string; cwd: string; profile: string }
  ref: TmuxRef
  exitDir?: string
  policy: SessionPolicy
  events: TerminalSessionEvents
  seam: SpawnSeam
  // The seam's outcome callback for the pane's logical command, whose lifetime is the session:
  // called once the session ends so the pane command's admission is answered by its outcome.
  paneComplete: (outcome: SpawnOutcome) => Promise<void>
}

const MAX_METADATA_LENGTH = 1024

function assertSessionMetadata(spec: { command: string; cwd: string; profile: string }) {
  if (!isTerminalProfile(spec.profile)) throw new Error(`profile is not a valid terminal label: ${spec.profile}`)
  for (const [field, value] of [['cwd', spec.cwd], ['command', spec.command]] as const) {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_METADATA_LENGTH) {
      throw new Error(`${field} must be a non-empty string of at most ${MAX_METADATA_LENGTH} characters`)
    }
  }
}

let nodePtyHelperPrepared = false

function ensureNodePtySpawnHelperExecutable() {
  if (nodePtyHelperPrepared || process.platform !== 'darwin') return
  const helper = path.resolve(
    path.dirname(require.resolve('node-pty')),
    '..',
    'prebuilds',
    `${process.platform}-${process.arch}`,
    'spawn-helper',
  )
  chmodSync(helper, 0o755)
  nodePtyHelperPrepared = true
}

// The secret half of a launch reaches the command through a file the wrapper sources and
// deletes before the command runs, because every other route puts the value in an argument
// vector: `tmux new-session -e KEY=value` places it in a tmux client's argv, and `ps` is
// world-readable to every user on the machine.
//
// Seeding the tmux SERVER's environment would be the obvious alternative and it is wrong.
// One server serves every pane in a worktree, so a provider key set there would be
// inherited by later panes — including a `local` pane that must never see one. The value is
// scoped to the process it was injected into and to nothing else.
//
// The file inherits the key store's custody: a private directory this process created
// (mkdtemp is 0700), exclusive creation, 0600, and a lifetime of one shell statement. It is
// plaintext for that instant, which is the trade being made — an argv exposure is durable
// and readable by every local user, this is neither, and neither defends against an
// attacker already running as this user.
function writeSecretHandoff(directory: string, secrets: SecretEnv | undefined) {
  if (!secrets || secrets.size === 0) return undefined
  assertInjectableNames(secrets)
  const target = path.join(directory, 'secret-env')
  secrets.use(entries => {
    // Single-quoted with the POSIX escape for a quote, which is total: every byte except
    // NUL survives it literally, and SecretEnv refuses a NUL at construction.
    const script = Object.entries(entries).map(([name, value]) => `export ${name}='${value.replace(/'/g, "'\\''")}'\n`).join('')
    writeFileSync(target, script, { flag: 'wx', mode: 0o600 })
  })
  return target
}

function removeHandoff(handoff: string | undefined) {
  if (!handoff) return
  try {
    rmSync(handoff, { force: true })
  } catch {
    // Already gone is the ordinary case — the wrapper deletes it the moment it sources it,
    // so a launch that got far enough to run the shell will have removed it first.
  }
}

// The wrapper reads both of these back by name *after* sourcing the hand-off — one to
// delete the hand-off, one to record the exit code — so a secret exported under either name
// changes what those reads resolve to. The hand-off would survive with plaintext in it, and
// the exit code would land on a file of the exporter's choosing, owned by the runner user.
//
// Refused rather than renamed or dropped: a launch that cannot mean what it says should not
// half-happen. The derived form can never reach this — `<PROVIDER>_API_KEY` has a fixed
// suffix — so what it guards is a hand-written catalog entry or a direct `SecretEnv.of`.
function assertInjectableNames(secrets: SecretEnv) {
  const reserved = secrets.names.filter(name => name === SECRET_FILE_ENV || name === EXIT_FILE_ENV)
  if (reserved.length > 0) throw new Error(`the launch wrapper reserves these variable names: ${reserved.join(', ')}`)
}

// Carries the session that outlived a failed launch, so the host can keep it
// on the retry list instead of losing the only handle to a running command.
export class UnkillableSessionError extends Error {
  constructor(readonly ref: TmuxRef) {
    super(`lane session survived a failed launch and could not be killed: ${ref.sessionName}`)
  }
}

// A pane that was admitted and launched, then found to have landed outside a live grant, so it
// was terminated and refused. Distinct from a failed launch: the command ran, so its admission is
// answered with a terminated outcome and the escape is audited as `path-not-granted`, not
// `spawn-failed`. A sentinel so the launch teardown records the security refusal rather than the
// generic failed-launch outcome.
class PaneLandingRefused extends Error {}

// The outcome recorded for a pane the runner terminated because it landed outside its grant. It
// ran, so `spawnFailed` would misreport it; the exact delivered signal is not observable once the
// session is killed through tmux, so the runner's forced termination is recorded as a kill.
function terminatedPaneOutcome(): SpawnOutcome {
  return { exitCode: null, signal: osConstants.signals.SIGKILL }
}

export class TerminalSession {
  readonly id: string
  readonly profile: string
  readonly cwd: string
  readonly command: string
  readonly ref: TmuxRef
  private readonly policy: SessionPolicy
  private readonly events: TerminalSessionEvents
  private readonly seam: SpawnSeam
  private readonly paneComplete: (outcome: SpawnOutcome) => Promise<void>
  private paneCompleted = false
  private exitRedrive: NodeJS.Timeout | undefined
  private readonly exitDir: string | undefined
  private attachPty: pty.IPty | undefined
  private phase: Phase = 'starting'
  private pendingBytes = 0
  private flowPaused = false
  private outputQueue: string[] = []
  private flushTimer: NodeJS.Timeout | undefined
  private cols = 80
  private rows = 24
  private unwatchPane: (() => void) | undefined
  private replayTokens = REPLAY_BURST
  private replayRefilledAt = Date.now()
  private deadPaneKillPending = false
  private scrollHeld = false
  private scrollNewOutput = false
  private replaying = false
  private replayQueued = false
  private replayBarrier = false
  private preInitBuffer: string[] = []
  private preInitBytes = 0
  private queuedBytes = 0
  private scrollResetting = false
  // Set whenever the pty is paused: a multiplexer coalesces output for a client
  // that is not reading, so a paused stretch is exactly when the viewer's live
  // stream has a hole that only scrollback can fill.
  private missedWhilePaused = false

  // Whether a viewer ever attached is orthogonal to the lifecycle: it stays true
  // through `exiting`, because a dying session still owes its viewer the tail
  // of the stream and the scrollback behind it.
  private viewerAttached = false

  // A kill that could not be confirmed: the command may still be running, so
  // this session must keep its watcher even when its channel goes away.
  private killUnconfirmed = false

  private get streaming() {
    return this.viewerAttached
  }

  private get exitPending() {
    return this.phase === 'exiting'
  }

  private get killPending() {
    return this.phase === 'killing'
  }

  private get finished() {
    return this.phase === 'finished' || this.phase === 'disposed'
  }

  private get disposed() {
    return this.phase === 'disposed'
  }

  private get live() {
    return this.phase === 'starting' || this.phase === 'streaming' || this.phase === 'killing'
  }

  static async launch(spec: TerminalLaunchSpec, policy: SessionPolicy, events: TerminalSessionEvents, seam: SpawnSeam) {
    // Validated before anything runs: a launch this runner would reject must
    // not leave the command's side effects behind on its way to being refused.
    const normalized = { command: spec.command, cwd: spec.cwd, profile: spec.profile ?? 'shell' }
    assertSessionMetadata(normalized)
    const id = spec.sessionId ?? randomUUID()
    if (!isSafeIdentifier(id)) throw new Error('sessionId must be a safe identifier')
    // Checked here as well as where the file is written, so a refused launch leaves no temp
    // directory and spawns no tmux call on its way out.
    if (spec.secrets) assertInjectableNames(spec.secrets)
    // The pane's LOGICAL command is the allowlisted unit, gated before any tmux runs: allowing
    // the tmux wrapper must never implicitly allow an arbitrary command inside it. A refused
    // command throws before a temp directory or a tmux session exists, and the refusal is
    // audited like every other runner-owned spawn.
    const authorized = await seam.authorize({ kind: 'pane', executable: spec.command, cwd: spec.cwd, grantScoped: true })
    if (authorized.status === 'refused') throw new Error(`command is not on the runner allowlist: ${spec.command}`)
    const paneComplete = authorized.authorization.complete
    // The command launches in the RESOLVED real directory the seam authorized, not the caller's
    // pathname: a symlink swapped between the grant check and the tmux call would otherwise run an
    // allowlisted command outside the grant.
    const vettedCwd = authorized.authorization.vetted.cwd
    const exitDir = mkdtempSync(path.join(tmpdir(), 'modula-runner-'))
    const ref = { socket: spec.socket ?? worktreeSocket(spec.cwd), sessionName: tmuxSessionName(spec.cwd, id) }
    // A half-launched session is torn down whole: a failed attach must not
    // leave a command running unobserved or a temp directory behind.
    let handoff: string | undefined
    try {
      handoff = writeSecretHandoff(exitDir, spec.secrets)
      await startTmuxSession({
        ...ref,
        cwd: vettedCwd,
        file: '/bin/sh',
        // The seam gates and audits the session's creation — the one tmux call that launches
        // the pane's command.
        args: ['-c', handoff ? `${SECRET_PRELUDE}${EXIT_WRAPPER}` : EXIT_WRAPPER, spec.command, ...(spec.args ?? [])],
        // Only the PATH of the handoff rides tmux's `-e` arguments, never its contents: a
        // path is not a credential, and this one names a file no other user can open.
        //
        // The order is load-bearing: the runner's own two variables are written after the
        // caller's, so `env` cannot redirect the wrapper's reads the way a secret under a
        // reserved name would. A test pins it, because reversing a spread is an easy edit.
        env: { ...spec.env, [EXIT_FILE_ENV]: path.join(exitDir, 'exit-code'), ...(handoff ? { [SECRET_FILE_ENV]: handoff } : {}) },
      }, seam)
      // Launching in the resolved real directory closes the check-to-spawn window; the pane is
      // now read back to close what remains — the resolved path can be renamed or replaced, or
      // its inode moved, between the tmux call and the pane entering it. Where the pane actually
      // landed is re-checked against the same live grant the admission used, before it is ever
      // reported ready.
      if (!(await TerminalSession.paneLandedInsideGrant(ref, authorized.authorization, seam))) throw new PaneLandingRefused()
      const session = new TerminalSession({ id, spec: normalized, ref, exitDir, policy, events, seam, paneComplete })
      session.attach()
      return session
    } catch (error) {
      // A pane caught outside its grant is a live process running where it was never authorized,
      // so it is killed FIRST — before its outcome is recorded — because the teardown must not be
      // gated on an audit log that may be down; then its admission is answered with a terminated
      // outcome and the escape is audited as path-not-granted, the same shape a preview refused by
      // its own read-back records. The credential is cleared first either way.
      if (error instanceof PaneLandingRefused) {
        removeHandoff(handoff)
        const killed = (await killTmuxSession(ref, seam)) || (await killTmuxSession(ref, seam))
        if (!killed) throw new UnkillableSessionError(ref)
        try {
          rmSync(exitDir, { recursive: true, force: true })
        } catch {}
        let durable = await completeDurably(paneComplete, terminatedPaneOutcome())
        await seam.recordRefusal({ kind: 'pane', executable: spec.command, cwd: vettedCwd, grantScoped: true }, 'path-not-granted')
        // AS-21: the rejection is withheld until the terminated outcome is durable, re-driven on a
        // slow cadence (unref'd) so a transient audit outage does not strand the launch — it rejects
        // once the record lands, resuming when the log recovers rather than hanging forever.
        while (!durable) {
          await new Promise<void>(resolve => { const t = setTimeout(resolve, EXIT_OUTCOME_REDRIVE_MS); t.unref?.() })
          durable = await completeDurably(paneComplete, terminatedPaneOutcome())
        }
        throw new Error(`command landed outside a granted directory: ${spec.command}`)
      }
      // The pane command was admitted but its session could not be brought up, so its admission
      // is answered as a spawn that did not take — retried through a transient audit failure.
      let durable = await completeDurably(paneComplete, { spawnFailed: true })
      // The credential goes first, before anything that can throw on the way out. An
      // unconfirmed kill leaves by a path that skips the cleanup below, and that is exactly
      // the case where a plaintext hand-off would be left on disk — the moment the promise
      // that it lives for one shell statement matters most.
      //
      // The exit file's reasoning does not extend to it: that one is kept because a live
      // command still writes to it. This is write-once and read-once, deleted by the wrapper
      // itself, and if a session did start without sourcing it yet, removing it makes the
      // wrapper exit 78 — a session we are already abandoning fails to start, which is the
      // outcome being asked for. Failing closed on a credential beats preserving a file for
      // a launch that is being given up on.
      removeHandoff(handoff)
      // A session that cannot be confirmed dead keeps its tmux session and its
      // exit file: deleting state a live command still writes to, and reporting
      // the original failure alone, would hide a running process nobody owns.
      const killed = (await killTmuxSession(ref, seam)) || (await killTmuxSession(ref, seam))
      if (!killed) throw new UnkillableSessionError(ref)
      try {
        rmSync(exitDir, { recursive: true, force: true })
      } catch {}
      // AS-21: the rejection is the acknowledgment, and a caller never sees the launch fail before
      // the record of why is durable. The rejection is withheld until the outcome is durable,
      // re-driven on a slow cadence (unref'd) so a transient audit outage does not strand the launch
      // — it resumes when the log recovers rather than hanging on a promise that never settles; the
      // audit writer's onFailure marks a persistent outage.
      while (!durable) {
        await new Promise<void>(resolve => { const t = setTimeout(resolve, EXIT_OUTCOME_REDRIVE_MS); t.unref?.() })
        durable = await completeDurably(paneComplete, { spawnFailed: true })
      }
      throw error
    }
  }

  // The pane's actual working directory, read back after launch and re-checked against the same
  // live grant the admission used. True when the pane is inside a live grant — or when the platform
  // exposes no process cwd at all, the documented residual where confinement rests on the
  // resolved-path spawn alone. False when a platform that CAN answer proves the pane landed outside
  // its grant, or cannot rule it out while the pane is still alive: unknown-while-alive fails closed
  // rather than stand in for granted. A pane that has already ended leaves nothing running to
  // contain, so an unreadable pid/cwd there is the documented fast-exit residual, not a refusal —
  // the seam contract records it, and a reliable pre-command cwd capture that would close it is
  // tracked in #16.
  private static async paneLandedInsideGrant(ref: TmuxRef, authorization: Authorization, seam: SpawnSeam): Promise<boolean> {
    const verifyLanding = authorization.verifyLanding
    if (!verifyLanding) return true
    if (!processCwdReadBackAvailable()) return true
    const deadline = Date.now() + PANE_LANDING_READBACK_MS
    do {
      if (await TerminalSession.paneAlreadyEnded(ref, seam)) return true
      const pid = await panePid(ref, seam)
      if (pid === null) return await TerminalSession.paneAlreadyEnded(ref, seam)
      const actual = await workingDirectoryOf(pid)
      if (actual !== null) return await verifyLanding(actual)
      await new Promise(resolve => setTimeout(resolve, PANE_LANDING_POLL_MS))
    } while (Date.now() < deadline)
    return await TerminalSession.paneAlreadyEnded(ref, seam)
  }

  // Only an ended pane makes an unreadable cwd harmless: a live pane whose directory cannot be read
  // is exactly the unknown the read-back must not wave through, so an unanswerable status fails
  // closed too.
  private static async paneAlreadyEnded(ref: TmuxRef, seam: SpawnSeam): Promise<boolean> {
    const status = await paneStatus(ref, seam)
    return status === null ? false : status.dead
  }

  // Reattach to a tmux session that outlived its host process. The original exit
  // file is gone with the old host, so an adopted session reports a null exit code.
  static async adopt(ref: TmuxRef, spec: TerminalAdoptSpec, policy: SessionPolicy, events: TerminalSessionEvents, seam: SpawnSeam) {
    const normalized = { command: spec.command, cwd: spec.cwd, profile: spec.profile ?? 'shell' }
    assertSessionMetadata(normalized)
    if (spec.sessionId !== undefined && !isSafeIdentifier(spec.sessionId)) throw new Error('sessionId must be a safe identifier')
    if (!(await hasTmuxSession(ref, seam))) throw new Error(`no tmux session to adopt: ${ref.sessionName}`)
    // A reattach spawns no command — the pane's command ran under the original launch that
    // gated it — so there is no fresh admission to answer here.
    const session = new TerminalSession({
      ...(spec.sessionId ? { id: spec.sessionId } : {}),
      spec: normalized,
      ref,
      policy,
      events,
      seam,
      paneComplete: async () => undefined,
    })
    session.attach()
    return session
  }

  private constructor(init: SessionInit) {
    // Metadata is checked against the wire's own rules at construction: a READY
    // the peer's validator would drop leaves a viewer waiting forever.
    assertSessionMetadata(init.spec)
    this.id = init.id ?? randomUUID()
    this.command = init.spec.command
    this.cwd = init.spec.cwd
    this.profile = init.spec.profile
    this.ref = init.ref
    this.exitDir = init.exitDir
    this.policy = init.policy
    this.events = init.events
    this.seam = init.seam
    this.paneComplete = init.paneComplete
  }

  isFinished() {
    return this.finished
  }

  // True while a kill is in flight or after one that could not be confirmed:
  // the command may still be running, so something must keep watching it.
  needsSupervision() {
    return !this.disposed && (this.killPending || this.killUnconfirmed)
  }

  handle(message: TerminalClientMessage) {
    // Acknowledgments outlive streaming: a session waiting to emit EXIT is
    // still draining its tail, and that drain runs on ACKs.
    if (message.type === 'ACK') return this.handleAck(message.bytes)
    // A kill has been asked for and is in flight: nothing may reach the command
    // in the window before it dies, least of all input the operator is trying
    // to stop.
    if (this.killPending) {
      if (message.type === 'KILL') return
      return this.events.send({ type: 'ERROR', message: 'session kill is pending' })
    }
    if (message.type === 'INIT') return this.handleInit(message)
    if (this.finished || this.exitPending) {
      // Killing a session that is already dying discards the undelivered tail
      // deliberately — the operator asked for the end, not for the bytes.
      if (message.type === 'KILL') return this.completeExit(true)
      return this.events.send({ type: 'ERROR', message: 'session already exited' })
    }
    // KILL answers to the operator, not to the viewer lifecycle: a command
    // launched before anyone attached must still be stoppable.
    if (message.type === 'KILL') return this.kill()
    if (!this.streaming) return this.events.send({ type: 'ERROR', message: 'session not initialized' })
    if (message.type === 'INPUT') return this.ptyCall(proc => proc.write(message.data))
    if (message.type === 'RESIZE') return this.resize(message.cols, message.rows)
    this.resetScroll()
  }

  // One kill at a time: a burst of KILL frames must cost one tmux call, not one
  // per frame.
  kill() {
    if (!this.live || this.killPending) return
    const resume = this.phase
    this.phase = 'killing'
    void killTmuxSession(this.ref, this.seam).then(killed => {
      if (this.disposed) return
      this.killUnconfirmed = !killed
      if (!killed) {
        // The command is still running: hand the session back to the phase the
        // kill interrupted rather than stranding it, and keep watching it.
        if (this.phase === 'killing') this.phase = resume
        return this.events.send({ type: 'ERROR', message: 'failed to kill session' })
      }
      // Confirmed dead: stay in 'killing' so no INIT or INPUT is accepted for a
      // corpse — restoring 'streaming' here would send READY for a dead
      // attachment. If nothing is attached, drive the exit now; otherwise the
      // attach client's own exit (its session is gone) carries us there.
      if (!this.attachPty) this.beginExit()
    })
  }

  // Continuity loss was announced (a reset in either direction): un-acknowledged
  // bytes may be gone along with the acknowledgments for them, so the window
  // restarts at zero instead of leaking permanently shut.
  recoverWindow() {
    this.pendingBytes = 0
    this.applyBackpressure()
    this.drainRetained()
    this.completeExit()
  }

  // A reset raised *by* a replay is the replay outrunning the channel's replay
  // budget: replaying again would reset again, forever. The loss stays
  // announced by the reset, and a viewer that wants the scrollback asks for it
  // with a fresh INIT.
  replayAfterReset() {
    this.pendingBytes = 0
    this.applyBackpressure()
    // The barrier goes up before any drain or exit: recovered history must
    // reach the viewer ahead of newer bytes, and an EXIT here would tear the
    // pane down with the scrollback still uncaptured.
    // Bounded per INIT epoch: a replay that keeps outrunning the replay budget
    // provokes the very reset that would restart it, and the loop converges
    // only if the runner stops answering.
    const replayable = this.streaming && !this.replaying && !this.replayBarrier && this.takeReplayToken()
    if (replayable) return this.replay()
    this.drainRetained()
    this.completeExit()
  }

  // Returns false when a requested kill could not be confirmed: the session
  // then keeps its poller and attachment, because tearing them down would
  // leave the command running with nothing watching it.
  async dispose(killSession: boolean): Promise<boolean> {
    // The phase advertises the in-flight kill for the whole await: without it,
    // a channel closing mid-kill sees a session that needs no supervision and
    // disposes the watcher off a command that may still be running.
    const previous = this.phase
    if (killSession) {
      this.phase = 'killing'
      if (!(await killTmuxSession(this.ref, this.seam))) {
        this.killUnconfirmed = true
        if (this.phase === 'killing') this.phase = previous
        return false
      }
    }
    this.killUnconfirmed = false
    this.phase = 'disposed'
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    // The withheld-EXIT re-drive stops with disposal: a fatal audit outage stays withheld rather
    // than resuming after the session is gone, the same posture the audit writer's onFailure marks.
    if (this.exitRedrive) clearTimeout(this.exitRedrive)
    this.exitRedrive = undefined
    this.stopPoll()
    // The reference is dropped before the kill so a throwing attachment cannot
    // strand cleanup behind it, or reject out of a shutdown that then never
    // reopens the host.
    const proc = this.attachPty
    this.attachPty = undefined
    try {
      proc?.kill()
    } catch {}
    this.removeExitDir()
    return true
  }

  private handleInit(message: { cols: number; rows: number; profile?: string }) {
    if (message.profile !== undefined && message.profile !== this.profile) {
      return this.events.send({ type: 'ERROR', message: 'profile does not match the bound session' })
    }
    if (this.finished || this.exitPending) return this.events.send({ type: 'ERROR', message: 'session already exited' })
    if (!this.attachPty) {
      try {
        this.attach()
      } catch {}
    }
    const attached = this.attachPty
    if (!attached) return this.events.send({ type: 'ERROR', message: 'session is not attachable' })
    this.resize(message.cols, message.rows)
    this.phase = 'streaming'
    this.viewerAttached = true
    // The window survives re-INIT on purpose: acknowledgment debt belongs to
    // the channel peer, which outlives viewer attach cycles, so a repeated INIT
    // cannot bypass flow control — only announced continuity loss resets it.
    this.events.send({ type: 'READY', sessionId: this.id, profile: this.profile, cwd: this.cwd, shell: this.command, pid: attached.pid })
    this.requestReplay()
  }

  private attach() {
    // Attaching a viewer spawns a tmux client, so it passes the same gate. In the normal flow
    // the session's creation already cleared it; this keeps the "every tmux invocation passes
    // the seam" rule true even if a policy changed between create and attach.
    if (!this.seam.check('tmux')) return
    ensureNodePtySpawnHelperExecutable()
    const proc = pty.spawn('tmux', tmuxAttachArgs(this.ref), {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
    })
    this.attachPty = proc
    let trimInitialPaint = this.viewerAttached
    // Callbacks answer only for the process that owns the attachment: a stale
    // client losing a race must not feed or retire the live one.
    proc.onData(data => {
      if (this.attachPty !== proc) return
      if (trimInitialPaint) {
        trimInitialPaint = false
        return
      }
      this.queueOutput(data)
    })
    proc.onExit(() => {
      if (this.attachPty === proc) this.handleAttachExit()
    })
    this.startPoll()
  }

  private handleAttachExit() {
    this.attachPty = undefined
    // Nothing is left to read from a gone attachment, so held-back output can
    // no longer arrive: the window stops gating the exit.
    this.flowPaused = false
    if (this.disposed || this.finished) return
    if (this.exitPending) return this.completeExit()
    void tmuxSessionPresence(this.ref, this.seam).then(presence => {
      if (this.disposed || this.finished || this.exitPending) return
      // An INIT may have re-attached while the question was in flight; a second
      // client would duplicate every byte the first one delivers.
      if (this.attachPty) return
      if (presence === 'present') {
        // The attach client died but the session lives: reattach immediately,
        // so exit monitoring never lapses while nobody watches across the seam.
        try {
          this.attach()
        } catch {
          this.events.send({ type: 'ERROR', message: 'lost attachment to a live session' })
        }
        return
      }
      // Only a confirmed absence retires the session; an unanswered question
      // leaves it to the pane watcher rather than fabricating an exit.
      if (presence === 'absent') this.beginExit()
    })
  }

  private beginExit() {
    if (!this.live) return
    this.phase = 'exiting'
    this.deadPaneKillPending = true
    this.stopPoll()
    // A capture already in flight owns the ordering from here: its completion
    // drains and completes the exit, so nothing may be emitted ahead of the
    // snapshot it is about to deliver.
    if (this.replaying || this.replayBarrier) return
    // Recovery goes first: flushOutput ends by completing the exit, and a queue
    // that drains there would finalize the session and abort the replay below,
    // losing the scrollback a paused viewer never saw. Output a paused viewer
    // missed lives solely in tmux history; a stream never paused already
    // delivered everything, so it needs no replay.
    if (this.streaming && this.missedWhilePaused && this.takeReplayToken()) return this.replay()
    this.flushOutput()
    this.completeExit()
  }

  // EXIT is the sequenced end-of-stream, so it may not overtake output the flow
  // window is still holding — neither bytes queued here nor bytes still unread
  // in a paused pty. It waits for both, driven by ACKs; a KILL forces it out
  // and discards the undelivered tail deliberately.
  private completeExit(force = false) {
    if (this.phase !== 'exiting') return
    if (!force && (this.outputQueue.length > 0 || this.flowPaused || this.replaying || this.replayBarrier)) return
    if (force) {
      // A forced exit abandons the undelivered tail deliberately — a KILL asked
      // for the end, not the bytes — and clears it so no later ACK can drain
      // OUTPUT out after the sequenced end-of-stream.
      if (this.flushTimer) clearTimeout(this.flushTimer)
      this.flushTimer = undefined
      this.outputQueue = []
      this.queuedBytes = 0
      this.preInitBuffer = []
      this.preInitBytes = 0
      this.flowPaused = false
    }
    this.phase = 'finished'
    this.stopPoll()
    // The ring is emitted exactly once, here: every exit path passes through
    // this point, and it clears itself once delivered.
    this.emitPreInitTail()
    // The sequenced EXIT is the operation's acknowledgment, and the pane command's outcome
    // record must be durable before it goes out: a viewer must not learn the pane ended before
    // the runner's own log of how. The synchronous state above is settled first so a re-entrant
    // completeExit returns early while this tail runs.
    void this.emitExit(this.readExit())
  }

  private async emitExit(exit: { exitCode: number | null; signal: number | null }) {
    // The pane command's admission is answered by the session's own end-of-life, since the
    // command's lifetime is the session's. Once, because every exit path lands here.
    if (!this.paneCompleted) {
      const outcome: SpawnOutcome = exit.exitCode !== null ? { exitCode: exit.exitCode, signal: null } : exit.signal !== null ? { exitCode: null, signal: exit.signal } : { spawnFailed: true }
      // AS-21: the sequenced EXIT is the acknowledgment, and it must not be sent before the pane's
      // outcome record is durable. A burst inside `completeDurably` just failed, so the EXIT is
      // withheld and re-driven on a slow cadence until the append recovers — then the outcome
      // records and the tail below runs. A persistent outage is surfaced by the audit writer's
      // onFailure and never emits EXIT; disposal stops the re-drive.
      if (!(await completeDurably(this.paneComplete, outcome))) return this.scheduleExitRedrive(exit)
      this.paneCompleted = true
    }
    if (this.exitRedrive) {
      clearTimeout(this.exitRedrive)
      this.exitRedrive = undefined
    }
    this.events.send({ type: 'EXIT', ...exit })
    // The end-of-stream is out and the scrollback has been replayed: the dead
    // pane kept alive to carry it can go now.
    if (this.deadPaneKillPending) {
      this.deadPaneKillPending = false
      void killTmuxSession(this.ref, this.seam)
    }
    this.removeExitDir()
    this.events.onExited()
  }

  // Keeps a withheld EXIT scheduled: one timer re-entering emitExit on a slow cadence, so a log
  // that recovers after more than one burst records the outcome and releases the EXIT, its cleanup,
  // and onExited. Not scheduled once disposed — the machinery stops there and the withheld EXIT
  // stays withheld rather than becoming an acknowledgment with no durable outcome behind it.
  private scheduleExitRedrive(exit: { exitCode: number | null; signal: number | null }) {
    if (this.disposed) return
    if (this.exitRedrive) return
    this.exitRedrive = setTimeout(() => {
      this.exitRedrive = undefined
      void this.emitExit(exit)
    }, EXIT_OUTCOME_REDRIVE_MS)
    this.exitRedrive.unref?.()
  }

  // A foreground command killed by signal N reports `$? = 128 + N`, which is the
  // only signal information a `$?`-based exit capture preserves: an explicit
  // exit code above 128 is conventionally indistinguishable from a signal, the
  // same ambiguity every shell carries. Exactly one field is populated.
  private readExit(): { exitCode: number | null; signal: number | null } {
    const raw = this.readRawExit()
    if (raw === null) return { exitCode: null, signal: null }
    if (raw > 128 && raw <= 128 + 64) return { exitCode: null, signal: raw - 128 }
    return { exitCode: raw, signal: null }
  }

  private readRawExit(): number | null {
    if (!this.exitDir) return null
    try {
      const raw = readFileSync(path.join(this.exitDir, 'exit-code'), 'utf8').trim()
      const code = Number(raw)
      return Number.isInteger(code) && code >= 0 ? code : null
    } catch {
      return null
    }
  }

  private removeExitDir() {
    if (!this.exitDir) return
    try {
      rmSync(this.exitDir, { recursive: true, force: true })
    } catch {}
  }

  private queueOutput(data: string) {
    if (this.finished) return
    // Until a viewer attaches, tmux history holds the scrollback — but a ring
    // survives the session too, because a command can die before any viewer
    // attaches and take its history with it.
    if (!this.streaming) return this.retainPreInit(data)
    this.outputQueue.push(data)
    this.queuedBytes += Buffer.byteLength(data)
    // Queued bytes count against the same bound as unacknowledged ones: while a
    // replay barrier or a closed window holds output back, the pty pauses
    // instead of letting the queue grow without limit.
    this.applyBackpressure()
    if (!this.replayBarrier) this.flushTimer ??= setTimeout(() => this.flushOutput(), this.policy.flow.flushMs)
  }

  private applyBackpressure() {
    const { highWaterBytes, lowWaterBytes } = this.policy.flow
    if (this.pendingBytes >= highWaterBytes || this.queuedBytes >= highWaterBytes) {
      if (this.flowPaused) return
      this.flowPaused = true
      this.missedWhilePaused = true
      return this.ptyCall(proc => proc.pause())
    }
    if (this.pendingBytes < lowWaterBytes && this.queuedBytes < lowWaterBytes) this.resumeFlow()
  }

  private retainPreInit(data: string) {
    this.preInitBuffer.push(data)
    this.preInitBytes += Buffer.byteLength(data)
    while (this.preInitBytes > PRE_INIT_BUFFER_BYTES && this.preInitBuffer.length > 1) {
      this.preInitBytes -= Buffer.byteLength(this.preInitBuffer.shift() ?? '')
    }
  }

  // Live output ships in the same bounded chunks as replay, and only while the
  // window is open: the remainder stays queued, so one fast burst can neither
  // assemble a frame past the wire cap nor blow past the watermark into the
  // replay buffer.
  private flushOutput() {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    if (this.replayBarrier || !this.streaming || this.finished) return
    const data = this.outputQueue.join('')
    this.outputQueue = []
    this.queuedBytes = 0
    if (!data) return
    let offset = 0
    while (offset < data.length && this.pendingBytes < this.policy.flow.highWaterBytes) {
      const chunk = data.slice(offset, offset + OUTPUT_CHUNK_CHARS)
      this.events.send({ type: 'OUTPUT', data: chunk })
      this.pendingBytes += Buffer.byteLength(chunk)
      offset += chunk.length
    }
    if (offset < data.length) {
      const tail = data.slice(offset)
      this.outputQueue.unshift(tail)
      this.queuedBytes += Buffer.byteLength(tail)
    }
    this.applyBackpressure()
    this.noteOutputWhileHeld()
    this.completeExit()
  }

  private handleAck(bytes: number) {
    if (!this.streaming && !this.exitPending) return this.events.send({ type: 'ERROR', message: 'session not initialized' })
    this.acknowledge(bytes)
  }

  private acknowledge(bytes: number) {
    // Replayed bytes are not charged to the window, so acknowledging them —
    // which the schema forbids — would credit debt the live stream never
    // incurred. Clamping hides that; saying so does not.
    if (bytes > this.pendingBytes) {
      // Reported *and refused*: crediting it anyway would let a peer open the
      // window at will by acknowledging output it never received.
      this.events.send({ type: 'ERROR', message: 'acknowledgment exceeds outstanding live output' })
      return
    }
    this.pendingBytes -= bytes
    this.applyBackpressure()
    this.drainRetained()
    this.completeExit()
  }

  private drainRetained() {
    if (this.finished) return
    if (this.outputQueue.length && !this.flushTimer && !this.replayBarrier) this.flushOutput()
  }

  private resumeFlow() {
    if (!this.flowPaused) return
    this.flowPaused = false
    this.ptyCall(proc => proc.resume())
  }

  private resize(cols: number, rows: number) {
    this.cols = cols
    this.rows = rows
    this.ptyCall(proc => proc.resize(cols, rows))
  }

  // Replay ships in bounded chunks: a single frame holding a whole scrollback
  // could exceed a small replay budget and be evicted before it ever flushed.
  // Capture is asynchronous, so a slow tmux delays this replay and nothing else,
  // and requests coalesce — one capture in flight, at most one queued — so a
  // peer repeating INIT cannot multiply tmux processes.
  // Live output waits behind a barrier while the capture runs, so a viewer
  // always renders the snapshot first and the live stream after it.
  // The INIT path: a viewer asking for scrollback gets it, or is told the
  // request was rationed rather than silently receiving nothing.
  private requestReplay() {
    if (this.takeReplayToken()) return this.replay()
    this.events.send({ type: 'ERROR', message: 'scrollback replay rate limited' })
  }

  private takeReplayToken() {
    const now = Date.now()
    const refill = Math.floor((now - this.replayRefilledAt) / REPLAY_REFILL_MS)
    if (refill > 0) {
      this.replayTokens = Math.min(REPLAY_BURST, this.replayTokens + refill)
      this.replayRefilledAt = now
    }
    if (this.replayTokens < 1) return false
    this.replayTokens -= 1
    return true
  }

  private replay() {
    const supersedeQueued = !this.replayBarrier
    this.replayBarrier = true
    if (this.replaying) {
      this.replayQueued = true
      return
    }
    this.replaying = true
    // Output already queued is, by construction, part of the snapshot the
    // capture is about to take — the snapshot happens later — so it is set
    // aside rather than re-sent after it. A capture that fails hands it back:
    // duplication is cosmetic, loss is not.
    const superseded = supersedeQueued ? this.outputQueue : []
    if (supersedeQueued) {
      this.outputQueue = []
      this.queuedBytes = 0
    }
    void captureTmuxScrollback(this.ref, this.policy.replayLines, this.seam, () => !this.disposed && !this.finished)
      .then(data => this.emitReplay(data, superseded))
      .then(() => {
        this.replaying = false
        if (this.disposed || this.finished) return
        if (this.replayQueued) {
          this.replayQueued = false
          this.replay()
          return
        }
        this.replayBarrier = false
        this.drainRetained()
        this.completeExit()
      })
  }

  // Chunks are paced across ticks: a large capture would otherwise record and
  // send thousands of frames in one turn, evicting its own replay buffer and
  // holding the loop that every other session's heartbeat shares.
  private async emitReplay(data: string | null, superseded: string[]) {
    if (this.disposed || this.finished || !this.streaming) return this.restoreSuperseded(superseded)
    if (data === null) {
      this.restoreSuperseded(superseded)
      return this.events.send({ type: 'ERROR', message: 'scrollback capture failed' })
    }
    for (let offset = 0; offset < data.length; offset += OUTPUT_CHUNK_CHARS) {
      if (this.disposed || this.finished || !this.streaming) return
      this.events.send({ type: 'OUTPUT', data: data.slice(offset, offset + OUTPUT_CHUNK_CHARS), replay: true })
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    // Only a capture that actually reached the viewer supersedes the ring:
    // a failed capture, or an exit that wins the race, still has it.
    this.preInitBuffer = []
    this.preInitBytes = 0
    this.missedWhilePaused = false
  }

  private restoreSuperseded(superseded: string[]) {
    if (superseded.length === 0) return
    this.outputQueue.unshift(...superseded)
    this.queuedBytes += superseded.reduce((total, chunk) => total + Buffer.byteLength(chunk), 0)
  }

  private emitPreInitTail() {
    // The ring is the only witness to output whose tmux history died with the
    // session — whether no viewer ever attached, or the capture that would
    // have replaced it failed or lost the race with the exit.
    if (this.preInitBuffer.length === 0) return
    const data = this.preInitBuffer.join('')
    this.preInitBuffer = []
    this.preInitBytes = 0
    for (let offset = 0; offset < data.length; offset += OUTPUT_CHUNK_CHARS) {
      this.events.send({ type: 'OUTPUT', data: data.slice(offset, offset + OUTPUT_CHUNK_CHARS), replay: true })
    }
  }

  // Async because it runs on the message path, and suppressed while in flight:
  // repeated resets against a wedged tmux must cost one late answer, not a
  // process per message.
  private resetScroll() {
    if (this.scrollResetting) return
    this.scrollResetting = true
    void exitTmuxCopyMode(this.ref, this.seam).then(ok => {
      this.scrollResetting = false
      if (this.disposed) return
      if (!ok) return this.events.send({ type: 'ERROR', message: 'scroll reset failed' })
      this.scrollHeld = false
      this.scrollNewOutput = false
      this.events.send({ type: 'SCROLL_STATE', held: false, newOutput: false })
    })
  }

  // The pane is watched from attach onward through the shared per-server
  // watcher: it reports copy-mode transitions and output arriving while held,
  // and it is how a dead pane — kept by remain-on-exit — turns into EXIT,
  // however fast the command died.
  private startPoll() {
    this.unwatchPane ??= watchPane(this.ref, this.policy.pollMs, status => this.observePane(status), this.seam)
  }

  private stopPoll() {
    this.unwatchPane?.()
    this.unwatchPane = undefined
  }

  private observePane(status: PaneStatus) {
    if (this.disposed || this.finished) return
    if (status.dead) return this.beginExit()
    // A presence check that went unanswered leaves the session attached to
    // nothing; the watcher is what notices the pane is in fact alive.
    if (!this.attachPty && !this.exitPending) {
      try {
        this.attach()
      } catch {
        this.events.send({ type: 'ERROR', message: 'lost attachment to a live session' })
        return
      }
    }
    if (!this.streaming || status.held === this.scrollHeld) return
    this.scrollHeld = status.held
    if (!status.held) this.scrollNewOutput = false
    this.events.send({ type: 'SCROLL_STATE', held: status.held, newOutput: this.scrollNewOutput })
  }

  private noteOutputWhileHeld() {
    if (!this.scrollHeld || this.scrollNewOutput) return
    this.scrollNewOutput = true
    this.events.send({ type: 'SCROLL_STATE', held: true, newOutput: true })
  }

  // A failed write or resize means this attachment is gone: kill it and take
  // the ordinary exit path, so presence is checked and a live session gets a
  // fresh client instead of being left permanently detached.
  private ptyCall(operation: (proc: pty.IPty) => void) {
    const proc = this.attachPty
    if (!proc) return
    try {
      operation(proc)
    } catch {
      try {
        proc.kill()
      } catch {}
      if (this.attachPty === proc) this.handleAttachExit()
    }
  }
}

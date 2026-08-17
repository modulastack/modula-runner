import { type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { constants as osConstants } from 'node:os'
import path from 'node:path'
import { hasControlCharacter, type RefusalReason } from '@modulastack/runner-protocol'
import type { PreviewRecipe } from './allowlist.js'
import type { SpawnOutcome } from './auditLog.js'
import { namespaceHasListener, networkNamespaceOf, passthroughContainment, type PreviewContainment } from './previewContainment.js'
import { completeDurably, type ConsentPolicy, type SpawnSeam, type VettedSpawn } from './spawnSeam.js'
import { descendantsOf, descendantsOfMany, isLoopbackAddress, listeningSocketsFor, listeningSocketsForMany, processGroups, processStartTimes, workingDirectoryOf, type ListeningSocket } from './listeningSockets.js'

// Preview servers and browser-QA targets run beside the operator's browser, so the port is
// the whole story: nothing is tunnelled and no endpoint crosses the seam.
//
// The port is discovered, not dictated. A preview command picks its own port — that is
// what dev servers do — and the contract says the runner reports the port, so assigning
// one and assuming obedience would report a number nothing is listening on.
//
// Loopback binding is verified after start, never inferred from the command. A command is
// free to bind every interface regardless of what it was told, so checking the shape of a
// configured string proves nothing about the socket that actually exists. A preview
// listening on any non-loopback address is killed and refused rather than reported ready.

const DEFAULT_READY_TIMEOUT_MS = 30_000
const READY_POLL_MS = 50
const MAX_READY_POLL_MS = 500
const STABLE_FOR_MS = 600
const WATCH_INTERVAL_MS = 2_000
const TERMINATION_ATTEMPTS = 5
const TERMINATION_POLL_MS = 100
const DEFAULT_MAX_PREVIEWS = 16
// How long a containment that claims a network namespace is given to actually move the preview
// into one before it is judged not to have — after which the host-visible readiness path governs.
const CONTAINMENT_ISOLATION_MS = 2_000
const SHUTDOWN_PASSES = 5
const BLIND_SWEEPS_ALLOWED = 3
// A withheld exit whose outcome append kept failing is re-driven on this slow cadence until it is
// durable — a burst inside `completeDurably` is bounded, but the outcome must survive an outage
// that outlasts one burst. Paced well above the burst's own retry so an audit outage stays a slow
// retry, never a tight loop; shutdown stops the machinery, and the exit is never emitted until the
// outcome is durable.
const EXIT_OUTCOME_REDRIVE_MS = 1_000

export type PreviewSpec = {
  previewId: string
  recipe: string
  cwd: string
}

// A recipe is the whole command line, held locally. The control plane names one; it never
// supplies one. Allowlisting an executable while accepting its arguments from the wire is
// not an allowlist at all — `node` plus a caller-controlled argv is arbitrary execution
// under the runner user, and no argument blocklist survives contact with an interpreter. The
// type lives with the signed allowlist (`allowlist.ts`), because a recipe is one entry of it.

export type PreviewAllowlist = {
  recipes: Readonly<Record<string, PreviewRecipe>>
  grantedPaths: readonly string[]
}

export type PreviewRecord = {
  previewId: string
  port: number
  pid: number
}

export type PreviewOutcome =
  | { status: 'ready'; record: PreviewRecord }
  | { status: 'refused'; reason: RefusalReason }

export type PreviewExit = {
  previewId: string
  exitCode: number | null
  signal: number | null
}

export type PreviewHostOptions = {
  // The recipe a preview names is resolved and gated by the seam, not by a second allowlist
  // held here: one signed source, one choke point. The seam supplies the vetted command and
  // args and audits the spawn; a recipe it does not hold is refused before a process exists.
  seam: SpawnSeam
  // The same consent the seam is built with: the seam does the pre-spawn grant admission, and
  // the host asks this for the post-spawn read-back, so directory consent is one decision made
  // in one place rather than a second copy that could drift from the seam's.
  consent: ConsentPolicy
  // How the preview process is launched. Absent, previews run directly under detect-and-stop; the
  // binary injects the network-namespace unit where the host supports it, so off-loopback binds are
  // contained rather than only detected. One launch seam, chosen once at composition.
  containment?: PreviewContainment
  readyTimeoutMs?: number
  maxPreviews?: number
}

export type PreviewCleanupFailure = {
  previewId: string
  pid: number
  reason: RefusalReason
}

export declare interface PreviewHost {
  on(event: 'exit', listener: (exit: PreviewExit) => void): this
  on(event: 'cleanup-failed', listener: (failure: PreviewCleanupFailure) => void): this
}

type RunningPreview = PreviewRecord & { child: ChildProcess; blindSweeps?: number; cleanupPending?: boolean }

// Members seen while a preview's root was still walkable. Teardown that starts after the
// wrapper has gone would otherwise capture nothing and declare an empty tree dead, which
// is exactly the case where a server outlived its wrapper.
const observedMembers = new WeakMap<ChildProcess, Map<number, string>>()

// Thrown when a preview's outcome could not be made durable before the host tore down. It is a
// fatal audit state, not a refusal: the caller must see the failure rather than a normal outcome
// claiming a record that was never written, so it propagates past the catch that would otherwise
// turn an inspection failure into an ordinary spawn-failed refusal.
class UndurableOutcomeError extends Error {}

// The outcome of a preview process the runner spawned and then terminated — a failed post-spawn
// grant recheck, a stop that arrived mid-start. It ran, so `spawnFailed` would misreport it; its
// real exit or killing signal is recorded, with `spawnFailed` only where the OS reports neither.
function terminatedOutcome(child: ChildProcess): SpawnOutcome {
  if (child.exitCode !== null) return { exitCode: child.exitCode, signal: null }
  const signal = child.signalCode !== null ? osConstants.signals[child.signalCode] : undefined
  return signal !== undefined ? { exitCode: null, signal } : { spawnFailed: true }
}

export class PreviewHost extends EventEmitter {
  private readonly seam: SpawnSeam
  private readonly consent: ConsentPolicy
  private readonly containment: PreviewContainment
  private readonly readyTimeoutMs: number
  private readonly maxPreviews: number
  private readonly running = new Map<string, RunningPreview>()
  private readonly stopping = new Map<ChildProcess, string>()
  private readonly finalized = new WeakSet<ChildProcess>()
  private readonly earlyExits = new Map<ChildProcess, { exitCode: number | null; signal: number | null }>()
  private readonly starting = new Set<string>()
  private readonly cancelled = new Set<string>()
  private readonly inFlight = new Set<Promise<unknown>>()
  private watchTimer: NodeJS.Timeout | undefined
  private sweeping = false
  private shuttingDown = false
  private shutdownRun: Promise<void> | undefined
  // The seam's outcome callback per admitted preview, called once the preview's end-of-life is
  // final so the audit records the outcome, not just the admission.
  private readonly completions = new Map<string, (outcome: SpawnOutcome) => Promise<void>>()
  // The re-drive timer for an exit whose outcome append is still failing, keyed by the SPECIFIC
  // completion callback rather than the previewId: the id is reusable, and a re-drive keyed by it
  // could complete a later start's spawn. One timer per pending completion, cleared on success or
  // shutdown.
  private readonly exitRedrives = new Map<(outcome: SpawnOutcome) => Promise<void>, NodeJS.Timeout>()

  constructor(options: PreviewHostOptions) {
    super()
    this.seam = options.seam
    this.consent = options.consent
    this.containment = options.containment ?? passthroughContainment()
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
    this.maxPreviews = options.maxPreviews ?? DEFAULT_MAX_PREVIEWS
  }

  // Refusals are values, not exceptions: every one maps onto the wire's REFUSED message,
  // so a caller cannot accidentally drop the reason on the floor.
  start(spec: PreviewSpec): Promise<PreviewOutcome> {
    return this.track(this.runStart(spec))
  }

  private async runStart(spec: PreviewSpec): Promise<PreviewOutcome> {
    // The identifier is reserved before the first await. Two adjacent PREVIEW_START frames
    // would otherwise both pass the duplicate check and both spawn.
    const taken = this.reserve(spec.previewId)
    if (taken) return await this.recordPreviewRefusal(spec, spec.cwd, taken)
    let child: ChildProcess | null = null
    let screenedCwd = ''
    // The post-spawn read-back's grant question, bound to the SAME consent the admission resolved
    // against. Captured from the authorization rather than answered from a separately-held consent
    // handle, so a composition supplying two consent instances cannot admit under one grant set and
    // clear a moved landing under another.
    let verifyLanding: ((resolvedRealCwd: string) => Promise<boolean>) | undefined
    // Stamped when the process exists, not before. Screening is asynchronous, so a
    // timestamp taken ahead of it lets a readiness poll join a snapshot that was started
    // after the stamp but before the child — a view that cannot contain it, and one poll
    // of the readiness budget spent on an answer that was never possible.
    let spawnedAt = 0
    try {
      const screened = this.screen(spec)
      if (screened.reason || !screened.cwd) return await this.recordPreviewRefusal(spec, spec.cwd, screened.reason ?? 'path-not-granted')
      // The seam decides both the recipe (allowlist) and the cwd (grant, grantScoped true),
      // resolves the granted real path into `vetted.cwd`, and audits the admission — one gate for
      // the allowlist and the directory alike. What stays here is the post-spawn read-back below.
      const authorized = await this.seam.authorize({ kind: 'preview', recipeId: spec.recipe, cwd: screened.cwd, grantScoped: true })
      if (authorized.status === 'refused') return { status: 'refused', reason: authorized.reason }
      screenedCwd = authorized.authorization.vetted.cwd
      verifyLanding = authorized.authorization.verifyLanding
      this.completions.set(spec.previewId, authorized.authorization.complete)
      child = await this.spawnPreview(spec.previewId, authorized.authorization.vetted)
      spawnedAt = Date.now()
    } finally {
      if (child === null) {
        this.starting.delete(spec.previewId)
        // A cancellation left behind would be consumed by the next start for this id,
        // killing a process that nobody asked to stop.
        this.cancelled.delete(spec.previewId)
      }
    }
    if (child === null) {
      await this.completeAudit(spec.previewId, { spawnFailed: true })
      return { status: 'refused', reason: 'spawn-failed' }
    }
    // Where the process actually landed, not where it was told to go. Resolving the path
    // and handing spawn the resolved one closes most of the window, but the resolved path
    // can itself be replaced between the check and the exec — so the working directory is
    // read back from the running process and re-checked against the grants.
    if (!(await this.landedInsideGrant(child, screenedCwd, verifyLanding))) {
      // Ownership before teardown, and the latch released either way: this child is never
      // going to be registered, so an exit held for a registration that will not happen is
      // a process object retained for the life of the host.
      this.stopping.set(child, spec.previewId)
      const ended = await endPreviewTree(child)
      if (!ended) this.retainForCleanup(spec.previewId, child, 'path-not-granted')
      else this.stopping.delete(child)
      this.earlyExits.delete(child)
      // Finalized only when the tree is actually gone. Marking it after a failed cleanup
      // made every later finalize return early, so the retained record was never released
      // and its capacity was held for the life of the host.
      if (ended) this.finalized.add(child)
      this.starting.delete(spec.previewId)
      // A cancellation left behind would be consumed by the next start for this id and
      // kill a process nobody asked to stop — the same defect as the cancelled path, in a
      // branch added after it was fixed there.
      this.cancelled.delete(spec.previewId)
      await this.completeAudit(spec.previewId, terminatedOutcome(child))
      // The read-back caught the process running outside its grant — a security refusal, audited
      // as such on top of the admitted spawn's own terminated outcome.
      return await this.recordPreviewRefusal(spec, screenedCwd, 'path-not-granted')
    }
    // A stop that arrived while this start was screening wins: the process must not
    // survive a request the control plane already believes was honoured.
    if (this.cancelled.delete(spec.previewId)) {
      // Ownership moves before the reservation is released. Releasing first let a second
      // start claim the identifier during the teardown await, after which a failed cleanup
      // would overwrite the replacement's record with the corpse of the old one.
      this.stopping.set(child, spec.previewId)
      this.starting.delete(spec.previewId)
      // The latch was for a registration that will never happen now.
      this.earlyExits.delete(child)
      // Same rule as everywhere else: a teardown that cannot be proven keeps the record
      // and the watcher, because the alternative is a process nobody is tracking.
      if (!(await endPreviewTree(child))) this.retainForCleanup(spec.previewId, child, 'unknown-preview')
      else {
        // Finalized, not merely released: an exit arriving afterwards would otherwise be
        // latched for a registration that can never come, holding the process object.
        this.finalized.add(child)
        this.stopping.delete(child)
      }
      await this.completeAudit(spec.previewId, terminatedOutcome(child))
      return { status: 'refused', reason: 'unknown-preview' }
    }
    // The slot is claimed before the wait so a second start for the same id refuses
    // instead of racing a half-started process into the map. The port is not known yet.
    this.running.set(spec.previewId, { previewId: spec.previewId, port: 0, pid: child.pid ?? 0, child })
    this.starting.delete(spec.previewId)
    // A wrapper that exited early has not necessarily taken its tree with it. Replaying
    // the latch lets finishExit judge that: if descendants are still alive it keeps
    // ownership, and readiness continues so the survivors are verified and watched.
    // Returning a refusal here left an exposed server registered with no port and nothing
    // checking it.
    const early = this.earlyExits.get(child)
    if (early) {
      this.earlyExits.delete(child)
      this.handleExit(spec.previewId, child, early.exitCode, early.signal)
      if (!this.running.has(spec.previewId)) return { status: 'refused', reason: 'spawn-failed' }
    }
    try {
      const outcome = await this.awaitReady(spec.previewId, child, spawnedAt)
      // A verification refusal is a security decision — the tree bound off loopback, or held more
      // than one listener — so it is audited on top of the admitted spawn's outcome. A plain
      // spawn-failure is not a security refusal and its outcome record already tells the story.
      if (outcome.status === 'refused' && outcome.reason !== 'spawn-failed') {
        await this.seam.recordRefusal({ kind: 'preview', recipeId: spec.recipe, cwd: screenedCwd, grantScoped: false, requestId: spec.previewId }, outcome.reason)
      }
      return outcome
    } catch (error) {
      // A fatal audit state during shutdown is surfaced, never swallowed into a refusal that
      // claims an outcome nothing recorded.
      if (error instanceof UndurableOutcomeError) throw error
      // Inspection can fail — an unsupported platform, a missing lsof, an unreadable
      // /proc. An unverified preview must not outlive the refusal that its caller sees.
      return await this.refuse(spec.previewId, child, 'spawn-failed')
    }
  }

  // An identifier stays taken while its previous process is still dying: letting a
  // replacement go ready before the old PREVIEW_EXIT arrives would have the control plane
  // read that exit as the new preview's.
  private reserve(previewId: string): RefusalReason | null {
    // Nothing new is admitted once shutdown has begun; otherwise convergence is a race
    // against a caller that keeps asking.
    if (this.shuttingDown) return 'runner-paused'
    if (this.running.has(previewId) || this.starting.has(previewId)) return 'already-running'
    if ([...this.stopping.values()].includes(previewId)) return 'already-running'
    // A peer can name as many previews as it likes; this host decides how many it will
    // actually run. Without a ceiling, unique identifiers alone buy unbounded processes,
    // path checks and process-table reads.
    if (this.running.size + this.starting.size + this.stopping.size >= this.maxPreviews) return 'at-capacity'
    this.starting.add(previewId)
    return null
  }

  // The entry moves to `stopping` rather than vanishing: the process has not exited yet,
  // and dropping it here would make its exit unattributable, so the end-of-life the
  // control plane is waiting for would never be reported.
  // Reports whether the identifier was known. A stop arriving while a start is still
  // screening would otherwise be answered `unknown-preview` while that start carried on
  // and later announced readiness for something the control plane believes it stopped.
  async stop(previewId: string): Promise<'unknown' | 'stopped' | 'retained'> {
    if (this.starting.has(previewId)) {
      this.cancelled.add(previewId)
      return 'stopped'
    }
    const preview = this.running.get(previewId)
    if (!preview) return 'unknown'
    this.running.delete(previewId)
    this.stopping.set(preview.child, previewId)
    if (this.running.size === 0) this.stopWatching()
    // No pre-signal: killing the group here would reparent any descendant that made its
    // own group before endPreviewTree gets to capture it, which is the loss this ordering
    // exists to prevent. Teardown captures first, then signals.
    //
    // Awaited, not fired and forgotten: stopAll resolving while preview servers are still
    // listening would let a shutdown, or a test's cleanup, proceed over live processes.
    if (!(await endPreviewTree(preview.child))) {
      // Unproven teardown keeps the record and the watcher, exactly as a refused preview
      // does. Reporting an exit for a tree that may still be listening would discard the
      // only handle to it.
      this.retainForCleanup(previewId, preview.child, 'spawn-failed')
      return 'retained'
    }
    // The wrapper may already have exited before this stop began, in which case no further
    // exit event is coming to release the identifier. Finalizing here — idempotently, so a
    // real exit that also arrives changes nothing — is what stops the id and its capacity
    // from being consumed forever with no end-of-life ever reported.
    this.finalize(previewId, preview.child, null, null)
    return 'stopped'
  }

  list(): PreviewRecord[] {
    return [...this.running.values()].map(({ previewId, port, pid }) => ({ previewId, port, pid }))
  }

  // Shutdown waits for work that has not finished announcing itself: a start still
  // screening will spawn a server after this returns. Cancel the reservations first so
  // those starts end their own processes, drain them, then stop what is running — stop()
  // already waits for its tree to die.
  // Convergence, not a snapshot: a start admitted between draining and stopping would
  // leave a live server behind a shutdown that already returned. Each pass cancels what is
  // reserved, drains what is running, and stops what exists; it ends only when all three
  // are empty at the same moment.
  // Bounded, because a tree that cannot be proven dead would otherwise make shutdown loop
  // forever: `stop` reinserts what it could not finish, so retrying without a ceiling is a
  // guarantee of hanging rather than a guarantee of cleanliness. What survives the ceiling
  // stays recorded as cleanup-pending and is reported, not silently abandoned.
  // Concurrent shutdowns share one run. Each call used to set and clear the same boolean,
  // so the first to finish reopened the gate while an older one was still converging — and
  // work admitted in that window was then stopped by the older call.
  async stopAll(): Promise<void> {
    if (this.shutdownRun) return await this.shutdownRun
    const run = this.runShutdown().finally(() => { this.shutdownRun = undefined })
    this.shutdownRun = run
    return await run
  }

  private async runShutdown() {
    this.shuttingDown = true
    // The re-drive machinery stops with shutdown: a withheld exit stays withheld rather than being
    // acknowledged without a durable outcome, and the fatal log state is the audit writer's to
    // surface through onFailure.
    for (const timer of this.exitRedrives.values()) clearTimeout(timer)
    this.exitRedrives.clear()
    try {
      for (let pass = 0; pass < SHUTDOWN_PASSES; pass += 1) {
        for (const previewId of this.starting) this.cancelled.add(previewId)
        // Running previews are stopped first. Draining starts before touching them meant a
        // preview that had already reached ready waited out another start's full readiness
        // timeout before anyone asked it to stop — with its server up the whole time.
        await Promise.all([...this.running.keys()].map(previewId => this.stop(previewId).catch(() => undefined)))
        await Promise.allSettled([...this.inFlight])
        // One preview refusing to die must not stop the others being asked; the pass
      // ceiling and the cleanup-failed report cover what is left.
      await Promise.all([...this.running.keys()].map(previewId => this.stop(previewId).catch(() => undefined)))
        await Promise.allSettled([...this.stopping.keys()].map(child => endPreviewTree(child)))
        if (this.inFlight.size === 0 && this.starting.size === 0 && this.running.size === 0 && this.stopping.size === 0) return
      }
      // Both halves are reported. A child stranded mid-teardown lives in `stopping`, not
      // `running`, so reporting only the latter left the most likely survivor of a failed
      // shutdown — one already being killed when the ceiling was reached — unmentioned.
      for (const preview of this.running.values()) {
        this.emit('cleanup-failed', { previewId: preview.previewId, pid: preview.child.pid ?? 0, reason: 'spawn-failed' })
      }
      for (const [child, previewId] of this.stopping) {
        this.emit('cleanup-failed', { previewId, pid: child.pid ?? 0, reason: 'spawn-failed' })
      }
    } finally {
      this.shuttingDown = false
    }
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.inFlight.add(work)
    // Tracking only. The work's own caller receives its rejection.
    void work.catch(() => undefined).finally(() => this.inFlight.delete(work))
    return work
  }

  // A refusal the preview host itself decides — turned away while shutting down, or rejected
  // after inspection for binding off loopback — is audited through the seam like the refusals
  // the seam makes, so every security refusal lands in the log in one form.
  private async recordPreviewRefusal(spec: PreviewSpec, cwd: string, reason: RefusalReason): Promise<PreviewOutcome> {
    await this.seam.recordRefusal({ kind: 'preview', recipeId: spec.recipe, cwd, grantScoped: false, requestId: spec.previewId }, reason)
    return { status: 'refused', reason }
  }

  private screen(spec: PreviewSpec): { reason?: RefusalReason; cwd?: string } {
    // Both the allowlist and the grant decisions are the seam's now — `authorize` refuses and
    // audits an unknown recipe or an ungranted cwd, so the preview surface records them the same
    // way every runner-owned spawn does. Screening keeps only the cwd's shape, the one check that
    // has no meaning to resolve against a grant.
    if (hasControlCharacter(spec.cwd)) return { reason: 'not-allowlisted' }
    return { cwd: spec.cwd }
  }

  // Containment is decided on real paths, not lexical ones: a symlink inside a granted
  // directory pointing outside it passes any string comparison, and spawn follows the
  // link. Resolving both sides asks the question the grant is actually about — which
  // directory will the command run in.
  // Linux exposes a running process's working directory, so the authorization can be
  // checked against where the process is rather than where it was sent. Elsewhere this
  // falls back to the screened path, and the residual is recorded in the seam contract.
  private async landedInsideGrant(child: ChildProcess, screenedCwd: string, verifyLanding?: (resolvedRealCwd: string) => Promise<boolean>) {
    if (!child.pid) return true
    // Asked of every platform that can answer, not only Linux. Returning true unconditionally
    // elsewhere meant the resolved directory could be swapped between screening and exec on a
    // supported platform and nothing would notice — a fail-open wearing a portability excuse.
    const actual = await workingDirectoryOf(child.pid)
    // Only an actual exit proves the process cannot be running outside its grant. An
    // unreadable cwd — permissions, I/O, a platform with no mechanism — says nothing about
    // where it is, and reading that as proof is unknown standing in for safe.
    if (actual === null) return child.exitCode !== null || child.signalCode !== null
    // Re-checked against the SAME consent the admission used, carried on the authorization — never
    // a separately-held handle, which two consent instances could let diverge. Absent (a
    // non-grant-scoped admission) there is no grant to escape beyond the resolved path itself.
    if (actual === screenedCwd) return true
    return verifyLanding ? await verifyLanding(actual) : false
  }

  // Returns the REAL directory to spawn in, not merely a verdict. Handing spawn the
  // caller's original path would let it re-follow a symlink that has been swapped since
  // the check; spawning into the resolved path means the directory that was authorized is
  // the directory that is entered.
  // HOST is a hint, not the guarantee: most dev servers honour it, and the ones that do
  // not are caught by verification rather than trusted to have obeyed.
  //
  // The containment launches the preview in its own process group. A wrapper command's real
  // server is a descendant, and signalling only the wrapper would leave that descendant holding
  // its socket — so refusing a non-loopback bind has to be able to end the whole tree.
  private async spawnPreview(previewId: string, vetted: VettedSpawn) {
    try {
      const child = await this.containment.spawn({
        command: vetted.command,
        args: vetted.args,
        cwd: vetted.cwd,
        env: { ...process.env, HOST: '127.0.0.1' },
      })
      // A command can exit before the awaits between spawn and registration finish. The
      // event is latched so it is not lost: readiness would otherwise poll for the full
      // timeout waiting on a process that was already gone.
      child.once('exit', (exitCode, signal) => this.recordExit(previewId, child, exitCode, signal))
      child.once('error', () => this.recordExit(previewId, child, null, null))
      return child
    } catch {
      // spawn rejects some inputs synchronously; a refusal value is the contract here,
      // never an exception escaping into an unhandled rejection.
      return null
    }
  }

  // Ownership is checked against the exact child, not the id: a stopped preview's delayed
  // exit must not delete the entry its immediate replacement just claimed. A child the
  // host asked to stop still owns its own exit, which is why `stopping` is consulted.
  // Latches an exit that arrives before the child is registered, then replays it once
  // ownership exists. Without this a fast failure is simply dropped.
  private recordExit(previewId: string, child: ChildProcess, exitCode: number | null, signal: NodeJS.Signals | number | null) {
    // A child already finalized has nothing left to report, and latching its exit would
    // hold the process object for a registration that has already come and gone.
    if (this.finalized.has(child)) return
    if (!this.running.has(previewId) && !this.stopping.has(child)) {
      this.earlyExits.set(child, { exitCode, signal: typeof signal === 'string' ? null : signal })
      return
    }
    this.handleExit(previewId, child, exitCode, signal)
  }

  private handleExit(previewId: string, child: ChildProcess, exitCode: number | null, signal: NodeJS.Signals | number | null) {
    const owns = this.running.get(previewId)?.child === child
    if (!owns && !this.stopping.has(child)) return
    void this.finishExit(previewId, child, owns, exitCode, typeof signal === 'string' ? null : signal)
  }

  // A wrapper exiting is not the preview exiting. Its process group can still hold a
  // daemonized server, and releasing ownership here would announce an end-of-life while
  // something is still listening — and lose the handle that could stop it.
  private async finishExit(previewId: string, child: ChildProcess, owns: boolean, exitCode: number | null, signal: number | null) {
    // The root exiting is the last moment its tree can be walked, so the record is taken
    // here rather than left to a teardown that may start after the number is gone. A stop
    // racing startup could otherwise find nothing recorded and declare an empty tree dead
    // while a daemonized descendant kept listening.
    if (child.pid) await rememberMembers(child, await descendantsOf(child.pid).catch(() => []))
    // Unknown counts as still-alive: releasing ownership because a check failed would
    // announce an end-of-life over a process nobody looked at. A group that still has
    // members counts too — a wrapper can exit before its server has opened a socket, and
    // judging that moment by listeners alone reports a live preview as finished.
    const stillOwned = child.pid ? await treeStillOwned(child.pid).catch(() => true) : false
    if (stillOwned) {
      if (owns) return
      if (!(await endPreviewTree(child))) {
        this.retainForCleanup(previewId, child, 'spawn-failed')
        return
      }
    }
    if (owns && this.running.get(previewId)?.child === child) this.running.delete(previewId)
    this.finalize(previewId, child, exitCode, signal)
  }

  // Every unproven teardown lands here. Keeping the record under the sweep is the whole
  // point — the sweep skips records with no advertised port, so a preview that merely got
  // remembered would sit with nobody retrying it while whatever it bound stayed up.
  private retainForCleanup(previewId: string, child: ChildProcess, reason: RefusalReason) {
    const existing = this.running.get(previewId)
    if (existing?.child === child) existing.cleanupPending = true
    else this.running.set(previewId, { previewId, port: 0, pid: child.pid ?? 0, child, cleanupPending: true })
    this.stopping.delete(child)
    this.startWatching()
    this.emit('cleanup-failed', { previewId, pid: child.pid ?? 0, reason })
  }

  // One completion path, safe to call twice: whichever of the exit event and the teardown
  // arrives first reports the end, and the other becomes a no-op. The guard is explicit
  // because both paths legitimately run — a stop tears the tree down, and the wrapper's
  // own exit still fires — and reporting an end-of-life twice is its own defect.
  private finalize(previewId: string, child: ChildProcess, exitCode: number | null, signal: number | null) {
    // Ownership is released before the duplicate guard, not after. A failed teardown can
    // race exit finalization and put the child back through retainForCleanup, and if the
    // guard ran first that reinserted record could never be removed — the identifier and
    // its capacity held for the life of the host by a notification that was merely
    // duplicate.
    this.stopping.delete(child)
    if (this.running.get(previewId)?.child === child) this.running.delete(previewId)
    if (this.finalized.has(child)) return
    this.finalized.add(child)
    if (this.running.size === 0) this.stopWatching()
    // The exit event is this operation's acknowledgment, and the outcome record must be durable
    // before it goes out — the control plane must not learn a preview ended before the runner's
    // own log of how. The synchronous state above is settled first so a duplicate finalize
    // returns early while this tail runs.
    void this.emitExit(previewId, exitCode !== null ? { exitCode, signal: null } : signal !== null ? { exitCode: null, signal } : { spawnFailed: true }, exitCode, signal)
  }

  private async emitExit(previewId: string, outcome: SpawnOutcome, exitCode: number | null, signal: number | null) {
    const complete = this.completions.get(previewId)
    this.completions.delete(previewId)
    if (complete) return await this.driveExit(previewId, complete, outcome, exitCode, signal)
    this.emit('exit', { previewId, exitCode, signal })
  }

  // Drives ONE specific completion to durability and emits its exit only then. Bound to the exact
  // callback captured here, never re-looked-up by previewId: a new start can reclaim the id before a
  // re-drive fires, and completing the wrong spawn — or leaving the new preview without its own
  // completion — is the race this closes. The completion is not left in `completions` while it
  // fails; it lives in this closure until it is durable.
  private async driveExit(previewId: string, complete: (outcome: SpawnOutcome) => Promise<void>, outcome: SpawnOutcome, exitCode: number | null, signal: number | null) {
    if (!(await completeDurably(complete, outcome))) {
      // AS-21: the exit notification is the acknowledgment and must not be sent before the outcome
      // record is durable. A burst inside `completeDurably` just failed, so this completion is
      // re-driven on a slow cadence until the append recovers — a persistent outage stays observable
      // through the audit writer's onFailure and never emits an exit; shutdown stops the machinery.
      this.scheduleExitRedrive(previewId, complete, outcome, exitCode, signal)
      return
    }
    const pending = this.exitRedrives.get(complete)
    if (pending) {
      clearTimeout(pending)
      this.exitRedrives.delete(complete)
    }
    this.emit('exit', { previewId, exitCode, signal })
  }

  // Keeps a withheld exit scheduled: one timer per pending completion re-entering driveExit on a
  // slow cadence, so a log that recovers after more than one burst eventually records that outcome
  // exactly once and releases the exit. Not scheduled during shutdown — the machinery stops there
  // and the withheld exit stays withheld rather than becoming an acknowledgment with no durable
  // outcome behind it.
  private scheduleExitRedrive(previewId: string, complete: (outcome: SpawnOutcome) => Promise<void>, outcome: SpawnOutcome, exitCode: number | null, signal: number | null) {
    if (this.shuttingDown) return
    if (this.exitRedrives.has(complete)) return
    const timer = setTimeout(() => {
      this.exitRedrives.delete(complete)
      void this.driveExit(previewId, complete, outcome, exitCode, signal)
    }, EXIT_OUTCOME_REDRIVE_MS)
    timer.unref?.()
    this.exitRedrives.set(complete, timer)
  }

  // Writes the seam's outcome record for an admitted preview that was refused after admission
  // (a spawn that never took, a teardown after a failed grant recheck), so an admission is
  // never left without an outcome. The refusal *is* the caller's acknowledgment, so it waits
  // for the outcome to be durable exactly as an exit does — a caller must not learn the preview
  // was refused before the runner's own record of why.
  private async completeAudit(previewId: string, outcome: SpawnOutcome) {
    const complete = this.completions.get(previewId)
    if (!complete) return
    this.completions.delete(previewId)
    // The refusal is the acknowledgment, and it waits for the outcome to be durable exactly as an
    // exit does. A persistently unwritable log withholds the refusal (fail closed): the wait keeps
    // retrying rather than resolving against a record that does not exist, and the audit writer's
    // onFailure signals the outage. Shutdown releases the wait so it does not hold `stopAll` open
    // forever — but it must not then resolve a normal refusal claiming an outcome that was never
    // recorded, so the caller is failed with the audit error rather than acknowledged.
    // Try at least once even mid-shutdown — a healthy log records the outcome and the refusal
    // resolves normally. Only a PERSISTENT failure that outlasts the shutdown signal gives up, and
    // then it is surfaced as a fatal audit state rather than a refusal claiming a record.
    do {
      if (await completeDurably(complete, outcome)) return
    } while (!this.shuttingDown)
    throw new UndurableOutcomeError('audit durability prevented recording the preview outcome before shutdown')
  }

  private async awaitReady(previewId: string, child: ChildProcess, spawnedAt: number): Promise<PreviewOutcome> {
    if (!child.pid) return await this.refuse(previewId, child, 'spawn-failed')
    const owned = () => this.running.get(previewId)?.child === child
    // A contained preview's readiness is its OWN bind inside the namespace, not the host-loopback
    // bridge the runner hands the forwarder — the bridge is listening from creation, so waiting on
    // host listeners alone would report ready before the preview has bound. Wait for the namespace
    // to hold a listener first, so the reported port is reachable through the forward the moment it
    // is announced (AS-30). A containment that claimed isolation but did not deliver it falls
    // through to the host-visible readiness below, where detect-and-stop governs it.
    if (this.containment.status.disposition === 'network-namespace') {
      const contained = await awaitContainedReadiness(child.pid, this.readyTimeoutMs, owned)
      if (contained === 'unbound') return await this.refuse(previewId, child, 'spawn-failed')
    }
    const first = await waitForListeners(child.pid, this.readyTimeoutMs, owned, spawnedAt)
    // Best effort: a failed walk adds nothing to the record, and the record only grows.
    await rememberMembers(child, await descendantsOf(child.pid).catch(() => []))
    if (first.length === 0) return await this.refuse(previewId, child, 'spawn-failed')
    // No fixed settle: readiness already waited for the set to stop changing, which is the
    // property the delay was approximating. One confirming read guards the gap between that
    // decision and this one.
    if (!owned()) return { status: 'refused', reason: 'spawn-failed' }
    const verdict = this.judge(await listeningSocketsFor(child.pid))
    if (verdict.reason) return await this.refuse(previewId, child, verdict.reason)
    const preview = this.running.get(previewId)
    if (!preview || preview.child !== child || verdict.port === undefined) return await this.refuse(previewId, child, 'spawn-failed')
    preview.port = verdict.port
    this.startWatching()
    return { status: 'ready', record: { previewId, port: preview.port, pid: preview.pid } }
  }

  private judge(sockets: ListeningSocket[]): { reason?: RefusalReason; port?: number } {
    if (sockets.length === 0) return { reason: 'spawn-failed' }
    // Every listener in the tree is judged, never just the first found: a process is free
    // to bind loopback itself and hand the exposed socket to a child.
    // Loopback is required of every socket, whatever its protocol — an exposed UDP port
    // is exposed. But the port a browser opens is a TCP one, so the advertised port is
    // chosen from TCP alone: counting a preview's auxiliary UDP socket as a second
    // candidate refused a perfectly good server as ambiguous, and a UDP-only process
    // announced a port nothing could connect to.
    if (sockets.some(socket => !isLoopbackAddress(socket.address))) return { reason: 'non-loopback-bind' }
    const ports = [...new Set(sockets.filter(socket => socket.protocol === 'tcp').map(socket => socket.port))]
    // Enumeration order does not say which listener is the preview, so a tree holding
    // several — an inspector beside a server — is refused rather than guessed at.
    if (ports.length !== 1 || ports[0] === undefined) return { reason: 'ambiguous-listener' }
    return { port: ports[0] }
  }

  // Verification continues for the preview's life. A tree can bind a new socket long after
  // it started, so a check performed only at readiness would certify a moment rather than
  // the promise. Losing loopback ends the preview; so does losing every listener, since a
  // process that closed its server without exiting would otherwise leave the control plane
  // advertising a port nothing answers.
  //
  // One sweep serves every preview. A timer each would multiply full process-table reads
  // by the number of previews, and overlapping passes would stack on a slow scan.
  private startWatching() {
    if (this.watchTimer) return
    this.watchTimer = setInterval(() => {
      // The sweep awaits process inspection and teardown, both of which can reject. A
      // discarded promise here turns a transient /proc or ps failure into an unhandled
      // rejection that ends the runner and abandons enforcement entirely — the watcher
      // exists to keep enforcing, so its own failure must stay observable and survivable.
      this.sweep().catch(error => this.emit('sweep-failed', { error }))
    }, WATCH_INTERVAL_MS)
    this.watchTimer.unref()
  }

  private stopWatching() {
    if (this.watchTimer) clearInterval(this.watchTimer)
    this.watchTimer = undefined
  }

  private async sweep() {
    if (this.sweeping) return
    this.sweeping = true
    try {
      // Cleanup-pending records have no advertised port but are exactly what must be
      // retried: their teardown was never proven.
      for (const preview of [...this.running.values()].filter(item => item.cleanupPending)) {
        if (!(await endPreviewTree(preview.child))) continue
        // finalize owns the delete and checks the child first: a concurrent stop can let a
        // replacement claim this id during teardown, and an unconditional delete here
        // would drop the replacement's record and leave its process untracked.
        this.finalize(preview.previewId, preview.child, null, null)
      }
      const live = [...this.running.values()].filter(preview => preview.child.pid && preview.port !== 0 && !preview.cleanupPending)
      // One process-table read answers for every preview in this pass.
      const snapshot = await listeningSocketsForMany(live.map(preview => preview.child.pid as number)).catch(() => null)
      // Best effort, as above: a pass contributes what it can see and never removes.
      const descendants = await descendantsOfMany(live.map(preview => preview.child.pid as number)).catch(() => null)
      for (const preview of live) {
        await rememberMembers(preview.child, descendants?.get(preview.child.pid as number) ?? [])
        const sockets = snapshot === null ? null : snapshot.get(preview.child.pid as number) ?? []
        if (sockets === null) {
          // Not knowing is not the same as being safe. A recipe that makes inspection fail
          // would otherwise be skipped by every sweep and keep whatever it bound.
          preview.blindSweeps = (preview.blindSweeps ?? 0) + 1
          if (preview.blindSweeps < BLIND_SWEEPS_ALLOWED) continue
        } else {
          preview.blindSweeps = 0
          const verdict = this.judge(sockets)
          if (!verdict.reason && verdict.port === preview.port) continue
        }
        if (this.running.get(preview.previewId)?.child !== preview.child) continue
        // The identifier stays held until the exit has been reported, so a replacement
        // cannot start and then receive this process's end-of-life as its own.
        this.stopping.set(preview.child, preview.previewId)
        if (await endPreviewTree(preview.child)) {
          // finalize owns the delete and checks the child first: this is exactly where a
          // replacement is most likely to have claimed the identifier during teardown.
          this.finalize(preview.previewId, preview.child, null, null)
          continue
        }
        // The socket that provoked this sweep may still be up. Keeping the record is what
        // makes the next pass try again; announcing an exit here would drop the only
        // handle to a process that is still listening.
        this.retainForCleanup(preview.previewId, preview.child, 'non-loopback-bind')
      }
    } finally {
      this.sweeping = false
      if (this.running.size === 0) this.stopWatching()
    }
  }

  private async refuse(previewId: string, child: ChildProcess, reason: RefusalReason): Promise<PreviewOutcome> {
    this.starting.delete(previewId)
    const ended = await endPreviewTree(child)
    if (!ended) {
      // Ownership is kept precisely because cleanup could not be proven: something may
      // still be listening, and forgetting it would leave a refused preview reachable with
      // nothing tracking it. The sweep keeps trying, and the capacity stays consumed
      // because the process is real.
      // Kept under the sweep, not merely remembered: the sweep skips records with no
      // advertised port, so a refused preview would sit here forever with nobody retrying
      // its teardown. Marking it cleanup-pending is what makes the retry happen.
      const pending = this.running.get(previewId)
      if (pending?.child === child) pending.cleanupPending = true
      else this.running.set(previewId, { previewId, port: 0, pid: child.pid ?? 0, child, cleanupPending: true })
      this.startWatching()
      this.emit('cleanup-failed', { previewId, pid: child.pid ?? 0, reason })
      return { status: 'refused', reason }
    }
    if (this.running.get(previewId)?.child === child) this.running.delete(previewId)
    this.finalized.add(child)
    await this.completeAudit(previewId, terminatedOutcome(child))
    return { status: 'refused', reason }
  }
}

// Signalling the group, not the process: the exposed socket may belong to a descendant,
// and killing only the wrapper would leave it listening after the runner said it refused.
function endProcessGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // Already gone; nothing to signal.
    }
  }
}

// Refusal has to mean the socket is unreachable, not that a signal was sent. A descendant
// can start its own process group and survive the group signal, so survivors are signalled
// individually and the tree is re-read until nothing is listening. Bounded: the promise
// this keeps is "no longer reachable", and a tree that will not die is reported rather
// than waited on forever.
// Wrapped whole: callers rely on `false` meaning "not proven dead" and every one of them
// has a retain-and-retry path for it. An inspection error escaping instead would skip that
// path entirely and leave a live process with nothing watching it — the single outcome
// this function exists to prevent.
async function endPreviewTree(child: ChildProcess, firstSignal: NodeJS.Signals = 'SIGKILL') {
  try {
    return await endPreviewTreeUnguarded(child, firstSignal)
  } catch {
    return false
  }
}

// Each pid's start time is captured the moment the pid is first seen. Reading it later —
// at teardown — would read whatever now holds that number, so a recycled pid would be
// recorded with a stranger's identity and then signalled as though it were ours.
export async function rememberMembers(child: ChildProcess, pids: Iterable<number>) {
  const fresh = [...pids]
  if (fresh.length === 0) return
  const seen = observedMembers.get(child) ?? new Map<number, string>()
  const unseen = fresh.filter(pid => !seen.has(pid))
  if (unseen.length > 0) {
    // Not knowing a start time means not recording the pid: an unidentified member cannot
    // later be proven to be the same process, so it must not be signalled on suspicion.
    const now = await processStartTimes().catch(() => null)
    if (now !== null) for (const pid of unseen) {
      const started = now.get(pid)
      if (started !== undefined) seen.set(pid, started)
    }
  }
  observedMembers.set(child, seen)
}

async function endPreviewTreeUnguarded(child: ChildProcess, firstSignal: NodeJS.Signals) {
  if (!child.pid) return true
  // A pid identifies this preview only while its process has not been reaped: Node reaps
  // on exit, and until then the number cannot be handed to anything else. So the root's
  // pid is usable exactly while the ChildProcess reports no exit — and that gates the
  // traversal as much as the signal, because walking a reused pid would classify a
  // stranger's children as this preview's and kill them.
  const rootUsable = () => child.exitCode === null && child.signalCode === null
  // Descendants are captured BEFORE the group is signalled. Killing first reparents any
  // descendant that made its own process group to init, which erases it from the tree walk
  // — so the one process most likely to have escaped the group signal is exactly the one
  // that would no longer be found.
  // No catch here either: an initial scan that fails is not a tree with no descendants.
  // Swallowing it let a separate-group child be reparented after the root died and vanish
  // from every later scan while its listener survived. The wrapper turns the throw into
  // the unproven result that retains the preview.
  // Seeded with whatever was observed while the root lived: a teardown beginning after the
  // wrapper exited can no longer walk the tree, and starting empty declared success over a
  // server that outlived its parent.
  const remembered = observedMembers.get(child) ?? new Map<number, string>()
  const known = new Set(remembered.keys())
  // Identities seen at first sighting win over anything read now: a pid recycled since
  // then reads as a different process, which is exactly the distinction being made.
  const startTimes = new Map([...(await processStartTimes()), ...remembered])
  if (rootUsable()) for (const pid of await descendantsOf(child.pid)) known.add(pid)
  // The group outlives its leader: pgid stays the root's number while any member remains,
  // so it can still be signalled after the wrapper is reaped — but only when a member this
  // teardown observed is still alive with its original identity, which is what proves the
  // group is still this preview's and not a stranger that inherited the number.
  if (rootUsable() || (await ownsGroupStill(child.pid, known, startTimes))) endProcessGroup(child, firstSignal)
  for (let attempt = 0; attempt < TERMINATION_ATTEMPTS; attempt += 1) {
    // No catch: the wrapper turns a throw into the unproven result every caller handles.
    // Swallowing it here produced an empty tree, which reads as "nothing left to kill" and
    // reported success over a child in another process group.
    // Once the root has been reaped its number is no longer ours to walk; what was
    // captured while it lived is the whole target from then on.
    const current = new Set(rootUsable() ? await descendantsOf(child.pid) : [])
    for (const pid of current) known.add(pid)
    // Null is checked immediately below and returns the unproven result.
    const identities = await processStartTimes().catch(() => null)
    if (identities === null) return false
    // Signalling only what the current scan still sees would spare exactly the process
    // that escaped — one that called setsid leaves the tree and would never appear again.
    // Identity is re-established by start time instead: a pid this teardown captured, still
    // alive and still no older than the tree it came from, is the same process.
    killAll(known, stillTheSame(known, startTimes, identities))
    // A failed inspection is not an empty one. Declaring the tree dead because the check
    // threw is the same mistake as declaring it healthy for the same reason: keep trying,
    // and let the attempt ceiling end it rather than an error that was read as success.
    // Same rule for the listener check: a reused pid's sockets are not this preview's.
    // -1 is deliberately not zero: an inspection that failed must not satisfy the
    // "nothing is listening" condition below.
    const remaining = await countRemainingListeners(child, rootUsable())
    if (remaining === 0 && current.size === 0 && !anyAlive(known)) return true
    await delay(TERMINATION_POLL_MS)
  }
  // The ceiling is reached without proof that the tree is gone. Reporting completion here
  // would make "refused" mean "a signal was sent", when what was promised is that nothing
  // is reachable — so the caller is told the truth instead.
  return false
}

// Only pids the current scan still attributes to this tree are signalled. A descendant can
// exit and have its number handed to something unrelated inside the retry window, and a
// remembered pid is a number, not an identity.
// A pid is the same process it was if it is still alive and its start time has not moved.
// Reuse hands the number to something newer, which this catches without needing the
// process to still be reachable through a tree walk.
function stillTheSame(known: Set<number>, startTimes: Map<number, string>, now: Map<number, string>) {
  const same = new Set<number>()
  for (const pid of known) {
    // Unknown is not a match. A pid captured after the baseline was taken has no recorded
    // start time, and treating that as proof of identity is how a reused number gets
    // signalled — the exact hazard this check exists to prevent.
    const before = startTimes.get(pid)
    if (before !== undefined && now.get(pid) === before) same.add(pid)
  }
  return same
}

function killAll(pids: Iterable<number>, stillOurs: Set<number>) {
  for (const pid of pids) {
    if (!stillOurs.has(pid)) continue
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already exited between enumeration and the signal.
    }
  }
}

// Alive means "this tree still holds something": a listener, or a group member that may be
// about to open one. Judging by listeners alone reports a preview as finished during the
// window between its wrapper exiting and its server binding.
async function treeStillOwned(rootPid: number) {
  if ((await listeningSocketsFor(rootPid)).length > 0) return true
  return (await descendantsOf(rootPid)).length > 0
}

async function countRemainingListeners(child: ChildProcess, usable: boolean) {
  if (!usable || !child.pid) return 0
  // A failed inspection reports -1 rather than 0 so it cannot satisfy the "nothing is
  // listening" test that ends teardown.
  return await listeningSocketsFor(child.pid).then(sockets => sockets.length).catch(() => -1)
}

// A surviving member proves the group is still ours only if it is STILL IN that group: a
// remembered descendant that called setsid has left, and its survival would otherwise
// vouch for a group id that has since been handed to strangers.
async function ownsGroupStill(root: number, known: Set<number>, startTimes: Map<number, string>) {
  if (known.size === 0) return false
  // Not knowing means not claiming: without a current reading there is no proof the group
  // is still ours, and signalling it would be signalling a number.
  const now = await processStartTimes().catch(() => null)
  // Same rule as the reading above: null is checked immediately and refuses the claim.
  const groups = await processGroups().catch(() => null)
  if (now === null || groups === null) return false
  return [...known].some(pid => {
    const before = startTimes.get(pid)
    return before !== undefined && now.get(pid) === before && groups.get(pid) === root
  })
}

function anyAlive(pids: Iterable<number>) {
  for (const pid of pids) {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      // Gone.
    }
  }
  return false
}

// Polling backs off as it waits. Discovery walks the process table, so a fixed fast
// interval would spend a slow startup scanning it hundreds of times; a server that comes
// up quickly is still noticed quickly, and one that takes thirty seconds costs a fraction
// of the scans.
// `spawnedAt` is what freshness means here: a scan that began after this process existed
// can answer for it, and one that began before cannot. Demanding a view newer than the
// current instant instead would make every poll start its own scan, which is the cost the
// sharing exists to avoid.
// Poll the preview's own network namespace until it holds a listener — the contained preview
// having bound — or the readiness budget runs out. The host-loopback bridge is deliberately not
// consulted here: it is up from the start, so only the namespace's table distinguishes a bound
// preview from one still starting.
// Readiness of a preview a containment CLAIMED to isolate. `bound`: it runs in its own namespace
// and has bound there. `unbound`: it is isolated but never bound within the budget. `uncontained`:
// it never entered a namespace of its own — a containment that claimed isolation but did not
// deliver it — so the host-visible readiness path, where detect-and-stop governs it, is the right
// judge. The distinction matters because only a listener in the preview's OWN namespace is the
// preview: during `unshare` startup the child is briefly still in the runner's namespace, where the
// host's listeners (including the very port the preview will later claim) are visible.
async function awaitContainedReadiness(pid: number, timeoutMs: number, stillWanted: () => boolean): Promise<'bound' | 'unbound' | 'uncontained'> {
  const runnerNamespace = networkNamespaceOf('self')
  const deadline = Date.now() + timeoutMs
  const isolationDeadline = Date.now() + CONTAINMENT_ISOLATION_MS
  let sawIsolated = false
  while (Date.now() < deadline) {
    if (!stillWanted()) return 'unbound'
    if (networkNamespaceOf(pid) !== runnerNamespace) {
      sawIsolated = true
      if (namespaceHasListener(pid)) return 'bound'
    } else if (!sawIsolated && Date.now() > isolationDeadline) {
      return 'uncontained'
    }
    await delay(READY_POLL_MS)
  }
  return sawIsolated ? 'unbound' : 'uncontained'
}

async function waitForListeners(pid: number, timeoutMs: number, stillWanted: () => boolean, spawnedAt: number) {
  const deadline = Date.now() + timeoutMs
  let interval = READY_POLL_MS
  let previous = ''
  let unchangedSince = Date.now()
  let latest: ListeningSocket[] = []
  while (Date.now() < deadline) {
    if (!stillWanted()) return []
    latest = await listeningSocketsFor(pid, spawnedAt)
    // An exposed socket is answered at once: waiting for it to settle is waiting while it
    // is reachable.
    if (latest.some(socket => !isLoopbackAddress(socket.address))) return latest
    const fingerprint = signatureOf(latest)
    if (fingerprint !== previous) {
      previous = fingerprint
      unchangedSince = Date.now()
    }
    // Stability is a duration, not a repeat count. A tree opens its sockets in whatever
    // order it likes, so an inspector or a UDP socket can be up while the server the
    // browser wants is still binding — and two identical polls fifty milliseconds apart
    // say nothing about that.
    if (latest.length > 0 && Date.now() - unchangedSince >= STABLE_FOR_MS) return latest
    await delay(interval)
    interval = Math.min(interval * 2, MAX_READY_POLL_MS)
  }
  // Budget spent: report what is there and let the caller judge it rather than holding out
  // for a stability that is not coming.
  return latest
}

function signatureOf(sockets: readonly ListeningSocket[]) {
  return sockets.map(socket => `${socket.protocol}:${socket.address}:${socket.port}`).sort().join(',')
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

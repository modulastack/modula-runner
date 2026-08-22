import {
  isLowercaseUuidV4,
  isSafeIdentifier,
  parseSessionLaunchClientMessage,
  SESSION_LAUNCH_PROTOCOL_VERSION,
  sessionStartDeadline,
  sessionStartFingerprint,
  type SessionFailureReason,
  type SessionRefusalReason,
  type SessionStartMessage,
} from '@modulastack/runner-protocol'
import type { LaunchPlan } from './accessProfiles.js'
import {
  SESSION_RECEIPT_SCHEMA_VERSION,
  type LocalProjectRecord,
  type SessionLaunchAction,
  type SessionLauncher,
  SessionLaunchNotImplementedError,
  type SessionLauncherOptions,
  type SessionReceipt,
  type SessionReceiptTombstone,
  type SessionTerminalResult,
  type SessionWorktreeRegisteredSnapshot,
  type SessionWorktreeSnapshot,
  type SessionWorktreeVerifiedSnapshot,
} from './sessionLaunch.js'

const INITIAL_RESPONSE_MS = 5_000
const LAUNCH_PROGRESS_MS = 180_000
const STORAGE_CLOSE: SessionLaunchAction = { kind: 'close-job-control', error: 'storage-unavailable' }

type LauncherRuntime = { options: SessionLauncherOptions; lanes: LaneScheduler }
type LaneRelease = () => void

class LaneScheduler {
  private readonly tails = new Map<string, Promise<void>>()

  tryAcquire(request: SessionStartMessage): LaneRelease | null {
    const key = laneKey(request)
    if (this.tails.has(key)) return null
    return this.enqueue(key)
  }

  async acquire(request: SessionStartMessage, signal: AbortSignal): Promise<LaneRelease> {
    const key = laneKey(request)
    const previous = this.tails.get(key)
    const release = this.enqueue(key, previous)
    if (!previous) return release
    try {
      await waitForLane(previous, signal)
    } catch (error) {
      void previous.finally(release)
      throw error
    }
    return release
  }

  private enqueue(key: string, previous = Promise.resolve()): LaneRelease {
    let complete!: () => void
    const turn = new Promise<void>(resolve => { complete = resolve })
    const tail = previous.then(() => turn)
    this.tails.set(key, tail)
    let released = false
    return () => {
      if (released) return
      released = true
      complete()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}

function laneKey(request: SessionStartMessage): string {
  return JSON.stringify([request.target.projectId, request.target.worktreeName])
}

export function createSessionLauncher(options: SessionLauncherOptions): SessionLauncher {
  const runtime: LauncherRuntime = { options, lanes: new LaneScheduler() }
  return {
    handle(request) {
      const parsed = parseSessionLaunchClientMessage(request, SESSION_LAUNCH_PROTOCOL_VERSION)
      if (!parsed) return invalidRequest(options, request)
      return launch(runtime, parsed, sessionStartFingerprint(parsed))
    },
    async *recover(): AsyncGenerator<never> {
      throw new SessionLaunchNotImplementedError()
    },
  }
}

async function* invalidRequest(
  options: SessionLauncherOptions,
  request: SessionStartMessage,
): AsyncGenerator<SessionLaunchAction> {
  if (!isLowercaseUuidV4(request.requestId)) {
    yield STORAGE_CLOSE
    return
  }
  yield await refuse(options, request, '0'.repeat(64), 'invalid-request', false)
}

async function* launch(
  runtime: LauncherRuntime,
  request: SessionStartMessage,
  fingerprint: string,
): AsyncGenerator<SessionLaunchAction> {
  const options = runtime.options
  const authenticated = safeSync(() => options.bindingId())
  if (!authenticated.ok) {
    yield STORAGE_CLOSE
    return
  }
  if (authenticated.value !== request.bindingId) {
    yield await refuse(options, request, fingerprint, 'binding-mismatch', false)
    return
  }
  const known = await safe(() => options.receipts.lookup(keyOf(request)))
  if (!known.ok) {
    yield STORAGE_CLOSE
    return
  }
  if (known.value.status !== 'missing') {
    yield await knownAction(options, request, fingerprint, known.value.status === 'receipt' ? known.value.receipt : known.value.tombstone)
    return
  }
  const now = clockTime(options)
  if (!now) {
    yield STORAGE_CLOSE
    return
  }
  const deadline = sessionStartDeadline(request.expiresAt, now.ms)
  if (deadline !== 'admissible') {
    yield await refuse(options, request, fingerprint, deadline === 'expired' ? 'request-expired' : 'invalid-request', true)
    return
  }
  if (!validTargetSyntax(request)) {
    yield await refuse(options, request, fingerprint, 'worktree-invalid', true)
    return
  }
  const projectResult = await timed(options, INITIAL_RESPONSE_MS, () => options.projects.get(request.target.projectId))
  if (!projectResult.ok) {
    yield projectResult.timeout ? await refuse(options, request, fingerprint, 'runner-paused', true) : STORAGE_CLOSE
    return
  }
  if (!projectResult.value) {
    yield await refuse(options, request, fingerprint, 'project-unknown', true)
    return
  }
  const initialAccess = await timed(options, INITIAL_RESPONSE_MS, signal => options.access.resolve(request.modelProfileId, signal))
  if (!initialAccess.ok) {
    yield initialAccess.timeout ? await refuse(options, request, fingerprint, 'runner-paused', true) : STORAGE_CLOSE
    return
  }
  if (initialAccess.value.status === 'refused') {
    yield await refuse(options, request, fingerprint, initialAccess.value.reason, true)
    return
  }
  const claimed = await safe(() => options.receipts.claim(request, fingerprint, now.iso))
  if (!claimed.ok) {
    yield STORAGE_CLOSE
    return
  }
  if (claimed.value.status === 'storage-unavailable') {
    yield STORAGE_CLOSE
    return
  }
  if (claimed.value.status === 'conflict') {
    yield await refuse(options, request, fingerprint, 'request-conflict', false)
    return
  }
  if (claimed.value.status === 'at-capacity') {
    yield await refuse(options, request, fingerprint, 'at-capacity', false)
    return
  }
  if (claimed.value.status === 'known') {
    yield await knownAction(options, request, fingerprint, claimed.value.value)
    return
  }
  let receipt = claimed.value.receipt
  if (!sameProject(receipt.project, projectResult.value)) {
    const updated = await persist(options, receipt, { project: projectResult.value })
    if (!updated) {
      yield STORAGE_CLOSE
      return
    }
    receipt = updated
  }
  if (!(await audit(options, receipt))) {
    yield STORAGE_CLOSE
    return
  }
  yield message({ type: 'SESSION_ACCEPTED', requestId: request.requestId })
  yield* continueLaunch(runtime, receipt, projectResult.value)
}

async function* continueLaunch(
  runtime: LauncherRuntime,
  receipt: SessionReceipt,
  project: LocalProjectRecord,
): AsyncGenerator<SessionLaunchAction> {
  const acquired = await acquireLane(runtime, receipt.request)
  if (!acquired.ok) {
    yield await fail(runtime.options, receipt, acquired.timeout ? 'launch-timeout' : 'provision-failed')
    return
  }
  try {
    yield* continueLaunchInLane(runtime.options, receipt, project, acquired.value)
  } finally {
    acquired.value()
  }
}

async function* continueLaunchInLane(
  options: SessionLauncherOptions,
  startingReceipt: SessionReceipt,
  project: LocalProjectRecord,
  releaseLane?: LaneRelease,
): AsyncGenerator<SessionLaunchAction> {
  let receipt = startingReceipt
  const prepared = await timed(options, LAUNCH_PROGRESS_MS, signal => options.worktrees.prepare(project, receipt.request.target, signal))
  if (!prepared.ok) {
    yield await fail(options, receipt, prepared.timeout ? 'launch-timeout' : 'provision-failed')
    return
  }
  if (prepared.value.status === 'failed') {
    yield await fail(options, receipt, prepared.value.reason)
    return
  }
  let snapshot: SessionWorktreeSnapshot = prepared.value.snapshot
  const preparedReceipt = await journal(options, receipt, snapshot)
  if (!preparedReceipt) {
    yield STORAGE_CLOSE
    return
  }
  receipt = preparedReceipt
  if (snapshot.phase === 'branch-created') {
    const branch = snapshot
    const registered = await timed(options, LAUNCH_PROGRESS_MS, signal => options.worktrees.register(branch, signal))
    if (!registered.ok) {
      yield await failProvisioning(options, receipt, branch, registered.timeout ? 'launch-timeout' : 'provision-failed')
      return
    }
    if (registered.value.status === 'failed') {
      yield await failProvisioning(options, receipt, branch, registered.value.reason)
      return
    }
    snapshot = registered.value.snapshot
    const journaled = await journal(options, receipt, snapshot)
    if (!journaled) {
      yield STORAGE_CLOSE
      return
    }
    receipt = journaled
  }
  if (snapshot.phase !== 'worktree-registered') {
    yield await fail(options, receipt, 'worktree-invalid')
    return
  }
  const registered = snapshot
  const verified = await timed(options, LAUNCH_PROGRESS_MS, signal => options.worktrees.verify(registered, receipt.request.target.relativeCwd, signal))
  if (!verified.ok) {
    yield await failProvisioning(options, receipt, registered, verified.timeout ? 'launch-timeout' : 'provision-failed')
    return
  }
  if (verified.value.status === 'failed') {
    yield await failProvisioning(options, receipt, registered, verified.value.reason)
    return
  }
  const verifiedSnapshot = verified.value.snapshot
  const provisioned = await transition(options, receipt, 'provisioned', { worktree: verifiedSnapshot })
  if (!provisioned) {
    yield STORAGE_CLOSE
    return
  }
  receipt = provisioned
  const freshAccess = await timed(options, LAUNCH_PROGRESS_MS, signal => options.access.resolve(receipt.request.modelProfileId, signal))
  if (!freshAccess.ok) {
    yield await failProvisioning(options, receipt, verifiedSnapshot, freshAccess.timeout ? 'launch-timeout' : 'runtime-unavailable')
    return
  }
  if (freshAccess.value.status === 'refused') {
    yield await failProvisioning(options, receipt, verifiedSnapshot, freshAccess.value.reason)
    return
  }
  releaseLane?.()
  const plan: LaunchPlan = freshAccess.value.plan
  const generatedSessionId = safeSync(() => options.identifiers.nextSessionId())
  if (!generatedSessionId.ok || !isSafeIdentifier(generatedSessionId.value)) {
    yield await fail(options, receipt, 'recovery-uncertain')
    return
  }
  const sessionId = generatedSessionId.value
  const intent = await transition(options, receipt, 'spawn-intent', { sessionId })
  if (!intent) {
    yield STORAGE_CLOSE
    return
  }
  receipt = intent
  const opened = await timed(options, LAUNCH_PROGRESS_MS, signal => options.channels.open(receipt.request.requestId, sessionId, signal))
  if (!opened.ok) {
    yield await fail(options, receipt, opened.timeout ? 'launch-timeout' : 'channel-unavailable')
    return
  }
  if (opened.value.status === 'failed') {
    yield await fail(options, receipt, opened.value.reason)
    return
  }
  const channelId = opened.value.channelId
  if (!isSafeIdentifier(channelId)) {
    await safe(() => options.channels.close(channelId, 'channel-unavailable'))
    yield await fail(options, receipt, 'channel-unavailable')
    return
  }
  const correlated = await persist(options, receipt, { channelId })
  if (!correlated) {
    await safe(() => options.channels.close(channelId, 'storage-unavailable'))
    yield STORAGE_CLOSE
    return
  }
  receipt = correlated
  const started = await timed(options, LAUNCH_PROGRESS_MS, signal => options.processes.start({
    requestId: receipt.request.requestId,
    sessionId,
    channelId,
    terminalProfile: receipt.request.terminalProfile,
    cwd: verifiedSnapshot.resolvedCwdPath,
    plan,
  }, signal))
  if (!started.ok) {
    const reason = await compensateProcess(
      options,
      sessionId,
      channelId,
      started.timeout ? 'launch-timeout' : 'spawn-failed',
    )
    yield await fail(options, receipt, reason)
    return
  }
  if (started.value.status === 'failed') {
    const reason = started.value.reason
    const closed = await safe(() => options.channels.close(channelId, reason))
    yield await fail(options, receipt, closed.ok ? reason : 'recovery-uncertain')
    return
  }
  const handle = started.value.handle
  if (handle.sessionId !== sessionId) {
    await safe(() => options.channels.close(channelId, 'recovery-uncertain'))
    yield await fail(options, receipt, 'recovery-uncertain')
    return
  }
  const live = await transition(options, receipt, 'started', { channelId, sessionId })
  if (!live || !(await audit(options, live))) {
    yield STORAGE_CLOSE
    return
  }
  receipt = live
  yield message({ type: 'SESSION_STARTED', requestId: receipt.request.requestId, channelId, sessionId })
  const finished = await safe(() => handle.finished)
  const result = finished.ok ? finishedResult(receipt.request.requestId, finished.value) : null
  if (!result) {
    yield await fail(options, receipt, 'recovery-uncertain')
    return
  }
  const terminal = await transition(options, receipt, 'finished', { result })
  if (!terminal || !(await audit(options, terminal))) {
    yield STORAGE_CLOSE
    return
  }
  yield message(result)
}

async function compensateProcess(
  options: SessionLauncherOptions,
  sessionId: string,
  channelId: string,
  definiteReason: Extract<SessionFailureReason, 'launch-timeout' | 'spawn-failed'>,
): Promise<SessionFailureReason> {
  const termination = await safe(() => options.processes.terminate(sessionId))
  const closed = await safe(() => options.channels.close(channelId, definiteReason))
  if (!termination.ok || termination.value === 'uncertain' || !closed.ok) return 'recovery-uncertain'
  return definiteReason
}

async function knownAction(
  options: SessionLauncherOptions,
  request: SessionStartMessage,
  fingerprint: string,
  value: SessionReceipt | SessionReceiptTombstone,
): Promise<SessionLaunchAction> {
  if (value.fingerprint !== fingerprint) return await refuse(options, request, fingerprint, 'request-conflict', false)
  if ('result' in value && !('request' in value)) {
    return (await auditTombstone(options, value)) ? message(value.result) : STORAGE_CLOSE
  }
  const receipt = value as SessionReceipt
  if (!(await audit(options, receipt))) return STORAGE_CLOSE
  if (receipt.result) return message(receipt.result)
  if (receipt.state === 'started' && receipt.sessionId && receipt.channelId) {
    return message({ type: 'SESSION_STARTED', requestId: request.requestId, sessionId: receipt.sessionId, channelId: receipt.channelId })
  }
  return message({ type: 'SESSION_ACCEPTED', requestId: request.requestId })
}

async function refuse(
  options: SessionLauncherOptions,
  request: SessionStartMessage,
  fingerprint: string,
  reason: SessionRefusalReason,
  persistReceipt: boolean,
): Promise<SessionLaunchAction> {
  const result = { type: 'SESSION_REFUSED' as const, requestId: request.requestId, reason }
  const now = clockTime(options)
  if (!now) return STORAGE_CLOSE
  let receipt = terminalReceipt(request, fingerprint, 'refused', result, now.iso)
  if (persistReceipt) {
    const stored = await safe(() => options.receipts.replace(1, receipt))
    if (!stored.ok || stored.value.status === 'storage-unavailable') return STORAGE_CLOSE
    if (stored.value.status === 'updated') receipt = stored.value.receipt
  }
  return (await audit(options, receipt)) ? message(result) : STORAGE_CLOSE
}

async function fail(
  options: SessionLauncherOptions,
  receipt: SessionReceipt,
  reason: SessionFailureReason,
): Promise<SessionLaunchAction> {
  const result = { type: 'SESSION_FAILED' as const, requestId: receipt.request.requestId, reason }
  const state = reason === 'recovery-uncertain' ? 'uncertain' : 'failed'
  const terminal = await transition(options, receipt, state, { result })
  return terminal && await audit(options, terminal) ? message(result) : STORAGE_CLOSE
}

async function failProvisioning(
  options: SessionLauncherOptions,
  receipt: SessionReceipt,
  snapshot: SessionWorktreeSnapshot,
  reason: SessionFailureReason,
): Promise<SessionLaunchAction> {
  if ('ownership' in snapshot && snapshot.ownership === 'reused') return await fail(options, receipt, reason)
  const rolledBack = await safe(() => options.worktrees.rollback(snapshot))
  const settledReason = !rolledBack.ok || rolledBack.value === 'uncertain' || rolledBack.value === 'not-owned'
    ? 'recovery-uncertain'
    : reason
  return await fail(options, receipt, settledReason)
}

async function journal(
  options: SessionLauncherOptions,
  receipt: SessionReceipt,
  worktree: SessionWorktreeSnapshot,
): Promise<SessionReceipt | null> {
  return await persist(options, receipt, { worktree })
}

async function transition(
  options: SessionLauncherOptions,
  receipt: SessionReceipt,
  state: SessionReceipt['state'],
  changes: Partial<SessionReceipt>,
): Promise<SessionReceipt | null> {
  const now = clockTime(options)
  if (!now) return null
  return await persist(options, receipt, {
    ...changes,
    state,
    phaseTimestamps: { ...receipt.phaseTimestamps, [state]: now.iso },
  })
}

async function persist(
  options: SessionLauncherOptions,
  receipt: SessionReceipt,
  changes: Partial<SessionReceipt>,
): Promise<SessionReceipt | null> {
  const result = await safe(() => options.receipts.replace(receipt.revision, { ...receipt, ...changes }))
  return result.ok && result.value.status === 'updated' ? result.value.receipt : null
}

async function auditTombstone(options: SessionLauncherOptions, tombstone: SessionReceiptTombstone): Promise<boolean> {
  const state = tombstone.result.type === 'SESSION_REFUSED'
    ? 'refused'
    : tombstone.result.type === 'SESSION_FINISHED'
      ? 'finished'
      : tombstone.result.reason === 'recovery-uncertain' ? 'uncertain' : 'failed'
  try {
    await options.audit.append({
      kind: 'session-launch',
      key: tombstone.key,
      state,
      at: tombstone.terminalAt,
      ...(tombstone.sessionId ? { sessionId: tombstone.sessionId } : {}),
      result: tombstone.result,
    })
    return true
  } catch {
    return false
  }
}

async function audit(options: SessionLauncherOptions, receipt: SessionReceipt): Promise<boolean> {
  const at = receipt.phaseTimestamps[receipt.state] ?? clockTime(options)?.iso
  if (!at) return false
  try {
    await options.audit.append({
      kind: 'session-launch',
      key: receipt.key,
      state: receipt.state,
      at,
      ...(receipt.sessionId ? { sessionId: receipt.sessionId } : {}),
      ...(receipt.result ? { result: receipt.result } : {}),
    })
    return true
  } catch {
    return false
  }
}

function terminalReceipt(
  request: SessionStartMessage,
  fingerprint: string,
  state: 'refused' | 'failed' | 'uncertain',
  result: SessionTerminalResult,
  at = new Date(0).toISOString(),
): SessionReceipt {
  return {
    schemaVersion: SESSION_RECEIPT_SCHEMA_VERSION,
    revision: 1,
    key: keyOf(request),
    fingerprint,
    request,
    state,
    phaseTimestamps: { [state]: at },
    worktree: { phase: 'none' },
    result,
  }
}

function validTargetSyntax(request: SessionStartMessage): boolean {
  return validBranch(request.target.branch) && validBranch(request.target.baseBranch)
}

function validBranch(value: string): boolean {
  if (!value || value.length > 255 || /[\u0000-\u0020\u007f~^:?*\\[]/.test(value)) return false
  if (value === '@' || value.startsWith('/') || value.endsWith('/') || value.endsWith('.') || value.includes('..') || value.includes('@{')) return false
  return value.split('/').every(component => component && !component.startsWith('.') && !component.endsWith('.lock'))
}

function finishedResult(
  requestId: string,
  value: { exitCode: number | null; signal: number | null },
): Extract<SessionTerminalResult, { type: 'SESSION_FINISHED' }> | null {
  if (value.exitCode !== null && Number.isSafeInteger(value.exitCode) && value.exitCode >= 0 && value.signal === null) {
    return { type: 'SESSION_FINISHED', requestId, exitCode: value.exitCode, signal: null }
  }
  if (value.signal !== null && Number.isSafeInteger(value.signal) && value.signal >= 0 && value.exitCode === null) {
    return { type: 'SESSION_FINISHED', requestId, exitCode: null, signal: value.signal }
  }
  return null
}

function sameProject(left: SessionReceipt['project'], right: LocalProjectRecord): boolean {
  return left?.projectId === right.projectId && left.revision === right.revision
    && left.repoPath === right.repoPath && left.worktreesRoot === right.worktreesRoot
}

function keyOf(request: SessionStartMessage) {
  return { bindingId: request.bindingId, requestId: request.requestId }
}

function message(message: SessionTerminalResult | { type: 'SESSION_ACCEPTED'; requestId: string } | { type: 'SESSION_STARTED'; requestId: string; channelId: string; sessionId: string }): SessionLaunchAction {
  return { kind: 'message', message }
}

function clockTime(options: SessionLauncherOptions): { ms: number; iso: string } | null {
  const ms = options.clock.now()
  if (!Number.isFinite(ms)) return null
  return { ms, iso: new Date(ms).toISOString() }
}

async function acquireLane(
  runtime: LauncherRuntime,
  request: SessionStartMessage,
): Promise<{ ok: true; value: LaneRelease } | { ok: false; timeout: boolean }> {
  const immediate = runtime.lanes.tryAcquire(request)
  if (immediate) return { ok: true, value: immediate }
  return await timed(runtime.options, LAUNCH_PROGRESS_MS, signal => runtime.lanes.acquire(request, signal))
}

async function waitForLane(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error('lane acquisition aborted')
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      cleanup()
      reject(new Error('lane acquisition aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void previous.then(
      () => {
        cleanup()
        resolve()
      },
      error => {
        cleanup()
        reject(error)
      },
    )
  })
}

async function timed<T>(
  options: SessionLauncherOptions,
  milliseconds: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; timeout: boolean }> {
  const controller = new AbortController()
  let settled = false
  let timedOut = false
  try {
    const operationResult = operation(controller.signal).then(
      async value => {
        if (timedOut) return await new Promise<never>(() => undefined)
        settled = true
        return { ok: true as const, value }
      },
      async () => {
        if (timedOut) return await new Promise<never>(() => undefined)
        settled = true
        return { ok: false as const, timeout: false }
      },
    )
    const timeout = options.clock.sleep(milliseconds).then(async () => {
      if (settled) return await new Promise<never>(() => undefined)
      timedOut = true
      controller.abort()
      return { ok: false as const, timeout: true }
    })
    return await Promise.race([operationResult, timeout])
  } catch {
    if (!settled) controller.abort()
    return { ok: false, timeout: false }
  }
}

function safeSync<T>(operation: () => T): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: operation() }
  } catch {
    return { ok: false }
  }
}

async function safe<T>(operation: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await operation() }
  } catch {
    return { ok: false }
  }
}

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
  type SessionLauncherOptions,
  type SessionProcessHandle,
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
    recover: () => recoverSessions(options),
  }
}

async function* recoverSessions(options: SessionLauncherOptions): AsyncGenerator<SessionLaunchAction> {
  const recovered = await safe(() => options.receipts.recover())
  if (!recovered.ok) {
    yield STORAGE_CLOSE
    return
  }
  yield* mergeRecovery(options, recovered.value)
}

async function* mergeRecovery(
  options: SessionLauncherOptions,
  receipts: readonly SessionReceipt[],
): AsyncGenerator<SessionLaunchAction> {
  const controller = new AbortController()
  const iterators = receipts.map(receipt => recoverReceipt(options, receipt, controller.signal)[Symbol.asyncIterator]())
  const pending = new Map(iterators.map((iterator, index) => [index, iterator.next()]))
  while (pending.size > 0) {
    const settled = await Promise.race([...pending].map(async ([index, result]) => ({ index, result: await result })))
    pending.delete(settled.index)
    if (settled.result.done) continue
    yield settled.result.value
    if (settled.result.value.kind === 'close-job-control') {
      controller.abort()
      return
    }
    pending.set(settled.index, iterators[settled.index]!.next())
  }
}

async function* recoverReceipt(
  options: SessionLauncherOptions,
  receipt: SessionReceipt,
  signal: AbortSignal,
): AsyncGenerator<SessionLaunchAction> {
  if (signal.aborted) return
  const binding = safeSync(() => options.bindingId())
  if (!binding.ok || binding.value !== receipt.key.bindingId) {
    yield await fail(options, receipt, 'recovery-uncertain')
    return
  }
  const project = await safe(() => options.projects.get(receipt.request.target.projectId))
  if (signal.aborted) return
  if (!project.ok || !project.value || !sameProject(receipt.project, project.value)) {
    yield await fail(options, receipt, 'recovery-uncertain')
    return
  }
  if (receipt.worktree.phase === 'none') {
    if (receipt.state !== 'accepted') {
      yield await fail(options, receipt, 'recovery-uncertain')
      return
    }
    if (!(await audit(options, receipt))) {
      yield STORAGE_CLOSE
      return
    }
    yield message({ type: 'SESSION_ACCEPTED', requestId: receipt.request.requestId })
    yield* continueLaunchInLane(options, receipt, project.value, signal)
    return
  }
  const inspected = await safe(() => options.worktrees.inspect(receipt.worktree))
  if (signal.aborted) return
  if (!inspected.ok || inspected.value !== 'exact') {
    yield await fail(options, receipt, 'recovery-uncertain')
    return
  }
  if (receipt.state === 'accepted') {
    if (!(await audit(options, receipt))) {
      yield STORAGE_CLOSE
      return
    }
    yield message({ type: 'SESSION_ACCEPTED', requestId: receipt.request.requestId })
    yield* recoverProvisioning(options, receipt, project.value, signal)
    return
  }
  if (receipt.worktree.phase !== 'verified') {
    yield await fail(options, receipt, 'recovery-uncertain')
    return
  }
  if (receipt.state === 'provisioned') {
    yield* startProvisioned(options, receipt, receipt.worktree, signal)
    return
  }
  if (receipt.state === 'spawn-intent' || receipt.state === 'started') {
    yield* recoverProcess(options, receipt, receipt.worktree, signal)
    return
  }
  yield await fail(options, receipt, 'recovery-uncertain')
}

async function* recoverProvisioning(
  options: SessionLauncherOptions,
  startingReceipt: SessionReceipt,
  project: LocalProjectRecord,
  recoverySignal: AbortSignal,
): AsyncGenerator<SessionLaunchAction> {
  if (recoverySignal.aborted) return
  let receipt = startingReceipt
  let snapshot = receipt.worktree
  if (snapshot.phase === 'branch-created') {
    const branch = snapshot
    const registered = await timed(
      options,
      LAUNCH_PROGRESS_MS,
      operationSignal => options.worktrees.register(branch, project, receipt.request.target, operationSignal),
      recoverySignal,
    )
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
    if (snapshot.phase === 'verified') {
      const provisioned = await transition(options, receipt, 'provisioned', { worktree: snapshot })
      if (!provisioned) yield STORAGE_CLOSE
      else yield* startProvisioned(options, provisioned, snapshot, recoverySignal)
      return
    }
    yield await fail(options, receipt, 'recovery-uncertain')
    return
  }
  const registered = snapshot
  const verified = await timed(
    options,
    LAUNCH_PROGRESS_MS,
    operationSignal => options.worktrees.verify(registered, receipt.request.target.relativeCwd, operationSignal),
    recoverySignal,
  )
  if (!verified.ok) {
    yield await failProvisioning(options, receipt, registered, verified.timeout ? 'launch-timeout' : 'provision-failed')
    return
  }
  if (verified.value.status === 'failed') {
    yield await failProvisioning(options, receipt, registered, verified.value.reason)
    return
  }
  const provisioned = await transition(options, receipt, 'provisioned', { worktree: verified.value.snapshot })
  if (!provisioned) {
    yield STORAGE_CLOSE
    return
  }
  yield* startProvisioned(options, provisioned, verified.value.snapshot, recoverySignal)
}

async function* recoverProcess(
  options: SessionLauncherOptions,
  startingReceipt: SessionReceipt,
  worktree: SessionWorktreeVerifiedSnapshot,
  recoverySignal: AbortSignal,
): AsyncGenerator<SessionLaunchAction> {
  if (recoverySignal.aborted) return
  const sessionId = startingReceipt.sessionId
  const prior = startingReceipt.channel
  if (!sessionId || !isSafeIdentifier(sessionId) || !prior || prior.lifecycle === 'replacement-intent' || !options.recoveryChannels) {
    yield await fail(options, startingReceipt, 'recovery-uncertain')
    return
  }
  const inspected = await safe(() => options.processes.inspect({ sessionId, cwd: worktree.resolvedCwdPath }))
  if (!inspected.ok || inspected.value !== 'exact' || recoverySignal.aborted) {
    yield await fail(options, startingReceipt, 'recovery-uncertain')
    return
  }
  const status = await safe(() => options.recoveryChannels!.status(prior.channelId, prior.generation, prior.connectionEpoch))
  if (!status.ok || (status.value !== 'closed' && status.value !== 'lost')) {
    yield await fail(options, startingReceipt, 'recovery-uncertain')
    return
  }
  const access = await timed(
    options,
    LAUNCH_PROGRESS_MS,
    operationSignal => options.access.resolve(startingReceipt.request.modelProfileId, operationSignal),
    recoverySignal,
  )
  if (!access.ok || access.value.status === 'refused') {
    yield await fail(options, startingReceipt, 'recovery-uncertain')
    return
  }
  const generation = prior.generation + 1
  if (!Number.isSafeInteger(generation)) {
    yield await fail(options, startingReceipt, 'recovery-uncertain')
    return
  }
  const claimed = await claimReplacement(options, startingReceipt, generation)
  if (claimed.status === 'storage-unavailable') {
    yield STORAGE_CLOSE
    return
  }
  if (claimed.status === 'contender') {
    const replay = await waitForReplacement(options, startingReceipt.key, claimed.current, generation)
    yield replay ?? STORAGE_CLOSE
    return
  }
  yield* openReplacement(options, claimed.receipt, worktree, access.value.plan, sessionId, generation, recoverySignal)
}

type ReplacementClaim =
  | { status: 'winner'; receipt: SessionReceipt }
  | { status: 'contender'; current: SessionReceipt | null }
  | { status: 'storage-unavailable' }

async function claimReplacement(
  options: SessionLauncherOptions,
  receipt: SessionReceipt,
  generation: number,
): Promise<ReplacementClaim> {
  const intent: SessionReceipt = {
    ...receipt,
    channel: { generation, lifecycle: 'replacement-intent', channelId: null },
  }
  const result = await safe(() => options.receipts.replace(receipt.revision, intent))
  if (!result.ok || result.value.status === 'storage-unavailable') return { status: 'storage-unavailable' }
  return result.value.status === 'updated'
    ? { status: 'winner', receipt: result.value.receipt }
    : { status: 'contender', current: result.value.current }
}

async function waitForReplacement(
  options: SessionLauncherOptions,
  key: SessionReceipt['key'],
  initial: SessionReceipt | null,
  generation: number,
): Promise<SessionLaunchAction | null> {
  let current = initial
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const action = current ? await replacementReplay(options, current, generation) : null
    if (action) return action
    const slept = await safe(() => options.clock.sleep(1))
    if (!slept.ok) return null
    const found = await safe(() => options.receipts.lookup(key))
    if (!found.ok || found.value.status !== 'receipt') return null
    current = found.value.receipt
  }
  return null
}

async function replacementReplay(
  options: SessionLauncherOptions,
  receipt: SessionReceipt,
  generation: number,
): Promise<SessionLaunchAction | null> {
  if (receipt.result) return (await audit(options, receipt)) ? message(receipt.result) : STORAGE_CLOSE
  if (receipt.state !== 'started' || !receipt.sessionId || receipt.channel?.generation !== generation
    || receipt.channel.lifecycle !== 'live' || !receipt.channel.channelId) return null
  return (await audit(options, receipt))
    ? message({ type: 'SESSION_STARTED', requestId: receipt.key.requestId, sessionId: receipt.sessionId, channelId: receipt.channel.channelId })
    : STORAGE_CLOSE
}

async function* openReplacement(
  options: SessionLauncherOptions,
  receipt: SessionReceipt,
  worktree: SessionWorktreeVerifiedSnapshot,
  plan: LaunchPlan,
  sessionId: string,
  generation: number,
  signal: AbortSignal,
): AsyncGenerator<SessionLaunchAction> {
  const opened = await timed(options, LAUNCH_PROGRESS_MS, operationSignal => options.channels.open(receipt.key.requestId, sessionId, operationSignal), signal)
  if (!opened.ok || opened.value.status === 'failed') {
    yield await fail(options, receipt, 'recovery-uncertain')
    return
  }
  const channelId = opened.value.channelId
  const connectionEpoch = opened.value.connectionEpoch
  if (!isSafeIdentifier(channelId)) {
    yield* closeFailedReplacement(options, receipt, channelId, generation, connectionEpoch)
    return
  }
  const stopClosing = closeChannelOnAbort(options, channelId, signal, generation, connectionEpoch)
  try {
    const adopted = await timed(options, LAUNCH_PROGRESS_MS, operationSignal => options.processes.adopt({
      requestId: receipt.key.requestId,
      sessionId,
      channelId,
      channelGeneration: generation,
      terminalProfile: receipt.request.terminalProfile,
      cwd: worktree.resolvedCwdPath,
      plan,
    }, operationSignal), signal)
    if (!adopted.ok || adopted.value.status === 'failed') {
      yield* closeFailedReplacement(options, receipt, channelId, generation, connectionEpoch)
      return
    }
    yield* publishStarted(
      options,
      receipt,
      worktree,
      channelId,
      sessionId,
      adopted.value.handle,
      signal,
      stopClosing,
      generation,
      connectionEpoch,
    )
  } finally {
    stopClosing()
  }
}

async function* closeFailedReplacement(
  options: SessionLauncherOptions,
  receipt: SessionReceipt,
  channelId: string,
  generation: number,
  connectionEpoch?: string,
): AsyncGenerator<SessionLaunchAction> {
  const closed = await safe(() => options.recoveryChannels!.closeExact(
    channelId,
    generation,
    'recovery-uncertain',
    connectionEpoch,
  ))
  if (!closed.ok || closed.value === 'unknown') {
    yield STORAGE_CLOSE
    return
  }
  yield await fail(options, receipt, 'recovery-uncertain')
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
    yield* continueLaunchInLane(runtime.options, receipt, project, undefined, acquired.value)
  } finally {
    acquired.value()
  }
}

async function* continueLaunchInLane(
  options: SessionLauncherOptions,
  startingReceipt: SessionReceipt,
  project: LocalProjectRecord,
  parentSignal?: AbortSignal,
  releaseLane?: LaneRelease,
): AsyncGenerator<SessionLaunchAction> {
  let receipt = startingReceipt
  const prepared = await timed(options, LAUNCH_PROGRESS_MS, signal => options.worktrees.prepare(project, receipt.request.target, signal), parentSignal)
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
    const registered = await timed(
      options,
      LAUNCH_PROGRESS_MS,
      signal => options.worktrees.register(branch, project, receipt.request.target, signal),
      parentSignal,
    )
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
  const verified = await timed(options, LAUNCH_PROGRESS_MS, signal => options.worktrees.verify(registered, receipt.request.target.relativeCwd, signal), parentSignal)
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
  yield* startProvisioned(options, provisioned, verifiedSnapshot, parentSignal, releaseLane)
}

async function* startProvisioned(
  options: SessionLauncherOptions,
  startingReceipt: SessionReceipt,
  worktree: SessionWorktreeVerifiedSnapshot,
  parentSignal?: AbortSignal,
  releaseLane?: LaneRelease,
): AsyncGenerator<SessionLaunchAction> {
  if (parentSignal?.aborted) return
  let receipt = startingReceipt
  const freshAccess = await timed(options, LAUNCH_PROGRESS_MS, signal => options.access.resolve(receipt.request.modelProfileId, signal), parentSignal)
  if (!freshAccess.ok) {
    yield await failProvisioning(options, receipt, worktree, freshAccess.timeout ? 'launch-timeout' : 'runtime-unavailable')
    return
  }
  if (freshAccess.value.status === 'refused') {
    yield await failProvisioning(options, receipt, worktree, freshAccess.value.reason)
    return
  }
  releaseLane?.()
  if (parentSignal?.aborted) return
  const generatedSessionId = safeSync(() => options.identifiers.nextSessionId())
  if (!generatedSessionId.ok || !isSafeIdentifier(generatedSessionId.value)) {
    yield await fail(options, receipt, 'recovery-uncertain')
    return
  }
  const sessionId = generatedSessionId.value
  const intent = await transition(options, receipt, 'spawn-intent', { sessionId })
  if (parentSignal?.aborted) return
  if (!intent) {
    yield STORAGE_CLOSE
    return
  }
  receipt = intent
  const opened = await timed(options, LAUNCH_PROGRESS_MS, signal => options.channels.open(receipt.request.requestId, sessionId, signal), parentSignal)
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
    const closed = await closeExactOrLegacy(options, channelId, 'channel-unavailable', 1, opened.value.connectionEpoch)
    yield closed === 'unknown' ? STORAGE_CLOSE : await fail(options, receipt, 'channel-unavailable')
    return
  }
  const correlation = await correlateChannel(options, receipt, channelId, 1, opened.value.connectionEpoch, parentSignal)
  if (correlation.aborted) return
  const correlated = correlation.receipt
  if (!correlated) {
    await closeExactOrLegacy(options, channelId, 'storage-unavailable', 1, opened.value.connectionEpoch)
    yield STORAGE_CLOSE
    return
  }
  receipt = correlated
  const plan: LaunchPlan = freshAccess.value.plan
  const processRequest = {
    requestId: receipt.request.requestId,
    sessionId,
    channelId,
    channelGeneration: 1,
    terminalProfile: receipt.request.terminalProfile,
    cwd: worktree.resolvedCwdPath,
    plan,
  }
  const stopClosingOnAbort = closeChannelOnAbort(options, channelId, parentSignal, 1, opened.value.connectionEpoch)
  let stopTerminatingOnAbort: () => void = () => undefined
  const releasePreStartGuards = () => {
    stopClosingOnAbort()
    stopTerminatingOnAbort()
  }
  try {
    const started = await timed(options, LAUNCH_PROGRESS_MS, signal => options.processes.start(processRequest, signal), parentSignal)
    if (!started.ok) {
      const compensation = await compensateProcess(
        options,
        { sessionId: processRequest.sessionId, cwd: processRequest.cwd },
        channelId,
        started.timeout ? 'launch-timeout' : 'spawn-failed',
        1,
        opened.value.connectionEpoch,
      )
      yield compensation === 'storage-unavailable'
        ? STORAGE_CLOSE
        : await fail(options, receipt, compensation)
      return
    }
    if (started.value.status === 'failed') {
      const reason = started.value.reason
      const closed = await closeExactOrLegacy(options, channelId, reason, 1, opened.value.connectionEpoch)
      yield closed === 'unknown' ? STORAGE_CLOSE : await fail(options, receipt, reason)
      return
    }
    stopTerminatingOnAbort = terminateProcessOnAbort(
      options,
      { sessionId: processRequest.sessionId, cwd: processRequest.cwd },
      parentSignal,
    )
    yield* publishStarted(
      options,
      receipt,
      worktree,
      channelId,
      sessionId,
      started.value.handle,
      parentSignal,
      releasePreStartGuards,
      1,
      opened.value.connectionEpoch,
    )
  } finally {
    releasePreStartGuards()
  }
}

async function* publishStarted(
  options: SessionLauncherOptions,
  startingReceipt: SessionReceipt,
  _worktree: SessionWorktreeVerifiedSnapshot,
  channelId: string,
  sessionId: string,
  handle: SessionProcessHandle,
  parentSignal?: AbortSignal,
  onStarted?: () => void,
  generation = 1,
  connectionEpoch?: string,
): AsyncGenerator<SessionLaunchAction> {
  if (parentSignal?.aborted) return
  let receipt = startingReceipt
  if (handle.sessionId !== sessionId
    || (handle.channelId !== undefined && handle.channelId !== channelId)
    || (handle.channelGeneration !== undefined && handle.channelGeneration !== generation)) {
    const closed = await closeExactOrLegacy(options, channelId, 'recovery-uncertain', generation, connectionEpoch)
    yield closed === 'unknown' ? STORAGE_CLOSE : await fail(options, receipt, 'recovery-uncertain')
    return
  }
  const live = await transition(options, receipt, 'started', {
    channelId,
    sessionId,
    channel: {
      generation,
      lifecycle: 'live',
      channelId,
      ...(connectionEpoch === undefined ? {} : { connectionEpoch }),
    },
  })
  if (parentSignal?.aborted) return
  if (!live || !(await audit(options, live))) {
    yield STORAGE_CLOSE
    return
  }
  if (parentSignal?.aborted) return
  receipt = live
  onStarted?.()
  yield message({ type: 'SESSION_STARTED', requestId: receipt.request.requestId, channelId, sessionId })
  const finished = await safe(() => handle.finished)
  if (parentSignal?.aborted) return
  const result = finished.ok ? finishedResult(receipt.request.requestId, finished.value) : null
  if (!result) {
    yield await fail(options, receipt, 'recovery-uncertain')
    return
  }
  if (options.channelEvents) {
    const settled = await safe(() => options.channelEvents!.handle({
      kind: 'terminal',
      key: receipt.key,
      sessionId,
      channelId,
      generation,
      exitCode: result.exitCode,
      signal: result.signal,
    }))
    if (!settled.ok || settled.value.status === 'unknown' || settled.value.status === 'storage-unavailable') {
      yield STORAGE_CLOSE
      return
    }
    if (settled.value.status === 'applied' && settled.value.action) yield settled.value.action
    return
  }
  const terminal = await transition(options, receipt, 'finished', {
    result,
    channel: {
      generation,
      lifecycle: 'closed',
      channelId,
      ...(connectionEpoch === undefined ? {} : { connectionEpoch }),
    },
  })
  if (!terminal || !(await audit(options, terminal))) {
    yield STORAGE_CLOSE
    return
  }
  yield message(result)
}

async function compensateProcess(
  options: SessionLauncherOptions,
  identity: { sessionId: string; cwd: string },
  channelId: string,
  definiteReason: Extract<SessionFailureReason, 'launch-timeout' | 'spawn-failed'>,
  generation?: number,
  connectionEpoch?: string,
): Promise<SessionFailureReason | 'storage-unavailable'> {
  const termination = await safe(() => options.processes.terminate(identity))
  const closed = await closeExactOrLegacy(options, channelId, definiteReason, generation, connectionEpoch)
  if (closed === 'unknown') return 'storage-unavailable'
  if (!termination.ok || termination.value === 'uncertain') return 'recovery-uncertain'
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

async function correlateChannel(
  options: SessionLauncherOptions,
  receipt: SessionReceipt,
  channelId: string,
  generation: number,
  connectionEpoch: string | undefined,
  signal?: AbortSignal,
): Promise<{ receipt: SessionReceipt | null; aborted: boolean }> {
  const stopClosingOnAbort = closeChannelOnAbort(options, channelId, signal, generation, connectionEpoch)
  if (signal?.aborted) {
    stopClosingOnAbort()
    return { receipt: null, aborted: true }
  }
  try {
    const correlated = await persist(options, receipt, {
      channelId,
      channel: {
        generation,
        lifecycle: 'live',
        channelId,
        ...(connectionEpoch === undefined ? {} : { connectionEpoch }),
      },
    })
    return { receipt: correlated, aborted: signal?.aborted ?? false }
  } finally {
    stopClosingOnAbort()
  }
}

function closeChannelOnAbort(
  options: SessionLauncherOptions,
  channelId: string,
  signal?: AbortSignal,
  generation?: number,
  connectionEpoch?: string,
): () => void {
  const close = () => { void closeExactOrLegacy(options, channelId, 'storage-unavailable', generation, connectionEpoch) }
  if (signal?.aborted) close()
  else signal?.addEventListener('abort', close, { once: true })
  return () => signal?.removeEventListener('abort', close)
}

async function closeExactOrLegacy(
  options: SessionLauncherOptions,
  channelId: string,
  reason: string,
  generation?: number,
  connectionEpoch?: string,
): Promise<'closed' | 'lost' | 'unknown'> {
  if (generation !== undefined && options.recoveryChannels) {
    const closed = await safe(() => options.recoveryChannels!.closeExact(channelId, generation, reason, connectionEpoch))
    return closed.ok ? closed.value : 'unknown'
  }
  const closed = await safe(() => options.channels.close(channelId, reason))
  return closed.ok ? 'closed' : 'unknown'
}

function terminateProcessOnAbort(
  options: SessionLauncherOptions,
  identity: { sessionId: string; cwd: string },
  signal?: AbortSignal,
): () => void {
  const terminate = () => { void safe(() => options.processes.terminate(identity)) }
  if (signal?.aborted) terminate()
  else signal?.addEventListener('abort', terminate, { once: true })
  return () => signal?.removeEventListener('abort', terminate)
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
  if (value === '@' || value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.') || value.includes('..') || value.includes('@{')) return false
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
  parentSignal?: AbortSignal,
): Promise<{ ok: true; value: T } | { ok: false; timeout: boolean }> {
  if (parentSignal?.aborted) return await new Promise<never>(() => undefined)
  const controller = new AbortController()
  const abortFromParent = () => controller.abort()
  parentSignal?.addEventListener('abort', abortFromParent, { once: true })
  let settled = false
  let timedOut = false
  try {
    const operationResult = operation(controller.signal).then(
      async value => {
        if (timedOut || parentSignal?.aborted) return await new Promise<never>(() => undefined)
        settled = true
        return { ok: true as const, value }
      },
      async () => {
        if (timedOut || parentSignal?.aborted) return await new Promise<never>(() => undefined)
        settled = true
        return { ok: false as const, timeout: false }
      },
    )
    const timeout = options.clock.sleep(milliseconds).then(async () => {
      if (settled || parentSignal?.aborted) return await new Promise<never>(() => undefined)
      timedOut = true
      controller.abort()
      return { ok: false as const, timeout: true }
    })
    return await Promise.race([operationResult, timeout])
  } catch {
    if (!settled) controller.abort()
    return { ok: false, timeout: false }
  } finally {
    parentSignal?.removeEventListener('abort', abortFromParent)
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

import {
  SESSION_FAILURE_REASONS,
  SESSION_REFUSAL_REASONS,
  sessionStartFingerprint,
  type SessionStartMessage,
} from '@modulastack/runner-protocol'
import type {
  SessionLaunchAction,
  SessionReceipt,
  SessionReceiptTombstone,
} from '../../src/index.js'
import { runtimeRedSensitiveValues } from './fixtureMaterial.js'
import type { RuntimeScenario } from './scenarioTypes.js'

export type StartedSessionEvidence = {
  requestId: string
  channelId: string
  sessionId: string
}

export type LaunchEvidence = {
  stored: ReadonlyMap<string, SessionReceipt | SessionReceiptTombstone>
  openedChannels: readonly StartedSessionEvidence[]
  durableStarts: readonly StartedSessionEvidence[]
}

export type LaunchStimulusResult = {
  actions: SessionLaunchAction[]
  batches: SessionLaunchAction[][]
  firstReceiptStable: boolean
  retention?: {
    replayedBeforeExpiry: boolean
    deletedAfterRetention: boolean
    refusedAfterRetention: boolean
  }
}

export async function collectLaunchStimuli(
  handle: (request: SessionStartMessage) => AsyncIterable<SessionLaunchAction>,
  scenario: RuntimeScenario,
  request: SessionStartMessage,
  stored: Map<string, SessionReceipt | SessionReceiptTombstone>,
  record: (event: string) => void,
  expireTombstone?: () => boolean | Promise<boolean>,
): Promise<LaunchStimulusResult> {
  if (!needsSecondStimulus(scenario.fixture)) {
    const first = await collect(handle(request), request.requestId, record)
    return { actions: first, batches: [first], firstReceiptStable: true }
  }
  if (scenario.fixture === 'tombstone-retention-retry') {
    const first = await collect(handle(request), request.requestId, record)
    const key = `${request.bindingId}:${request.requestId}`
    const replayedBeforeExpiry = isTombstone(stored.get(key)) && hasFinishedReplay(first, request.requestId)
    const deletedAfterRetention = expireTombstone ? await expireTombstone() : false
    const second = await collect(handle(request), request.requestId, record)
    return {
      actions: [...first, ...second],
      batches: [first, second],
      firstReceiptStable: true,
      retention: {
        replayedBeforeExpiry,
        deletedAfterRetention,
        refusedAfterRetention: hasRefusal(second, request.requestId, 'request-expired'),
      },
    }
  }
  const secondRequest = secondRequestFor(scenario, request)
  if (scenario.fixture.startsWith('concurrent-')) {
    const [first, second] = await Promise.all([
      collect(handle(request), request.requestId, record),
      collect(handle(secondRequest), secondRequest.requestId, record),
    ])
    return { actions: [...first, ...second], batches: [first, second], firstReceiptStable: true }
  }
  const first = await collect(handle(request), request.requestId, record)
  const key = `${request.bindingId}:${request.requestId}`
  const firstReceiptPresent = stored.has(key)
  const before = JSON.stringify(stored.get(key))
  const second = await collect(handle(secondRequest), secondRequest.requestId, record)
  return {
    actions: [...first, ...second],
    batches: [first, second],
    firstReceiptStable: firstReceiptPresent && stored.has(key) && before === JSON.stringify(stored.get(key)),
  }
}

export async function collectRecoveryStimulus(
  values: AsyncIterable<SessionLaunchAction>,
  expectedRequestId: string,
  record: (event: string) => void,
): Promise<LaunchStimulusResult> {
  const actions = await collect(values, expectedRequestId, record)
  return { actions, batches: [actions], firstReceiptStable: true }
}

export function recordLaunchScenarioEvidence(
  record: (event: string) => void,
  scenario: RuntimeScenario,
  observed: LaunchStimulusResult,
  request: SessionStartMessage,
  claimCalls: number,
  successfulClaims: number,
  evidence: LaunchEvidence,
) {
  if (claimCalls === 1) record('receipts.claim:once')
  if (successfulClaims === 1) {
    record('receipts.claim:atomic-one')
    record('receipts.claim:one-winner')
  }
  if (scenario.fixture === 'canonical-body-reordered') {
    const second = secondRequestFor(scenario, request)
    if (sessionStartFingerprint(request) === sessionStartFingerprint(second)) record('stimulus.fingerprint:same')
  }
  if (scenario.fixture.includes('duplicate') || scenario.fixture === 'canonical-body-reordered') {
    if (sameTerminalOutcome(observed.batches[0] ?? [], observed.batches[1] ?? [], request.requestId)) record('action.replay:same-outcome')
  }
  if (scenario.fixture === 'duplicate-different-body' && observed.firstReceiptStable) record('receipt.first:immutable')
  if (scenario.fixture === 'tombstone-retention-retry') {
    if (observed.retention?.replayedBeforeExpiry) record('receipt.tombstone:replayed-before-expiry')
    if (observed.retention?.deletedAfterRetention) record('receipt.tombstone:deleted-after-retention')
    if (observed.retention?.refusedAfterRetention) record('receipt.tombstone:request-expired')
  }
  if (hasStartedCorrelation(observed.actions, evidence, true, request.requestId)) record('action.started:request+channel+session')
  if (scenario.fixture.includes('known-terminal') && observed.batches.length > 0
    && observed.batches.every(batch => terminalReplayMatchesStored(batch, evidence.stored, request))) {
    record('action.replay:terminal')
  }
  if (scenario.fixture.includes('known-started') && hasStartedCorrelation(observed.actions, evidence, false, request.requestId)) {
    record('action.started:stable-correlation')
  }
  if (scenario.fixture === 'recover-exact-session' && hasNewChannelStableSession(observed.actions, evidence, request.requestId)) {
    record('action.started:new-channel+stable-session')
  }
  if (scenario.fixture === 'refusal-vocabulary' && hasOnlyClosedReasons(observed.actions)) record('action.refusal-vocabulary:closed')
}

function needsSecondStimulus(fixture: string): boolean {
  return fixture.includes('duplicate') || fixture.includes('concurrent') || fixture === 'canonical-body-reordered'
    || fixture === 'same-target-distinct-requests' || fixture === 'tombstone-retention-retry'
}

function secondRequestFor(scenario: RuntimeScenario, request: SessionStartMessage): SessionStartMessage {
  if (scenario.fixture.includes('different-body')) return { ...request, modelProfileId: 'different-profile' }
  if (scenario.fixture === 'same-target-distinct-requests' || scenario.fixture === 'concurrent-same-lane') {
    return { ...request, requestId: nextRequestId(request.requestId) }
  }
  if (scenario.fixture === 'canonical-body-reordered') {
    return {
      target: {
        relativeCwd: request.target.relativeCwd,
        baseBranch: request.target.baseBranch,
        branch: request.target.branch,
        worktreeName: request.target.worktreeName,
        projectId: request.target.projectId,
      },
      modelProfileId: request.modelProfileId,
      terminalProfile: request.terminalProfile,
      expiresAt: request.expiresAt,
      requestId: request.requestId,
      bindingId: request.bindingId,
      type: 'SESSION_START',
    }
  }
  return request
}

function recordAction(
  record: (event: string) => void,
  action: SessionLaunchAction,
  expectedRequestId: string,
) {
  if (action.kind === 'close-job-control') {
    record(`action.close:${action.error}`)
    return
  }
  const message = action.message
  if (containsSensitiveActionData(message)) record('action.sensitive-field')
  if (message.type === 'SESSION_ACCEPTED') record('action.accepted')
  if (message.type === 'SESSION_STARTED') record('action.started')
  if (message.type === 'SESSION_REFUSED') record(`action.refused:${message.reason}`)
  if (message.type === 'SESSION_FAILED') record(`action.failed:${message.reason}`)
  if (message.type === 'SESSION_FINISHED') record('action.finished')
  if (message.requestId === expectedRequestId) {
    record(`action.requestId:${expectedRequestId}`)
    record(`input.request:${expectedRequestId}`)
  }
}

const forbiddenActionFields = new Set([
  'accesstoken', 'allowlist', 'apikey', 'args', 'argtemplate', 'argv', 'attachtoken', 'authorization', 'bearer',
  'bearertoken', 'command', 'confirmationnonce', 'credential', 'endpoint', 'endpointaddress', 'endpointid',
  'endpointurl', 'env', 'environment', 'executable', 'hmac', 'key', 'keyfingerprint', 'keylabel', 'password',
  'privatekey', 'proof', 'recipe', 'secret', 'secretkey', 'secrets', 'sessiontoken', 'signature', 'signingkey',
  'signingmaterial', 'token', 'tokenproof', 'trustanchor', 'url',
])

export function containsSensitiveActionData(value: unknown): boolean {
  if (typeof value === 'string') return runtimeRedSensitiveValues.some(sensitive => value.includes(sensitive))
  if (Array.isArray(value)) return value.some(containsSensitiveActionData)
  if (!isRecord(value)) return false
  return Object.entries(value).some(([field, child]) => {
    return forbiddenActionFields.has(normalizeFieldName(field)) || containsSensitiveActionData(child)
  })
}

function normalizeFieldName(field: string): string {
  return field.replaceAll(/[-_]/g, '').toLowerCase()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameTerminalOutcome(
  first: readonly SessionLaunchAction[],
  second: readonly SessionLaunchAction[],
  expectedRequestId: string,
): boolean {
  const firstResult = terminalMessage(first)
  const secondResult = terminalMessage(second)
  return firstResult !== null && secondResult !== null
    && firstResult.requestId === expectedRequestId
    && secondResult.requestId === expectedRequestId
    && sameTerminalMessage(firstResult, secondResult)
}

function terminalMessage(actions: readonly SessionLaunchAction[]) {
  const terminals = terminalMessages(actions)
  return terminals.length === 1 ? terminals[0]! : null
}

function terminalMessages(actions: readonly SessionLaunchAction[]) {
  return actions
    .flatMap(action => action.kind === 'message' ? [action.message] : [])
    .filter(message => message.type === 'SESSION_REFUSED' || message.type === 'SESSION_FAILED' || message.type === 'SESSION_FINISHED')
}

export function terminalReplayMatchesStored(
  actions: readonly SessionLaunchAction[],
  stored: ReadonlyMap<string, SessionReceipt | SessionReceiptTombstone>,
  request: SessionStartMessage,
): boolean {
  const storedValue = stored.get(`${request.bindingId}:${request.requestId}`)
  const expected = storedValue?.result
  const terminals = terminalMessages(actions)
  return expected !== undefined
    && expected.requestId === request.requestId
    && terminals.length === 1
    && terminals[0]?.requestId === request.requestId
    && sameTerminalMessage(terminals[0]!, expected)
}

function sameTerminalMessage(
  left: NonNullable<ReturnType<typeof terminalMessage>>,
  right: NonNullable<ReturnType<typeof terminalMessage>>,
): boolean {
  if (left.type !== right.type || left.requestId !== right.requestId) return false
  if (left.type === 'SESSION_FINISHED') return right.type === 'SESSION_FINISHED'
    && left.exitCode === right.exitCode && left.signal === right.signal
  return right.type !== 'SESSION_FINISHED' && left.reason === right.reason
}

function hasFinishedReplay(actions: readonly SessionLaunchAction[], requestId: string): boolean {
  const terminal = terminalMessage(actions)
  return terminal?.type === 'SESSION_FINISHED' && terminal.requestId === requestId
}

function hasRefusal(
  actions: readonly SessionLaunchAction[],
  requestId: string,
  reason: 'request-expired',
): boolean {
  const terminal = terminalMessage(actions)
  return terminal?.type === 'SESSION_REFUSED' && terminal.requestId === requestId && terminal.reason === reason
}

function isTombstone(value: SessionReceipt | SessionReceiptTombstone | undefined): value is SessionReceiptTombstone {
  return value !== undefined && !('request' in value)
}

function hasStartedCorrelation(
  actions: readonly SessionLaunchAction[],
  evidence: LaunchEvidence,
  requireOpenChannel: boolean,
  expectedRequestId: string,
): boolean {
  return actions.some(action => {
    if (action.kind !== 'message' || action.message.type !== 'SESSION_STARTED') return false
    const message = action.message
    const matches = (candidate: StartedSessionEvidence) => candidate.requestId === expectedRequestId
      && message.requestId === expectedRequestId
      && candidate.channelId === message.channelId && candidate.sessionId === message.sessionId
    return evidence.durableStarts.some(matches) && (!requireOpenChannel || evidence.openedChannels.some(matches))
  })
}

function hasNewChannelStableSession(
  actions: readonly SessionLaunchAction[],
  evidence: LaunchEvidence,
  expectedRequestId: string,
): boolean {
  return actions.some(action => action.kind === 'message' && action.message.type === 'SESSION_STARTED'
    && action.message.sessionId === 'session-stable' && action.message.channelId !== 'channel-old'
    && hasStartedCorrelation([action], evidence, true, expectedRequestId))
}

function hasOnlyClosedReasons(actions: readonly SessionLaunchAction[]): boolean {
  const outcomes = actions.flatMap(action => action.kind === 'message' ? [action.message] : [])
    .filter(message => message.type === 'SESSION_REFUSED' || message.type === 'SESSION_FAILED')
  return outcomes.length > 0 && outcomes.every(message => message.type === 'SESSION_REFUSED'
    ? (SESSION_REFUSAL_REASONS as readonly string[]).includes(message.reason)
    : (SESSION_FAILURE_REASONS as readonly string[]).includes(message.reason))
}

function nextRequestId(requestId: string): string {
  return `${requestId.slice(0, -1)}${requestId.endsWith('f') ? 'e' : 'f'}`
}

const MAX_LAUNCH_ACTIONS = 8

async function collect(
  values: AsyncIterable<SessionLaunchAction>,
  expectedRequestId: string,
  record: (event: string) => void,
): Promise<SessionLaunchAction[]> {
  const actions: SessionLaunchAction[] = []
  for await (const action of values) {
    if (actions.length === MAX_LAUNCH_ACTIONS) {
      throw new Error(`session launch emitted ${actions.length + 1} actions; maximum is ${MAX_LAUNCH_ACTIONS}`)
    }
    actions.push(action)
    recordAction(record, action, expectedRequestId)
  }
  return actions
}

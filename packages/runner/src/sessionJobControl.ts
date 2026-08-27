import {
  MAX_FRAME_BYTES,
  SESSION_LAUNCH_PROTOCOL_VERSION,
  isLowercaseUuidV4,
  isSafeIdentifier,
  parseSessionLaunchClientMessage,
  sessionLaunchPayload,
  sessionStartFingerprint,
  type Payload,
} from '@modulastack/runner-protocol'
import type { AuditLog } from './auditLog.js'
import { AsyncReplayCache } from './asyncReplay.js'
import type { RunnerClock } from './runtimeClock.js'
import type { SessionLaunchAction, SessionLauncher } from './sessionLaunch.js'

const MAX_REPLAYED_SESSION_ACTIONS = 8

export const SESSION_JOB_CONTROL_ERRORS = [
  'unsupported-session-launch',
  'invalid-session-launch',
  'storage-unavailable',
] as const
export type SessionJobControlError = (typeof SESSION_JOB_CONTROL_ERRORS)[number]

export type SessionJobControlPhase = 'pre-welcome' | 'active' | 'reconnecting'

export type SessionJobControlContext = {
  connectionId: string
  channelId: string
  phase: SessionJobControlPhase
  selectedProtocolVersion: number | null
  authenticatedBindingId: string | null
}

export type SessionJobControlInput = {
  context: SessionJobControlContext
  payload: Payload
}

export type SessionJobControlEffect =
  | { kind: 'send'; channelId: string; payload: Payload }
  | { kind: 'close-job-control'; channelId: string; error: SessionJobControlError }
  | { kind: 'not-session' }

export type SessionConnectionAuditReason =
  | Exclude<SessionJobControlError, 'storage-unavailable'>
  | 'binding-mismatch'

export type SessionConnectionAuditRecord = {
  kind: 'session-connection-refusal'
  connectionId: string
  channelId: string
  requestId: string | null
  reason: SessionConnectionAuditReason
  selectedProtocolVersion: number | null
  phase: SessionJobControlPhase
  at: string
}

export interface SessionJobControl {
  dispatch(input: SessionJobControlInput): AsyncIterable<SessionJobControlEffect>
  recover(context: SessionJobControlContext): AsyncIterable<SessionJobControlEffect>
}

export type SessionJobControlOptions = {
  launcher: SessionLauncher
  audit?: Pick<AuditLog, 'append'>
  clock?: RunnerClock
}

export class SessionJobControlNotImplementedError extends Error {
  constructor() {
    super('session job-control composition is interface-only and is not active')
    this.name = 'SessionJobControlNotImplementedError'
  }
}

export function createSessionJobControl(options: SessionJobControlOptions): SessionJobControl {
  const replays = new AsyncReplayCache<SessionLaunchAction>(4_096, MAX_REPLAYED_SESSION_ACTIONS)
  return {
    dispatch: input => dispatch(options, replays, input),
    recover: context => recover(options.launcher, context),
  }
}

async function* dispatch(
  options: SessionJobControlOptions,
  replays: AsyncReplayCache<SessionLaunchAction>,
  input: SessionJobControlInput,
): AsyncGenerator<SessionJobControlEffect> {
  if (!sessionCandidate(input.payload)) {
    yield { kind: 'not-session' }
    return
  }
  if (!launchNegotiated(input.context)) {
    yield await auditedClose(options, input.context, 'unsupported-session-launch', null)
    return
  }
  const body = input.payload.codec === 'json' ? input.payload.body : null
  const requestId = recognizableRequestId(body)
  if (!boundedJson(body)) {
    yield await auditedClose(options, input.context, 'invalid-session-launch', requestId)
    return
  }
  const request = parseSessionLaunchClientMessage(body, SESSION_LAUNCH_PROTOCOL_VERSION)
  if (!request) {
    const correlated = requestId && !hasUnsafeDeclaredIdentifier(body) ? requestId : null
    if (correlated && await appendRefusal(options, input.context, 'invalid-session-launch', correlated)) {
      yield {
        kind: 'send',
        channelId: input.context.channelId,
        payload: sessionLaunchPayload({ type: 'SESSION_REFUSED', requestId: correlated, reason: 'invalid-request' }),
      }
      return
    }
    yield correlated
      ? storageClose(input.context)
      : await auditedClose(options, input.context, 'invalid-session-launch', null)
    return
  }
  if (input.context.authenticatedBindingId !== request.bindingId) {
    if (await appendRefusal(options, input.context, 'binding-mismatch', request.requestId)) {
      yield {
        kind: 'send',
        channelId: input.context.channelId,
        payload: sessionLaunchPayload({ type: 'SESSION_REFUSED', requestId: request.requestId, reason: 'binding-mismatch' }),
      }
    } else {
      yield storageClose(input.context)
    }
    return
  }
  const key = `${request.bindingId}\u0000${request.requestId}\u0000${sessionStartFingerprint(request)}`
  for await (const action of replays.stream(key, () => options.launcher.handle(request))) {
    yield effectFor(input.context, action)
  }
}

async function* recover(
  launcher: SessionLauncher,
  context: SessionJobControlContext,
): AsyncGenerator<SessionJobControlEffect> {
  if (!launchNegotiated(context)) return
  if (!context.authenticatedBindingId) {
    yield storageClose(context)
    return
  }
  for await (const action of launcher.recover(context.authenticatedBindingId)) yield effectFor(context, action)
}

function effectFor(context: SessionJobControlContext, action: SessionLaunchAction): SessionJobControlEffect {
  if (action.kind === 'close-job-control') return storageClose(context)
  return { kind: 'send', channelId: context.channelId, payload: sessionLaunchPayload(action.message) }
}

async function auditedClose(
  options: SessionJobControlOptions,
  context: SessionJobControlContext,
  reason: Exclude<SessionJobControlError, 'storage-unavailable'>,
  requestId: string | null,
): Promise<SessionJobControlEffect> {
  return await appendRefusal(options, context, reason, requestId)
    ? { kind: 'close-job-control', channelId: context.channelId, error: reason }
    : storageClose(context)
}

async function appendRefusal(
  options: SessionJobControlOptions,
  context: SessionJobControlContext,
  reason: SessionConnectionAuditReason,
  requestId: string | null,
): Promise<boolean> {
  if (!options.audit || !options.clock) return false
  const at = new Date(options.clock.now())
  if (!Number.isFinite(at.getTime())) return false
  const record: SessionConnectionAuditRecord = {
    kind: 'session-connection-refusal',
    connectionId: sanitizedId(context.connectionId),
    channelId: sanitizedId(context.channelId),
    requestId,
    reason,
    selectedProtocolVersion: context.selectedProtocolVersion,
    phase: context.phase,
    at: at.toISOString(),
  }
  try {
    await options.audit.append(record)
    return true
  } catch {
    return false
  }
}

function sessionCandidate(payload: Payload): boolean {
  if (payload.codec !== 'json' || !isRecord(payload.body)) return false
  return typeof payload.body.type === 'string' && payload.body.type.startsWith('SESSION_')
}

function launchNegotiated(context: SessionJobControlContext): boolean {
  return context.phase === 'active' && context.selectedProtocolVersion === SESSION_LAUNCH_PROTOCOL_VERSION
}

function recognizableRequestId(value: unknown): string | null {
  if (!isRecord(value) || value.type !== 'SESSION_START') return null
  return isLowercaseUuidV4(value.requestId) ? value.requestId : null
}

function hasUnsafeDeclaredIdentifier(value: unknown): boolean {
  if (!isRecord(value)) return false
  const target = isRecord(value.target) ? value.target : {}
  return [value.terminalProfile, value.modelProfileId, target.projectId, target.worktreeName]
    .some(candidate => candidate !== undefined && !isSafeIdentifier(candidate))
}

function boundedJson(value: unknown): boolean {
  try {
    const encoded = JSON.stringify(value)
    return typeof encoded === 'string' && Buffer.byteLength(encoded) <= MAX_FRAME_BYTES
  } catch {
    return false
  }
}

function storageClose(context: SessionJobControlContext): SessionJobControlEffect {
  return { kind: 'close-job-control', channelId: context.channelId, error: 'storage-unavailable' }
}

function sanitizedId(value: string): string {
  return isSafeIdentifier(value) ? value : 'unknown'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

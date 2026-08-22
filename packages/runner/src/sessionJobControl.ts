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
import type { RunnerClock } from './runtimeClock.js'
import type { SessionLaunchAction, SessionLauncher } from './sessionLaunch.js'

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
  const replays = new Map<string, ReplayEntry>()
  return {
    dispatch: input => dispatch(options, replays, input),
    recover: context => recover(options.launcher, context),
  }
}

type ReplayEntry = {
  actions: SessionLaunchAction[]
  done: boolean
  failed: boolean
  failure: unknown
  waiters: Set<() => void>
}

const MAX_REPLAY_ENTRIES = 4_096

async function* dispatch(
  options: SessionJobControlOptions,
  replays: Map<string, ReplayEntry>,
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
  let replay = replays.get(key)
  if (!replay) {
    replay = { actions: [], done: false, failed: false, failure: undefined, waiters: new Set() }
    replays.set(key, replay)
    evictCompletedReplays(replays)
    void pumpReplay(replay, options.launcher.handle(request))
  }
  for await (const action of replayActions(replay)) yield effectFor(input.context, action)
}

async function pumpReplay(entry: ReplayEntry, actions: AsyncIterable<SessionLaunchAction>): Promise<void> {
  try {
    for await (const action of actions) {
      entry.actions.push(structuredClone(action))
      notifyReplay(entry)
    }
  } catch (error) {
    entry.failed = true
    entry.failure = error
  } finally {
    entry.done = true
    notifyReplay(entry)
  }
}

async function* replayActions(entry: ReplayEntry): AsyncGenerator<SessionLaunchAction> {
  let index = 0
  for (;;) {
    while (index < entry.actions.length) {
      yield entry.actions[index]!
      index += 1
    }
    if (entry.done) {
      if (entry.failed) throw entry.failure
      return
    }
    await new Promise<void>(resolve => entry.waiters.add(resolve))
  }
}

function notifyReplay(entry: ReplayEntry): void {
  const waiters = [...entry.waiters]
  entry.waiters.clear()
  for (const resolve of waiters) resolve()
}

function evictCompletedReplays(replays: Map<string, ReplayEntry>): void {
  if (replays.size <= MAX_REPLAY_ENTRIES) return
  for (const [key, entry] of replays) {
    if (!entry.done) continue
    replays.delete(key)
    if (replays.size <= MAX_REPLAY_ENTRIES) return
  }
}

async function* recover(
  launcher: SessionLauncher,
  context: SessionJobControlContext,
): AsyncGenerator<SessionJobControlEffect> {
  if (!launchNegotiated(context)) return
  for await (const action of launcher.recover()) yield effectFor(context, action)
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

import { createHash } from 'node:crypto'
import { isSafeIdentifier, type Payload } from './frames.js'
import { isBoundedControlFreeString, isLowercaseUuidV4, isRecord, isRfc3339Utc } from './validation.js'
import { SESSION_LAUNCH_PROTOCOL_VERSION } from './version.js'
export const MAX_SESSION_BRANCH_LENGTH = 255
export const MAX_SESSION_RELATIVE_CWD_LENGTH = 1024
export const MAX_SESSION_REQUEST_AGE_MS = 24 * 60 * 60 * 1000

export const SESSION_REFUSAL_REASONS = [
  'invalid-request',
  'binding-mismatch',
  'project-unknown',
  'path-not-granted',
  'runner-paused',
  'worktree-invalid',
  'at-capacity',
  'request-conflict',
  'request-expired',
  'unknown-profile',
  'runtime-unknown',
  'runtime-unavailable',
  'runtime-unauthenticated',
  'access-unsupported',
  'unknown-key',
  'key-provider-mismatch',
  'unknown-endpoint',
  'endpoint-unavailable',
  'model-unavailable',
  'profile-incomplete',
] as const
export type SessionRefusalReason = (typeof SESSION_REFUSAL_REASONS)[number]

export const SESSION_FAILURE_REASONS = [
  'project-unknown',
  'path-not-granted',
  'worktree-invalid',
  'worktree-conflict',
  'provision-failed',
  'spawn-failed',
  'channel-unavailable',
  'launch-timeout',
  'recovery-uncertain',
  'unknown-profile',
  'runtime-unknown',
  'runtime-unavailable',
  'runtime-unauthenticated',
  'access-unsupported',
  'unknown-key',
  'key-provider-mismatch',
  'unknown-endpoint',
  'endpoint-unavailable',
  'model-unavailable',
  'profile-incomplete',
] as const
export type SessionFailureReason = (typeof SESSION_FAILURE_REASONS)[number]

export type SessionLaunchTarget = {
  projectId: string
  worktreeName: string
  branch: string
  baseBranch: string
  relativeCwd: string
}

export type SessionStartMessage = {
  type: 'SESSION_START'
  bindingId: string
  requestId: string
  expiresAt: string
  terminalProfile: string
  modelProfileId: string
  target: SessionLaunchTarget
}

export type SessionAcceptedMessage = { type: 'SESSION_ACCEPTED'; requestId: string }
export type SessionStartedMessage = { type: 'SESSION_STARTED'; requestId: string; channelId: string; sessionId: string }
export type SessionRefusedMessage = { type: 'SESSION_REFUSED'; requestId: string; reason: SessionRefusalReason }
export type SessionFailedMessage = { type: 'SESSION_FAILED'; requestId: string; reason: SessionFailureReason }
export type SessionFinishedMessage =
  | { type: 'SESSION_FINISHED'; requestId: string; exitCode: number; signal: null }
  | { type: 'SESSION_FINISHED'; requestId: string; exitCode: null; signal: number }

export type SessionLaunchClientMessage = SessionStartMessage
export type SessionLaunchServerMessage =
  | SessionAcceptedMessage
  | SessionStartedMessage
  | SessionRefusedMessage
  | SessionFailedMessage
  | SessionFinishedMessage

export type SessionStartIdentity = Pick<SessionStartMessage, 'bindingId' | 'requestId'>
export type SessionStartDeadline = 'admissible' | 'expired' | 'too-far' | 'invalid'

export function decodeSessionLaunchClientMessage(payload: Payload, protocolVersion: number): SessionLaunchClientMessage | null {
  return payload.codec === 'json' ? parseSessionLaunchClientMessage(payload.body, protocolVersion) : null
}

export function decodeSessionLaunchServerMessage(payload: Payload, protocolVersion: number): SessionLaunchServerMessage | null {
  return payload.codec === 'json' ? parseSessionLaunchServerMessage(payload.body, protocolVersion) : null
}

export function parseSessionLaunchClientMessage(value: unknown, protocolVersion: number): SessionLaunchClientMessage | null {
  if (protocolVersion !== SESSION_LAUNCH_PROTOCOL_VERSION || !isRecord(value) || value.type !== 'SESSION_START') return null
  return parseSessionStart(value)
}

export function parseSessionLaunchServerMessage(value: unknown, protocolVersion: number): SessionLaunchServerMessage | null {
  if (protocolVersion !== SESSION_LAUNCH_PROTOCOL_VERSION || !isRecord(value)) return null
  if (value.type === 'SESSION_ACCEPTED') return requestOnly(value, 'SESSION_ACCEPTED')
  if (value.type === 'SESSION_STARTED') return sessionStarted(value)
  if (value.type === 'SESSION_REFUSED') return sessionRefused(value)
  if (value.type === 'SESSION_FAILED') return sessionFailed(value)
  if (value.type === 'SESSION_FINISHED') return sessionFinished(value)
  return null
}

export function sessionStartIdentity(value: unknown): SessionStartIdentity | null {
  if (!isRecord(value) || value.type !== 'SESSION_START') return null
  if (!isLowercaseUuidV4(value.bindingId) || !isLowercaseUuidV4(value.requestId)) return null
  return { bindingId: value.bindingId, requestId: value.requestId }
}

export function sessionStartDeadline(expiresAt: string, nowMs: number): SessionStartDeadline {
  if (!isRfc3339Utc(expiresAt) || !Number.isFinite(nowMs)) return 'invalid'
  const deadline = Date.parse(expiresAt)
  if (deadline <= nowMs) return 'expired'
  return deadline - nowMs <= MAX_SESSION_REQUEST_AGE_MS ? 'admissible' : 'too-far'
}

export function canonicalSessionStart(message: SessionStartMessage): string {
  return JSON.stringify({
    bindingId: message.bindingId,
    expiresAt: message.expiresAt,
    modelProfileId: message.modelProfileId,
    requestId: message.requestId,
    target: {
      baseBranch: message.target.baseBranch,
      branch: message.target.branch,
      projectId: message.target.projectId,
      relativeCwd: message.target.relativeCwd,
      worktreeName: message.target.worktreeName,
    },
    terminalProfile: message.terminalProfile,
    type: message.type,
  })
}

export function sessionStartFingerprint(message: SessionStartMessage): string {
  return createHash('sha256').update(canonicalSessionStart(message), 'utf8').digest('hex')
}

export function sessionLaunchPayload(message: SessionLaunchClientMessage | SessionLaunchServerMessage): Payload {
  const normalized = message.type === 'SESSION_START'
    ? parseSessionLaunchClientMessage(message, SESSION_LAUNCH_PROTOCOL_VERSION)
    : parseSessionLaunchServerMessage(message, SESSION_LAUNCH_PROTOCOL_VERSION)
  if (!normalized) throw new TypeError('invalid session-launch message')
  return { codec: 'json', body: normalized }
}

export function isSessionRefusalReason(value: unknown): value is SessionRefusalReason {
  return typeof value === 'string' && (SESSION_REFUSAL_REASONS as readonly string[]).includes(value)
}

export function isSessionFailureReason(value: unknown): value is SessionFailureReason {
  return typeof value === 'string' && (SESSION_FAILURE_REASONS as readonly string[]).includes(value)
}

function parseSessionStart(value: Record<string, unknown>): SessionStartMessage | null {
  const identity = sessionStartIdentity(value)
  if (!identity || !isRfc3339Utc(value.expiresAt)) return null
  if (!isSafeIdentifier(value.terminalProfile) || !isSafeIdentifier(value.modelProfileId)) return null
  const target = parseTarget(value.target)
  return target ? { type: 'SESSION_START', ...identity, expiresAt: value.expiresAt, terminalProfile: value.terminalProfile, modelProfileId: value.modelProfileId, target } : null
}

function parseTarget(value: unknown): SessionLaunchTarget | null {
  if (!isRecord(value) || !isSafeIdentifier(value.projectId) || !isSafeIdentifier(value.worktreeName)) return null
  if (!isBranch(value.branch) || !isBranch(value.baseBranch) || !isRelativeCwd(value.relativeCwd)) return null
  return {
    projectId: value.projectId,
    worktreeName: value.worktreeName,
    branch: value.branch,
    baseBranch: value.baseBranch,
    relativeCwd: value.relativeCwd,
  }
}

function requestOnly<T extends 'SESSION_ACCEPTED'>(value: Record<string, unknown>, type: T): SessionAcceptedMessage | null {
  return isLowercaseUuidV4(value.requestId) ? { type, requestId: value.requestId } : null
}

function sessionStarted(value: Record<string, unknown>): SessionStartedMessage | null {
  if (!isLowercaseUuidV4(value.requestId) || !isSafeIdentifier(value.channelId) || !isSafeIdentifier(value.sessionId)) return null
  return { type: 'SESSION_STARTED', requestId: value.requestId, channelId: value.channelId, sessionId: value.sessionId }
}

function sessionRefused(value: Record<string, unknown>): SessionRefusedMessage | null {
  if (!isLowercaseUuidV4(value.requestId) || !isSessionRefusalReason(value.reason)) return null
  return { type: 'SESSION_REFUSED', requestId: value.requestId, reason: value.reason }
}

function sessionFailed(value: Record<string, unknown>): SessionFailedMessage | null {
  if (!isLowercaseUuidV4(value.requestId) || !isSessionFailureReason(value.reason)) return null
  return { type: 'SESSION_FAILED', requestId: value.requestId, reason: value.reason }
}

function sessionFinished(value: Record<string, unknown>): SessionFinishedMessage | null {
  if (!isLowercaseUuidV4(value.requestId)) return null
  const exitCode = nonNegativeInteger(value.exitCode)
  const signal = nonNegativeInteger(value.signal)
  if (exitCode !== null && value.signal === null) return { type: 'SESSION_FINISHED', requestId: value.requestId, exitCode, signal: null }
  if (signal !== null && value.exitCode === null) return { type: 'SESSION_FINISHED', requestId: value.requestId, exitCode: null, signal }
  return null
}

function isBranch(value: unknown): value is string {
  return isBoundedControlFreeString(value, 1, MAX_SESSION_BRANCH_LENGTH)
}

function isRelativeCwd(value: unknown): value is string {
  if (!isBoundedControlFreeString(value, 1, MAX_SESSION_RELATIVE_CWD_LENGTH) || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  if (value === '.') return true
  return value.split('/').every(component => component.length > 0 && component !== '.' && component !== '..')
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

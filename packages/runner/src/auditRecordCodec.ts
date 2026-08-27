import {
  MAX_ENDPOINT_CAPABILITIES,
  SESSION_LAUNCH_PROTOCOL_VERSION,
  isRefusalReason,
  isSafeIdentifier,
  parseSessionLaunchServerMessage,
} from '@modulastack/runner-protocol'
import {
  AUDIT_RECORD_SCHEMA_VERSION,
  MAX_AUDIT_RECORD_BYTES,
  MAX_CAPABILITY_REFRESH_INTENTIONS,
  MAX_CAPABILITY_REFRESH_RUNTIMES,
  type AuditRecordInputV2,
  type AuditRecordV2,
  type AuditSequence,
  type CapabilityEndpointOutcomeCounts,
  type CapabilityRuntimeOutcomeCounts,
} from './auditLifecycle.js'
import type { SessionReceiptState, SessionTerminalResult } from './sessionLaunch.js'

const SESSION_STATES = new Set(['accepted', 'provisioned', 'spawn-intent', 'started', 'finished', 'refused', 'failed', 'uncertain'])
const CONNECTION_REASONS = new Set(['unsupported-session-launch', 'invalid-session-launch', 'binding-mismatch'])
const CONNECTION_PHASES = new Set(['pre-welcome', 'active', 'reconnecting'])
const SPAWN_KINDS = new Set(['pane', 'preview', 'git', 'tmux', 'probe'])

export function encodeAuditRecord(input: AuditRecordInputV2, sequence: AuditSequence): Buffer {
  const normalized = normalizeAuditRecord(input, sequence)
  if (!normalized) throw new TypeError('invalid audit record')
  const bytes = Buffer.from(`${JSON.stringify(normalized)}\n`)
  if (bytes.byteLength > MAX_AUDIT_RECORD_BYTES) throw new TypeError('audit record exceeds its byte limit')
  return bytes
}

export function decodeAuditRecord(line: Uint8Array): AuditRecordV2 | null {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)) as unknown
    if (!isRecord(value) || !validSequence(value.sequence)) return null
    const { sequence, ...input } = value
    return normalizeAuditRecord(input, sequence)
  } catch {
    return null
  }
}

function normalizeAuditRecord(value: unknown, sequence: AuditSequence): AuditRecordV2 | null {
  if (!isRecord(value) || !validBase(value, sequence) || typeof value.kind !== 'string') return null
  const base: Base = { schemaVersion: AUDIT_RECORD_SCHEMA_VERSION, sequence, eventId: value.eventId, at: value.at }
  if (value.kind === 'spawn-admitted') {
    const subject = spawnSubject(value)
    return subject && isSafeIdentifier(value.spawnId) ? { ...base, kind: value.kind, spawnId: value.spawnId, ...subject } : null
  }
  if (value.kind === 'spawn-outcome') {
    const outcome = spawnOutcome(value.outcome)
    return isSafeIdentifier(value.spawnId) && outcome ? { ...base, kind: value.kind, spawnId: value.spawnId, outcome } : null
  }
  if (value.kind === 'refused') {
    const subject = spawnSubject(value)
    return subject && isRefusalReason(value.reason) ? { ...base, kind: value.kind, reason: value.reason, ...subject } : null
  }
  if (value.kind === 'kill') {
    return typeof value.confirmed === 'boolean' && boundedCount(value.targetCount, 4_096) && sha256(value.targetsSha256)
      ? { ...base, kind: value.kind, confirmed: value.confirmed, targetCount: value.targetCount, targetsSha256: value.targetsSha256 }
      : null
  }
  if (value.kind === 'session-connection-refusal') return connectionRecord(base, value)
  if (value.kind === 'session-launch') return sessionRecord(base, value)
  if (value.kind === 'capability-refresh-admitted') return capabilityAdmission(base, value)
  if (value.kind === 'capability-refresh-outcome') return capabilityOutcome(base, value)
  return null
}

function validBase(value: Record<string, unknown>, sequence: AuditSequence): value is Record<string, unknown> & { eventId: string; at: string } {
  return value.schemaVersion === AUDIT_RECORD_SCHEMA_VERSION
    && validSequence(sequence)
    && isSafeIdentifier(value.eventId)
    && validTimestamp(value.at)
}

function spawnSubject(value: Record<string, unknown>) {
  if (typeof value.spawnKind !== 'string' || !SPAWN_KINDS.has(value.spawnKind)) return null
  if (!nullableIdentifier(value.subjectId) || !nullableIdentifier(value.requestId)) return null
  return {
    spawnKind: value.spawnKind as 'pane' | 'preview' | 'git' | 'tmux' | 'probe',
    subjectId: value.subjectId as string | null,
    requestId: value.requestId as string | null,
  }
}

function spawnOutcome(value: unknown) {
  if (!isRecord(value)) return null
  if (value.spawnFailed === true && Object.keys(value).length === 1) return { spawnFailed: true as const }
  if (nonnegativeInteger(value.exitCode) && value.signal === null) return { exitCode: value.exitCode, signal: null }
  if (nonnegativeInteger(value.signal) && value.exitCode === null) return { exitCode: null, signal: value.signal }
  return null
}

function connectionRecord(base: Base, value: Record<string, unknown>): AuditRecordV2 | null {
  if (!isSafeIdentifier(value.connectionId) || !isSafeIdentifier(value.channelId) || !nullableIdentifier(value.requestId)) return null
  if (typeof value.reason !== 'string' || !CONNECTION_REASONS.has(value.reason)) return null
  if (typeof value.phase !== 'string' || !CONNECTION_PHASES.has(value.phase)) return null
  if (value.selectedProtocolVersion !== null && !nonnegativeInteger(value.selectedProtocolVersion)) return null
  return {
    ...base,
    kind: 'session-connection-refusal',
    connectionId: value.connectionId,
    channelId: value.channelId,
    requestId: value.requestId as string | null,
    reason: value.reason as 'unsupported-session-launch' | 'invalid-session-launch' | 'binding-mismatch',
    selectedProtocolVersion: value.selectedProtocolVersion as number | null,
    phase: value.phase as 'pre-welcome' | 'active' | 'reconnecting',
  }
}

function sessionRecord(base: Base, value: Record<string, unknown>): AuditRecordV2 | null {
  if (!isRecord(value.key) || !isSafeIdentifier(value.key.bindingId) || !isSafeIdentifier(value.key.requestId)) return null
  if (typeof value.state !== 'string' || !SESSION_STATES.has(value.state)) return null
  if (value.sessionId !== undefined && !isSafeIdentifier(value.sessionId)) return null
  const result = value.result === undefined
    ? undefined
    : parseSessionLaunchServerMessage(value.result, SESSION_LAUNCH_PROTOCOL_VERSION)
  if (value.result !== undefined && (!result || !['SESSION_REFUSED', 'SESSION_FAILED', 'SESSION_FINISHED'].includes(result.type))) return null
  const terminal = result as SessionTerminalResult | undefined
  return {
    ...base,
    kind: 'session-launch',
    key: { bindingId: value.key.bindingId, requestId: value.key.requestId },
    state: value.state as SessionReceiptState,
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId as string }),
    ...(terminal === undefined ? {} : { result: terminal }),
  }
}

function capabilityAdmission(base: Base, value: Record<string, unknown>): AuditRecordV2 | null {
  if (!isSafeIdentifier(value.refreshId) || !Array.isArray(value.runtimeIds)) return null
  if (value.runtimeIds.length > MAX_CAPABILITY_REFRESH_RUNTIMES || !value.runtimeIds.every(isSafeIdentifier)) return null
  const runtimeIds = [...value.runtimeIds] as string[]
  if (new Set(runtimeIds).size !== runtimeIds.length || [...runtimeIds].sort().join('\0') !== runtimeIds.join('\0')) return null
  if (!boundedCount(value.runtimeIntentions, MAX_CAPABILITY_REFRESH_INTENTIONS)) return null
  if (!boundedCount(value.endpointIntentions, MAX_ENDPOINT_CAPABILITIES)) return null
  return {
    ...base,
    kind: 'capability-refresh-admitted',
    refreshId: value.refreshId,
    runtimeIds,
    runtimeIntentions: value.runtimeIntentions,
    endpointIntentions: value.endpointIntentions,
  }
}

function capabilityOutcome(base: Base, value: Record<string, unknown>): AuditRecordV2 | null {
  const runtimeOutcomes = runtimeCounts(value.runtimeOutcomes)
  const endpointOutcomes = endpointCounts(value.endpointOutcomes)
  if (!isSafeIdentifier(value.refreshId) || !runtimeOutcomes || !endpointOutcomes || typeof value.snapshotChanged !== 'boolean') return null
  return { ...base, kind: 'capability-refresh-outcome', refreshId: value.refreshId, runtimeOutcomes, endpointOutcomes, snapshotChanged: value.snapshotChanged }
}

function runtimeCounts(value: unknown): CapabilityRuntimeOutcomeCounts | null {
  if (!isRecord(value)) return null
  const counts = ['answered', 'missing', 'unanswered', 'refused'] as const
  return counts.every(key => boundedCount(value[key], MAX_CAPABILITY_REFRESH_INTENTIONS))
    ? Object.fromEntries(counts.map(key => [key, value[key]])) as CapabilityRuntimeOutcomeCounts
    : null
}

function endpointCounts(value: unknown): CapabilityEndpointOutcomeCounts | null {
  if (!isRecord(value)) return null
  const counts = ['available', 'unavailable', 'refused'] as const
  return counts.every(key => boundedCount(value[key], MAX_ENDPOINT_CAPABILITIES))
    ? Object.fromEntries(counts.map(key => [key, value[key]])) as CapabilityEndpointOutcomeCounts
    : null
}

type Base = Pick<AuditRecordV2, 'schemaVersion' | 'sequence' | 'eventId' | 'at'>

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function validSequence(value: unknown): value is AuditSequence {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)
}

function nullableIdentifier(value: unknown): value is string | null {
  return value === null || isSafeIdentifier(value)
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function boundedCount(value: unknown, maximum: number): value is number {
  return nonnegativeInteger(value) && value <= maximum
}

function sha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

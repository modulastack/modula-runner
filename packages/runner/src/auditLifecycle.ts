import { MAX_RUNTIME_CAPABILITIES, type RefusalReason } from '@modulastack/runner-protocol'
import type { SpawnOutcome } from './auditLog.js'
import type { SessionConnectionAuditReason, SessionJobControlPhase } from './sessionJobControl.js'
import type { SessionReceiptKey, SessionReceiptState, SessionTerminalResult } from './sessionLaunch.js'

export const AUDIT_RECORD_SCHEMA_VERSION = 2
export const AUDIT_SEGMENT_SCHEMA_VERSION = 1
export const AUDIT_ARCHIVE_SCHEMA_VERSION = 1
export const MAX_AUDIT_RECORD_BYTES = 16 * 1024
export const MAX_AUDIT_SEGMENT_BYTES = 8 * 1024 * 1024
export const MAX_AUDIT_SEGMENT_RECORDS = 16_384
export const MAX_RESIDENT_AUDIT_SEGMENTS = 8
export const MAX_AUDIT_METADATA_BYTES = 1024 * 1024
export const MAX_CAPABILITY_REFRESH_RUNTIMES = MAX_RUNTIME_CAPABILITIES
export const MAX_CAPABILITY_REFRESH_INTENTIONS = MAX_RUNTIME_CAPABILITIES * 2

export const AUDIT_SEGMENT_STATES = ['open', 'sealed', 'acked', 'reclaimed'] as const
export type AuditSegmentState = (typeof AUDIT_SEGMENT_STATES)[number]
export type AuditSequence = string

export type AuditRecordBaseV2 = {
  schemaVersion: typeof AUDIT_RECORD_SCHEMA_VERSION
  sequence: AuditSequence
  eventId: string
  at: string
}

export type AuditSpawnKind = 'pane' | 'preview' | 'git' | 'tmux' | 'probe'
export type AuditSpawnSubject = {
  spawnKind: AuditSpawnKind
  subjectId: string | null
  requestId: string | null
}

export type AuditRecordV2 = AuditRecordBaseV2 & (
  | ({ kind: 'spawn-admitted'; spawnId: string } & AuditSpawnSubject)
  | { kind: 'spawn-outcome'; spawnId: string; outcome: SpawnOutcome }
  | ({ kind: 'refused'; reason: RefusalReason } & AuditSpawnSubject)
  | { kind: 'kill'; confirmed: boolean; targetCount: number; targetsSha256: string }
  | {
      kind: 'session-connection-refusal'
      connectionId: string
      channelId: string
      requestId: string | null
      reason: SessionConnectionAuditReason
      selectedProtocolVersion: number | null
      phase: SessionJobControlPhase
    }
  | {
      kind: 'session-launch'
      key: SessionReceiptKey
      state: SessionReceiptState
      sessionId?: string
      result?: SessionTerminalResult
    }
  | {
      kind: 'capability-refresh-admitted'
      refreshId: string
      runtimeIds: readonly string[]
      runtimeIntentions: number
      endpointIntentions: number
    }
  | {
      kind: 'capability-refresh-outcome'
      refreshId: string
      runtimeOutcomes: CapabilityRuntimeOutcomeCounts
      endpointOutcomes: CapabilityEndpointOutcomeCounts
      snapshotChanged: boolean
    }
)

type WithoutSequence<T> = T extends AuditRecordBaseV2 ? Omit<T, 'sequence'> : never
export type AuditRecordInputV2 = WithoutSequence<AuditRecordV2>

export type CapabilityRuntimeOutcomeCounts = {
  answered: number
  missing: number
  unanswered: number
  refused: number
}

export type CapabilityEndpointOutcomeCounts = {
  available: number
  unavailable: number
  refused: number
}

export type AuditSegmentManifest = {
  schemaVersion: typeof AUDIT_SEGMENT_SCHEMA_VERSION
  sequence: AuditSequence
  state: 'sealed'
  recordSchemaVersion: 1 | typeof AUDIT_RECORD_SCHEMA_VERSION
  bytes: number
  records: number
  sha256: string
  firstRecordSequence: AuditSequence
  lastRecordSequence: AuditSequence
  previousManifestSha256: string | null
}

export type AuditArchiveAcknowledgement = {
  schemaVersion: typeof AUDIT_ARCHIVE_SCHEMA_VERSION
  segmentSequence: AuditSequence
  segmentSha256: string
  manifestSha256: string
  bytes: number
  records: number
  exportId: string
  artifactSha256: string
  acknowledgedAt: string
}

export type AuditReclamationTombstone = {
  schemaVersion: typeof AUDIT_ARCHIVE_SCHEMA_VERSION
  segmentSequence: AuditSequence
  segmentSha256: string
  acknowledgementSha256: string
  reclaimedAt: string
}

export type AuditLifecycleSnapshot = {
  state: 'ready' | 'storage-unavailable'
  residentSegments: number
  residentBytes: number
  metadataBytes: number
  openSequence: AuditSequence | null
}

export interface RunnerAuditLifecycle {
  append(record: AuditRecordInputV2): Promise<void>
  snapshot(): Promise<AuditLifecycleSnapshot>
  close(): Promise<void>
}

export type RunnerAuditLifecycleOptions = {
  runnerHome: string
  currentUserId?: number
  now?: () => number
}

export type RunnerAuditLifecycleOpen =
  | { status: 'ready'; audit: RunnerAuditLifecycle }
  | { status: 'storage-unavailable' }

export type RunnerAuditArchiveOptions = {
  runnerHome: string
  destination: string
  currentUserId?: number
  now?: () => number
}

export type RunnerAuditArchiveResult =
  | { status: 'archived'; segments: number; bytes: number; acknowledgementDigests: readonly string[] }
  | { status: 'nothing-to-archive' }
  | { status: 'storage-unavailable' }

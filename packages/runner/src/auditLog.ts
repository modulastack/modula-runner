import type { RefusalReason } from '@modulastack/runner-protocol'
import type { AuditSpawnKind } from './auditLifecycle.js'
import type { SessionConnectionAuditRecord } from './sessionJobControl.js'
import type { SessionLaunchAuditRecord } from './sessionLaunch.js'

export type SpawnOutcome =
  | { exitCode: number; signal: null }
  | { exitCode: null; signal: number }
  | { spawnFailed: true }

export type AuditRecord =
  | {
      kind: 'spawn-admitted'
      spawnId: string
      spawnKind: AuditSpawnKind
      requestId: string | null
      executable: string | null
      recipeId: string | null
      cwd: string
      at: string
    }
  | { kind: 'spawn-outcome'; spawnId: string; outcome: SpawnOutcome; at: string }
  | {
      kind: 'refused'
      requestId: string | null
      spawnKind: AuditSpawnKind
      executable: string | null
      recipeId: string | null
      cwd: string | null
      reason: RefusalReason
      at: string
    }
  | { kind: 'kill'; confirmed: boolean; details: string; at: string }
  | SessionConnectionAuditRecord
  | SessionLaunchAuditRecord

// Policy and process modules depend only on this ingress. Segment layout, migration, archive,
// and reclamation stay behind the lifecycle adapter assembled by the file-runner composition root.
export interface AuditLog {
  append(record: AuditRecord): Promise<void>
}

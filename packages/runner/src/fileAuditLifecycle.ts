import type {
  RunnerAuditArchiveOptions,
  RunnerAuditArchiveResult,
  RunnerAuditLifecycleOpen,
  RunnerAuditLifecycleOptions,
} from './auditLifecycle.js'
import { archiveRunnerAuditFile } from './fileAuditArchive.js'
import {
  openBoundRunnerAuditLifecycleCore,
  openRunnerAuditLifecycleCore,
} from './fileAuditLifecycleCore.js'
import { migrateLegacyAudit } from './fileAuditMigration.js'

export function openRunnerAuditLifecycle(options: RunnerAuditLifecycleOptions): Promise<RunnerAuditLifecycleOpen> {
  return openRunnerAuditLifecycleCore(options, migrateLegacyAudit)
}

export function openBoundRunnerAuditLifecycle(options: RunnerAuditLifecycleOptions): Promise<RunnerAuditLifecycleOpen> {
  return openBoundRunnerAuditLifecycleCore(options, migrateLegacyAudit)
}

export function archiveRunnerAudit(options: RunnerAuditArchiveOptions): Promise<RunnerAuditArchiveResult> {
  return archiveRunnerAuditFile(options, migrateLegacyAudit)
}

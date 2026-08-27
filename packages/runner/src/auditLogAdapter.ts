import { createHash, randomUUID } from 'node:crypto'
import type { AuditRecordInputV2, RunnerAuditLifecycle } from './auditLifecycle.js'
import type { AuditLog, AuditRecord } from './auditLog.js'

export function adaptAuditLog(lifecycle: RunnerAuditLifecycle): AuditLog {
  return { append: async record => await lifecycle.append(auditRecordV2(record)) }
}

function auditRecordV2(record: AuditRecord): AuditRecordInputV2 {
  const base = { schemaVersion: 2 as const, eventId: randomUUID(), at: record.at }
  if (record.kind === 'spawn-admitted') {
    return {
      ...base,
      kind: record.kind,
      spawnId: record.spawnId,
      spawnKind: record.spawnKind,
      subjectId: record.recipeId,
      requestId: record.requestId,
    }
  }
  if (record.kind === 'spawn-outcome') return { ...base, kind: record.kind, spawnId: record.spawnId, outcome: record.outcome }
  if (record.kind === 'refused') {
    return {
      ...base,
      kind: record.kind,
      spawnKind: record.spawnKind,
      subjectId: record.recipeId,
      requestId: record.requestId,
      reason: record.reason,
    }
  }
  if (record.kind === 'kill') {
    return {
      ...base,
      kind: record.kind,
      confirmed: record.confirmed,
      targetCount: 0,
      targetsSha256: createHash('sha256').update(record.details).digest('hex'),
    }
  }
  if (record.kind === 'session-connection-refusal') {
    return {
      ...base,
      kind: record.kind,
      connectionId: record.connectionId,
      channelId: record.channelId,
      requestId: record.requestId,
      reason: record.reason,
      selectedProtocolVersion: record.selectedProtocolVersion,
      phase: record.phase,
    }
  }
  return {
    ...base,
    kind: record.kind,
    key: record.key,
    state: record.state,
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    ...(record.result ? { result: record.result } : {}),
  }
}

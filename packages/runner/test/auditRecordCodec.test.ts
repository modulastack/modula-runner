import { describe, expect, it } from 'vitest'
import { decodeAuditRecord, encodeAuditRecord } from '../src/auditRecordCodec.js'
import type { AuditRecordInputV2 } from '../src/index.js'

function admission(overrides: Partial<AuditRecordInputV2> = {}): AuditRecordInputV2 {
  return {
    schemaVersion: 2,
    eventId: 'event-1',
    at: '2026-08-22T00:00:00.000Z',
    kind: 'spawn-admitted',
    spawnId: 'spawn-1',
    spawnKind: 'pane',
    subjectId: null,
    requestId: null,
    ...overrides,
  } as AuditRecordInputV2
}

describe('audit record codec', () => {
  it('assigns and round-trips the lifecycle-owned sequence', () => {
    const encoded = encodeAuditRecord(admission(), '7')
    expect(decodeAuditRecord(encoded.subarray(0, -1))).toEqual({ ...admission(), sequence: '7' })
  })

  it('copies only declared fields and drops an unknown hostile value', () => {
    const encoded = encodeAuditRecord({ ...admission(), rawCommand: 'secret --token=value' } as unknown as AuditRecordInputV2, '1')
    expect(encoded.toString()).not.toContain('secret')
    expect(decodeAuditRecord(encoded.subarray(0, -1))).toEqual({ ...admission(), sequence: '1' })
  })

  it('rejects malformed outcomes and noncanonical sequences', () => {
    expect(() => encodeAuditRecord({
      schemaVersion: 2,
      eventId: 'event-1',
      at: '2026-08-22T00:00:00.000Z',
      kind: 'spawn-outcome',
      spawnId: 'spawn-1',
      outcome: { exitCode: 0, signal: 15 },
    } as unknown as AuditRecordInputV2, '1')).toThrow('invalid audit record')
    expect(decodeAuditRecord(Buffer.from(`${JSON.stringify({ ...admission(), sequence: '01' })}`))).toBeNull()
  })

  it('requires canonical unique runtime ordering in an aggregate admission', () => {
    const record: AuditRecordInputV2 = {
      schemaVersion: 2,
      eventId: 'event-1',
      at: '2026-08-22T00:00:00.000Z',
      kind: 'capability-refresh-admitted',
      refreshId: 'refresh-1',
      runtimeIds: ['beta', 'alpha'],
      runtimeIntentions: 2,
      endpointIntentions: 0,
    }
    expect(() => encodeAuditRecord(record, '1')).toThrow('invalid audit record')
  })
})

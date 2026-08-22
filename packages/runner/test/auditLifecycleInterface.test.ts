import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@modulastack/runner-protocol'
import {
  AUDIT_RECORD_SCHEMA_VERSION,
  AUDIT_SEGMENT_STATES,
  AuditLifecycleNotImplementedError,
  MAX_AUDIT_METADATA_BYTES,
  MAX_AUDIT_RECORD_BYTES,
  MAX_AUDIT_SEGMENT_BYTES,
  MAX_AUDIT_SEGMENT_RECORDS,
  MAX_RESIDENT_AUDIT_SEGMENTS,
  archiveRunnerAudit,
  createCapabilityProbeBatchSeam,
  createSessionChannelEventCoordinator,
  openRunnerAuditLifecycle,
  type AuditRecordInputV2,
  type SessionReceiptLedger,
} from '../src/index.js'

describe('audit lifecycle interface checkpoint', () => {
  it('publishes the operator-ratified fixed bounds without activating protocol v2', () => {
    expect(PROTOCOL_VERSION).toBe(1)
    expect(AUDIT_RECORD_SCHEMA_VERSION).toBe(2)
    expect(MAX_AUDIT_RECORD_BYTES).toBe(16 * 1024)
    expect(MAX_AUDIT_SEGMENT_BYTES).toBe(8 * 1024 * 1024)
    expect(MAX_AUDIT_SEGMENT_RECORDS).toBe(16_384)
    expect(MAX_RESIDENT_AUDIT_SEGMENTS).toBe(8)
    expect(MAX_AUDIT_METADATA_BYTES).toBe(1024 * 1024)
    expect(AUDIT_SEGMENT_STATES).toEqual(['open', 'sealed', 'acked', 'reclaimed'])
  })

  it('fails closed for an unusable lifecycle root and keeps offline archive inactive', async () => {
    await expect(openRunnerAuditLifecycle({ runnerHome: '/inactive' }))
      .resolves.toEqual({ status: 'storage-unavailable' })
    await expect(archiveRunnerAudit({ runnerHome: '/inactive', destination: '/inactive-archive' }))
      .rejects.toBeInstanceOf(AuditLifecycleNotImplementedError)
  })

  it('does not classify a channel event without a current receipt', async () => {
    const receipts: SessionReceiptLedger = {
      lookup: async () => ({ status: 'missing' }),
      claim: async () => ({ status: 'storage-unavailable' }),
      replace: async () => ({ status: 'storage-unavailable' }),
      recover: async () => [],
      compact: async () => undefined,
    }
    const coordinator = createSessionChannelEventCoordinator({
      receipts,
      audit: { append: async () => undefined },
      clock: { now: () => 0, sleep: async () => undefined },
    })
    await expect(coordinator.handle({
      kind: 'lost',
      key: { bindingId: '123e4567-e89b-42d3-a456-426614174000', requestId: '123e4567-e89b-42d3-a456-426614174001' },
      sessionId: 'session-1',
      channelId: 'channel-1',
      generation: 1,
    })).resolves.toEqual({ status: 'unknown' })
  })

  it('wraps one refresh in the durable aggregate admission and outcome pair', async () => {
    const records: AuditRecordInputV2[] = []
    const seam = createCapabilityProbeBatchSeam({
      policy: null,
      audit: {
        append: async record => { records.push(record) },
        snapshot: async () => ({ state: 'ready', residentSegments: 1, residentBytes: 0, metadataBytes: 0, openSequence: '1' }),
        close: async () => undefined,
      },
    })
    await expect(seam.run({ refreshId: 'refresh-1', probes: [], endpointIntentions: 0 }, async () => ({
      outcome: {
        runtimeOutcomes: { answered: 0, missing: 0, unanswered: 0, refused: 0 },
        endpointOutcomes: { available: 0, unavailable: 0, refused: 0 },
        snapshotChanged: false,
      },
      value: null,
    }))).resolves.toEqual({ status: 'completed', value: null })
    expect(records.map(record => record.kind)).toEqual(['capability-refresh-admitted', 'capability-refresh-outcome'])
  })
})

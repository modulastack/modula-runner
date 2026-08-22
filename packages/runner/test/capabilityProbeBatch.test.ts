import { describe, expect, it, vi } from 'vitest'
import {
  createCapabilityProbeBatchSeam,
  type AuditRecordInputV2,
  type CapabilityProbeIntent,
  type CommandPolicy,
  type RunnerAuditLifecycle,
} from '../src/index.js'

const policy: CommandPolicy = {
  allowsExecutable: executable => executable === '/allowed',
  recipe: () => null,
  executables: ['/allowed'],
  keyId: 'test-anchor',
}

function probe(
  probeId: string,
  runtimeId: string,
  check: 'version' | 'auth',
  executable: string,
): CapabilityProbeIntent {
  return {
    probeId,
    runtimeId,
    check,
    request: { kind: 'probe', executable, args: ['--private-local-arg'], cwd: '/tmp', grantScoped: false },
  }
}

function recordingAudit(failAt = -1) {
  const records: AuditRecordInputV2[] = []
  let appends = 0
  const audit: RunnerAuditLifecycle = {
    async append(record) {
      appends += 1
      if (appends === failAt) throw new Error('audit unavailable')
      records.push(record)
    },
    async snapshot() {
      return { state: 'ready', residentSegments: 1, residentBytes: 0, metadataBytes: 0, openSequence: '1' }
    },
    async close() {},
  }
  return { audit, records }
}

const emptyEndpoints = { available: 0, unavailable: 0, refused: 0 }

describe('capability probe batch', () => {
  it('durably brackets one mixed refresh without persisting commands or argv', async () => {
    const held = recordingAudit()
    const seam = createCapabilityProbeBatchSeam({ policy, audit: held.audit, now: () => 1_700_000_000_000 })
    const order: string[] = []
    const result = await seam.run({
      refreshId: 'refresh-1',
      probes: [probe('probe-1', 'alpha', 'version', '/allowed'), probe('probe-2', 'beta', 'auth', '/denied')],
      endpointIntentions: 0,
    }, async decisions => {
      order.push(held.records[0]?.kind ?? 'missing-admission')
      expect(decisions.map(decision => decision.status)).toEqual(['admitted', 'refused'])
      expect(decisions[0]).toMatchObject({ status: 'admitted', vetted: { command: '/allowed' } })
      return {
        outcome: {
          runtimeOutcomes: { answered: 1, missing: 0, unanswered: 0, refused: 1 },
          endpointOutcomes: emptyEndpoints,
          snapshotChanged: true,
        },
        value: 'snapshot',
      }
    })

    expect(result).toEqual({ status: 'completed', value: 'snapshot' })
    expect(order).toEqual(['capability-refresh-admitted'])
    expect(held.records.map(record => record.kind)).toEqual(['capability-refresh-admitted', 'capability-refresh-outcome'])
    expect(held.records[0]).toMatchObject({ runtimeIds: ['alpha', 'beta'], runtimeIntentions: 2, endpointIntentions: 0 })
    expect(JSON.stringify(held.records)).not.toContain('/allowed')
    expect(JSON.stringify(held.records)).not.toContain('--private-local-arg')
  })

  it('does not run probes when the admission aggregate is unavailable', async () => {
    const held = recordingAudit(1)
    const runner = vi.fn(async () => ({
      outcome: { runtimeOutcomes: { answered: 0, missing: 0, unanswered: 0, refused: 0 }, endpointOutcomes: emptyEndpoints, snapshotChanged: false },
      value: null,
    }))
    const seam = createCapabilityProbeBatchSeam({ policy, audit: held.audit })

    await expect(seam.run({ refreshId: 'refresh-1', probes: [], endpointIntentions: 0 }, runner))
      .resolves.toEqual({ status: 'storage-unavailable' })
    expect(runner).not.toHaveBeenCalled()
  })

  it('withholds the snapshot when the outcome aggregate is unavailable', async () => {
    const held = recordingAudit(2)
    const seam = createCapabilityProbeBatchSeam({ policy, audit: held.audit })

    await expect(seam.run({ refreshId: 'refresh-1', probes: [], endpointIntentions: 0 }, async () => ({
      outcome: { runtimeOutcomes: { answered: 0, missing: 0, unanswered: 0, refused: 0 }, endpointOutcomes: emptyEndpoints, snapshotChanged: false },
      value: 'must-not-escape',
    }))).resolves.toEqual({ status: 'storage-unavailable' })
    expect(held.records.map(record => record.kind)).toEqual(['capability-refresh-admitted'])
  })

  it('records a bounded failed outcome before propagating a probe failure', async () => {
    const held = recordingAudit()
    const seam = createCapabilityProbeBatchSeam({ policy, audit: held.audit })

    await expect(seam.run({
      refreshId: 'refresh-1',
      probes: [probe('probe-1', 'alpha', 'version', '/allowed'), probe('probe-2', 'beta', 'auth', '/denied')],
      endpointIntentions: 1,
    }, async () => { throw new Error('probe pass failed') })).rejects.toThrow('probe pass failed')

    expect(held.records[1]).toMatchObject({
      kind: 'capability-refresh-outcome',
      runtimeOutcomes: { answered: 0, missing: 0, unanswered: 1, refused: 1 },
      endpointOutcomes: { available: 0, unavailable: 1, refused: 0 },
      snapshotChanged: false,
    })
  })

  it('rejects malformed batches before audit or execution', async () => {
    const held = recordingAudit()
    const runner = vi.fn()
    const seam = createCapabilityProbeBatchSeam({ policy, audit: held.audit })
    const duplicate = probe('probe-1', 'alpha', 'version', '/allowed')

    await expect(seam.run({ refreshId: 'refresh-1', probes: [duplicate, duplicate], endpointIntentions: 0 }, runner))
      .rejects.toThrow('invalid capability refresh batch')
    expect(held.records).toEqual([])
    expect(runner).not.toHaveBeenCalled()
  })

  it('records failure and rejects a malformed aggregate outcome', async () => {
    const held = recordingAudit()
    const seam = createCapabilityProbeBatchSeam({ policy, audit: held.audit })

    await expect(seam.run({ refreshId: 'refresh-1', probes: [probe('probe-1', 'alpha', 'version', '/allowed')], endpointIntentions: 0 }, async () => ({
      outcome: { runtimeOutcomes: { answered: 0, missing: 0, unanswered: 0, refused: 0 }, endpointOutcomes: emptyEndpoints, snapshotChanged: false },
      value: null,
    }))).rejects.toThrow('invalid capability refresh outcome')
    expect(held.records.map(record => record.kind)).toEqual(['capability-refresh-admitted', 'capability-refresh-outcome'])
  })
})

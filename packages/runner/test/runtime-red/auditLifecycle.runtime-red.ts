import { describe, expect, it } from 'vitest'
import {
  createCapabilityProbeBatchSeam,
  createSessionChannelEventCoordinator,
  openRunnerAuditLifecycle,
  type AuditRecordInputV2,
  type SessionReceipt,
} from '../../src/index.js'
import { observeRecoveryChannelScenario, type RecoveryChannelObservation } from './recoveryChannelSubject.js'
import { auditScenarioIdFor } from './scenarioIdentity.js'

type ObligationId = `AL-${number}` | `CH-${number}`
type Disposition = 'runtime-red' | 'future-harness' | 'interface-insufficient'
type Scenario = {
  id: ObligationId
  disposition: Disposition
  assertion: string
  oracle: readonly string[]
  harness?: string
  interfaceNeed?: string
}

const scenarios = [
  row('AL-01', 'runtime-red', 'Capability refresh must emit a bounded admission/outcome pair around its complete local catalogue.', ['batch.admitted', 'batch.outcome', 'snapshot.published']),
  row('AL-02', 'runtime-red', 'Non-routine spawn evidence remains individually durable before acknowledgement.', ['audit.append:spawn-admitted', 'audit.snapshot:ready']),
  row('AL-03', 'future-harness', 'Fixed record, segment, metadata, and resident bounds rotate before overflow or fail closed.', ['audit.bound:record', 'audit.bound:segment', 'audit.bound:resident'], 'byte-accurate filesystem boundary harness plugs into openRunnerAuditLifecycle by appending boundary-sized v2 records and observing snapshot plus on-disk segments'),
  row('AL-04', 'future-harness', 'Rotation has one durable OPEN-to-SEALED recovery linearization point.', ['audit.open', 'audit.sealed', 'audit.recovered'], 'write/fsync/rename/directory-fsync crash injector plugs into lifecycle filesystem operations'),
  row('AL-05', 'future-harness', 'Every lifecycle directory-entry mutation receives required directory sync.', ['entry.mutated', 'directory.synced', 'sync.failure:unavailable'], 'syscall-level directory-sync fault injector plugs into lifecycle filesystem operations'),
  row('AL-06', 'future-harness', 'Offline archive accepts only a safe exclusive-lease local destination.', ['archive.lease', 'archive.destination.custody', 'archive.destination.outside-home'], 'filesystem custody/path-identity swap harness plugs into archiveRunnerAudit'),
  row('AL-07', 'future-harness', 'Archive acknowledgement follows verified destination durability and precedes reclamation.', ['archive.destination.verified', 'archive.ack.durable', 'archive.reclaim.eligible'], 'acknowledgement-loss and destination-replacement harness plugs into archiveRunnerAudit'),
  row('AL-08', 'future-harness', 'Reclamation requires exact acknowledgement and durable tombstone evidence.', ['segment.acked', 'tombstone.durable', 'segment.reclaimed'], 'restart/retention harness plugs into openRunnerAuditLifecycle and archiveRunnerAudit'),
  row('AL-09', 'future-harness', 'Required audit persistence failure blocks work through storage-unavailable.', ['append.failed', 'job-control.closed', 'admission.blocked'], 'append/rotation/ack persistence-fault harness plugs into lifecycle composition and job-control observer'),
  row('AL-10', 'future-harness', 'Foreground, archive, shutdown, and recovery serialize one home lifecycle.', ['lease.one-writer', 'archive.blocked', 'segment.single-transition'], 'multiprocess home-lease harness plugs into lifecycle and archive factories'),
  row('AL-11', 'future-harness', 'Final audit rotates within shutdown deadline without starting archive or claiming success on failure.', ['shutdown.deadline', 'shutdown.archive.absent', 'shutdown.audit.durable'], 'controlled-clock shutdown harness plugs into runner composition with lifecycle factory'),
  row('AL-12', 'future-harness', 'Legacy migration and corrupt/newer state recover deterministically or fail closed.', ['migration.v1', 'migration.digest-chain', 'corruption.unavailable'], 'versioned state-image/interrupted-migration harness plugs into openRunnerAuditLifecycle'),
  row('CH-01', 'runtime-red', 'One request has at most one live channel.', ['recoveryChannels.status:channel-prior:g1:closed', 'channels.open:channel-replacement-1']),
  row('CH-02', 'runtime-red', 'Replacement requires authoritative prior close/loss and exact identity.', ['worktree.inspect:exact', 'process.inspect:session-recovery-stable:/worktrees/lane-recovery:exact']),
  row('CH-03', 'runtime-red', 'Durable live generation precedes replacement SESSION_STARTED.', ['receipts.replace.updated:9:g2:live:channel-replacement-1', 'action.started:session-recovery-stable:channel-replacement-1']),
  row('CH-04', 'runtime-red', 'Unknown pre-start close yields uncertainty and no correlated result.', ['recoveryChannels.closeExact:channel-replacement-1:g2', 'action.close:storage-unavailable']),
  row('CH-05', 'runtime-red', 'Concurrent recovery has one generation-CAS winner.', ['receipts.replace.conflict:7', 'channels.open:channel-replacement-1']),
  row('CH-06', 'runtime-red', 'Retired-generation callbacks cannot mutate the current channel.', ['callback.retired', 'channel.current.unchanged']),
] as const satisfies readonly Scenario[]

function row(id: ObligationId, disposition: Disposition, assertion: string, oracle: readonly string[], harness?: string, interfaceNeed?: string): Scenario {
  return { id, disposition, assertion, oracle, ...(harness ? { harness } : {}), ...(interfaceNeed ? { interfaceNeed } : {}) }
}

describe('verifier-owned audit lifecycle runtime-red catalogue', () => {
  it('assigns every AL and CH obligation a deterministic identity and a non-vacuous oracle', () => {
    expect(scenarios).toHaveLength(18)
    expect(new Set(scenarios.map(scenario => scenario.id)).size).toBe(18)
    expect(new Set(scenarios.map(scenario => auditScenarioIdFor(scenario.id))).size).toBe(18)
    for (const scenario of scenarios) expect(scenario.oracle.length).toBeGreaterThan(1)
  })

  for (const scenario of scenarios.filter(scenario => scenario.disposition === 'future-harness')) {
    it(`[${scenario.id}] retains its required deterministic harness`, () => {
      expect(scenario.harness).toMatch(/plugs into/)
    })
  }

  for (const scenario of scenarios.filter(scenario => scenario.disposition === 'interface-insufficient')) {
    it(`[${scenario.id}] records the missing production observation seam`, () => {
      expect(scenario.interfaceNeed).toMatch(/Publish/)
    })
  }

  it('marks CH-01 through CH-05 as executable production-launcher runtime-red rows', () => {
    expect(scenarios.filter(scenario => scenario.disposition === 'runtime-red').map(scenario => scenario.id)).toEqual([
      'AL-01', 'AL-02', 'CH-01', 'CH-02', 'CH-03', 'CH-04', 'CH-05', 'CH-06',
    ])
  })
})

describe('audit lifecycle and replacement-channel production subjects are intentionally red', () => {
  it('[AL-01] drives the production-named batch factory, never the permanent unimplemented factory', async () => {
    const events: AuditRecordInputV2[] = []
    const batch = createCapabilityProbeBatchSeam({
      policy: null,
      audit: {
        append: async record => { events.push(record) },
        snapshot: async () => ({ state: 'ready', residentSegments: 1, residentBytes: 1, metadataBytes: 0, openSequence: '1' }),
        close: async () => undefined,
      },
    })
    await expect(batch.run({ refreshId: auditScenarioIdFor('AL-01'), probes: [], endpointIntentions: 0 }, async () => ({
      outcome: { runtimeOutcomes: { answered: 0, missing: 0, unanswered: 0, refused: 0 }, endpointOutcomes: { available: 0, unavailable: 0, refused: 0 }, snapshotChanged: false },
      value: null,
    }))).resolves.toEqual({ status: 'completed', value: null })
    expect(events.map(record => record.kind)).toEqual(['capability-refresh-admitted', 'capability-refresh-outcome'])
  })

  it('[CH-06] drives the production event coordinator with a retired generation terminal event', async () => {
    const key = { bindingId: '123e4567-e89b-42d3-a456-426614174000', requestId: '223e4567-e89b-42d3-a456-426614174000' }
    const current: SessionReceipt = {
      schemaVersion: 1,
      revision: 2,
      key,
      fingerprint: 'channel-event-fixture',
      request: {
        type: 'SESSION_START', ...key, expiresAt: '2026-08-22T00:10:00Z', terminalProfile: 'coder', modelProfileId: 'daily',
        target: { projectId: 'project-1', worktreeName: 'lane', branch: 'feat/lane', baseBranch: 'main', relativeCwd: '.' },
      },
      state: 'started',
      phaseTimestamps: { accepted: '2026-08-22T00:00:00Z', provisioned: '2026-08-22T00:00:01Z', 'spawn-intent': '2026-08-22T00:00:02Z', started: '2026-08-22T00:00:03Z' },
      worktree: {
        phase: 'verified', branch: 'feat/lane', branchRef: 'refs/heads/feat/lane', baseBranch: 'main', headCommit: 'a'.repeat(40), expectedBaseCommit: 'b'.repeat(40), gitCommonDir: '/projects/project-1/.git',
        ownership: 'created', worktreePath: '/worktrees/lane', worktreeIdentity: { device: '1', inode: '2' }, worktreeGitDir: '/projects/project-1/.git/worktrees/lane', gitEntryIdentity: { device: '1', inode: '3' },
        relativeCwd: '.', resolvedCwdPath: '/worktrees/lane', resolvedCwdIdentity: { device: '1', inode: '2' }, clean: true,
      },
      sessionId: 'session-1',
      channel: { generation: 2, lifecycle: 'live', channelId: 'channel-current' },
      channelId: 'channel-current',
    }
    const coordinator = createSessionChannelEventCoordinator({
      receipts: {
        lookup: async () => ({ status: 'receipt', receipt: current }), claim: async () => ({ status: 'storage-unavailable' }),
        replace: async () => ({ status: 'storage-unavailable' }), recover: async () => [], compact: async () => undefined,
      },
      audit: { append: async () => undefined },
      clock: { now: () => 0, sleep: async () => undefined },
    })
    await expect(coordinator.handle({
      key, sessionId: 'session-1', channelId: 'channel-retired', generation: 1, kind: 'terminal', exitCode: 0, signal: null,
    })).resolves.toMatchObject({ status: 'retired' })
  })

  it('[AL-02] drives the production lifecycle factory with a constructible spawn-admitted record', async () => {
    const opened = await openRunnerAuditLifecycle({ runnerHome: `/runtime-red/${auditScenarioIdFor('AL-02')}` })
    if (opened.status !== 'ready') throw new Error('unexpected storage-unavailable lifecycle')
    const record: AuditRecordInputV2 = { schemaVersion: 2, eventId: auditScenarioIdFor('AL-02'), at: '2026-08-22T00:00:00.000Z', kind: 'spawn-admitted', spawnId: 'spawn-1', spawnKind: 'pane', subjectId: null, requestId: null }
    await opened.audit.append(record)
    expect((await opened.audit.snapshot()).state).toBe('ready')
    await opened.audit.close()
  })

  it('[CH-01] replaces a closed generation only after its loss state is observed', async () => {
    const observation = await observeRecoveryChannelScenario('CH-01')
    expectEvents(observation, [
      'recoveryChannels.status:channel-prior:g1:closed',
      'worktree.inspect:exact',
      'process.inspect:session-recovery-stable:/worktrees/lane-recovery:exact',
      'channels.open:223e4567-e89b-42d3-a456-426614174000:session-recovery-stable:channel-replacement-1',
      'process.adopt.request:session-recovery-stable:channel-replacement-1:g2',
      'process.adopt.handle:session-recovery-stable:channel-replacement-1:g2',
    ])
    expectBefore(observation, 'recoveryChannels.status:channel-prior:g1:closed', 'channels.open:')
    expectBefore(observation, 'worktree.inspect:exact', 'channels.open:')
    expectBefore(observation, 'process.inspect:session-recovery-stable:/worktrees/lane-recovery:exact', 'channels.open:')
    expectEventCount(observation, 'channels.open:', 1)
    expectNoEvent(observation, 'process.start:')
    expect(startedCorrelations(observation)).toEqual(['session-recovery-stable:channel-replacement-1:223e4567-e89b-42d3-a456-426614174000'])
    expect(observation.receipt.channel).toEqual({ generation: 2, lifecycle: 'live', channelId: 'channel-replacement-1' })
  })

  it('[CH-02] treats a worktree identity mismatch as non-destructive recovery uncertainty', async () => {
    const exact = await observeRecoveryChannelScenario('CH-02')
    const mismatch = await observeRecoveryChannelScenario('CH-02-mismatch')
    expectEvents(exact, [
      'recoveryChannels.status:channel-prior:g1:closed',
      'worktree.inspect:exact',
      'process.inspect:session-recovery-stable:/worktrees/lane-recovery:exact',
      'process.adopt.request:session-recovery-stable:channel-replacement-1:g2',
    ])
    expectBefore(exact, 'worktree.inspect:exact', 'channels.open:')
    expectBefore(exact, 'process.inspect:session-recovery-stable:/worktrees/lane-recovery:exact', 'channels.open:')
    expectEvents(mismatch, ['worktree.inspect:mismatch', 'action.failed:recovery-uncertain:223e4567-e89b-42d3-a456-426614174000'])
    expectNoEvent(mismatch, 'channels.open:')
    expectNoEvent(mismatch, 'process.adopt.')
    expectNoEvent(mismatch, 'process.start:')
    expectNoEvent(mismatch, 'process.terminate:')
    expectNoEvent(mismatch, 'worktree.rollback')
  })

  it('[CH-03] writes the replacement intent and live generation before SESSION_STARTED', async () => {
    const observation = await observeRecoveryChannelScenario('CH-03')
    expectEvents(observation, [
      'receipts.replace.updated:8:g2:replacement-intent:none',
      'receipts.replace.updated:9:g2:live:channel-replacement-1',
      'action.started:session-recovery-stable:channel-replacement-1:223e4567-e89b-42d3-a456-426614174000',
    ])
    expectBefore(observation, 'receipts.replace.updated:8:g2:replacement-intent:none', 'channels.open:')
    expectBefore(observation, 'receipts.replace.updated:9:g2:live:channel-replacement-1', 'action.started:')
    expect(startedCorrelations(observation)).toEqual(['session-recovery-stable:channel-replacement-1:223e4567-e89b-42d3-a456-426614174000'])
    expect(observation.receipt.channel).toEqual({ generation: 2, lifecycle: 'live', channelId: 'channel-replacement-1' })
  })

  it('[CH-04] closes the exact replacement channel before uncertainty escapes', async () => {
    const observation = await observeRecoveryChannelScenario('CH-04')
    expectEvents(observation, [
      'recoveryChannels.status:channel-prior:g1:lost',
      'channels.open:223e4567-e89b-42d3-a456-426614174000:session-recovery-stable:channel-replacement-1',
      'process.adopt:failed',
      'recoveryChannels.closeExact:channel-replacement-1:g2:',
      'action.close:storage-unavailable',
    ])
    expectBefore(observation, 'channels.open:', 'process.adopt:failed')
    expectBefore(observation, 'process.adopt:failed', 'recoveryChannels.closeExact:channel-replacement-1:g2:')
    expectBefore(observation, 'recoveryChannels.closeExact:channel-replacement-1:g2:', 'action.close:storage-unavailable')
    expectEventCount(observation, 'channels.open:', 1)
    expectNoEvent(observation, 'action.started:')
    expectNoEvent(observation, 'action.failed:')
    expect(observation.actions).toEqual([{ kind: 'close-job-control', error: 'storage-unavailable' }])
  })

  it('[CH-05] lets one recovery stream win the generation compare-and-set and replays it', async () => {
    const observation = await observeRecoveryChannelScenario('CH-05')
    expectEvents(observation, [
      'receipts.recover.concurrent-ready',
      'receipts.replace.updated:8:g2:replacement-intent:none',
      'receipts.replace.conflict:7:',
      'receipts.replace.updated:9:g2:live:channel-replacement-1',
      'channels.open:223e4567-e89b-42d3-a456-426614174000:session-recovery-stable:channel-replacement-1',
      'process.adopt.request:session-recovery-stable:channel-replacement-1:g2',
    ])
    expectEventCount(observation, 'receipts.recover:started:r7', 2)
    expectEventCount(observation, 'channels.open:', 1)
    expectEventCount(observation, 'process.adopt.request:session-recovery-stable:channel-replacement-1:g2', 1)
    expectEventCount(observation, 'receipts.replace.updated:8:g2:replacement-intent:none', 1)
    expectEventCount(observation, 'receipts.replace.updated:9:g2:live:channel-replacement-1', 1)
    expect(startedCorrelations(observation)).toEqual([
      'session-recovery-stable:channel-replacement-1:223e4567-e89b-42d3-a456-426614174000',
      'session-recovery-stable:channel-replacement-1:223e4567-e89b-42d3-a456-426614174000',
    ])
    expect(observation.receipt.channel).toEqual({ generation: 2, lifecycle: 'live', channelId: 'channel-replacement-1' })
  })
})

function expectEvents(observation: RecoveryChannelObservation, fragments: readonly string[]) {
  for (const fragment of fragments) {
    expect(observation.events.some(event => event.includes(fragment)), fragment).toBe(true)
  }
}

function expectNoEvent(observation: RecoveryChannelObservation, fragment: string) {
  expect(observation.events.some(event => event.includes(fragment)), fragment).toBe(false)
}

function expectBefore(observation: RecoveryChannelObservation, first: string, second: string) {
  const firstIndex = observation.events.findIndex(event => event.includes(first))
  const secondIndex = observation.events.findIndex(event => event.includes(second))
  expect(firstIndex, first).toBeGreaterThanOrEqual(0)
  expect(secondIndex, second).toBeGreaterThan(firstIndex)
}

function expectEventCount(observation: RecoveryChannelObservation, fragment: string, count: number) {
  expect(observation.events.filter(event => event.includes(fragment)), fragment).toHaveLength(count)
}

function startedCorrelations(observation: RecoveryChannelObservation): readonly string[] {
  return observation.actions.flatMap(action => action.kind === 'message' && action.message.type === 'SESSION_STARTED'
    ? [`${action.message.sessionId}:${action.message.channelId}:${action.message.requestId}`]
    : [])
}

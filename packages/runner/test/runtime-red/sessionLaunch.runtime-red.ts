import { sessionStartDeadline, type SessionStartMessage } from '@modulastack/runner-protocol'
import { describe, expect, it } from 'vitest'
import type {
  AuditRecord,
  SessionLaunchAction,
  SessionLauncher,
  SessionReceipt,
  SessionReceiptTombstone,
} from '../../src/index.js'
import {
  RUNTIME_RED_CONTRACT_SHA256,
  RUNTIME_RED_OBLIGATIONS,
  type RuntimeRedArea,
  type RuntimeRedObligation,
} from './obligationMatrix.js'
import { unemittableOracleFragments } from './driverEmittability.js'
import {
  pairingFixtureBearer,
  runtimeRedFixtureApiKey,
  runtimeRedFixtureCommand,
  runtimeRedFixtureCredential,
  runtimeRedFixtureEndpoint,
  runtimeRedFixtureForbiddenEnv,
  runtimeRedSensitiveValues,
} from './fixtureMaterial.js'
import {
  capacityAuditMatchesRequest,
  observeCapacityDurabilityScenario,
  rejectWrongCapacityAuditResultId,
} from './capacityDurabilitySubject.js'
import {
  ledgerCapacityFixtureEvidence,
  ledgerCompactionMutationEvents,
  ledgerPersistenceMutationEvents,
  ledgerTerminalReplayMutationEvidence,
} from './ledgerSubject.js'
import { collectLaunchStimuli, containsSensitiveActionData, terminalReplayMatchesStored } from './launcherEvidence.js'
import {
  LAUNCHER_FIXTURE_NOW,
  RECEIPT_OUTCOME_EXPIRED_AT,
  launcherRequestFor,
  receiptContainsSensitiveData,
} from './launcherSubject.js'
import {
  hasDeclaredPendingEnvelope,
  observePairingScenario,
  pairingRequestContainsFixtureBearer,
  pairingResponsesForFixture,
} from './pairingSubject.js'
import { pairingCodeFor } from './scenarioIdentity.js'
import { runtimeScenarioIds, scenarioFor } from './runtimeScenarios.js'
import { createHomeFixtureStorage, observeHomeScenario } from './homeSubject.js'
import { jobControlPayloadForScenario, observeJobControlOverflowProbe } from './jobControlSubject.js'
import { pairingSecrecySinks, pairingSecrecySinkMarker } from './secrecySinks.js'
import {
  emptySubjectMutant,
  observationMatches,
  type RuntimeObservation,
  type RuntimeScenario,
  type RuntimeSubject,
} from './scenarioTypes.js'
import { observeRuntimeScenario } from './runtimeSubject.js'

const expectedAreaCounts: Record<RuntimeRedArea, number> = {
  pairing: 26,
  negotiation: 15,
  resolution: 36,
  worktree: 14,
  terminal: 16,
  receipt: 25,
  'no-silence': 13,
}

const requiredRuntimeFamilies = {
  'B-01 HTTPS/no-redirect pairing policy': ['G1-P02', 'G1-P03'],
  'staged delivery deadlines': ['G1-C04', 'G1-S02'],
  'durability and storage close': ['G1-R12', 'G1-R13', 'G1-R21', 'G1-S01', 'G1-S08', 'G1-S12'],
  'idempotency and reconnect': ['G1-R01', 'G1-R03', 'G1-R05', 'G1-R07', 'G1-R09', 'G1-S10'],
  'global receipt limits': ['G1-R16', 'G1-R18', 'G1-R21'],
  'phase crash recovery': ['G1-W13', 'G1-R10'],
  'exact-match adoption and rollback': ['G1-C15', 'G1-R11'],
  'active-v1 safety': ['G1-N02', 'G1-N08'],
} as const

const runtimeObligations = RUNTIME_RED_OBLIGATIONS.filter(obligation => obligation.disposition === 'runtime-red')
const shadowObligations = RUNTIME_RED_OBLIGATIONS.filter(obligation => obligation.disposition === 'real-plane-shadow')
const laterEvidenceObligations = RUNTIME_RED_OBLIGATIONS.filter(obligation => obligation.disposition === 'later-evidence')
const runtimeScenarios = runtimeObligations.map(scenarioFor)
const interfaceRedSubjectErrors: Partial<Record<RuntimeSubject, string>> = {
  application: 'RunnerApplicationNotImplementedError',
  pairing: 'PairingContractNotImplementedError',
  runtime: 'RunnerRuntimeNotImplementedError',
  'job-control': 'SessionJobControlNotImplementedError',
  launcher: 'SessionLaunchNotImplementedError',
  home: 'RunnerHomeNotImplementedError',
}
const launcherMutantFixtures = [
  ['G1-R01', 'duplicate-exact-request-verifier-wrong-response-id'],
  ['G1-R01', 'duplicate-exact-request-verifier-double-terminal'],
  ['G1-R07', 'known-terminal-replay-verifier-wrong-retained-result'],
  ['G1-C15', 'recover-exact-session-verifier-wrong-response-id'],
] satisfies readonly (readonly [RuntimeScenario['obligationId'], string])[]
const overflowStreams = ['dispatch', 'recovery'] satisfies readonly ('dispatch' | 'recovery')[]

describe('G2 independent runtime-red obligation accounting', () => {
  it('binds exactly 145 unique obligations to the approved contract', () => {
    expect(RUNTIME_RED_CONTRACT_SHA256).toBe('420d953ee202022f42b2bec7a525b575a017e09df567dd37d99f53c097447278')
    expect(RUNTIME_RED_OBLIGATIONS).toHaveLength(145)
    expect(new Set(RUNTIME_RED_OBLIGATIONS.map(obligation => obligation.id)).size).toBe(145)
    expect(countByArea(RUNTIME_RED_OBLIGATIONS)).toEqual(expectedAreaCounts)
    expect(runtimeObligations).toHaveLength(131)
    expect(shadowObligations).toHaveLength(13)
    expect(laterEvidenceObligations).toHaveLength(1)
  })

  it('retains every settled blocker and every required security/runtime family', () => {
    const settled = new Set(RUNTIME_RED_OBLIGATIONS.flatMap(obligation => 'settledBlocker' in obligation ? [obligation.settledBlocker] : []))
    expect([...settled].sort()).toEqual(Array.from({ length: 16 }, (_, index) => `B-${String(index + 1).padStart(2, '0')}`))
    const runtimeIds = new Set(runtimeObligations.map(obligation => obligation.id))
    for (const ids of Object.values(requiredRuntimeFamilies)) expect(ids.every(id => runtimeIds.has(id))).toBe(true)
  })

  it('keeps the first executable-oracle origin interface-red accounting explicit', () => {
    const interfaceRedRows = runtimeScenarios.filter(scenario => interfaceRedSubjectErrors[scenario.subject] !== undefined)
    const executableRows = runtimeScenarios.filter(scenario => interfaceRedSubjectErrors[scenario.subject] === undefined)
    expect(interfaceRedRows).toHaveLength(123)
    expect(executableRows).toHaveLength(8)
    expect(new Set(executableRows.map(scenario => scenario.subject))).toEqual(new Set(['terminal-host', 'ledger']))
  })

  it('gives every runtime row a selected production subject, stimulus, and non-vacuous oracle', () => {
    expect(new Set(runtimeScenarioIds())).toEqual(new Set(runtimeObligations.map(obligation => obligation.id)))
    expect(new Set(runtimeScenarios.map(scenario => scenario.stimulus)).size).toBe(131)
    expect(new Set(runtimeScenarios.map(scenario => scenario.subject))).toEqual(
      new Set(['application', 'pairing', 'runtime', 'job-control', 'launcher', 'terminal-host', 'ledger', 'home']),
    )
    for (const [index, scenario] of runtimeScenarios.entries()) {
      expect(scenario.assertion).toBe(runtimeObligations[index]!.assertion)
      expect(scenario.fixture.length).toBeGreaterThan(3)
      expect(scenario.oracle.require.length).toBeGreaterThan(1)
      expect(observationMatches(emptySubjectMutant(scenario), scenario.oracle), scenario.obligationId).toBe(false)
      expect(observationMatches(oracleWitness(scenario), scenario.oracle), `${scenario.obligationId} satisfiable`).toBe(true)
    }
  })

  it('requires every oracle event fragment to be emitted by its owning driver source', () => {
    for (const scenario of runtimeScenarios) {
      expect(unemittableOracleFragments(scenario), scenario.obligationId).toEqual([])
    }
    const launcher = runtimeScenarios.find(scenario => scenario.subject === 'launcher')!
    const poisoned = { ...launcher, oracle: { ...launcher.oracle, forbid: ['action.never-emitted'] } }
    expect(unemittableOracleFragments(poisoned)).toContain('action.never-emitted')
  })

  it('rejects forbidden-event, reversed-order, and exact-count mutants without relying on missing bodies', () => {
    for (const scenario of runtimeScenarios) {
      const witness = oracleWitness(scenario)
      if (witness.status !== 'observed') throw new Error('oracle witness must be observed')
      for (const forbidden of scenario.oracle.forbid) {
        const mutant = { ...witness, events: [...witness.events, forbidden] }
        expect(observationMatches(mutant, scenario.oracle), `${scenario.obligationId} forbid ${forbidden}`).toBe(false)
      }
      for (const [first, second] of scenario.oracle.before ?? []) {
        const remaining = witness.events.filter(event => !event.includes(first) && !event.includes(second))
        const mutant = { ...witness, events: [...remaining, second, first] }
        expect(observationMatches(mutant, scenario.oracle), `${scenario.obligationId} order ${first}`).toBe(false)
      }
      for (const fragment of Object.keys(scenario.oracle.counts ?? {})) {
        const mutant = { ...witness, events: [...witness.events, fragment] }
        expect(observationMatches(mutant, scenario.oracle), `${scenario.obligationId} count ${fragment}`).toBe(false)
      }
    }
  })

  it('rejects audited pairing, registration, storage-failure, and capacity mutants', () => {
    const capacity = ledgerCapacityFixtureEvidence()
    expect(capacity.fullReceiptCount).toBe(4_096)
    expect(capacity.receiptBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(capacity.receiptBytesWithNext).toBeGreaterThan(8 * 1024 * 1024)
    expect(capacity.inFlightCount).toBe(32)
    expect(capacity.tombstoneCount).toBe(32_768)
    expect(capacity.tombstoneCountSourceRetained).toBe(true)
    expect(capacity.tombstoneBytes).toBeLessThanOrEqual(16 * 1024 * 1024)
    expect(capacity.tombstoneBytesWithNext).toBeGreaterThan(16 * 1024 * 1024)
    expect(capacity.tombstoneByteSourceRetained).toBe(true)

    expectMutantRejected('G1-P23', events => [...events, 'store.revoke:new-binding'])
    expectOutputMutantRejected('G1-P12', output => [...output, `stdout:${pairingFixtureBearer}`])
    expectMutantRejected('G1-W06', events => [...events, 'worktree.register.call'])
    expectMutantRejected('G1-S08', events => [...events, 'process.start.call'])
    expectMutantRejected('G1-R21', events => events.filter(candidate => !candidate.includes('capacity.audit:correlated')))
    for (const event of [
      'capacity.receipts-count:blocked',
      'capacity.receipts-bytes:blocked',
      'capacity.inflight:blocked',
      'capacity.tombstones-count:preserved',
      'capacity.tombstones-bytes:preserved',
    ]) {
      expectMutantRejected('G1-R16', events => events.filter(candidate => !candidate.includes(event)))
    }
  })

  it('requires a persisted first receipt before declaring it immutable', async () => {
    const scenario = runtimeScenarios.find(candidate => candidate.obligationId === 'G1-R03')
    if (!scenario) throw new Error('missing G1-R03 scenario')
    const request: SessionStartMessage = {
      type: 'SESSION_START',
      bindingId: '123e4567-e89b-42d3-a456-426614174000',
      requestId: '223e4567-e89b-42d3-a456-426614174003',
      expiresAt: '2026-08-21T00:10:00Z',
      terminalProfile: 'coder',
      modelProfileId: 'daily',
      target: { projectId: 'modulastack', worktreeName: 'lane-01', branch: 'feat/lane-01', baseBranch: 'main', relativeCwd: '.' },
    }
    const stored = new Map<string, SessionReceipt | SessionReceiptTombstone>()
    const observed = await collectLaunchStimuli(async function* () {}, scenario, request, stored, () => undefined)
    expect(observed.firstReceiptStable).toBe(false)
  })

  it('keeps ordinary launcher requests admissible while the explicit receipt-outcome fixture remains expired', () => {
    const currentTime = Date.parse(LAUNCHER_FIXTURE_NOW)
    expect(sessionStartDeadline(launcherRequestFor(scenarioById('G1-R25')).expiresAt, currentTime)).toBe('admissible')
    expect(sessionStartDeadline(RECEIPT_OUTCOME_EXPIRED_AT, currentTime)).toBe('expired')
  })

  it('requires every declared pending-pairing envelope field', () => {
    const declared = {
      bindingId: 'binding-1',
      confirmationExpiresAt: '2026-08-21T00:10:00Z',
      confirmationNonce: 'nonce-1',
      controlPlaneOrigin: 'https://example.test',
      pendingSince: '2026-08-21T00:00:00Z',
      runnerId: 'runner-1',
      token: pairingFixtureBearer,
    }
    expect(hasDeclaredPendingEnvelope(declared)).toBe(true)
    const { token: _token, ...missingToken } = declared
    expect(hasDeclaredPendingEnvelope(missingToken)).toBe(false)
    expect(hasDeclaredPendingEnvelope({ ...missingToken, unexpected: 'field' })).toBe(false)
  })

  it('runs #44-#46 negative mutations through the executable test seams', async () => {
    const capacity = scenarioById('G1-R21')
    await expect(rejectWrongCapacityAuditResultId(capacity)).rejects.toThrow('capacity fixture received an unexpected audit')
    await expect(observeCapacityDurabilityScenario(capacity, nonSentinelLauncher)).rejects.toThrow('capacity non-sentinel')

    const replay = await ledgerTerminalReplayMutationEvidence()
    expect(replay.matching).toBe(true)
    expect(replay.wrongResponseId).toBe(false)
    expect(replay.doubleTerminal).toBe(false)
    expect(replay.wrongRetainedResult).toBe(false)

    for (const [id, fixture] of launcherMutantFixtures) {
      await expectExecutableMutantRejected(id, fixture)
    }

    for (const stream of overflowStreams) {
      const observation = await observeJobControlOverflowProbe(stream)
      if (!expectExpectedInterfaceBoundary(scenarioById('G1-R08'), observation)) {
        expect(observation.status).toBe('observed')
      }
      if (observation.status === 'observed') {
        expect(observation.result, `${stream} overflow must close its producer`).toBe('job-control:overflow-rejected')
        expect(observation.events.some(event => event.includes(`overflow.${stream}:yielded:9`))).toBe(true)
        expect(observation.events.some(event => event.includes(`overflow.${stream}:producer-closed`))).toBe(true)
      }
    }
  })

  it('requires capacity audit correlation by binding and request id', () => {
    const request: SessionStartMessage = {
      type: 'SESSION_START',
      bindingId: '123e4567-e89b-42d3-a456-426614174000',
      requestId: '223e4567-e89b-42d3-a456-426614174006',
      expiresAt: '2026-08-21T00:10:00Z',
      terminalProfile: 'coder',
      modelProfileId: 'daily',
      target: { projectId: 'modulastack', worktreeName: 'lane-01', branch: 'feat/lane-01', baseBranch: 'main', relativeCwd: '.' },
    }
    const record: AuditRecord = {
      kind: 'session-launch',
      key: { bindingId: request.bindingId, requestId: request.requestId },
      state: 'refused',
      at: '2026-08-21T00:00:00Z',
      result: { type: 'SESSION_REFUSED', requestId: request.requestId, reason: 'at-capacity' },
    }
    expect(capacityAuditMatchesRequest(record, request)).toBe(true)
    expect(capacityAuditMatchesRequest({ ...record, key: { ...record.key, bindingId: '323e4567-e89b-42d3-a456-426614174003' } }, request)).toBe(false)
    expect(capacityAuditMatchesRequest({ ...record, key: { ...record.key, requestId: '223e4567-e89b-42d3-a456-426614174007' } }, request)).toBe(false)
  })

  it('routes counterpart request-id custody to an explicit real-plane shadow', () => {
    const runner = RUNTIME_RED_OBLIGATIONS.find(obligation => obligation.id === 'G1-R20')
    const counterpart = RUNTIME_RED_OBLIGATIONS.find(obligation => obligation.id === 'G1-R23')
    const validation = RUNTIME_RED_OBLIGATIONS.find(obligation => obligation.id === 'G1-L02')
    if (!runner || !counterpart || !validation) throw new Error('missing request-id attribution rows')
    expect(runner.disposition).toBe('runtime-red')
    expect(runner.assertion).not.toContain('control plane')
    expect(validation.assertion).not.toContain('control plane')
    expect(counterpart.disposition).toBe('real-plane-shadow')
    expect(counterpart.assertion).toContain('generates')
    expect(counterpart.assertion).toContain('never reuses')
    expect(counterpart.evidenceGate).toContain('Task #47')
  })

  it('requires separate correlated receipt outcomes', () => {
    for (const marker of [
      'receipt.outcome:conflict:correlated',
      'receipt.outcome:expiry:correlated',
      'receipt.outcome:retained-completion',
      'receipt.outcome:retained-replay',
      'receipt.outcome:capacity:correlated',
    ]) {
      expectMutantRejected('G1-R25', events => events.filter(event => !event.includes(marker)))
    }
  })

  it('rejects sensitive action and receipt data', () => {
    expect(containsSensitiveActionData({ type: 'SESSION_STARTED', requestId: 'request-1', channelId: 'channel-1', sessionId: 'session-1' })).toBe(false)
    expect(containsSensitiveActionData({ token: 'untrusted-value' })).toBe(true)
    expect(runtimeRedFixtureApiKey).toContain('runtime-red-fixture')
    expect(containsSensitiveActionData({ apiKey: runtimeRedFixtureApiKey })).toBe(true)
    expect(containsSensitiveActionData({ sessionId: pairingFixtureBearer })).toBe(true)
    for (const sensitive of runtimeRedSensitiveValues) {
      expect(containsSensitiveActionData({ sessionId: `prefix-${sensitive}-suffix` })).toBe(true)
    }
    for (const receipt of [
      { command: runtimeRedFixtureCommand },
      { argv: ['--model', 'approved'] },
      { env: { RUNNER_MODE: '1' } },
      { credential: runtimeRedFixtureCredential },
      { endpoint: runtimeRedFixtureEndpoint },
      { signingMaterial: 'fixture-signature' },
    ]) {
      expect(receiptContainsSensitiveData(receipt)).toBe(true)
    }
    expect(receiptContainsSensitiveData({ key: { bindingId: 'binding-1', requestId: 'request-1' } })).toBe(false)
    expectMutantRejected('G1-L35', events => [...events, 'receipt.sensitive-field'])
  })

  it('requires terminal replay to match its stored terminal payload', () => {
    const request: SessionStartMessage = {
      type: 'SESSION_START',
      bindingId: '123e4567-e89b-42d3-a456-426614174000',
      requestId: '223e4567-e89b-42d3-a456-426614174004',
      expiresAt: '2026-08-21T00:10:00Z',
      terminalProfile: 'coder',
      modelProfileId: 'daily',
      target: { projectId: 'modulastack', worktreeName: 'lane-01', branch: 'feat/lane-01', baseBranch: 'main', relativeCwd: '.' },
    }
    const tombstone: SessionReceiptTombstone = {
      key: { bindingId: request.bindingId, requestId: request.requestId },
      fingerprint: 'f'.repeat(64),
      result: { type: 'SESSION_REFUSED', requestId: request.requestId, reason: 'at-capacity' },
      terminalAt: '2026-08-21T00:01:00Z',
      deleteAfter: '2026-09-20T00:01:00Z',
    }
    const stored = new Map([[`${request.bindingId}:${request.requestId}`, tombstone]])
    const matching: SessionLaunchAction[] = [{ kind: 'message', message: tombstone.result }]
    const mismatched: SessionLaunchAction[] = [{
      kind: 'message',
      message: { type: 'SESSION_REFUSED', requestId: request.requestId, reason: 'request-conflict' },
    }]
    const wrongType: SessionLaunchAction[] = [{
      kind: 'message',
      message: { type: 'SESSION_FAILED', requestId: request.requestId, reason: 'spawn-failed' },
    }]
    expect(terminalReplayMatchesStored(matching, stored, request)).toBe(true)
    expect(terminalReplayMatchesStored([...matching, ...matching], stored, request)).toBe(false)
    expect(terminalReplayMatchesStored(mismatched, stored, request)).toBe(false)
    expect(terminalReplayMatchesStored(wrongType, stored, request)).toBe(false)
  })

  it('closes an over-limit launch stream on the ninth action', async () => {
    const scenario = runtimeScenarios.find(candidate => candidate.obligationId === 'G1-L03')
    if (!scenario) throw new Error('missing G1-L03 scenario')
    const request: SessionStartMessage = {
      type: 'SESSION_START',
      bindingId: '123e4567-e89b-42d3-a456-426614174000',
      requestId: '223e4567-e89b-42d3-a456-426614174005',
      expiresAt: '2026-08-21T00:10:00Z',
      terminalProfile: 'coder',
      modelProfileId: 'daily',
      target: { projectId: 'modulastack', worktreeName: 'lane-01', branch: 'feat/lane-01', baseBranch: 'main', relativeCwd: '.' },
    }
    let consumed = 0
    let closed = false
    async function* overLimit(): AsyncGenerator<SessionLaunchAction> {
      try {
        for (let index = 0; index < 10; index += 1) {
          consumed += 1
          yield { kind: 'close-job-control', error: 'storage-unavailable' }
        }
      } finally {
        closed = true
      }
    }
    await expect(collectLaunchStimuli(
      () => overLimit(),
      scenario,
      request,
      new Map<string, SessionReceipt | SessionReceiptTombstone>(),
      () => undefined,
    )).rejects.toThrow('maximum is 8')
    expect(consumed).toBe(9)
    expect(closed).toBe(true)
  })

  it('requires every G1-P12 sink and rejects bearer leaks in each', async () => {
    const sinks = pairingSecrecySinks.map(pairingSecrecySinkMarker)
    const scenario = runtimeScenarios.find(candidate => candidate.obligationId === 'G1-P12')
    if (!scenario) throw new Error('missing G1-P12 scenario')
    expect(scenario.oracle.outputIncludes).toEqual(sinks)
    for (const sink of sinks) {
      expectOutputMutantRejected('G1-P12', output => output.filter(value => !value.startsWith(sink)))
      expectOutputMutantRejected('G1-P12', output => [...output, `${sink}${pairingFixtureBearer}`])
    }
    const observation = await observePairingScenario(scenario)
    if (observation.status === 'missing-production-runtime') {
      expect(observation.error).toBe('PairingContractNotImplementedError')
      return
    }
    const pairingCode = pairingCodeFor(scenario.obligationId)
    expect(observation.events.some(event => event.includes('input.code:accepted'))).toBe(true)
    expect(observation.events.some(event => event.includes(pairingCode))).toBe(false)
    expect(observation.output.some(output => output.includes(pairingCode))).toBe(false)
  })

  it('injects home metadata, read, and replace failures without a happy-path substitute', async () => {
    const base = runtimeScenarios.find(candidate => candidate.obligationId === 'G1-L19')
    if (!base) throw new Error('missing G1-L19 scenario')
    const cases = [
      ['home-unsafe-metadata', 'home:failed:state-linked', 'storage.inspect:unsafe-metadata', 'storage.read:'],
      ['home-read-unavailable', 'home:failed:state-io-failed', 'storage.read:configuration:storage-unavailable', 'home:ready'],
      ['home-replace-unavailable', 'home:replace:storage-unavailable', 'storage.replace:configuration:storage-unavailable', 'home.replace:written'],
    ] as const
    for (const [fixture, result, required, forbidden] of cases) {
      const observation = await observeHomeScenario({ ...base, fixture })
      if (observation.status === 'missing-production-runtime') {
        expect(observation.error).toBe('RunnerHomeNotImplementedError')
        await expectHomeFixtureFailure(fixture, required)
        continue
      }
      expect(observation.result).toBe(result)
      expect(observation.events.some(event => event.includes(required))).toBe(true)
      expect(observation.events.some(event => event.includes(forbidden))).toBe(false)
    }
  })

  it('uses deterministic non-credential material for forbidden environment input', () => {
    const scenario = runtimeScenarios.find(candidate => candidate.obligationId === 'G1-L06')
    if (!scenario) throw new Error('missing G1-L06 scenario')
    const payload = jobControlPayloadForScenario({ ...scenario, fixture: 'v2-forbidden-field' })
    expect(runtimeRedFixtureForbiddenEnv).toBe('[runtime-red-fixture:forbidden-env]')
    expect(JSON.stringify(payload)).toContain(runtimeRedFixtureForbiddenEnv)
    expect(JSON.stringify(payload)).not.toMatch(/secret|credential/i)
  })

  it('scans every pairing header and body value for the fixture bearer before redaction', () => {
    expect(pairingRequestContainsFixtureBearer({
      headers: { 'x-probe': 'safe' },
      body: JSON.stringify({ nested: ['safe', { value: 'safe' }] }),
    })).toBe(false)
    expect(pairingRequestContainsFixtureBearer({
      headers: { 'x-probe': `prefix-${pairingFixtureBearer}-suffix` },
      body: JSON.stringify({ value: 'safe' }),
    })).toBe(true)
    expect(pairingRequestContainsFixtureBearer({
      headers: { 'x-probe': 'safe' },
      body: JSON.stringify({ nested: ['safe', { value: pairingFixtureBearer }] }),
    })).toBe(true)
    expectMutantRejected('G1-P12', events => [...events, 'transport.bearer-leak:true'])
  })

  it('requires the deadline-specific confirmation response before its uncertain outcome', async () => {
    expect(pairingResponsesForFixture('confirmation-deadline-uncertain')[0]).toEqual({ status: 503, mediaType: 'missing', body: '' })
    const scenario = runtimeScenarios.find(candidate => candidate.obligationId === 'G1-P18')
    if (!scenario) throw new Error('missing G1-P18 scenario')
    const observation = await observePairingScenario(scenario)
    if (observation.status === 'missing-production-runtime') {
      expect(observation.error).toBe('PairingContractNotImplementedError')
      return
    }
    const eventIndex = (fragment: string) => observation.events.findIndex(event => event.includes(fragment))
    expect(eventIndex('transport.confirm:final')).toBeGreaterThan(-1)
    expect(eventIndex('transport.confirm:503')).toBeGreaterThan(eventIndex('transport.confirm:final'))
    expect(eventIndex('store.markConfirmationUnknown')).toBeGreaterThan(eventIndex('transport.confirm:503'))
  })

  it('binds reconnect recovery and the ambiguous-loss quiet interval to connection two', () => {
    const reconnect = runtimeScenarios.find(candidate => candidate.obligationId === 'G1-N13')
    const ambiguous = runtimeScenarios.find(candidate => candidate.obligationId === 'G1-S10')
    if (!reconnect || !ambiguous) throw new Error('missing reconnect scenarios')
    expect(reconnect.oracle.require).toContain('runtime.job-control-recovery:connection:>=2')
    expect(reconnect.oracle.before).toContainEqual(['runtime.protocol-recovery:2:connection:[2]', 'runtime.job-control-recovery:connection:>=2'])
    expect(ambiguous.oracle.before).toContainEqual(['runtime.reconnect', 'runtime.job-control-recovery:connection:>=2'])
    expect(ambiguous.oracle.before).toContainEqual(['runtime.job-control-recovery:connection:>=2', 'runtime.ambiguous-loss:quiet-window:begin:connection:>=2'])
    expectMutantRejected('G1-N13', events => events.filter(event => !event.includes('runtime.job-control-recovery:connection:>=2')))
    expectMutantRejected('G1-S10', events => events.filter(event => !event.includes('runtime.ambiguous-loss:quiet-window:begin:connection:>=2')))
  })

  it('requires disconnect sequence and reset watermark continuity evidence', () => {
    const continuityMutants = [
      ['G1-C11', ['terminal.sequence:pre-disconnect:', 'terminal.sequence:post-reconnect:', 'terminal.exit:replayed:same-sequence', 'terminal.sequence:replay-next-contiguous']],
      ['G1-C12', ['terminal.sequence:pre-disconnect-high-water:', 'terminal.sequence:post-reconnect:', 'terminal.resume:same-channel+token+sequence']],
      ['G1-C13', ['terminal.sequence:pre-disconnect-high-water:', 'terminal.sequence:reset:', 'terminal.reset:watermark-advances-pre-disconnect', 'terminal.post-reset:all-advance']],
    ] satisfies readonly (readonly [RuntimeScenario['obligationId'], readonly string[]])[]
    for (const [id, markers] of continuityMutants) {
      for (const marker of markers) expectMutantRejected(id, events => events.filter(event => !event.includes(marker)))
    }
  })

  it('derives persistence and eviction evidence from mutated ledger images', () => {
    const live = ledgerCompactionMutationEvents('live-eviction')
    const inflight = ledgerCompactionMutationEvents('inflight-eviction')
    const unexpired = ledgerCompactionMutationEvents('unexpired-eviction')
    expect(live).toContain('storage.replace:live-evicted')
    expect(inflight).toContain('storage.replace:inflight-evicted')
    expect(unexpired).toContain('storage.replace:unexpired-evicted')
    expectMutantRejected('G1-R18', events => [...events, ...live])
    expectMutantRejected('G1-R18', events => [...events, ...inflight])
    expectMutantRejected('G1-R18', events => [...events, ...unexpired])

    const persistenceMutants = [
      'revision',
      'project-evidence',
      'worktree-evidence',
      'result-request-id',
      'result-type',
      'result-payload',
      'inject-secret',
    ] as const
    for (const mutant of persistenceMutants) {
      const events = ledgerPersistenceMutationEvents(mutant)
      expect(events, mutant).not.toContain('storage.replace:receipt-fields-complete')
      expectMutantRejected('G1-R14', witness => [
        ...witness.filter(event => !event.includes('storage.replace:receipt-fields-complete')),
        ...events,
      ])
    }
    expect(ledgerPersistenceMutationEvents('inject-secret')).toContain('storage.replace:secret')
  })

  for (const obligation of shadowObligations) {
    it(`[${obligation.id}] remains an explicit real-plane shadow`, () => {
      expect(obligation.evidenceGate).toMatch(/G4|Task #47/)
      expect(obligation.assertion.length).toBeGreaterThan(20)
    })
  }

  for (const obligation of laterEvidenceObligations) {
    it(`[${obligation.id}] remains explicit later control-plane evidence`, () => {
      expect(obligation.evidenceGate).toContain('customer-control-plane')
      expect(obligation.assertion).toContain('ModulaStack')
    })
  }
})

describe('G2 production runtime is intentionally red', () => {
  for (const scenario of runtimeScenarios) {
    it(`[${scenario.obligationId}] ${scenario.assertion}`, async () => {
      const observation = await observeRuntimeScenario(scenario)
      expectOriginObservation(scenario, observation)
    })
  }
})

function scenarioById(id: RuntimeScenario['obligationId']): RuntimeScenario {
  const scenario = runtimeScenarios.find(candidate => candidate.obligationId === id)
  if (!scenario) throw new Error(`missing runtime scenario ${id}`)
  return scenario
}

function expectExpectedInterfaceBoundary(scenario: RuntimeScenario, observation: RuntimeObservation): boolean {
  if (observation.status !== 'missing-production-runtime') return false
  const expectedError = interfaceRedSubjectErrors[scenario.subject]
  expect(expectedError, `${scenario.obligationId} must not lose an active subject`).toBeDefined()
  expect(observation).toEqual({
    status: 'missing-production-runtime',
    subject: scenario.subject,
    error: expectedError,
  })
  return true
}

function expectOriginObservation(scenario: RuntimeScenario, observation: RuntimeObservation) {
  expect(observation.status, `${scenario.obligationId} must reach its ${scenario.subject} oracle`).toBe('observed')
  if (observation.status !== 'observed') return
  expect(observationMatches(observation, scenario.oracle), `${scenario.obligationId} discriminating oracle`).toBe(true)
  assertTerminalSequenceBoundary(scenario, observation)
}

async function expectExecutableMutantRejected(id: RuntimeScenario['obligationId'], fixture: string) {
  const source = scenarioById(id)
  const mutant: RuntimeScenario = { ...source, fixture, stimulus: `${fixture}:${id}` }
  const observation = await observeRuntimeScenario(mutant)
  if (expectExpectedInterfaceBoundary(mutant, observation)) return
  expect(observation.status).toBe('observed')
  if (observation.status !== 'observed') return
  expect(observationMatches(observation, source.oracle), `${id}:${fixture}`).toBe(false)
}

function nonSentinelLauncher(): SessionLauncher {
  return {
    async *handle() {
      throw new Error('capacity non-sentinel')
    },
    async *recover() {},
  }
}

function assertTerminalSequenceBoundary(scenario: RuntimeScenario, observation: RuntimeObservation) {
  if (observation.status !== 'observed') return
  if (scenario.obligationId === 'G1-C11') {
    expect(sequenceFor(observation, 'terminal.sequence:post-reconnect:[')).toBe(sequenceFor(observation, 'terminal.sequence:pre-disconnect:['))
    return
  }
  if (scenario.obligationId === 'G1-C12') {
    expect(sequenceFor(observation, 'terminal.sequence:post-reconnect:[')).toBeGreaterThan(
      sequenceFor(observation, 'terminal.sequence:pre-disconnect-high-water:['),
    )
    return
  }
  if (scenario.obligationId === 'G1-C13') {
    expect(sequenceFor(observation, 'terminal.sequence:reset:[')).toBeGreaterThan(
      sequenceFor(observation, 'terminal.sequence:pre-disconnect-high-water:['),
    )
  }
}

function sequenceFor(observation: Extract<RuntimeObservation, { status: 'observed' }>, prefix: string): number {
  const event = observation.events.find(candidate => candidate.includes(prefix))
  const digits = event?.match(/\[(\d+)\]/)?.[1]
  if (!digits) throw new Error(`missing sequence event ${prefix}`)
  const sequence = Number(digits)
  if (!Number.isSafeInteger(sequence)) throw new Error(`invalid sequence event ${prefix}`)
  return sequence
}

async function expectHomeFixtureFailure(
  fixture: 'home-unsafe-metadata' | 'home-read-unavailable' | 'home-replace-unavailable',
  required: string,
) {
  const events: string[] = []
  const storage = createHomeFixtureStorage(fixture, event => events.push(event))
  if (fixture === 'home-unsafe-metadata') {
    const inspection = await storage.inspect({ override: '/tmp/runtime-red-home' })
    expect(inspection.entries[0]?.kind).toBe('symlink')
  } else if (fixture === 'home-read-unavailable') {
    await expect(storage.read('configuration')).resolves.toEqual({ status: 'storage-unavailable' })
  } else {
    await expect(storage.replace('configuration', null, Buffer.from('{}'))).resolves.toEqual({ status: 'storage-unavailable' })
  }
  expect(events.some(event => event.includes(required))).toBe(true)
}

function expectMutantRejected(id: string, mutate: (events: readonly string[]) => readonly string[]) {
  const scenario = runtimeScenarios.find(candidate => candidate.obligationId === id)
  if (!scenario) throw new Error(`missing runtime scenario ${id}`)
  const witness = oracleWitness(scenario)
  if (witness.status !== 'observed') throw new Error('oracle witness must be observed')
  const mutant = { ...witness, events: mutate(witness.events) }
  expect(observationMatches(mutant, scenario.oracle), id).toBe(false)
}

function expectOutputMutantRejected(id: string, mutate: (output: readonly string[]) => readonly string[]) {
  const scenario = runtimeScenarios.find(candidate => candidate.obligationId === id)
  if (!scenario) throw new Error(`missing runtime scenario ${id}`)
  const witness = oracleWitness(scenario)
  if (witness.status !== 'observed') throw new Error('oracle witness must be observed')
  const mutant = { ...witness, output: mutate(witness.output) }
  expect(observationMatches(mutant, scenario.oracle), id).toBe(false)
}

function oracleWitness(scenario: RuntimeScenario): RuntimeObservation {
  const first = scenario.oracle.before?.map(([event]) => event) ?? []
  const second = new Set(scenario.oracle.before?.map(([, event]) => event) ?? [])
  const middle = scenario.oracle.require.filter(event => !first.includes(event) && !second.has(event))
  const events = [...new Set(first), ...middle, ...second]
  for (const [fragment, expected] of Object.entries(scenario.oracle.counts ?? {})) {
    const present = events.filter(event => event.includes(fragment)).length
    for (let index = present; index < expected; index += 1) events.push(fragment)
  }
  return {
    status: 'observed',
    subject: scenario.subject,
    result: scenario.oracle.result,
    events,
    output: scenario.oracle.outputIncludes ?? [],
  }
}

function countByArea(obligations: readonly RuntimeRedObligation[]): Record<RuntimeRedArea, number> {
  const counts = Object.fromEntries(Object.keys(expectedAreaCounts).map(area => [area, 0])) as Record<RuntimeRedArea, number>
  for (const obligation of obligations) counts[obligation.area] += 1
  return counts
}

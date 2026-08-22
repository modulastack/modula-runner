import { createHmac } from 'node:crypto'
import {
  PAIRING_CONFIRM_PATH,
  pairingConfirmationMessage,
  pairingSecretBytes,
} from '@modulastack/runner-protocol'
import {
  PairingContractError,
  PairingContractNotImplementedError,
  createPairingContractService,
  type ContractPairingIdentity,
  type ContractPairingRecord,
  type ContractPairingSnapshot,
  type PairingContractServiceOptions,
  type PairingHttpRequest,
  type PairingHttpResponse,
  type PairingMutation,
  type PairingReservation,
} from '../../src/index.js'
import { pairingFixtureBearer, pairingFixtureNonce } from './fixtureMaterial.js'
import { createRecorder } from './recorder.js'
import { pairingCodeFor } from './scenarioIdentity.js'
import { pairingSecrecySinks, type PairingSecrecySink } from './secrecySinks.js'
import type { RuntimeObservation, RuntimeScenario } from './scenarioTypes.js'

const bindingId = '123e4567-e89b-42d3-a456-426614174000'
const runnerId = 'runner-01'
const token = pairingFixtureBearer
const confirmationNonce = pairingFixtureNonce
const expiresAt = '2026-08-21T00:10:00Z'
const supersedingBindingId = '323e4567-e89b-42d3-a456-426614174003'
type PairingFrameEvidence = {
  method: PairingHttpRequest['method']
  url: string
  redirect: PairingHttpRequest['redirect']
  headerNames: readonly string[]
  bodyFields: readonly string[]
}

type PairingSecrecyEvidence = {
  outboundFrames: PairingFrameEvidence[]
  errors: string[]
  identity: ContractPairingIdentity | null
}

const pendingEnvelopeFields = [
  'bindingId',
  'confirmationExpiresAt',
  'confirmationNonce',
  'controlPlaneOrigin',
  'pendingSince',
  'runnerId',
  'token',
]

export async function observePairingScenario(scenario: RuntimeScenario): Promise<RuntimeObservation> {
  if (scenario.fixture === 'http-status-matrix') return observeHttpStatusMatrix(scenario)
  const recorder = createRecorder()
  const record = pendingRecord(scenario.fixture)
  let snapshot: ContractPairingSnapshot = scenario.fixture === 'resume-pending' || scenario.fixture.startsWith('confirmation-deadline')
    ? { state: 'pending', record }
    : scenario.fixture === 'pending-superseded'
      ? { state: 'pending', record: { ...record, bindingId: supersedingBindingId } }
      : { state: 'unpaired', record: null }
  const responses = pairingResponsesForFixture(scenario.fixture)
  const secrecy: PairingSecrecyEvidence = { outboundFrames: [], errors: [], identity: null }
  let exchangeIndex = 0
  const options: PairingContractServiceOptions = {
    clock: {
      now() {
        recorder.record(scenario.fixture.startsWith('confirmation-deadline') ? 'clock.deadline:600000' : 'clock.now')
        return scenario.fixture.startsWith('confirmation-deadline') ? Date.parse(expiresAt) : Date.parse('2026-08-21T00:00:00Z')
      },
      async sleep(milliseconds) {
        recorder.record(`clock.sleep:${milliseconds}`)
      },
    },
    transport: {
      async exchange(request) {
        const confirmation = new URL(request.url).pathname === PAIRING_CONFIRM_PATH
        secrecy.outboundFrames.push(recordPairingRequest(recorder.record, request, scenario))
        const response = responses[exchangeIndex++]
        if (response instanceof Error) {
          if (!confirmation) recorder.record('transport.redeem:lost-response')
          throw response
        }
        const resolved = response ?? { status: 500, mediaType: 'missing' as const, body: '' }
        recorder.record(`${confirmation ? 'transport.confirm' : 'transport.redeem'}:${resolved.status}`)
        return resolved
      },
    },
    store: {
      async reserve(): Promise<PairingReservation> {
        const status = scenario.fixture === 'reservation-in-progress' ? 'pairing-in-progress' : 'reserved'
        recorder.record(`store.reserve:${status}`)
        return status === 'reserved' ? { status, reservationId: 'reservation-1' } : { status }
      },
      async release() {
        recorder.record('store.release')
      },
      async commitPending(_reservationId, next): Promise<PairingMutation> {
        const declaredEnvelope = hasDeclaredPendingEnvelope(next)
        if (!declaredEnvelope) recorder.record('store.commitPending:unknown-field')
        const result = scenario.fixture === 'pending-store-failure'
          ? 'storage-unavailable'
          : scenario.fixture === 'pending-superseded' ? 'superseded' : 'updated'
        recorder.record(`store.commitPending:${result}`)
        if (result === 'updated') {
          snapshot = { state: 'pending', record: next }
          if (declaredEnvelope) recorder.record('store.commitPending:declared-envelope')
          recorder.record('clock.pendingSince')
        }
        return result
      },
      async snapshot() {
        recorder.record(`store.snapshot:${snapshot.state}`)
        if (scenario.fixture === 'pending-superseded') recorder.record('store.snapshot:new-binding')
        return snapshot
      },
      async markConfirmationUnknown(targetBindingId) {
        recorder.record('store.markConfirmationUnknown')
        recorder.record(`store.markConfirmationUnknown:${bindingLabel(targetBindingId)}`)
        return targetBindingId === supersedingBindingId ? 'updated' : scenario.fixture === 'pending-superseded' ? 'superseded' : 'updated'
      },
      async settle(targetBindingId) {
        recorder.record('store.settle')
        recorder.record(`store.settle:${bindingLabel(targetBindingId)}`)
        return targetBindingId === supersedingBindingId || scenario.fixture !== 'pending-superseded' ? 'updated' : 'superseded'
      },
      async revoke(targetBindingId) {
        recorder.record('store.revoke')
        recorder.record(`store.revoke:${bindingLabel(targetBindingId)}`)
        if (targetBindingId === supersedingBindingId) snapshot = snapshot.state === 'pending' ? { state: 'revoked', record: snapshot.record } : snapshot
        return targetBindingId === supersedingBindingId || scenario.fixture !== 'pending-superseded' ? 'updated' : 'superseded'
      },
    },
  }
  const service = createPairingContractService(options)
  try {
    if (scenario.fixture === 'resume-pending' || scenario.fixture.startsWith('confirmation-deadline')) {
      const value = await service.resumeConfirmation()
      secrecy.identity = value
      return observed(scenario, value ? 'pairing:resume:success' : 'pairing:resume:null', recorder, secrecy, snapshot)
    }
    const code = pairingCodeFor(scenario.obligationId)
    recorder.record('input.code:accepted')
    const value = await service.pair('https://example.test', {
      code,
      runner: { name: 'runtime-red', version: '0.1.0', os: 'linux', arch: 'x64' },
    })
    recorder.record(`pairing.identity:${value.bindingId}:${value.runnerId}`)
    secrecy.identity = value
    return observed(scenario, 'pairing:success', recorder, secrecy, snapshot)
  } catch (error) {
    if (error instanceof PairingContractNotImplementedError) {
      return { status: 'missing-production-runtime', subject: 'pairing', error: error.name }
    }
    if (error instanceof PairingContractError) {
      secrecy.errors.push(error.message)
      if (scenario.fixture === 'confirm-network-loss') await service.snapshot()
      return observed(scenario, `pairing:error:${error.failure}`, recorder, secrecy, snapshot)
    }
    throw error
  }
}

async function observeHttpStatusMatrix(scenario: RuntimeScenario): Promise<RuntimeObservation> {
  const recorder = createRecorder()
  recorder.record(`storage.fixture:${scenario.fixture}`)
  const cases = [
    ['redeem-204-body', 'pairing:error:malformed-response'],
    ['redeem-201-body', 'pairing:error:malformed-response'],
    ['redeem-invalid-404', 'pairing:error:invalid-code'],
    ['redeem-expired-410', 'pairing:error:expired-code'],
    ['redeem-refused-501', 'pairing:error:refused'],
    ['redeem-unreachable-599', 'pairing:error:unreachable'],
    ['confirm-204-body', 'pairing:error:malformed-response'],
    ['confirm-malformed-200', 'pairing:error:malformed-response'],
    ['confirm-unreachable-404', 'pairing:error:unreachable'],
    ['confirm-expired-status', 'pairing:error:expired-code'],
    ['confirm-terminal-refusal', 'pairing:error:refused'],
    ['confirm-unreachable-599', 'pairing:error:unreachable'],
  ] as const
  let complete = true
  for (const [fixture, expected] of cases) {
    const observation = await observePairingScenario({ ...scenario, fixture, stimulus: `${scenario.stimulus}:${fixture}` })
    if (observation.status === 'missing-production-runtime') return observation
    for (const event of observation.events) recorder.record(event.slice(event.indexOf(':') + 1))
    const outcome = observation.result === expected ? expected.replace('pairing:error:', '') : `wrong:${observation.result}`
    recorder.record(`pairing.status:${fixture}:${outcome}`)
    complete &&= observation.result === expected
  }
  if (complete) recorder.record('pairing.status-matrix:complete')
  return { status: 'observed', subject: 'pairing', result: 'pairing:status-matrix', events: recorder.events, output: recorder.output }
}

export function hasDeclaredPendingEnvelope(value: object): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === pendingEnvelopeFields.length && actual.every((key, index) => key === pendingEnvelopeFields[index])
}

function pendingRecord(fixture: string): ContractPairingRecord {
  return {
    bindingId,
    runnerId,
    token,
    confirmationNonce,
    confirmationExpiresAt: expiresAt,
    controlPlaneOrigin: 'https://example.test',
    pendingSince: '2026-08-21T00:00:00Z',
    ...(fixture.includes('network-loss') || fixture.includes('uncertain') ? { confirmationUnknownAt: '2026-08-21T00:05:00Z' } : {}),
  }
}

export function pairingResponsesForFixture(fixture: string): Array<PairingHttpResponse | Error> {
  const envelope = JSON.stringify({ bindingId, runnerId, token, confirmationNonce, confirmationExpiresAt: expiresAt, unknown: 'discard-me' })
  if (fixture === 'redeem-wrong-media') return [{ status: 200, mediaType: 'other', body: envelope }]
  if (fixture === 'redeem-204-body') return [{ status: 204, mediaType: 'application/json', body: envelope }]
  if (fixture === 'redeem-201-body') return [{ status: 201, mediaType: 'application/json', body: envelope }]
  if (fixture === 'redeem-invalid-404') return [{ status: 404, mediaType: 'missing', body: '' }]
  if (fixture === 'redeem-expired-410') return [{ status: 410, mediaType: 'missing', body: '' }]
  if (fixture === 'redeem-refused-501') return [{ status: 501, mediaType: 'missing', body: '' }]
  if (fixture === 'redeem-unreachable-599') return [{ status: 599, mediaType: 'missing', body: '' }]
  if (fixture === 'redeem-response-lost') return [new Error('response lost')]
  if (fixture === 'confirm-network-loss') {
    return [{ status: 200, mediaType: 'application/json', body: envelope }, new Error('confirmation unknown')]
  }
  if (fixture === 'confirmation-deadline-uncertain') return [{ status: 503, mediaType: 'missing', body: '' }]
  if (fixture === 'confirm-204-body') return [{ status: 200, mediaType: 'application/json', body: envelope }, { status: 204, mediaType: 'application/json', body: '{}' }]
  if (fixture === 'confirm-malformed-200') return [{ status: 200, mediaType: 'application/json', body: envelope }, { status: 200, mediaType: 'application/json', body: '{}' }]
  if (fixture === 'confirm-unreachable-404') return [{ status: 200, mediaType: 'application/json', body: envelope }, { status: 404, mediaType: 'missing', body: '' }]
  if (fixture === 'confirm-unreachable-599') return [{ status: 200, mediaType: 'application/json', body: envelope }, { status: 599, mediaType: 'missing', body: '' }]
  if (fixture === 'confirm-expired-status') return [{ status: 200, mediaType: 'application/json', body: envelope }, { status: 410, mediaType: 'missing', body: '' }]
  if (fixture === 'confirm-terminal-refusal') return [{ status: 200, mediaType: 'application/json', body: envelope }, { status: 403, mediaType: 'missing', body: '' }]
  if (fixture === 'resume-pending') return [{ status: 204, mediaType: 'missing', body: '' }]
  return [{ status: 200, mediaType: 'application/json', body: envelope }, { status: 204, mediaType: 'missing', body: '' }]
}

export function pairingRequestContainsFixtureBearer(
  request: Pick<PairingHttpRequest, 'headers' | 'body'>,
): boolean {
  if (Object.values(request.headers).some(value => value.includes(pairingFixtureBearer))) return true
  try {
    return containsFixtureBearer(JSON.parse(request.body))
  } catch {
    return request.body.includes(pairingFixtureBearer)
  }
}

function containsFixtureBearer(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(pairingFixtureBearer)
  if (Array.isArray(value)) return value.some(containsFixtureBearer)
  if (typeof value !== 'object' || value === null) return false
  return Object.values(value).some(containsFixtureBearer)
}

function recordPairingRequest(
  record: (event: string) => void,
  request: PairingHttpRequest,
  scenario: RuntimeScenario,
): PairingFrameEvidence {
  const url = new URL(request.url)
  const confirmation = url.pathname === PAIRING_CONFIRM_PATH
  record(`transport.bearer-leak:${pairingRequestContainsFixtureBearer(request)}`)
  const parsed = JSON.parse(request.body) as Record<string, unknown>
  const evidence: PairingFrameEvidence = {
    method: request.method,
    url: request.url,
    redirect: request.redirect,
    headerNames: Object.keys(request.headers).sort(),
    bodyFields: Object.keys(parsed).sort(),
  }
  record(`${confirmation ? 'transport.confirm' : 'transport.redeem'}:${url.pathname}`)
  if (!confirmation) record(`transport.redeem:${url.origin}`)
  record(`transport.redirect:${request.redirect}`)
  if (!confirmation) {
    if (evidence.bodyFields.join(',') === 'code,runner') record('transport.body:code+runner')
    if ('token' in parsed) record('transport.body:token')
    if ('secret' in parsed || 'workloadSecret' in parsed) record('transport.body:workload-secret')
    return evidence
  }
  record('transport.confirm:tokenProof')
  if ('token' in parsed) record('transport.confirm:bearer-token')
  const message = pairingConfirmationMessage({ bindingId, runnerId, origin: 'https://example.test', confirmationNonce })
  const key = pairingSecretBytes(token)
  const expected = message && key ? createHmac('sha256', key).update(message, 'utf8').digest('hex') : null
  if (parsed.tokenProof === expected) {
    record('transport.confirm:proof-bound')
    record('transport.confirm:nonce-bound')
  }
  if (scenario.fixture === 'resume-pending') record('transport.confirm:repeat')
  if (scenario.fixture.startsWith('confirmation-deadline')) record('transport.confirm:final')
  return evidence
}

function bindingLabel(targetBindingId: string): string {
  if (targetBindingId === bindingId) return 'old-binding'
  if (targetBindingId === supersedingBindingId) return 'new-binding'
  return 'unknown-binding'
}

function observed(
  scenario: RuntimeScenario,
  result: string,
  recorder: ReturnType<typeof createRecorder>,
  secrecy: PairingSecrecyEvidence,
  snapshot: ContractPairingSnapshot,
): RuntimeObservation {
  recordPairingSecrecySinks(recorder, secrecy, snapshot)
  recorder.record(`transport.media:${scenario.fixture === 'redeem-wrong-media' ? 'other' : 'application/json'}`)
  return { status: 'observed', subject: 'pairing', result, events: recorder.events, output: recorder.output }
}

function recordPairingSecrecySinks(
  recorder: ReturnType<typeof createRecorder>,
  secrecy: PairingSecrecyEvidence,
  snapshot: ContractPairingSnapshot,
) {
  const values: Record<PairingSecrecySink, unknown> = {
    frames: secrecy.outboundFrames,
    argv: ['pair', '--control-plane', 'https://example.test'],
    environment: [],
    logs: recorder.events,
    errors: secrecy.errors,
    listings: { state: snapshot.state, fields: snapshot.record ? Object.keys(snapshot.record).sort() : [] },
    artifacts: secrecy.identity,
  }
  for (const sink of pairingSecrecySinks) recorder.capture(sink, values[sink])
}

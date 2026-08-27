import { createHmac } from 'node:crypto'
import {
  PAIRING_CONFIRM_PATH,
  pairingConfirmationMessage,
  pairingSecretBytes,
  type PairingRedemptionRequest,
} from '@modulastack/runner-protocol'
import { describe, expect, it } from 'vitest'
import {
  PairingContractError,
  createPairingContractService,
  type ContractPairingRecord,
  type ContractPairingSnapshot,
  type PairingContractStore,
  type PairingHttpRequest,
  type PairingHttpResponse,
} from '../src/index.js'

const now = Date.parse('2026-08-21T00:00:00Z')
const token = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
const confirmationNonce = 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8'
const envelope = {
  bindingId: '123e4567-e89b-42d3-a456-426614174000',
  runnerId: 'runner-01',
  token,
  confirmationNonce,
  confirmationExpiresAt: '2026-08-21T00:10:00Z',
}
const request: PairingRedemptionRequest = {
  code: 'AAECAwQFBgcICQoLDA0ODw.EBESExQVFhcYGRobHB0',
  runner: { name: 'runner', version: '0.1.0', os: 'linux', arch: 'x64' },
}

function store(initial: ContractPairingSnapshot = { state: 'unpaired', record: null }) {
  let snapshot = structuredClone(initial)
  const events: string[] = []
  const value: PairingContractStore = {
    reserve: async () => { events.push('reserve'); return { status: 'reserved', reservationId: 'reservation-1' } },
    release: async () => { events.push('release') },
    commitPending: async (_reservationId, record) => {
      events.push('commit')
      snapshot = { state: 'pending', record: structuredClone(record) }
      return 'updated'
    },
    snapshot: async () => structuredClone(snapshot),
    markConfirmationUnknown: async (_bindingId, at) => {
      events.push('unknown')
      if (snapshot.state === 'pending') snapshot = { state: 'pending', record: { ...snapshot.record, confirmationUnknownAt: at } }
      return 'updated'
    },
    settle: async (_bindingId, pairedAt) => {
      events.push('settle')
      if (snapshot.state === 'pending') snapshot = { state: 'paired', record: { ...snapshot.record, pairedAt } }
      return 'updated'
    },
    revoke: async (_bindingId, revokedAt) => {
      events.push('revoke')
      if (snapshot.state === 'pending' || snapshot.state === 'paired') snapshot = { state: 'revoked', record: { ...snapshot.record, revokedAt } }
      return 'updated'
    },
  }
  return { value, events, snapshot: () => structuredClone(snapshot) }
}

function service(responses: Array<PairingHttpResponse | Error>, held = store(), clockNow = now) {
  const requests: PairingHttpRequest[] = []
  let index = 0
  return {
    held,
    requests,
    value: createPairingContractService({
      store: held.value,
      clock: { now: () => clockNow, sleep: async () => undefined },
      transport: {
        exchange: async candidate => {
          requests.push(candidate)
          const response = responses[index++]
          if (response instanceof Error) throw response
          if (!response) throw new Error('missing fixture response')
          return response
        },
      },
    }),
  }
}

function redemption(body = JSON.stringify({ ...envelope, ignored: 'discard' })): PairingHttpResponse {
  return { status: 200, mediaType: 'application/json', body }
}

function confirmation(status = 204, body = ''): PairingHttpResponse {
  return { status, mediaType: 'missing', body }
}

describe('production pairing contract', () => {
  it('stores the declared pending envelope before sending a bound proof without the token', async () => {
    const subject = service([redemption(), confirmation()])
    await expect(subject.value.pair('https://example.test/path', request)).resolves.toEqual({
      bindingId: envelope.bindingId,
      runnerId: envelope.runnerId,
    })
    expect(subject.held.events).toEqual(['reserve', 'commit', 'settle'])
    expect(subject.requests.map(value => new URL(value.url).pathname)).toEqual(['/api/runner/v1/pair', PAIRING_CONFIRM_PATH])
    expect(subject.requests[0]).toMatchObject({ redirect: 'error', timeoutMs: 15_000 })
    const confirmBody = JSON.parse(subject.requests[1]!.body) as Record<string, unknown>
    expect(confirmBody).not.toHaveProperty('token')
    const message = pairingConfirmationMessage({
      bindingId: envelope.bindingId,
      runnerId: envelope.runnerId,
      origin: 'https://example.test',
      confirmationNonce,
    })!
    expect(confirmBody.tokenProof).toBe(createHmac('sha256', pairingSecretBytes(token)!).update(message).digest('hex'))
    expect(subject.held.snapshot()).toMatchObject({ state: 'paired', record: { controlPlaneOrigin: 'https://example.test' } })
  })

  it('never replays an unknown redemption and releases its reservation', async () => {
    const subject = service([new Error('response lost')])
    await expect(subject.value.pair('https://example.test', request)).rejects.toMatchObject({ failure: 'unreachable' })
    expect(subject.held.events).toEqual(['reserve', 'release'])
    expect(subject.requests).toHaveLength(1)
  })

  it('releases the local reservation when pending-envelope persistence fails', async () => {
    const held = store()
    held.value.commitPending = async () => { held.events.push('commit'); return 'storage-unavailable' }
    const subject = service([redemption()], held)
    await expect(subject.value.pair('https://example.test', request)).rejects.toMatchObject({ failure: 'store-failed' })
    expect(held.events).toEqual(['reserve', 'commit', 'release'])
    expect(subject.requests).toHaveLength(1)
  })

  it('keeps a durable pending binding resumable after ambiguous confirmation loss', async () => {
    const subject = service([redemption(), new Error('confirmation lost')])
    await expect(subject.value.pair('https://example.test', request)).rejects.toMatchObject({ failure: 'unreachable' })
    expect(subject.held.events).toEqual(['reserve', 'commit', 'unknown'])
    expect(subject.held.snapshot()).toMatchObject({ state: 'pending', record: { confirmationUnknownAt: '2026-08-21T00:00:00.000Z' } })
  })

  it('revokes terminal confirmation refusal and leaves no retry path', async () => {
    const subject = service([redemption(), confirmation(403)])
    await expect(subject.value.pair('https://example.test', request)).rejects.toMatchObject({ failure: 'refused' })
    expect(subject.held.events).toEqual(['reserve', 'commit', 'revoke'])
    expect(subject.held.snapshot().state).toBe('revoked')
  })

  it('treats server confirmation expiry as metadata rather than a runner-clock deadline', async () => {
    const skewed = { ...envelope, confirmationExpiresAt: '2026-08-20T23:50:00Z' }
    const subject = service([redemption(JSON.stringify(skewed)), confirmation()])
    await expect(subject.value.pair('https://example.test', request)).resolves.toEqual({
      bindingId: envelope.bindingId,
      runnerId: envelope.runnerId,
    })
    expect(subject.held.events).toEqual(['reserve', 'commit', 'settle'])
  })

  it('uses pendingSince plus ten minutes for the final local confirmation', async () => {
    const record: ContractPairingRecord = {
      ...envelope,
      confirmationExpiresAt: '2026-08-22T00:00:00Z',
      controlPlaneOrigin: 'https://example.test',
      pendingSince: '2026-08-21T00:00:00Z',
    }
    const before = store({ state: 'pending', record })
    await expect(service([confirmation(404)], before, Date.parse('2026-08-21T00:09:59Z')).value.resumeConfirmation())
      .rejects.toMatchObject({ failure: 'unreachable' })
    expect(before.snapshot().state).toBe('pending')

    const atDeadline = store({ state: 'pending', record })
    await expect(service([confirmation(404)], atDeadline, Date.parse('2026-08-21T00:10:00Z')).value.resumeConfirmation())
      .rejects.toMatchObject({ failure: 'expired-code' })
    expect(atDeadline.snapshot().state).toBe('revoked')
  })

  it('reports confirmation uncertainty on a final unknown deadline attempt', async () => {
    const record: ContractPairingRecord = {
      ...envelope,
      controlPlaneOrigin: 'https://example.test',
      pendingSince: '2026-08-21T00:00:00Z',
      confirmationUnknownAt: '2026-08-21T00:05:00Z',
    }
    const held = store({ state: 'pending', record })
    const subject = service([new Error('still unknown')], held, Date.parse(envelope.confirmationExpiresAt))
    await expect(subject.value.resumeConfirmation()).rejects.toMatchObject({ failure: 'confirmation-uncertain' })
    expect(held.events).toEqual(['unknown'])
  })

  it('does not let a final route absence erase an earlier unknown activation result', async () => {
    const record: ContractPairingRecord = {
      ...envelope,
      controlPlaneOrigin: 'https://example.test',
      pendingSince: '2026-08-21T00:00:00Z',
      confirmationUnknownAt: '2026-08-21T00:05:00Z',
    }
    const held = store({ state: 'pending', record })
    const subject = service([confirmation(404)], held, Date.parse(envelope.confirmationExpiresAt))
    await expect(subject.value.resumeConfirmation()).rejects.toMatchObject({ failure: 'confirmation-uncertain' })
    expect(held.events).toEqual([])
    expect(held.snapshot().state).toBe('pending')
  })

  it('expires after a final route absence only when no attempt was unknown', async () => {
    const record: ContractPairingRecord = {
      ...envelope,
      controlPlaneOrigin: 'https://example.test',
      pendingSince: '2026-08-21T00:00:00Z',
    }
    const held = store({ state: 'pending', record })
    const subject = service([confirmation(404)], held, Date.parse(envelope.confirmationExpiresAt))
    await expect(subject.value.resumeConfirmation()).rejects.toMatchObject({ failure: 'expired-code' })
    expect(held.events).toEqual(['revoke'])
    expect(held.snapshot().state).toBe('revoked')
  })

  it('records malformed confirmation success as unknown before reporting it', async () => {
    const malformed = { status: 204, mediaType: 'application/json' as const, body: '{}' }
    const subject = service([redemption(), malformed])
    await expect(subject.value.pair('https://example.test', request)).rejects.toMatchObject({ failure: 'malformed-response' })
    expect(subject.held.events).toEqual(['reserve', 'commit', 'unknown'])
    expect(subject.held.snapshot()).toMatchObject({ state: 'pending', record: { confirmationUnknownAt: '2026-08-21T00:00:00.000Z' } })
  })

  it('rejects malformed success bodies before confirmation and releases the reservation', async () => {
    const cases = [
      { status: 200, mediaType: 'other' as const, body: JSON.stringify(envelope) },
      redemption('{'),
      redemption(JSON.stringify({ ...envelope, token: 'invalid' })),
    ]
    for (const response of cases) {
      const subject = service([response])
      await expect(subject.value.pair('https://example.test', request)).rejects.toBeInstanceOf(PairingContractError)
      expect(subject.held.events).toEqual(['reserve', 'release'])
      expect(subject.requests).toHaveLength(1)
    }
  })
})

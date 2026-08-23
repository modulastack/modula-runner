import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  MAX_PAIRING_CODE_LENGTH,
  PAIRING_CONFIRM_PATH,
  PAIRING_REDEEM_PATH,
  canonicalPairingOrigin,
  isPairingCode,
  isPairingSecret,
  pairingConfirmationMessage,
  pairingConfirmationStatus,
  pairingRedemptionStatus,
  pairingSecretBytes,
  parsePairingConfirmationRequest,
  parsePairingRedemptionRequest,
  parsePendingPairingEnvelope,
} from '@modulastack/runner-protocol'

const bindingId = '123e4567-e89b-42d3-a456-426614174000'
const pairingCode = 'AAECAwQFBgcICQoLDA0ODw.EBESExQVFhcYGRobHB0'
const request = {
  code: `  ${pairingCode}  `,
  runner: { name: 'desk runner', version: '0.1.0', os: 'linux', arch: 'x64' },
  ignored: 'discarded',
}
const token = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
const nonce = 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8'

const envelope = {
  bindingId,
  runnerId: 'runner-01',
  token,
  confirmationNonce: nonce,
  confirmationExpiresAt: '2026-08-21T14:00:00Z',
  endpoint: 'must-not-survive',
}

describe('pairing HTTP contract', () => {
  it('publishes the frozen versioned routes', () => {
    expect(PAIRING_REDEEM_PATH).toBe('/api/runner/v1/pair')
    expect(PAIRING_CONFIRM_PATH).toBe('/api/runner/v1/pair/confirm')
  })

  it('normalizes declared request and pending response fields only', () => {
    expect(parsePairingRedemptionRequest(request)).toEqual({ code: pairingCode, runner: request.runner })
    expect(parsePendingPairingEnvelope(envelope)).toEqual({
      bindingId,
      runnerId: 'runner-01',
      token,
      confirmationNonce: nonce,
      confirmationExpiresAt: '2026-08-21T14:00:00Z',
    })
  })

  it('enforces canonical pairing-code entropy, 32-byte secrets, and envelope identity', () => {
    expect(pairingCode).toHaveLength(MAX_PAIRING_CODE_LENGTH)
    expect(isPairingCode(pairingCode)).toBe(true)
    expect(isPairingCode(`AAECAwQFBgcICQoLDA0ODw.${'A'.repeat(18)}`)).toBe(false)
    expect(isPairingCode(`AAECAwQFBgcICQoLDA0ODw.${pairingCode.split('.')[1]}=`)).toBe(false)
    expect(parsePairingRedemptionRequest({ ...request, code: 'short-lived-code' })).toBeNull()
    expect(isPairingSecret(token)).toBe(true)
    expect(isPairingSecret(`${token}=`)).toBe(false)
    expect(isPairingSecret(`${token.slice(0, -1)}B`)).toBe(false)
    expect(parsePendingPairingEnvelope({ ...envelope, bindingId: bindingId.toUpperCase() })).toBeNull()
    expect(parsePendingPairingEnvelope({ ...envelope, confirmationNonce: token })).toBeNull()
    expect(parsePendingPairingEnvelope({ ...envelope, confirmationExpiresAt: '2026-02-30T00:00:00Z' })).toBeNull()
    expect(parsePairingRedemptionRequest({ ...request, runner: { ...request.runner, name: 'bad\nname' } })).toBeNull()
  })

  it('uses one WHATWG ASCII origin and reproduces the cross-language proof vector', () => {
    expect(canonicalPairingOrigin('https://EXAMPLE.test:443/path?q=1')).toBe('https://example.test')
    expect(canonicalPairingOrigin('https://user:pass@example.test')).toBeNull()
    expect(canonicalPairingOrigin('file:///tmp/control-plane')).toBeNull()
    const message = pairingConfirmationMessage({ bindingId, runnerId: 'runner-01', origin: 'https://EXAMPLE.test:443/path', confirmationNonce: nonce })
    expect(message).toBe(`modula-runner-pair-confirm:v1\n${bindingId}\nrunner-01\nhttps://example.test\n${nonce}`)
    expect(createHmac('sha256', pairingSecretBytes(token)!).update(message!, 'utf8').digest('hex'))
      .toBe('7610a86a8a314afd963c1348c35d41c46579aa456e99ef612d0a1becf1c9eec0')
  })

  it('validates confirmation without carrying the bearer token', () => {
    const confirmation = parsePairingConfirmationRequest({
      bindingId,
      runnerId: 'runner-01',
      confirmationNonce: nonce,
      tokenProof: 'a'.repeat(64),
      token: 'discard-me',
    })
    expect(confirmation).toEqual({ bindingId, runnerId: 'runner-01', confirmationNonce: nonce, tokenProof: 'a'.repeat(64) })
    expect(confirmation).not.toHaveProperty('token')
    expect(parsePairingConfirmationRequest({ ...confirmation, tokenProof: 'A'.repeat(64) })).toBeNull()
  })

  it('classifies every HTTP status family without an unruled success', () => {
    expect(pairingRedemptionStatus(200)).toBe('pending')
    expect(pairingRedemptionStatus(204)).toBe('malformed-response')
    expect(pairingRedemptionStatus(404)).toBe('invalid-code')
    expect(pairingRedemptionStatus(410)).toBe('expired-code')
    expect(pairingRedemptionStatus(501)).toBe('refused')
    expect(pairingRedemptionStatus(599)).toBe('unreachable')
    expect(pairingConfirmationStatus(200)).toBe('malformed-response')
    expect(pairingConfirmationStatus(204)).toBe('confirmed')
    expect(pairingConfirmationStatus(404)).toBe('unreachable')
    expect(pairingConfirmationStatus(410)).toBe('expired-code')
    expect(pairingConfirmationStatus(418)).toBe('refused')
    expect(pairingConfirmationStatus(599)).toBe('unreachable')
  })
})

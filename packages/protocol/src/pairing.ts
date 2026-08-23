import { isSafeIdentifier, type RunnerInfo } from './frames.js'
import { isBoundedControlFreeString, isLowercaseUuidV4, isRecord, isRfc3339Utc } from './validation.js'

export const PAIRING_REDEEM_PATH = '/api/runner/v1/pair'
export const PAIRING_CONFIRM_PATH = '/api/runner/v1/pair/confirm'
export const PAIRING_CHALLENGE_TTL_MS = 10 * 60 * 1000
export const PAIRING_CODE_ID_BYTES = 16
export const PAIRING_CODE_SECRET_BYTES = 14
export const PAIRING_CODE_ID_TEXT_LENGTH = 22
export const PAIRING_CODE_SECRET_TEXT_LENGTH = 19
export const MAX_PAIRING_CODE_LENGTH = PAIRING_CODE_ID_TEXT_LENGTH + 1 + PAIRING_CODE_SECRET_TEXT_LENGTH
export const MAX_PAIRING_RESPONSE_BYTES = 64 * 1024
export const PAIRING_SECRET_BYTES = 32
export const PAIRING_SECRET_TEXT_LENGTH = 43

export type PairingRedemptionRequest = {
  code: string
  runner: RunnerInfo
}

export type PendingPairingEnvelope = {
  bindingId: string
  runnerId: string
  token: string
  confirmationNonce: string
  confirmationExpiresAt: string
}

export type PairingConfirmationRequest = {
  bindingId: string
  runnerId: string
  confirmationNonce: string
  tokenProof: string
}

export type PairingConfirmationProofInput = {
  bindingId: string
  runnerId: string
  origin: string
  confirmationNonce: string
}

export type PairingRedemptionStatus =
  | 'pending'
  | 'invalid-code'
  | 'expired-code'
  | 'unreachable'
  | 'refused'
  | 'malformed-response'

export type PairingConfirmationStatus =
  | 'confirmed'
  | 'expired-code'
  | 'unreachable'
  | 'refused'
  | 'malformed-response'

export function parsePairingRedemptionRequest(value: unknown): PairingRedemptionRequest | null {
  if (!isRecord(value) || typeof value.code !== 'string') return null
  const code = value.code.trim()
  if (!isPairingCode(code)) return null
  const runner = parsePairingRunner(value.runner)
  return runner ? { code, runner } : null
}

export function parsePendingPairingEnvelope(value: unknown): PendingPairingEnvelope | null {
  if (!isRecord(value)) return null
  const { bindingId, runnerId, token, confirmationNonce, confirmationExpiresAt } = value
  if (!isLowercaseUuidV4(bindingId) || !isSafeIdentifier(runnerId)) return null
  if (!isPairingSecret(token) || !isPairingSecret(confirmationNonce) || token === confirmationNonce || !isRfc3339Utc(confirmationExpiresAt)) return null
  return { bindingId, runnerId, token, confirmationNonce, confirmationExpiresAt }
}

export function parsePairingConfirmationRequest(value: unknown): PairingConfirmationRequest | null {
  if (!isRecord(value)) return null
  const { bindingId, runnerId, confirmationNonce, tokenProof } = value
  if (!isLowercaseUuidV4(bindingId) || !isSafeIdentifier(runnerId) || !isPairingSecret(confirmationNonce)) return null
  if (typeof tokenProof !== 'string' || !/^[0-9a-f]{64}$/.test(tokenProof)) return null
  return { bindingId, runnerId, confirmationNonce, tokenProof }
}

// Canonicalization is not transport authorization. The runner still applies its
// HTTPS-except-loopback secure-URL policy before calling this shared serializer.
export function canonicalPairingOrigin(input: string): string | null {
  try {
    const url = new URL(input)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.origin === 'null') return null
    return url.origin
  } catch {
    return null
  }
}

export function pairingConfirmationMessage(input: PairingConfirmationProofInput): string | null {
  const origin = canonicalPairingOrigin(input.origin)
  if (!origin || !isLowercaseUuidV4(input.bindingId) || !isSafeIdentifier(input.runnerId)) return null
  if (!isPairingSecret(input.confirmationNonce)) return null
  return `modula-runner-pair-confirm:v1\n${input.bindingId}\n${input.runnerId}\n${origin}\n${input.confirmationNonce}`
}

export function isPairingCode(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== MAX_PAIRING_CODE_LENGTH) return false
  const [id, secret, extra] = value.split('.')
  if (extra !== undefined || !id || !secret) return false
  return canonicalBase64urlBytes(id, PAIRING_CODE_ID_BYTES) && canonicalBase64urlBytes(secret, PAIRING_CODE_SECRET_BYTES)
}

export function pairingSecretBytes(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length !== PAIRING_SECRET_TEXT_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) return null
  const decoded = Buffer.from(value, 'base64url')
  return decoded.length === PAIRING_SECRET_BYTES && decoded.toString('base64url') === value ? decoded : null
}

export function isPairingSecret(value: unknown): value is string {
  return pairingSecretBytes(value) !== null
}

function canonicalBase64urlBytes(value: string, bytes: number): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false
  const decoded = Buffer.from(value, 'base64url')
  return decoded.length === bytes && decoded.toString('base64url') === value
}

export function pairingRedemptionStatus(status: number): PairingRedemptionStatus {
  if (!isHttpStatus(status)) return 'malformed-response'
  if (status === 200) return 'pending'
  if (status < 200 || (status >= 201 && status < 300)) return 'malformed-response'
  if (status >= 300 && status < 400) return 'unreachable'
  if (status === 400 || status === 401 || status === 404) return 'invalid-code'
  if (status === 409 || status === 410) return 'expired-code'
  if (status === 429 || (status >= 500 && status !== 501)) return 'unreachable'
  return 'refused'
}

export function pairingConfirmationStatus(status: number): PairingConfirmationStatus {
  if (!isHttpStatus(status)) return 'malformed-response'
  if (status === 204) return 'confirmed'
  if (status < 200 || (status >= 200 && status < 300)) return 'malformed-response'
  if (status >= 300 && status < 400) return 'unreachable'
  if (status === 409 || status === 410) return 'expired-code'
  if (status === 404 || status === 405 || status === 429 || status >= 500) return 'unreachable'
  return 'refused'
}

function parsePairingRunner(value: unknown): RunnerInfo | null {
  if (!isRecord(value)) return null
  const { name, version, os, arch } = value
  if (![name, version, os, arch].every(field => isBoundedControlFreeString(field, 1, 200))) return null
  return { name: name as string, version: version as string, os: os as string, arch: arch as string }
}

function isHttpStatus(status: number) {
  return Number.isInteger(status) && status >= 100 && status <= 599
}

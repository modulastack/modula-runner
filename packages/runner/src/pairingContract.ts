import { createHmac } from 'node:crypto'
import {
  MAX_PAIRING_RESPONSE_BYTES,
  PAIRING_CHALLENGE_TTL_MS,
  PAIRING_CONFIRM_PATH,
  PAIRING_REDEEM_PATH,
  canonicalPairingOrigin,
  pairingConfirmationMessage,
  pairingConfirmationStatus,
  pairingRedemptionStatus,
  pairingSecretBytes,
  parsePairingRedemptionRequest,
  parsePendingPairingEnvelope,
  type PairingRedemptionRequest,
  type PendingPairingEnvelope,
} from '@modulastack/runner-protocol'
import { assertSecureControlPlaneUrl } from './secureUrl.js'
import type { RunnerClock } from './runtimeClock.js'

export const PAIRING_CONTRACT_FAILURES = [
  'invalid-code',
  'expired-code',
  'unreachable',
  'refused',
  'malformed-response',
  'store-failed',
  'settle-failed',
  'superseded',
  'pairing-in-progress',
  'already-paired',
  'confirmation-uncertain',
] as const
export type PairingContractFailure = (typeof PAIRING_CONTRACT_FAILURES)[number]

export class PairingContractError extends Error {
  constructor(readonly failure: PairingContractFailure, message: string) {
    super(message)
    this.name = 'PairingContractError'
  }
}

export type ContractPairingRecord = PendingPairingEnvelope & {
  controlPlaneOrigin: string
  pendingSince: string
  pairedAt?: string
  revokedAt?: string
  confirmationUnknownAt?: string
}

export type ContractPairingState = 'unpaired' | 'reserved' | 'pending' | 'paired' | 'revoked'

// Reservation ids are process-local capabilities and never leave the mutating caller. A durable
// store restores a stale reserved state's recorded predecessor on first snapshot/reserve after
// ownership loss; `reserved` here therefore describes only a live in-process lease.
export type ContractPairingSnapshot =
  | { state: 'unpaired' | 'reserved'; record: null }
  | { state: 'pending' | 'paired' | 'revoked'; record: ContractPairingRecord }

export type PairingReservation =
  | { status: 'reserved'; reservationId: string }
  | { status: 'pairing-in-progress' }
  | { status: 'already-paired' }

export type PairingMutation = 'updated' | 'superseded' | 'storage-unavailable'

export interface PairingContractStore {
  reserve(): Promise<PairingReservation>
  release(reservationId: string): Promise<void>
  commitPending(reservationId: string, record: ContractPairingRecord): Promise<PairingMutation>
  // Snapshot recovers a durable reservation not owned by this store instance before returning.
  snapshot(): Promise<ContractPairingSnapshot>
  markConfirmationUnknown(bindingId: string, at: string): Promise<PairingMutation>
  settle(bindingId: string, pairedAt: string): Promise<PairingMutation>
  revoke(bindingId: string, revokedAt: string): Promise<PairingMutation>
}

export type ContractPairingIdentity = Pick<ContractPairingRecord, 'bindingId' | 'runnerId'>

export type PairingHttpRequest = {
  method: 'POST'
  url: string
  headers: Readonly<Record<string, string>>
  body: string
  redirect: 'error'
  timeoutMs: number
}

export type PairingResponseMediaType = 'application/json' | 'other' | 'missing'

export type PairingHttpResponse = {
  status: number
  mediaType: PairingResponseMediaType
  body: string
}

export interface PairingContractTransport {
  exchange(request: PairingHttpRequest): Promise<PairingHttpResponse>
}

export type PairingContractServiceOptions = {
  store: PairingContractStore
  transport: PairingContractTransport
  clock: RunnerClock
}

export interface PairingContractService {
  pair(controlPlaneOrigin: string, request: PairingRedemptionRequest): Promise<ContractPairingIdentity>
  resumeConfirmation(): Promise<ContractPairingIdentity | null>
  snapshot(): Promise<ContractPairingSnapshot>
  current(): Promise<ContractPairingRecord | null>
  revoke(): Promise<void>
}

export class PairingContractNotImplementedError extends Error {
  constructor() {
    super('the adopted pairing contract is interface-only and is not active')
    this.name = 'PairingContractNotImplementedError'
  }
}

const PAIRING_REQUEST_TIMEOUT_MS = 15_000
const JSON_HEADERS = { accept: 'application/json', 'content-type': 'application/json' } as const

export function createPairingContractService(options: PairingContractServiceOptions): PairingContractService {
  return new ProductionPairingContractService(options)
}

export function createUnimplementedPairingContractService(): PairingContractService {
  const unavailable = async (): Promise<never> => {
    throw new PairingContractNotImplementedError()
  }
  return {
    pair: unavailable,
    resumeConfirmation: unavailable,
    snapshot: unavailable,
    current: unavailable,
    revoke: unavailable,
  }
}

class ProductionPairingContractService implements PairingContractService {
  constructor(private readonly options: PairingContractServiceOptions) {}

  async pair(controlPlaneOrigin: string, input: PairingRedemptionRequest): Promise<ContractPairingIdentity> {
    const request = parsePairingRedemptionRequest(input)
    if (!request) throw failure('invalid-code')
    const origin = secureOrigin(controlPlaneOrigin)
    const reservation = await this.reserve()
    let response: PairingHttpResponse
    try {
      response = await this.options.transport.exchange(httpRequest(`${origin}${PAIRING_REDEEM_PATH}`, request))
    } catch {
      await this.release(reservation)
      throw failure('unreachable')
    }
    const status = pairingRedemptionStatus(response.status)
    if (status !== 'pending') {
      await this.release(reservation)
      throw failure(status)
    }
    const nowMs = this.nowMs()
    const envelope = redemptionEnvelope(response)
    if (!envelope) {
      await this.release(reservation)
      throw failure('malformed-response')
    }
    const record: ContractPairingRecord = { ...envelope, controlPlaneOrigin: origin, pendingSince: new Date(nowMs).toISOString() }
    let committed: PairingMutation
    try {
      committed = await this.options.store.commitPending(reservation, record)
    } catch {
      committed = 'storage-unavailable'
    }
    if (committed === 'storage-unavailable') {
      await this.release(reservation)
      throw failure('store-failed')
    }
    if (committed === 'superseded') {
      await this.snapshot()
      throw failure('superseded')
    }
    return await this.confirm(record, false)
  }

  async resumeConfirmation(): Promise<ContractPairingIdentity | null> {
    const snapshot = await this.snapshot()
    if (snapshot.state === 'paired') return identityOf(snapshot.record)
    if (snapshot.state !== 'pending') return null
    const deadline = localConfirmationDeadline(snapshot.record)
    if (!Number.isFinite(deadline)) throw failure('store-failed')
    return await this.confirm(snapshot.record, deadline <= this.nowMs())
  }

  async snapshot(): Promise<ContractPairingSnapshot> {
    try {
      return await this.options.store.snapshot()
    } catch {
      throw failure('store-failed')
    }
  }

  async current(): Promise<ContractPairingRecord | null> {
    const snapshot = await this.snapshot()
    return snapshot.state === 'paired' ? structuredClone(snapshot.record) : null
  }

  async revoke(): Promise<void> {
    const snapshot = await this.snapshot()
    if (snapshot.state !== 'pending' && snapshot.state !== 'paired') return
    await mutationOrThrow(() => this.options.store.revoke(snapshot.record.bindingId, this.now()), 'settle-failed')
  }

  private async reserve(): Promise<string> {
    let reservation: PairingReservation
    try {
      reservation = await this.options.store.reserve()
    } catch {
      throw failure('store-failed')
    }
    if (reservation.status === 'pairing-in-progress') throw failure('pairing-in-progress')
    if (reservation.status === 'already-paired') throw failure('already-paired')
    return reservation.reservationId
  }

  private async release(reservationId: string): Promise<void> {
    try {
      await this.options.store.release(reservationId)
    } catch {
      throw failure('store-failed')
    }
  }

  private async confirm(record: ContractPairingRecord, finalAttempt: boolean): Promise<ContractPairingIdentity> {
    const proof = confirmationProof(record)
    let response: PairingHttpResponse
    try {
      response = await this.options.transport.exchange(httpRequest(`${record.controlPlaneOrigin}${PAIRING_CONFIRM_PATH}`, {
        bindingId: record.bindingId,
        runnerId: record.runnerId,
        confirmationNonce: record.confirmationNonce,
        tokenProof: proof,
      }))
    } catch {
      return await this.unknownConfirmation(record, finalAttempt)
    }
    if (typeof response.body !== 'string' || Buffer.byteLength(response.body) > MAX_PAIRING_RESPONSE_BYTES) {
      return await this.unknownConfirmation(record, finalAttempt, 'malformed-response')
    }
    const status = pairingConfirmationStatus(response.status)
    if (status === 'confirmed') {
      if (response.mediaType !== 'missing' || response.body.length !== 0) {
        return await this.unknownConfirmation(record, finalAttempt, 'malformed-response')
      }
      await mutationOrThrow(() => this.options.store.settle(record.bindingId, this.now()), 'settle-failed')
      return identityOf(record)
    }
    if (status === 'expired-code' || status === 'refused') {
      await mutationOrThrow(() => this.options.store.revoke(record.bindingId, this.now()), 'settle-failed')
      throw failure(status)
    }
    if (finalAttempt && finalRouteAbsent(response.status)) {
      if (record.confirmationUnknownAt) throw failure('confirmation-uncertain')
      await mutationOrThrow(() => this.options.store.revoke(record.bindingId, this.now()), 'settle-failed')
      throw failure('expired-code')
    }
    if (status === 'unreachable' && response.status >= 500) return await this.unknownConfirmation(record, finalAttempt)
    if (status === 'malformed-response') return await this.unknownConfirmation(record, finalAttempt, status)
    if (finalAttempt) throw failure('confirmation-uncertain')
    throw failure(status)
  }

  private async unknownConfirmation(
    record: ContractPairingRecord,
    finalAttempt: boolean,
    nonFinalFailure: PairingContractFailure = 'unreachable',
  ): Promise<never> {
    await mutationOrThrow(() => this.options.store.markConfirmationUnknown(record.bindingId, this.now()), 'settle-failed')
    throw failure(finalAttempt ? 'confirmation-uncertain' : nonFinalFailure)
  }

  private now(): string {
    const date = new Date(this.nowMs())
    if (!Number.isFinite(date.getTime())) throw failure('store-failed')
    return date.toISOString()
  }

  private nowMs(): number {
    const value = this.options.clock.now()
    if (!Number.isFinite(value)) throw failure('store-failed')
    return value
  }
}

function redemptionEnvelope(response: PairingHttpResponse): PendingPairingEnvelope | null {
  if (response.mediaType !== 'application/json' || typeof response.body !== 'string' || Buffer.byteLength(response.body) > MAX_PAIRING_RESPONSE_BYTES) return null
  let body: unknown
  try {
    body = JSON.parse(response.body)
  } catch {
    return null
  }
  return parsePendingPairingEnvelope(body)
}

function localConfirmationDeadline(record: ContractPairingRecord): number {
  const pendingSince = Date.parse(record.pendingSince)
  return Number.isFinite(pendingSince) ? pendingSince + PAIRING_CHALLENGE_TTL_MS : Number.NaN
}

function secureOrigin(input: string): string {
  try {
    assertSecureControlPlaneUrl(input)
  } catch {
    throw failure('refused')
  }
  const origin = canonicalPairingOrigin(input)
  if (!origin) throw failure('refused')
  return origin
}

function confirmationProof(record: ContractPairingRecord): string {
  const message = pairingConfirmationMessage({
    bindingId: record.bindingId,
    runnerId: record.runnerId,
    origin: record.controlPlaneOrigin,
    confirmationNonce: record.confirmationNonce,
  })
  const token = pairingSecretBytes(record.token)
  if (!message || !token) throw failure('malformed-response')
  return createHmac('sha256', token).update(message, 'utf8').digest('hex')
}

function httpRequest(url: string, body: unknown): PairingHttpRequest {
  return {
    method: 'POST',
    url,
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
    redirect: 'error',
    timeoutMs: PAIRING_REQUEST_TIMEOUT_MS,
  }
}

async function mutationOrThrow(
  operation: () => Promise<PairingMutation>,
  storageFailure: Extract<PairingContractFailure, 'settle-failed'>,
): Promise<void> {
  let result: PairingMutation
  try {
    result = await operation()
  } catch {
    throw failure(storageFailure)
  }
  if (result === 'superseded') throw failure('superseded')
  if (result === 'storage-unavailable') throw failure(storageFailure)
}

function finalRouteAbsent(status: number): boolean {
  return status === 404 || status === 405 || status === 501
}

function identityOf(record: ContractPairingRecord): ContractPairingIdentity {
  return { bindingId: record.bindingId, runnerId: record.runnerId }
}

function failure(reason: PairingContractFailure): PairingContractError {
  return new PairingContractError(reason, `pairing failed: ${reason}`)
}

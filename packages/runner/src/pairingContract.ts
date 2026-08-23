import type { PairingRedemptionRequest, PendingPairingEnvelope } from '@modulastack/runner-protocol'
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

export function createPairingContractService(_options: PairingContractServiceOptions): PairingContractService {
  return createUnimplementedPairingContractService()
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

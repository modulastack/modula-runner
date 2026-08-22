import { randomBytes } from 'node:crypto'
import {
  canonicalPairingOrigin,
  parsePendingPairingEnvelope,
} from '@modulastack/runner-protocol'
import { openSealedRecord, type EncryptedStoreOptions, type SealedRecordFile } from './identityStore.js'
import {
  type ContractPairingRecord,
  type ContractPairingSnapshot,
  type PairingContractStore,
  type PairingMutation,
  type PairingReservation,
} from './pairingContract.js'
import { assertSecureControlPlaneUrl } from './secureUrl.js'

const PAIRING_STORE_SCHEMA_VERSION = 1
const processReservations = new WeakMap<SealedRecordFile, ReservationOwnership>()

type RestorablePairingState =
  | { state: 'unpaired' }
  | { state: 'revoked'; record: ContractPairingRecord }

type StoredPairingRecordState = { state: 'pending' | 'paired' | 'revoked'; record: ContractPairingRecord }
type StoredPairingBody =
  | { state: 'unpaired' }
  | { state: 'reserved'; reservationId: string; previous: RestorablePairingState }
  | StoredPairingRecordState
type StoredPairingState = StoredPairingBody & { schemaVersion: 1; revision: number }

export function createEncryptedPairingContractStore(options: EncryptedStoreOptions): PairingContractStore {
  return pairingContractStore(openSealedRecord('pairing binding', options))
}

export function pairingContractStore(file: SealedRecordFile): PairingContractStore {
  const read = async () => decodeStoredState(await file.read())
  const ownership = processReservationFor(file)
  return {
    reserve: () => file.serialize(async () => await reserve(file, await read(), ownership)),
    release: reservationId => file.serialize(async () => await release(file, await read(), reservationId, ownership)),
    commitPending: (reservationId, record) => file.serialize(async () => await mutate(async () => {
      const current = await read()
      if (ownership.reservationId !== reservationId || current.state !== 'reserved' || current.reservationId !== reservationId) {
        ownership.reservationId = null
        return 'superseded'
      }
      await file.write(nextState(current, { state: 'pending', record: validateRecord(record, 'pending') }))
      ownership.reservationId = null
      return 'updated'
    })),
    snapshot: () => file.serialize(async () => snapshotOf(await recoverStaleReservation(file, await read(), ownership))),
    markConfirmationUnknown: (bindingId, at) => file.serialize(async () => await mutate(async () => await mutateRecord(file, await read(), bindingId, record => ({
      state: 'pending',
      record: validateRecord({ ...record, confirmationUnknownAt: validTimestamp(at) }, 'pending'),
    }), 'pending'))),
    settle: (bindingId, pairedAt) => file.serialize(async () => await mutate(async () => await settle(file, await read(), bindingId, pairedAt))),
    revoke: (bindingId, revokedAt) => file.serialize(async () => await mutate(async () => await revoke(file, await read(), bindingId, revokedAt))),
  }
}

type ReservationOwnership = { reservationId: string | null }

function processReservationFor(file: SealedRecordFile): ReservationOwnership {
  const held = processReservations.get(file)
  if (held) return held
  const created: ReservationOwnership = { reservationId: null }
  processReservations.set(file, created)
  return created
}

async function reserve(
  file: SealedRecordFile,
  candidate: StoredPairingState,
  ownership: ReservationOwnership,
): Promise<PairingReservation> {
  const current = await recoverStaleReservation(file, candidate, ownership)
  if (current.state === 'reserved' || current.state === 'pending') return { status: 'pairing-in-progress' }
  if (current.state === 'paired') return { status: 'already-paired' }
  const reservationId = randomBytes(16).toString('hex')
  const previous: RestorablePairingState = current.state === 'revoked'
    ? { state: 'revoked', record: structuredClone(current.record) }
    : { state: 'unpaired' }
  await file.write(nextState(current, { state: 'reserved', reservationId, previous }))
  ownership.reservationId = reservationId
  return { status: 'reserved', reservationId }
}

async function release(
  file: SealedRecordFile,
  current: StoredPairingState,
  reservationId: string,
  ownership: ReservationOwnership,
): Promise<void> {
  if (ownership.reservationId !== reservationId) return
  ownership.reservationId = null
  if (current.state !== 'reserved' || current.reservationId !== reservationId) return
  const restored = current.previous.state === 'revoked'
    ? { state: 'revoked' as const, record: current.previous.record }
    : { state: 'unpaired' as const }
  await file.write(nextState(current, restored))
}

async function recoverStaleReservation(
  file: SealedRecordFile,
  current: StoredPairingState,
  ownership: ReservationOwnership,
): Promise<StoredPairingState> {
  if (current.state !== 'reserved' || current.reservationId === ownership.reservationId) return current
  const restored = current.previous.state === 'revoked'
    ? { state: 'revoked' as const, record: current.previous.record }
    : { state: 'unpaired' as const }
  const recovered = nextState(current, restored)
  await file.write(recovered)
  return recovered
}

async function settle(
  file: SealedRecordFile,
  current: StoredPairingState,
  bindingId: string,
  pairedAt: string,
): Promise<PairingMutation> {
  if (current.state === 'paired' && current.record.bindingId === bindingId) return 'updated'
  return await mutateRecord(file, current, bindingId, record => {
    const next = { ...record, pairedAt: validTimestamp(pairedAt) }
    delete next.revokedAt
    return { state: 'paired', record: validateRecord(next, 'paired') }
  }, 'pending')
}

async function revoke(
  file: SealedRecordFile,
  current: StoredPairingState,
  bindingId: string,
  revokedAt: string,
): Promise<PairingMutation> {
  if (current.state === 'revoked' && current.record.bindingId === bindingId) return 'updated'
  if (current.state !== 'pending' && current.state !== 'paired') return 'superseded'
  if (current.record.bindingId !== bindingId) return 'superseded'
  return await mutate(async () => {
    await file.write(nextState(current, {
      state: 'revoked',
      record: validateRecord({ ...current.record, revokedAt: validTimestamp(revokedAt) }, 'revoked'),
    }))
    return 'updated'
  })
}

async function mutateRecord(
  file: SealedRecordFile,
  current: StoredPairingState,
  bindingId: string,
  update: (record: ContractPairingRecord) => StoredPairingRecordState,
  requiredState: 'pending',
): Promise<PairingMutation> {
  if (current.state !== requiredState || current.record.bindingId !== bindingId) return 'superseded'
  return await mutate(async () => {
    await file.write(nextState(current, update(current.record)))
    return 'updated'
  })
}

async function mutate(operation: () => Promise<PairingMutation>): Promise<PairingMutation> {
  try {
    return await operation()
  } catch {
    return 'storage-unavailable'
  }
}

function nextState(
  current: StoredPairingState,
  next: StoredPairingBody,
): StoredPairingState {
  return { ...structuredClone(next), schemaVersion: PAIRING_STORE_SCHEMA_VERSION, revision: current.revision + 1 } as StoredPairingState
}

function decodeStoredState(value: unknown): StoredPairingState {
  if (value === null) return { schemaVersion: PAIRING_STORE_SCHEMA_VERSION, revision: 0, state: 'unpaired' }
  if (!isRecord(value) || value.schemaVersion !== PAIRING_STORE_SCHEMA_VERSION || !validRevision(value.revision)) invalidStore()
  if (value.state === 'unpaired') return { schemaVersion: 1, revision: value.revision, state: 'unpaired' }
  if (value.state === 'reserved') {
    if (typeof value.reservationId !== 'string' || !/^[0-9a-f]{32}$/.test(value.reservationId)) invalidStore()
    return {
      schemaVersion: 1,
      revision: value.revision,
      state: 'reserved',
      reservationId: value.reservationId,
      previous: decodePrevious(value.previous),
    }
  }
  if (value.state !== 'pending' && value.state !== 'paired' && value.state !== 'revoked') invalidStore()
  return {
    schemaVersion: 1,
    revision: value.revision,
    state: value.state,
    record: validateRecord(value.record, value.state),
  }
}

function decodePrevious(value: unknown): RestorablePairingState {
  if (!isRecord(value)) invalidStore()
  if (value.state === 'unpaired') return { state: 'unpaired' }
  if (value.state === 'revoked') return { state: 'revoked', record: validateRecord(value.record, 'revoked') }
  return invalidStore()
}

function validateRecord(value: unknown, state: 'pending' | 'paired' | 'revoked'): ContractPairingRecord {
  if (!isRecord(value)) invalidStore()
  const envelope = parsePendingPairingEnvelope(value)
  if (!envelope || typeof value.controlPlaneOrigin !== 'string' || canonicalPairingOrigin(value.controlPlaneOrigin) !== value.controlPlaneOrigin) invalidStore()
  try {
    assertSecureControlPlaneUrl(value.controlPlaneOrigin)
  } catch {
    invalidStore()
  }
  const pendingSince = validTimestamp(value.pendingSince)
  const pairedAt = optionalTimestamp(value.pairedAt)
  const revokedAt = optionalTimestamp(value.revokedAt)
  const confirmationUnknownAt = optionalTimestamp(value.confirmationUnknownAt)
  const pendingTime = Date.parse(pendingSince)
  if ([pairedAt, revokedAt, confirmationUnknownAt].some(timestamp => timestamp !== null && Date.parse(timestamp) < pendingTime)) invalidStore()
  if (pairedAt && revokedAt && Date.parse(revokedAt) < Date.parse(pairedAt)) invalidStore()
  if (state === 'pending' && (pairedAt || revokedAt)) invalidStore()
  if (state === 'paired' && (!pairedAt || revokedAt)) invalidStore()
  if (state === 'revoked' && !revokedAt) invalidStore()
  return {
    ...envelope,
    controlPlaneOrigin: value.controlPlaneOrigin,
    pendingSince,
    ...(pairedAt ? { pairedAt } : {}),
    ...(revokedAt ? { revokedAt } : {}),
    ...(confirmationUnknownAt ? { confirmationUnknownAt } : {}),
  }
}

function snapshotOf(state: StoredPairingState): ContractPairingSnapshot {
  if (state.state === 'unpaired' || state.state === 'reserved') return { state: state.state, record: null }
  return { state: state.state, record: structuredClone(state.record) }
}

function validTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) invalidStore()
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19)) invalidStore()
  return value
}

function optionalTimestamp(value: unknown): string | null {
  return value === undefined ? null : validTimestamp(value)
}

function validRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidStore(): never {
  throw new Error('the stored pairing contract state is invalid')
}

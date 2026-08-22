import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createEncryptedApiKeyStore,
  createEncryptedPairingContractStore,
  pairingContractStore,
  type ContractPairingRecord,
} from '../src/index.js'
import type { SealedRecordFile } from '../src/identityStore.js'

const roots: string[] = []
const bindingId = '123e4567-e89b-42d3-a456-426614174000'
const record: ContractPairingRecord = {
  bindingId,
  runnerId: 'runner-01',
  token: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  confirmationNonce: 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8',
  confirmationExpiresAt: '2026-08-21T00:10:00Z',
  controlPlaneOrigin: 'https://example.test',
  pendingSince: '2026-08-21T00:00:00Z',
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function memoryFile(initial: unknown = null) {
  let held = structuredClone(initial)
  let queue: Promise<unknown> = Promise.resolve()
  let failWrites = false
  const reopen = (): SealedRecordFile => ({
    serialize: operation => {
      const result = queue.then(operation, operation)
      queue = result.catch(() => undefined)
      return result
    },
    read: async () => structuredClone(held),
    write: async value => {
      if (failWrites) throw new Error('write failed')
      held = structuredClone(value)
    },
  })
  const file = reopen()
  return { file, reopen, failWrites: (value: boolean) => { failWrites = value }, value: () => structuredClone(held) }
}

describe('pairing contract store', () => {
  it('serializes reservation, pending, paired, and revoked transitions', async () => {
    const memory = memoryFile()
    const store = pairingContractStore(memory.file)
    const [first, second] = await Promise.all([store.reserve(), store.reserve()])
    expect([first.status, second.status].sort()).toEqual(['pairing-in-progress', 'reserved'])
    const reserved = first.status === 'reserved' ? first : second
    if (reserved.status !== 'reserved') throw new Error('reservation missing')
    await expect(store.commitPending(reserved.reservationId, record)).resolves.toBe('updated')
    await expect(store.snapshot()).resolves.toEqual({ state: 'pending', record })
    await expect(store.markConfirmationUnknown(bindingId, '2026-08-21T00:01:00Z')).resolves.toBe('updated')
    await expect(store.settle(bindingId, '2026-08-21T00:02:00Z')).resolves.toBe('updated')
    await expect(store.snapshot()).resolves.toMatchObject({ state: 'paired', record: { pairedAt: '2026-08-21T00:02:00Z' } })
    await expect(store.revoke(bindingId, '2026-08-21T00:03:00Z')).resolves.toBe('updated')
    await expect(store.snapshot()).resolves.toMatchObject({ state: 'revoked', record: { revokedAt: '2026-08-21T00:03:00Z' } })
  })

  it('does not compare server expiry metadata to the runner clock domain', async () => {
    const memory = memoryFile()
    const store = pairingContractStore(memory.file)
    const reservation = await store.reserve()
    if (reservation.status !== 'reserved') throw new Error('reservation missing')
    const skewed = { ...record, confirmationExpiresAt: '2026-08-20T23:50:00Z' }
    await expect(store.commitPending(reservation.reservationId, skewed)).resolves.toBe('updated')
    await expect(store.snapshot()).resolves.toEqual({ state: 'pending', record: skewed })
  })

  it('preserves a live process reservation across two store handles for the same file', async () => {
    const memory = memoryFile()
    const first = pairingContractStore(memory.file)
    const reservation = await first.reserve()
    if (reservation.status !== 'reserved') throw new Error('reservation missing')
    const second = pairingContractStore(memory.file)
    await expect(second.snapshot()).resolves.toEqual({ state: 'reserved', record: null })
    await expect(first.commitPending(reservation.reservationId, record)).resolves.toBe('updated')
  })

  it('recovers a crash-stale reservation before admitting a new process', async () => {
    const memory = memoryFile()
    const first = pairingContractStore(memory.file)
    await expect(first.reserve()).resolves.toMatchObject({ status: 'reserved' })
    const restarted = pairingContractStore(memory.reopen())
    await expect(restarted.snapshot()).resolves.toEqual({ state: 'unpaired', record: null })
    await expect(restarted.reserve()).resolves.toMatchObject({ status: 'reserved' })
  })

  it('restores revoked state when a replacement reservation is released', async () => {
    const memory = memoryFile({ schemaVersion: 1, revision: 3, state: 'revoked', record: { ...record, revokedAt: '2026-08-21T00:03:00Z' } })
    const store = pairingContractStore(memory.file)
    const reservation = await store.reserve()
    if (reservation.status !== 'reserved') throw new Error('reservation missing')
    await store.release(reservation.reservationId)
    await expect(store.snapshot()).resolves.toMatchObject({ state: 'revoked', record: { bindingId } })
  })

  it('returns storage-unavailable without losing a durable reservation on failed commit', async () => {
    const memory = memoryFile()
    const store = pairingContractStore(memory.file)
    const reservation = await store.reserve()
    if (reservation.status !== 'reserved') throw new Error('reservation missing')
    memory.failWrites(true)
    await expect(store.commitPending(reservation.reservationId, record)).resolves.toBe('storage-unavailable')
    memory.failWrites(false)
    await store.release(reservation.reservationId)
    await expect(store.snapshot()).resolves.toEqual({ state: 'unpaired', record: null })
  })

  it('rejects malformed persisted lifecycle and stale binding mutations', async () => {
    const malformed = pairingContractStore(memoryFile({ schemaVersion: 1, revision: 1, state: 'pending', record: null }).file)
    await expect(malformed.snapshot()).rejects.toThrow('stored pairing contract state is invalid')

    const memory = memoryFile({ schemaVersion: 1, revision: 1, state: 'pending', record })
    const store = pairingContractStore(memory.file)
    await expect(store.settle('323e4567-e89b-42d3-a456-426614174002', '2026-08-21T00:02:00Z')).resolves.toBe('superseded')
    await expect(store.revoke('323e4567-e89b-42d3-a456-426614174002', '2026-08-21T00:02:00Z')).resolves.toBe('superseded')
    await expect(store.snapshot()).resolves.toEqual({ state: 'pending', record })
  })

  it('encrypts pairing and API-key records under one private key file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'runner-pairing-contract-store-'))
    roots.push(root)
    const keyPath = path.join(root, 'sealing.key')
    const pairingPath = path.join(root, 'pairing.bin')
    const keysPath = path.join(root, 'keys.bin')
    const store = createEncryptedPairingContractStore({ path: pairingPath, keyPath })
    const reservation = await store.reserve()
    if (reservation.status !== 'reserved') throw new Error('reservation missing')
    await expect(store.commitPending(reservation.reservationId, record)).resolves.toBe('updated')
    const keys = createEncryptedApiKeyStore({ path: keysPath, keyPath })
    await keys.put({ label: 'daily', provider: 'anthropic', secret: 'sk-ant-example-secret' })

    expect((await readFile(pairingPath, 'utf8')).includes(record.token)).toBe(false)
    expect((await readFile(keysPath, 'utf8')).includes('sk-ant-example-secret')).toBe(false)
    await expect(createEncryptedPairingContractStore({ path: pairingPath, keyPath }).snapshot()).resolves.toEqual({ state: 'pending', record })
    await chmod(keyPath, 0o644)
    await expect(createEncryptedPairingContractStore({ path: pairingPath, keyPath }).snapshot()).rejects.toThrow('readable by other users')
  })
})

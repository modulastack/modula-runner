import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createFileRunnerHomeStorage,
  createMemoryApiKeyStore,
  createRunnerHome,
  signAllowlist,
  type PairingContractStore,
  type RunnerHomeFailure,
  type RunnerHomeInspection,
  type RunnerHomeStorage,
} from '../src/index.js'

const roots: string[] = []
const clock = { now: () => Date.parse('2026-08-22T00:00:00Z'), sleep: async () => undefined }

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function pairingStore(): PairingContractStore {
  return {
    reserve: async () => ({ status: 'reserved', reservationId: 'reservation-1' }),
    release: async () => undefined,
    commitPending: async () => 'updated',
    snapshot: async () => ({ state: 'unpaired', record: null }),
    markConfirmationUnknown: async () => 'updated',
    settle: async () => 'updated',
    revoke: async () => 'updated',
  }
}

function policy() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const keyId = 'operator'
  return {
    revision: 1,
    allowlist: signAllowlist(
      { executables: ['git'], recipes: {} },
      { keyId, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
    ),
    trustAnchors: [{ keyId, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() }],
  }
}

async function fileHome() {
  const parent = await mkdtemp(path.join(tmpdir(), 'runner-home-open-'))
  roots.push(parent)
  const root = path.join(parent, 'home')
  const storage = createFileRunnerHomeStorage({ defaultRoot: root })
  await storage.inspect({})
  await storage.replace('policy', null, Buffer.from(JSON.stringify(policy())))
  return { root, storage }
}

describe('production runner home', () => {
  it('opens complete trusted state while excluding a second foreground runner', async () => {
    const { root, storage } = await fileHome()
    const first = createRunnerHome({ storage, clock, pairing: pairingStore(), keys: createMemoryApiKeyStore() })
    await expect(first.open({})).resolves.toMatchObject({ status: 'ready' })

    const competingStorage = createFileRunnerHomeStorage({ defaultRoot: root })
    const competing = createRunnerHome({ storage: competingStorage, clock, pairing: pairingStore(), keys: createMemoryApiKeyStore() })
    await expect(competing.open({})).resolves.toEqual({ status: 'failed', code: 'state-io-failed' })

    await storage.release!()
    await expect(competing.open({})).resolves.toMatchObject({ status: 'ready' })
    await competingStorage.release!()
  })

  it('releases the foreground lease when record preflight fails', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'runner-home-open-failure-'))
    roots.push(parent)
    const root = path.join(parent, 'home')
    const storage = createFileRunnerHomeStorage({ defaultRoot: root })
    const home = createRunnerHome({ storage, clock, pairing: pairingStore(), keys: createMemoryApiKeyStore() })
    await expect(home.open({})).resolves.toEqual({ status: 'failed', code: 'policy-missing' })

    const next = createFileRunnerHomeStorage({ defaultRoot: root })
    await next.inspect({})
    await expect(next.acquire!()).resolves.toBe('acquired')
    await next.release!()
  })

  it('maps unsafe root and record metadata before acquiring the home', async () => {
    const cases: Array<readonly [RunnerHomeInspection, RunnerHomeFailure]> = [
      [inspection({ rootKind: 'symlink' }), 'state-linked'],
      [inspection({ rootOwner: 'other' }), 'state-wrong-owner'],
      [inspection({ rootMode: 0o755 }), 'state-insecure-mode'],
      [inspection({ entries: [{ record: 'configuration', kind: 'directory', owner: 'current-user', mode: 0o600, links: 1 }] }), 'state-not-regular'],
      [inspection({ entries: [{ record: 'configuration', kind: 'regular', owner: 'current-user', mode: 0o600, links: 2 }] }), 'state-linked'],
    ]
    for (const [value, code] of cases) {
      const acquire = vi.fn(async () => 'acquired' as const)
      const storage: RunnerHomeStorage = {
        inspect: async () => value,
        acquire,
        release: async () => undefined,
        read: async () => ({ status: 'missing' }),
        replace: async () => ({ status: 'storage-unavailable' }),
        append: async () => 'storage-unavailable',
      }
      const home = createRunnerHome({ storage, clock, pairing: pairingStore(), keys: createMemoryApiKeyStore() })
      await expect(home.open({})).resolves.toEqual({ status: 'failed', code })
      expect(acquire).not.toHaveBeenCalled()
    }
  })
})

function inspection(overrides: Partial<RunnerHomeInspection>): RunnerHomeInspection {
  return {
    rootKind: 'directory',
    rootOwner: 'current-user',
    rootMode: 0o700,
    entries: [],
    ...overrides,
  }
}

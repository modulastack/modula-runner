import { generateKeyPairSync } from 'node:crypto'
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  allowlistKeyId,
  createFileRunnerHome,
  createFileRunnerHomeStorage as createStorage,
  createMemoryApiKeyStore,
  createRunnerHome,
  signAllowlist,
  type FileRunnerHomeStorageOptions,
  type PairingContractStore,
  type RunnerHomeFailure,
  type RunnerHomeInspection,
  type RunnerHomeStorage,
} from '../src/index.js'

const roots: string[] = []
const storages: RunnerHomeStorage[] = []
const clock = { now: () => Date.parse('2026-08-22T00:00:00Z'), sleep: async () => undefined }

afterEach(async () => {
  await Promise.all(storages.splice(0).map(storage => storage.close?.()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function createFileRunnerHomeStorage(options: FileRunnerHomeStorageOptions): RunnerHomeStorage {
  const storage = createStorage(options)
  storages.push(storage)
  return storage
}

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
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const keyId = allowlistKeyId(publicPem)
  return {
    revision: 1,
    allowlist: signAllowlist(
      { executables: ['git'], recipes: {} },
      { keyId, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
    ),
    trustAnchors: [{ keyId, publicKey: publicPem }],
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

  it('composes encrypted pairing/key custody behind one file-home factory and releases on close', async () => {
    const { root } = await fileHome()
    const home = createFileRunnerHome({ defaultRoot: root, clock })
    await expect(home.open({})).resolves.toMatchObject({ status: 'ready' })
    await home.close?.()
    await expect(lstat(path.join(root, 'runner.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails before state reads when the shared sealing key is permissive', async () => {
    const { root } = await fileHome()
    await writeFile(path.join(root, 'sealing.key'), Buffer.alloc(32), { mode: 0o644 })
    const home = createFileRunnerHome({ defaultRoot: root, clock })
    await expect(home.open({})).resolves.toEqual({ status: 'failed', code: 'state-insecure-mode' })
  })

  it('accepts the secure segmented audit directory during home preflight', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'runner-home-audit-directory-'))
    roots.push(root)
    await mkdir(path.join(root, 'audit.jsonl'), { mode: 0o700 })
    const storage = createFileRunnerHomeStorage({ defaultRoot: root })
    const home = createRunnerHome({ storage, clock, pairing: pairingStore(), keys: createMemoryApiKeyStore() })
    await expect(home.open({})).resolves.toEqual({ status: 'failed', code: 'policy-missing' })
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

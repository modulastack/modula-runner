import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createMemoryApiKeyStore,
  openRunnerHomeRecords,
  signAllowlist,
  SessionReceiptStorageUnavailableError,
  type PairingContractStore,
  type RunnerHomeRecord,
  type RunnerHomeStorage,
  type SignedAllowlist,
  type TrustAnchor,
} from '../src/index.js'

const clock = { now: () => Date.parse('2026-08-22T00:00:00Z'), sleep: async () => undefined }

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

function memoryStorage(initial: Partial<Record<RunnerHomeRecord, unknown>> = {}) {
  const records = new Map<RunnerHomeRecord, Uint8Array>()
  const audit: string[] = []
  for (const [record, value] of Object.entries(initial)) records.set(record as RunnerHomeRecord, Buffer.from(JSON.stringify(value)))
  const storage: RunnerHomeStorage = {
    inspect: async () => ({ rootKind: 'directory', rootOwner: 'current-user', rootMode: 0o700, entries: [] }),
    read: async record => {
      const bytes = records.get(record)
      return bytes ? { status: 'found', bytes: structuredClone(bytes), sha256: digest(bytes) } : { status: 'missing' }
    },
    replace: async (record, expectedSha256, bytes) => {
      const current = records.get(record)
      const currentSha256 = current ? digest(current) : null
      if (currentSha256 !== expectedSha256) return { status: 'conflict', currentSha256 }
      records.set(record, structuredClone(bytes))
      return { status: 'written', sha256: digest(bytes) }
    },
    append: async (_record, bytes) => {
      audit.push(Buffer.from(bytes).toString('utf8'))
      return 'appended'
    },
  }
  return { storage, audit, records }
}

function signedPolicy(): { revision: number; allowlist: SignedAllowlist; trustAnchors: TrustAnchor[] } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const keyId = 'operator'
  return {
    revision: 1,
    allowlist: signAllowlist(
      { executables: ['git', 'tmux'], recipes: {} },
      { keyId, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
    ),
    trustAnchors: [{ keyId, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() }],
  }
}

describe('runner-home logical records', () => {
  it('opens trusted state and exposes durable configuration, project, receipt, and audit adapters', async () => {
    const held = memoryStorage({ policy: signedPolicy() })
    const opened = await openRunnerHomeRecords({ storage: held.storage, clock, pairing: pairingStore(), keys: createMemoryApiKeyStore() })
    expect(opened.status).toBe('ready')
    if (opened.status !== 'ready') throw new Error(opened.code)

    const configuration = await opened.home.configuration.snapshot()
    expect(configuration).toMatchObject({ revision: 1, profiles: [] })
    await expect(opened.home.configuration.replace(1, { profiles: [], endpoints: [] })).resolves.toMatchObject({
      status: 'updated',
      configuration: { revision: 2 },
    })

    const project = await opened.home.projects.create({ projectId: 'modulastack', repoPath: '/repos/modulastack', worktreesRoot: '/worktrees' })
    expect(project.revision).toBe(1)
    await expect(opened.home.projects.list()).resolves.toEqual([project])
    await expect(opened.home.projects.remove(project.projectId, project.revision)).resolves.toBe('removed')
    const recreated = await opened.home.projects.create({ projectId: 'modulastack', repoPath: '/repos/modulastack', worktreesRoot: '/worktrees' })
    expect(recreated.revision).toBeGreaterThan(project.revision)
    await expect(opened.home.projects.remove(recreated.projectId, project.revision)).resolves.toBe('conflict')
    await expect(opened.home.projects.remove(recreated.projectId, recreated.revision)).resolves.toBe('removed')
    await expect(opened.home.receipts.recover()).resolves.toEqual([])
    held.records.set('receipts', Buffer.from('{'))
    await expect(opened.home.receipts.recover()).rejects.toBeInstanceOf(SessionReceiptStorageUnavailableError)

    await opened.home.audit.append({ kind: 'kill', confirmed: true, details: 'operator stop', at: '2026-08-22T00:00:00Z' })
    expect(held.audit).toEqual(['{"kind":"kill","confirmed":true,"details":"operator stop","at":"2026-08-22T00:00:00Z"}\n'])
  })

  it('retries unrelated project compare-and-set conflicts across registry instances', async () => {
    const held = memoryStorage({ policy: signedPolicy() })
    const [first, second] = await Promise.all([
      openRunnerHomeRecords({ storage: held.storage, clock, pairing: pairingStore(), keys: createMemoryApiKeyStore() }),
      openRunnerHomeRecords({ storage: held.storage, clock, pairing: pairingStore(), keys: createMemoryApiKeyStore() }),
    ])
    if (first.status !== 'ready' || second.status !== 'ready') throw new Error('homes did not open')
    const created = await Promise.all([
      first.home.projects.create({ projectId: 'first', repoPath: '/repos/first', worktreesRoot: '/worktrees/first' }),
      second.home.projects.create({ projectId: 'second', repoPath: '/repos/second', worktreesRoot: '/worktrees/second' }),
    ])
    expect(created.map(project => project.revision).sort((left, right) => left - right)).toEqual([1, 2])
    await expect(first.home.projects.list()).resolves.toHaveLength(2)
  })

  it('rejects duplicate local configuration before returning a usable home', async () => {
    const profile = { modelProfileId: 'daily', access: 'subscription', runtime: 'claude' }
    const held = memoryStorage({
      policy: signedPolicy(),
      configuration: { revision: 1, profiles: [profile, profile], endpoints: [] },
    })
    await expect(openRunnerHomeRecords({
      storage: held.storage,
      clock,
      pairing: pairingStore(),
      keys: createMemoryApiKeyStore(),
    })).resolves.toEqual({ status: 'failed', code: 'config-duplicate' })

    const incomplete = memoryStorage({ policy: signedPolicy(), configuration: { revision: 1, profiles: [{}], endpoints: [] } })
    await expect(openRunnerHomeRecords({
      storage: incomplete.storage,
      clock,
      pairing: pairingStore(),
      keys: createMemoryApiKeyStore(),
    })).resolves.toEqual({ status: 'failed', code: 'config-invalid' })
  })

  it('rejects access-mode profiles that omit required local bindings', async () => {
    const profiles = [
      { modelProfileId: 'api', access: 'api-key', runtime: 'claude' },
      { modelProfileId: 'local', access: 'local', runtime: 'claude' },
    ]
    for (const profile of profiles) {
      const held = memoryStorage({ policy: signedPolicy(), configuration: { revision: 1, profiles: [profile], endpoints: [] } })
      await expect(openRunnerHomeRecords({
        storage: held.storage,
        clock,
        pairing: pairingStore(),
        keys: createMemoryApiKeyStore(),
      })).resolves.toEqual({ status: 'failed', code: 'config-invalid' })
    }
  })

  it('rejects a live grant alias retarget before persisting an unreadable image', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'runner-home-grants-'))
    try {
      const first = path.join(parent, 'first')
      const second = path.join(parent, 'second')
      const alias = path.join(parent, 'alias')
      await Promise.all([mkdir(first), mkdir(second)])
      await symlink(first, alias)
      const held = memoryStorage({
        policy: signedPolicy(),
        grants: {
          revision: 1,
          records: [{ path: await realpath(first), alias: path.resolve(alias), grantedAt: '2026-08-22T00:00:00Z' }],
        },
      })
      const opened = await openRunnerHomeRecords({ storage: held.storage, clock, pairing: pairingStore(), keys: createMemoryApiKeyStore() })
      if (opened.status !== 'ready') throw new Error(opened.code)
      await unlink(alias)
      await symlink(second, alias)
      await expect(opened.home.grants.grant(alias)).rejects.toThrow('state-io-failed')
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('returns the winning receipt image after an underlying storage conflict', async () => {
    const held = memoryStorage({ policy: signedPolicy() })
    const replace = held.storage.replace
    let injectConflict = true
    held.storage.replace = async (record, expectedSha256, bytes) => {
      if (record === 'receipts' && injectConflict) {
        injectConflict = false
        const winner = { schemaVersion: 1, revision: 1, capacityBlockedUntil: null, receipts: [], tombstones: [] }
        const encoded = Buffer.from(JSON.stringify(winner))
        held.records.set('receipts', encoded)
        return { status: 'conflict', currentSha256: digest(encoded) }
      }
      return await replace(record, expectedSha256, bytes)
    }
    const opened = await openRunnerHomeRecords({ storage: held.storage, clock, pairing: pairingStore(), keys: createMemoryApiKeyStore() })
    if (opened.status !== 'ready') throw new Error(opened.code)
    const request = {
      type: 'SESSION_START' as const,
      bindingId: '123e4567-e89b-42d3-a456-426614174000',
      requestId: '223e4567-e89b-42d3-a456-426614174001',
      expiresAt: '2026-08-22T00:10:00Z',
      terminalProfile: 'coder',
      modelProfileId: 'daily',
      target: { projectId: 'modulastack', worktreeName: 'lane-01', branch: 'feat/lane-01', baseBranch: 'main', relativeCwd: '.' },
    }
    await expect(opened.home.receipts.claim(request, 'f'.repeat(64), '2026-08-22T00:00:00Z')).resolves.toMatchObject({ status: 'claimed' })
  })

  it('maps missing, foreign, tampered, and malformed policy to the stable startup vocabulary', async () => {
    const trusted = signedPolicy()
    const cases: Array<readonly [string, Partial<Record<RunnerHomeRecord, unknown>>, string]> = [
      ['missing', {}, 'policy-missing'],
      ['foreign', { policy: { ...trusted, allowlist: { ...trusted.allowlist, keyId: 'foreign' } } }, 'policy-unknown-key'],
      ['tampered', { policy: { ...trusted, allowlist: { ...trusted.allowlist, signature: 'AAAA' } } }, 'policy-bad-signature'],
      ['malformed', { policy: { revision: 1, allowlist: null, trustAnchors: [] } }, 'policy-malformed'],
    ]
    for (const [name, initial, code] of cases) {
      const held = memoryStorage(initial)
      await expect(openRunnerHomeRecords({
        storage: held.storage,
        clock,
        pairing: pairingStore(),
        keys: createMemoryApiKeyStore(),
      }), name).resolves.toEqual({ status: 'failed', code })
    }
    const invalidJson = memoryStorage()
    invalidJson.records.set('policy', Buffer.from('{'))
    await expect(openRunnerHomeRecords({
      storage: invalidJson.storage,
      clock,
      pairing: pairingStore(),
      keys: createMemoryApiKeyStore(),
    })).resolves.toEqual({ status: 'failed', code: 'policy-malformed' })
  })

  it('fails closed when a state record is malformed or its audit append is unavailable', async () => {
    const invalidStates = [
      memoryStorage({ policy: signedPolicy(), projects: { revision: 1, projects: [null] } }),
      memoryStorage({ policy: signedPolicy(), grants: { revision: 1, records: [{ path: null, grantedAt: '2026-08-22T00:00:00Z' }] } }),
      memoryStorage({
        policy: signedPolicy(),
        grants: {
          revision: 1,
          records: [
            { path: '/safe', grantedAt: '2026-08-22T00:00:00Z' },
            { path: '/safe', grantedAt: '2026-08-22T00:01:00Z' },
          ],
        },
      }),
    ]
    for (const invalid of invalidStates) {
      await expect(openRunnerHomeRecords({
        storage: invalid.storage,
        clock,
        pairing: pairingStore(),
        keys: createMemoryApiKeyStore(),
      })).resolves.toEqual({ status: 'failed', code: 'state-io-failed' })
    }

    const held = memoryStorage({ policy: signedPolicy() })
    held.storage.append = async () => 'storage-unavailable'
    const opened = await openRunnerHomeRecords({ storage: held.storage, clock, pairing: pairingStore(), keys: createMemoryApiKeyStore() })
    if (opened.status !== 'ready') throw new Error(opened.code)
    await expect(opened.home.audit.append({ kind: 'kill', confirmed: false, details: 'uncertain', at: '2026-08-22T00:00:00Z' })).rejects.toThrow('audit-unavailable')
  })
})

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

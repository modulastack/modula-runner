import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  allowlistKeyId,
  createMemoryApiKeyStore,
  openRunnerHomeRecords,
  signAllowlist,
  SessionReceiptStorageUnavailableError,
  type AuditRecordInputV2,
  type PairingContractStore,
  type RunnerAuditLifecycle,
  type RunnerHomeStateRecord,
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

function memoryStorage(initial: Partial<Record<RunnerHomeStateRecord, unknown>> = {}) {
  const records = new Map<RunnerHomeStateRecord, Uint8Array>()
  const audit: AuditRecordInputV2[] = []
  let auditUnavailable = false
  for (const [record, value] of Object.entries(initial)) {
    const serialized = record === 'trust' ? `${canonicalJson(value)}\n` : JSON.stringify(value)
    records.set(record as RunnerHomeStateRecord, Buffer.from(serialized))
  }
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
  }
  const lifecycle: RunnerAuditLifecycle = {
    append: async record => {
      if (auditUnavailable) throw new Error('audit unavailable')
      audit.push(record)
    },
    snapshot: async () => ({ state: 'ready', residentSegments: 1, residentBytes: 0, metadataBytes: 0, openSequence: '1' }),
    close: async () => undefined,
  }
  return { storage, lifecycle, audit, records, failAudit: () => { auditUnavailable = true } }
}

function openRecords(held: ReturnType<typeof memoryStorage>) {
  return openRunnerHomeRecords({
    storage: held.storage,
    audit: held.lifecycle,
    clock,
    pairing: pairingStore(),
    keys: createMemoryApiKeyStore(),
  })
}

function signedPolicy(): { revision: number; allowlist: SignedAllowlist; trustAnchors: TrustAnchor[] } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const keyId = allowlistKeyId(publicPem)
  return {
    revision: 1,
    allowlist: signAllowlist(
      { executables: ['git', 'tmux'], recipes: {} },
      { keyId, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
    ),
    trustAnchors: [{ keyId, publicKey: publicPem }],
  }
}

function storedTrust(policy = signedPolicy()): unknown {
  return { schemaVersion: 1, revision: policy.revision, anchors: policy.trustAnchors, allowlist: policy.allowlist }
}

describe('runner-home logical records', () => {
  it('opens trusted state and exposes durable configuration, project, receipt, and audit adapters', async () => {
    const held = memoryStorage({ trust: storedTrust() })
    const opened = await openRecords(held)
    expect(opened.status).toBe('ready')
    if (opened.status !== 'ready') throw new Error(opened.code)

    const configuration = await opened.home.configuration.snapshot()
    expect(configuration).toMatchObject({ revision: 1, profiles: [] })
    await expect(opened.home.configuration.replace(1, { profiles: [], endpoints: [] })).resolves.toMatchObject({
      status: 'updated',
      configuration: { revision: 2 },
    })

    await expect(opened.home.projects.create({
      projectId: 'invalid', repoPath: '/repos/invalid', worktreesRoot: '/worktrees', extra: true,
    } as never)).rejects.toThrow('state-io-failed')
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
    expect(held.audit).toHaveLength(1)
    expect(held.audit[0]).toMatchObject({ kind: 'kill', confirmed: true, targetCount: 0 })
    expect(JSON.stringify(held.audit)).not.toContain('operator stop')
  })

  it('decodes configuration arrays without caller-controlled map dispatch', async () => {
    const held = memoryStorage({ trust: storedTrust() })
    const opened = await openRecords(held)
    if (opened.status !== 'ready') throw new Error('home did not open')
    const profile = { modelProfileId: 'daily', access: 'subscription' as const, runtime: 'claude' }
    const profiles = [profile]
    Object.defineProperty(profiles, 'map', {
      value: () => [{ ...profile, extra: true }],
    })

    await expect(opened.home.configuration.replace(1, { profiles, endpoints: [] })).resolves.toEqual({
      status: 'updated', configuration: { revision: 2, profiles: [profile], endpoints: [] },
    })
    await expect(opened.home.configuration.snapshot()).resolves.toEqual({ revision: 2, profiles: [profile], endpoints: [] })

    const endpoint = { endpointId: 'local', kind: 'ollama' as const, baseUrl: 'http://localhost:11434' }
    const endpoints = [endpoint]
    Object.defineProperty(endpoints, 'map', {
      value: () => [{ ...endpoint, extra: true }],
    })
    await expect(opened.home.configuration.replace(2, { profiles: [], endpoints })).resolves.toEqual({
      status: 'updated', configuration: { revision: 3, profiles: [], endpoints: [endpoint] },
    })
    await expect(opened.home.configuration.snapshot()).resolves.toEqual({ revision: 3, profiles: [], endpoints: [endpoint] })
    await expect(opened.home.configuration.replace(3, { profiles: [], endpoints: Array(257).fill(endpoint) }))
      .rejects.toThrow('config-invalid')
  })

  it('snapshots configuration arrays and their loop bounds exactly once', async () => {
    const held = memoryStorage({ trust: storedTrust() })
    const opened = await openRecords(held)
    if (opened.status !== 'ready') throw new Error('home did not open')
    let profileLengthReads = 0
    let endpointLengthReads = 0
    const profiles = new Proxy([{ modelProfileId: 'daily', access: 'subscription' as const, runtime: 'claude' }], {
      get: (target, property, receiver) => property === 'length'
        ? (++profileLengthReads === 1 ? 1 : 1_000_000)
        : Reflect.get(target, property, receiver),
    })
    const endpoints = new Proxy([{ endpointId: 'local', kind: 'ollama' as const, baseUrl: 'http://localhost:11434' }], {
      get: (target, property, receiver) => property === 'length'
        ? (++endpointLengthReads === 1 ? 1 : 1_000_000)
        : Reflect.get(target, property, receiver),
    })

    await expect(opened.home.configuration.replace(1, { profiles, endpoints }))
      .resolves.toMatchObject({ status: 'updated', configuration: { revision: 2 } })
    expect({ profileLengthReads, endpointLengthReads }).toEqual({ profileLengthReads: 1, endpointLengthReads: 1 })
    await expect(opened.home.configuration.snapshot()).resolves.toMatchObject({
      profiles: [{ modelProfileId: 'daily' }], endpoints: [{ endpointId: 'local' }],
    })
  })

  it('snapshots accessor-backed configuration fields exactly once before validation', async () => {
    const held = memoryStorage({ trust: storedTrust() })
    const opened = await openRecords(held)
    if (opened.status !== 'ready') throw new Error('home did not open')
    const profileAccesses = { access: 0, modelProfileId: 0, runtime: 0, endpointId: 0, keyLabel: 0, model: 0, provider: 0 }
    const profile = Object.defineProperties({}, {
      access: { enumerable: true, get: () => profileAccesses.access++ === 0 ? 'subscription' : 'unsafe' },
      modelProfileId: { enumerable: true, get: () => profileAccesses.modelProfileId++ === 0 ? 'daily' : 'unsafe\u0000id' },
      runtime: { enumerable: true, get: () => profileAccesses.runtime++ === 0 ? 'claude' : 'unsafe\u0000runtime' },
      endpointId: { enumerable: true, get: () => { profileAccesses.endpointId += 1; return undefined } },
      keyLabel: { enumerable: true, get: () => { profileAccesses.keyLabel += 1; return undefined } },
      model: { enumerable: true, get: () => { profileAccesses.model += 1; return undefined } },
      provider: { enumerable: true, get: () => { profileAccesses.provider += 1; return undefined } },
    })
    const endpointAccesses = { endpointId: 0, kind: 0, baseUrl: 0 }
    const endpoint = Object.defineProperties({}, {
      endpointId: { enumerable: true, get: () => endpointAccesses.endpointId++ === 0 ? 'local' : 'unsafe\u0000endpoint' },
      kind: { enumerable: true, get: () => endpointAccesses.kind++ === 0 ? 'ollama' : 'unsafe' },
      baseUrl: { enumerable: true, get: () => endpointAccesses.baseUrl++ === 0 ? 'http://localhost:11434' : 'unsafe\u0000url' },
    })

    await expect(opened.home.configuration.replace(1, { profiles: [profile], endpoints: [endpoint] } as never))
      .resolves.toMatchObject({ status: 'updated', configuration: { profiles: [{ modelProfileId: 'daily' }], endpoints: [{ endpointId: 'local' }] } })
    expect(profileAccesses).toEqual({ access: 1, modelProfileId: 1, runtime: 1, endpointId: 1, keyLabel: 1, model: 1, provider: 1 })
    expect(endpointAccesses).toEqual({ endpointId: 1, kind: 1, baseUrl: 1 })
    await expect(opened.home.configuration.snapshot()).resolves.toMatchObject({
      profiles: [{ access: 'subscription', modelProfileId: 'daily', runtime: 'claude' }],
      endpoints: [{ endpointId: 'local', kind: 'ollama', baseUrl: 'http://localhost:11434' }],
    })
  })

  it('retries unrelated project compare-and-set conflicts across registry instances', async () => {
    const held = memoryStorage({ trust: storedTrust() })
    const [first, second] = await Promise.all([openRecords(held), openRecords(held)])
    if (first.status !== 'ready' || second.status !== 'ready') throw new Error('homes did not open')
    const created = await Promise.all([
      first.home.projects.create({ projectId: 'first', repoPath: '/repos/first', worktreesRoot: '/worktrees/first' }),
      second.home.projects.create({ projectId: 'second', repoPath: '/repos/second', worktreesRoot: '/worktrees/second' }),
    ])
    expect(created.map(project => project.revision).sort((left, right) => left - right)).toEqual([1, 2])
    await expect(first.home.projects.list()).resolves.toHaveLength(2)
  })

  it('uses the snapshotted project id after an asynchronous registry read', async () => {
    const existing = { projectId: 'existing', repoPath: '/repos/existing', worktreesRoot: '/worktrees/existing', revision: 1 }
    const held = memoryStorage({
      trust: storedTrust(),
      projects: { revision: 1, projects: [existing] },
    })
    const opened = await openRecords(held)
    if (opened.status !== 'ready') throw new Error('home did not open')
    const project = { projectId: 'existing', repoPath: '/repos/new', worktreesRoot: '/worktrees/new' }
    const read = held.storage.read.bind(held.storage)
    held.storage.read = async record => {
      const result = await read(record)
      if (record === 'projects') project.projectId = 'changed-by-caller'
      return result
    }

    await expect(opened.home.projects.create(project)).rejects.toThrow('project id already exists')
    await expect(opened.home.projects.list()).resolves.toEqual([existing])
  })

  it('snapshots accessor-backed project fields exactly once before validation', async () => {
    const held = memoryStorage({ trust: storedTrust() })
    const opened = await openRecords(held)
    if (opened.status !== 'ready') throw new Error('home did not open')
    const accesses = { projectId: 0, repoPath: 0, worktreesRoot: 0 }
    const project = Object.defineProperties({}, {
      projectId: { enumerable: true, get: () => accesses.projectId++ === 0 ? 'safe-project' : 'unsafe\u0000project' },
      repoPath: { enumerable: true, get: () => accesses.repoPath++ === 0 ? '/repos/safe' : 'relative/repo' },
      worktreesRoot: { enumerable: true, get: () => accesses.worktreesRoot++ === 0 ? '/worktrees/safe' : 'relative/worktrees' },
    }) as { projectId: string; repoPath: string; worktreesRoot: string }

    await expect(opened.home.projects.create(project)).resolves.toMatchObject({
      projectId: 'safe-project', repoPath: '/repos/safe', worktreesRoot: '/worktrees/safe',
    })
    expect(accesses).toEqual({ projectId: 1, repoPath: 1, worktreesRoot: 1 })
    await expect(opened.home.projects.list()).resolves.toMatchObject([{
      projectId: 'safe-project', repoPath: '/repos/safe', worktreesRoot: '/worktrees/safe',
    }])
  })

  it('rejects duplicate local configuration before returning a usable home', async () => {
    const profile = { modelProfileId: 'daily', access: 'subscription', runtime: 'claude' }
    const held = memoryStorage({
      trust: storedTrust(),
      configuration: { revision: 1, profiles: [profile, profile], endpoints: [] },
    })
    await expect(openRecords(held)).resolves.toEqual({ status: 'failed', code: 'config-duplicate' })

    const invalidConfigurations = [
      { revision: 1, profiles: [{}], endpoints: [] },
      { revision: 1, profiles: [{ modelProfileId: 'keyed', runtime: 'claude', access: 'api-key' }], endpoints: [] },
      { revision: 1, profiles: [], endpoints: [{ endpointId: 'lab', kind: 'openai-compatible', baseUrl: 'https://user:secret@example.test' }] },
    ]
    for (const configuration of invalidConfigurations) {
      const incomplete = memoryStorage({ trust: storedTrust(), configuration })
      await expect(openRecords(incomplete)).resolves.toEqual({ status: 'failed', code: 'config-invalid' })
    }
  })

  it('rejects unknown and malformed nested configuration fields', async () => {
    const invalidConfigurations = [
      { revision: 1, profiles: [], endpoints: [], extra: true },
      { revision: 1, profiles: [{ modelProfileId: 'daily', access: 'subscription', runtime: 'claude', extra: true }], endpoints: [] },
      { revision: 1, profiles: [], endpoints: [{ endpointId: 'lab', kind: 'ollama', baseUrl: 'http://localhost:11434', extra: true }] },
      { revision: 1, profiles: [{ modelProfileId: '../daily', access: 'subscription', runtime: 'claude' }], endpoints: [] },
    ]
    for (const configuration of invalidConfigurations) {
      await expect(openRecords(memoryStorage({ trust: storedTrust(), configuration })))
        .resolves.toEqual({ status: 'failed', code: 'config-invalid' })
    }
  })

  it('rejects access-mode profiles that omit required local bindings', async () => {
    const profiles = [
      { modelProfileId: 'api', access: 'api-key', runtime: 'claude' },
      { modelProfileId: 'local', access: 'local', runtime: 'claude' },
    ]
    for (const profile of profiles) {
      const held = memoryStorage({ trust: storedTrust(), configuration: { revision: 1, profiles: [profile], endpoints: [] } })
      await expect(openRecords(held)).resolves.toEqual({ status: 'failed', code: 'config-invalid' })
    }
  })

  it('merges unrelated grants across independent CAS writers', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'runner-home-grant-cas-'))
    try {
      const firstPath = path.join(parent, 'first')
      const secondPath = path.join(parent, 'second')
      await Promise.all([mkdir(firstPath), mkdir(secondPath)])
      const held = memoryStorage({ trust: storedTrust() })
      const [first, second] = await Promise.all([openRecords(held), openRecords(held)])
      if (first.status !== 'ready' || second.status !== 'ready') throw new Error('homes did not open')
      await Promise.all([first.home.grants.grant(firstPath), second.home.grants.grant(secondPath)])
      await expect(first.home.grants.list()).resolves.toEqual(expect.arrayContaining([await realpath(firstPath), await realpath(secondPath)]))
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('rejects a concurrent same-path grant whose alias was not persisted', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'runner-home-grant-alias-race-'))
    try {
      const target = path.join(parent, 'target')
      const firstAlias = path.join(parent, 'first-alias')
      const secondAlias = path.join(parent, 'second-alias')
      await mkdir(target)
      await Promise.all([symlink(target, firstAlias), symlink(target, secondAlias)])
      const held = memoryStorage({ trust: storedTrust() })
      const replace = held.storage.replace
      let grantWrites = 0
      let releaseWriters: (() => void) | undefined
      const writersReady = new Promise<void>(resolve => { releaseWriters = resolve })
      held.storage.replace = async (record, expectedSha256, bytes) => {
        if (record === 'grants') {
          grantWrites += 1
          if (grantWrites === 2) releaseWriters?.()
          await writersReady
        }
        return await replace(record, expectedSha256, bytes)
      }
      const [first, second] = await Promise.all([openRecords(held), openRecords(held)])
      if (first.status !== 'ready' || second.status !== 'ready') throw new Error('homes did not open')
      const results = await Promise.allSettled([first.home.grants.grant(firstAlias), second.home.grants.grant(secondAlias)])
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('bounds grant CAS conflicts instead of retrying forever', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'runner-home-grant-cap-'))
    try {
      const target = path.join(parent, 'target')
      await mkdir(target)
      const held = memoryStorage({ trust: storedTrust() })
      const replace = held.storage.replace
      let conflicts = 0
      held.storage.replace = async (record, expectedSha256, bytes) => {
        if (record === 'grants') {
          conflicts += 1
          return { status: 'conflict', currentSha256: null }
        }
        return await replace(record, expectedSha256, bytes)
      }
      const opened = await openRecords(held)
      if (opened.status !== 'ready') throw new Error(opened.code)
      await expect(opened.home.grants.grant(target)).rejects.toThrow('state-io-failed')
      expect(conflicts).toBe(8)
    } finally {
      await rm(parent, { recursive: true, force: true })
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
        trust: storedTrust(),
        grants: {
          revision: 1,
          records: [{ path: await realpath(first), alias: path.resolve(alias), grantedAt: '2026-08-22T00:00:00Z' }],
        },
      })
      const opened = await openRecords(held)
      if (opened.status !== 'ready') throw new Error(opened.code)
      await unlink(alias)
      await symlink(second, alias)
      await expect(opened.home.grants.grant(alias)).rejects.toThrow('state-io-failed')
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('returns the winning receipt image after an underlying storage conflict', async () => {
    const held = memoryStorage({ trust: storedTrust() })
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
    const opened = await openRecords(held)
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
    const cases: Array<readonly [string, Partial<Record<RunnerHomeStateRecord, unknown>>, string]> = [
      ['missing', {}, 'policy-missing'],
      ['foreign', { trust: storedTrust({ ...trusted, allowlist: { ...trusted.allowlist, keyId: 'foreign' } }) }, 'policy-unknown-key'],
      ['tampered', { trust: storedTrust({ ...trusted, allowlist: { ...trusted.allowlist, signature: 'AAAA' } }) }, 'policy-malformed'],
      ['malformed', { trust: { schemaVersion: 1, revision: 1, allowlist: null, anchors: [] } }, 'policy-malformed'],
    ]
    for (const [name, initial, code] of cases) {
      const held = memoryStorage(initial)
      await expect(openRecords(held), name).resolves.toEqual({ status: 'failed', code })
    }
    const invalidJson = memoryStorage()
    invalidJson.records.set('policy', Buffer.from('{'))
    await expect(openRecords(invalidJson)).resolves.toEqual({ status: 'failed', code: 'policy-trust-migration-required' })
  })

  it('fails closed when a state record is malformed or its audit append is unavailable', async () => {
    const invalidStates = [
      memoryStorage({ trust: storedTrust(), projects: { revision: 1, projects: [null] } }),
      memoryStorage({ trust: storedTrust(), projects: { revision: 1, projects: [], extra: true } }),
      memoryStorage({ trust: storedTrust(), projects: { revision: 1, projects: [{ projectId: 'p', repoPath: '/r', worktreesRoot: '/w', revision: 1, extra: true }] } }),
      memoryStorage({ trust: storedTrust(), grants: { revision: 1, records: [{ path: null, grantedAt: '2026-08-22T00:00:00Z' }] } }),
      memoryStorage({ trust: storedTrust(), grants: { revision: 1, records: [], extra: true } }),
      memoryStorage({ trust: storedTrust(), grants: { revision: 1, records: [{ path: '/safe', grantedAt: '2026-08-22T00:00:00Z', extra: true }] } }),
      memoryStorage({ trust: storedTrust(), grants: { revision: 1, records: [{ path: '/safe', grantedAt: '2026-02-30T00:00:00Z' }] } }),
      memoryStorage({
        trust: storedTrust(),
        grants: {
          revision: 1,
          records: [
            { path: '/first', alias: '/second', grantedAt: '2026-08-22T00:00:00Z' },
            { path: '/second', grantedAt: '2026-08-22T00:01:00Z' },
          ],
        },
      }),
      memoryStorage({
        trust: storedTrust(),
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
      await expect(openRecords(invalid)).resolves.toEqual({ status: 'failed', code: 'state-io-failed' })
    }

    const held = memoryStorage({ trust: storedTrust() })
    const opened = await openRecords(held)
    if (opened.status !== 'ready') throw new Error(opened.code)
    held.failAudit()
    await expect(opened.home.audit.append({ kind: 'kill', confirmed: false, details: 'uncertain', at: '2026-08-22T00:00:00Z' })).rejects.toThrow('audit unavailable')
  })
})

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value)
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

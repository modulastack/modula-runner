import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  createRunnerTrustStore,
  createTrustRotationAuthorization,
  generateAllowlistSigningKey,
  initializeRunnerTrust,
  openRunnerTrust,
  RunnerTrustError,
  signAllowlist,
  type RunnerHomeStateRecord,
  type RunnerHomeStorage,
} from '../src/index.js'

function memoryStorage(initial: Partial<Record<RunnerHomeStateRecord, unknown>> = {}) {
  const records = new Map<RunnerHomeStateRecord, Uint8Array>()
  for (const [record, value] of Object.entries(initial)) {
    const serialized = record === 'trust' ? `${canonicalJson(value)}\n` : JSON.stringify(value)
    records.set(record as RunnerHomeStateRecord, Buffer.from(serialized))
  }
  const storage: RunnerHomeStorage = {
    inspect: async () => ({ rootKind: 'directory', rootOwner: 'current-user', rootMode: 0o700, entries: [] }),
    read: async record => {
      const bytes = records.get(record)
      return bytes ? { status: 'found', bytes, sha256: digest(bytes) } : { status: 'missing' }
    },
    replace: async (record, expectedSha256, bytes) => {
      const current = records.get(record)
      const currentSha256 = current ? digest(current) : null
      if (currentSha256 !== expectedSha256) return { status: 'conflict', currentSha256 }
      records.set(record, Buffer.from(bytes))
      return { status: 'written', sha256: digest(bytes) }
    },
  }
  return { storage, records }
}

function policy(key = generateAllowlistSigningKey()) {
  return {
    key,
    snapshot: {
      revision: 1,
      allowlist: signAllowlist({ executables: ['git'], recipes: {} }, key.signingKey),
      trustAnchors: [key.trustAnchor],
    },
  }
}

function stored(snapshot: ReturnType<typeof policy>['snapshot']): unknown {
  return { schemaVersion: 1, revision: snapshot.revision, anchors: snapshot.trustAnchors, allowlist: snapshot.allowlist }
}

describe('runner trust store', () => {
  it('bootstraps one authoritative record and an old-binary-failing tombstone', async () => {
    const held = memoryStorage()
    const first = policy()
    await expect(initializeRunnerTrust(held.storage, first.snapshot)).resolves.toBe('initialized')
    const trust = JSON.parse(Buffer.from(held.records.get('trust')!).toString('utf8'))
    const tombstone = JSON.parse(Buffer.from(held.records.get('policy')!).toString('utf8'))
    expect(trust).toMatchObject({ schemaVersion: 1, revision: 1, anchors: [first.key.trustAnchor] })
    expect(tombstone).toEqual({ schemaVersion: 2, migratedTo: 'policy.trust.json' })
    await expect((await openRunnerTrust(held.storage)).snapshot()).resolves.toEqual(first.snapshot)
    await expect(initializeRunnerTrust(held.storage, first.snapshot)).resolves.toBe('exact-existing')
    const changed = {
      ...first.snapshot,
      allowlist: signAllowlist({ executables: ['tmux'], recipes: {} }, first.key.signingKey),
    }
    await expect(initializeRunnerTrust(held.storage, changed)).resolves.toBe('conflict')
    await expect(initializeRunnerTrust(held.storage, policy().snapshot)).resolves.toBe('conflict')
  })

  it('recognizes an identical concurrent bootstrap winner', async () => {
    const first = policy()
    const held = memoryStorage()
    const replace = held.storage.replace
    let injected = false
    held.storage.replace = async (record, expectedSha256, bytes) => {
      if (record === 'trust' && !injected) {
        injected = true
        const winner = Buffer.from(`${canonicalJson(stored(first.snapshot))}\n`)
        held.records.set('trust', winner)
        return { status: 'conflict', currentSha256: digest(winner) }
      }
      return await replace(record, expectedSha256, bytes)
    }
    await expect(initializeRunnerTrust(held.storage, first.snapshot)).resolves.toBe('exact-existing')
    expect(JSON.parse(Buffer.from(held.records.get('policy')!).toString('utf8')))
      .toEqual({ schemaVersion: 2, migratedTo: 'policy.trust.json' })
  })

  it('recognizes an identical legacy-derived migration winner while staging the tombstone', async () => {
    const first = policy()
    const migrated = {
      ...first.snapshot,
      allowlist: signAllowlist({ executables: ['tmux'], recipes: {} }, first.key.signingKey),
    }
    const held = memoryStorage({ policy: migrated })
    const replace = held.storage.replace
    let injected = false
    held.storage.replace = async (record, expectedSha256, bytes) => {
      if (record === 'policy' && !injected) {
        injected = true
        held.records.set('trust', Buffer.from(`${canonicalJson(stored(migrated))}\n`))
        held.records.set('policy', Buffer.from(`${canonicalJson({ schemaVersion: 2, migratedTo: 'policy.trust.json' })}\n`))
        return { status: 'conflict', currentSha256: digest(held.records.get('policy')!) }
      }
      return await replace(record, expectedSha256, bytes)
    }
    await expect(initializeRunnerTrust(held.storage, first.snapshot)).resolves.toBe('exact-existing')
    await expect((await openRunnerTrust(held.storage)).snapshot()).resolves.toEqual(migrated)
  })

  it('tombstones legacy authority before publishing trust and resumes after interruption', async () => {
    const first = policy()
    const held = memoryStorage({ policy: first.snapshot })
    const replace = held.storage.replace
    let interruptTrust = true
    held.storage.replace = async (record, expectedSha256, bytes) => {
      if (record === 'trust' && interruptTrust) return { status: 'storage-unavailable' }
      return await replace(record, expectedSha256, bytes)
    }
    await expect(initializeRunnerTrust(held.storage, first.snapshot)).rejects.toMatchObject({ failure: 'state-io-failed' })
    const pending = JSON.parse(Buffer.from(held.records.get('policy')!).toString('utf8'))
    expect(pending).toMatchObject({ schemaVersion: 3, migratedTo: 'policy.trust.json' })
    expect(pending).not.toHaveProperty('allowlist')
    expect(pending).not.toHaveProperty('trustAnchors')
    interruptTrust = false
    await expect(initializeRunnerTrust(held.storage, first.snapshot)).resolves.toBe('initialized')
    await expect((await openRunnerTrust(held.storage)).snapshot()).resolves.toEqual(first.snapshot)
  })

  it('requires an external key to migrate legacy policy authority', async () => {
    const first = policy()
    const held = memoryStorage({ policy: first.snapshot })
    await expect(openRunnerTrust(held.storage)).rejects.toMatchObject({
      failure: 'policy-trust-migration-required',
    })
    const wrong = policy()
    await expect(initializeRunnerTrust(held.storage, wrong.snapshot)).rejects.toMatchObject({
      failure: 'policy-unknown-key',
    })
    await expect(initializeRunnerTrust(held.storage, first.snapshot)).resolves.toBe('initialized')
    await expect((await openRunnerTrust(held.storage)).snapshot()).resolves.toEqual(first.snapshot)
  })

  it('performs restart-safe add, resign, and remove rotation', async () => {
    const old = policy()
    const next = generateAllowlistSigningKey()
    const held = memoryStorage({ trust: stored(old.snapshot) })
    const store = createRunnerTrustStore(held.storage)

    const expanded = [old.key.trustAnchor, next.trustAnchor]
    const add = createTrustRotationAuthorization(old.snapshot, expanded, old.key.signingKey)
    const added = await store.rotateTrust!(1, expanded, add)
    expect(added).toMatchObject({ status: 'updated', policy: { revision: 2 } })

    const current = await store.snapshot()
    const resigned = signAllowlist({ executables: ['git', 'tmux'], recipes: {} }, next.signingKey)
    await expect(store.replace(current.revision, { allowlist: resigned, trustAnchors: current.trustAnchors }))
      .resolves.toMatchObject({ status: 'updated', policy: { revision: 3 } })

    const beforeRemove = await store.snapshot()
    const remove = createTrustRotationAuthorization(beforeRemove, [next.trustAnchor], old.key.signingKey)
    await expect(store.rotateTrust!(beforeRemove.revision, [next.trustAnchor], remove))
      .resolves.toMatchObject({ status: 'updated', policy: { revision: 4, trustAnchors: [next.trustAnchor] } })
    await expect(store.rotateTrust!(beforeRemove.revision, [next.trustAnchor], remove))
      .resolves.toMatchObject({ status: 'updated', policy: { revision: 4, trustAnchors: [next.trustAnchor] } })
    await expect((await openRunnerTrust(held.storage)).snapshot()).resolves.toMatchObject({ revision: 4 })
  })

  it('accepts exact replay but rejects stale changes, unknown authorization, and active-key removal', async () => {
    const old = policy()
    const unknown = generateAllowlistSigningKey()
    const held = memoryStorage({ trust: stored(old.snapshot) })
    const store = createRunnerTrustStore(held.storage)
    const expanded = [old.key.trustAnchor, unknown.trustAnchor]
    const wrong = createTrustRotationAuthorization(old.snapshot, expanded, unknown.signingKey)
    await expect(store.rotateTrust!(1, expanded, wrong)).resolves.toEqual({ status: 'unauthorized' })

    const valid = createTrustRotationAuthorization(old.snapshot, expanded, old.key.signingKey)
    await expect(store.rotateTrust!(1, expanded, valid)).resolves.toMatchObject({ status: 'updated', policy: { revision: 2 } })
    await expect(store.rotateTrust!(1, expanded, valid)).resolves.toMatchObject({ status: 'updated', policy: { revision: 2 } })
    const staleChange = [...expanded, generateAllowlistSigningKey().trustAnchor]
    await expect(store.rotateTrust!(1, staleChange, valid)).resolves.toMatchObject({ status: 'conflict' })

    const current = await store.snapshot()
    const removeActive = createTrustRotationAuthorization(current, [unknown.trustAnchor], old.key.signingKey)
    await expect(store.rotateTrust!(current.revision, [unknown.trustAnchor], removeActive))
      .resolves.toEqual({ status: 'unauthorized' })
  })

  it('repairs policy-only replacement and rejects unknown trust fields', async () => {
    const first = policy()
    const held = memoryStorage({
      trust: stored(first.snapshot),
      policy: policy().snapshot,
    })
    await openRunnerTrust(held.storage)
    expect(JSON.parse(Buffer.from(held.records.get('policy')!).toString('utf8')))
      .toEqual({ schemaVersion: 2, migratedTo: 'policy.trust.json' })

    const canonical = held.records.get('trust')!
    held.records.set('trust', canonical.subarray(0, canonical.length - 1))
    await expect(openRunnerTrust(held.storage)).rejects.toMatchObject({ failure: 'policy-malformed' })

    const malformed = stored(first.snapshot) as Record<string, unknown>
    malformed.extra = true
    held.records.set('trust', Buffer.from(JSON.stringify(malformed)))
    await expect(openRunnerTrust(held.storage)).rejects.toMatchObject({ failure: 'policy-malformed' })
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

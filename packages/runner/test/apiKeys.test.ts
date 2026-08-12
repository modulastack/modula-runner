import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_KEY_LABELS, assertProviderName, createEncryptedApiKeyStore, createMemoryApiKeyStore, keyVariableFor, lastFourOf } from '../src/apiKeys.js'
import { createEncryptedPairingStore } from '../src/identityStore.js'
import { SecretEnv } from '../src/secretEnv.js'

// The custody rules are identityStore's and are tested there; what is tested here is that
// the key store actually inherits them rather than reimplementing them, and the rules that
// are its own — one active record per label, a removal that keeps the evidence and drops
// the plaintext, and no API anywhere that returns a key.

const SECRET = 'sk-test-0123456789abcdef'
const roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.length = 0
})

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), 'mr-keys-'))
  roots.push(root)
  return { root, keysPath: path.join(root, 'keys.enc'), keyPath: path.join(root, 'store.key') }
}

function encrypted() {
  const paths = workspace()
  return { ...paths, store: createEncryptedApiKeyStore({ path: paths.keysPath, keyPath: paths.keyPath }) }
}

describe.each([
  ['encrypted', () => encrypted().store],
  ['in-memory', () => createMemoryApiKeyStore()],
])('%s key store', (_name, create) => {
  it('answers with metadata and never with a key', async () => {
    const store = create()

    const record = await store.put({ label: 'work', provider: 'anthropic', secret: SECRET })

    expect(record).toEqual({ label: 'work', provider: 'anthropic', lastFour: 'cdef', createdAt: expect.any(String) })
    expect(JSON.stringify(await store.list())).not.toContain(SECRET)
    expect(await store.get('work')).toEqual(record)
    expect(await store.get('never-added')).toBeNull()
  })

  it('seals the key into an injectable value bound to the variable the caller names', async () => {
    const store = create()
    await store.put({ label: 'work', provider: 'anthropic', secret: SECRET })

    const secrets = await store.injectAs('work', 'ANTHROPIC_API_KEY')

    expect(secrets?.names).toEqual(['ANTHROPIC_API_KEY'])
    expect(secrets?.use(entries => entries.ANTHROPIC_API_KEY)).toBe(SECRET)
    expect(await store.injectAs('never-added', 'ANTHROPIC_API_KEY')).toBeNull()
  })

  it('records a removal, drops the plaintext, and refuses to reuse the label', async () => {
    const store = create()
    await store.put({ label: 'work', provider: 'anthropic', secret: SECRET })

    await store.remove('work')

    expect(await store.injectAs('work', 'ANTHROPIC_API_KEY')).toBeNull()
    expect(await store.get('work')).toMatchObject({ label: 'work', lastFour: 'cdef', removedAt: expect.any(String) })
    await expect(store.put({ label: 'work', provider: 'anthropic', secret: SECRET })).rejects.toThrow(/removed/)
    await expect(store.remove('never-added')).rejects.toThrow(/no key with that label/)
  })

  it('rotates in place, so a label keeps meaning one key', async () => {
    const store = create()
    await store.put({ label: 'work', provider: 'anthropic', secret: SECRET })

    const rotated = await store.put({ label: 'work', provider: 'anthropic', secret: 'sk-test-fedcba9876543210' })

    expect(rotated.lastFour).toBe('3210')
    expect(await store.list()).toHaveLength(1)
    expect((await store.injectAs('work', 'K'))?.use(entries => entries.K)).toBe('sk-test-fedcba9876543210')
  })

  it('refuses what a key record cannot hold', async () => {
    const store = create()

    await expect(store.put({ label: 'work', provider: 'anthropic', secret: 'sk-short' })).rejects.toThrow(/between/)
    await expect(store.put({ label: '../escape', provider: 'anthropic', secret: SECRET })).rejects.toThrow(/safe identifier/)
    await expect(store.put({ label: 'work', provider: '1password', secret: SECRET })).rejects.toThrow(/provider name/)
    await expect(store.put({ label: 'work', provider: 'anthropic', secret: `${SECRET}\n` })).rejects.toThrow(/control characters/)
  })

  it('refuses a provider it could store but never load a key for', async () => {
    const store = create()

    // `amazon.bedrock` reads as a perfectly reasonable vendor name and is the exact shape
    // the store used to accept: the dot cannot appear in an environment variable, so the
    // key went in, reported success, and no profile could ever load it.
    await expect(store.put({ label: 'work', provider: 'amazon.bedrock', secret: SECRET })).rejects.toThrow(/provider name/)
    expect(await store.list()).toEqual([])
  })

  // Its own timeout: the encrypted variant is 64 sequential writes that each fsync the file
  // and its directory, which is a second or two idle and several times that on a busy
  // machine. The durability is the point, so the test waits rather than skipping it.
  it('bounds how many records it will hold', async () => {
    const store = create()
    for (let index = 0; index < MAX_KEY_LABELS; index += 1) {
      await store.put({ label: `key-${index}`, provider: 'anthropic', secret: SECRET })
    }

    await expect(store.put({ label: 'one-too-many', provider: 'anthropic', secret: SECRET })).rejects.toThrow(/most key records/)
  }, 60_000)
})

describe('key store custody', () => {
  it('writes the record and the key 0600, and holds no plaintext on disk', async () => {
    const { store, keysPath, keyPath } = encrypted()

    await store.put({ label: 'work', provider: 'anthropic', secret: SECRET })

    expect(statSync(keysPath).mode & 0o777).toBe(0o600)
    expect(statSync(keyPath).mode & 0o777).toBe(0o600)
    const ciphertext = await readFile(keysPath, 'utf8')
    expect(ciphertext).not.toContain(SECRET)
    // Nothing readable at all: the label is the operator's own word and the record is
    // sealed whole, so a copied directory discloses neither the key nor what it is for.
    expect(ciphertext).not.toContain('anthropic')
  })

  it('reads back through a second handle, and fails closed on a tampered record', async () => {
    const { store, keysPath, keyPath } = encrypted()
    await store.put({ label: 'work', provider: 'anthropic', secret: SECRET })

    const reopened = createEncryptedApiKeyStore({ path: keysPath, keyPath })
    expect((await reopened.injectAs('work', 'K'))?.use(entries => entries.K)).toBe(SECRET)

    const sealed = JSON.parse(await readFile(keysPath, 'utf8'))
    sealed.body = Buffer.from('not the record it was').toString('base64')
    await writeFile(keysPath, JSON.stringify(sealed))

    await expect(createEncryptedApiKeyStore({ path: keysPath, keyPath }).list()).rejects.toThrow(/authentication/)
  })

  it('shares one key file with the pairing binding rather than minting a second store', async () => {
    const { keysPath, keyPath, root } = workspace()
    const keys = createEncryptedApiKeyStore({ path: keysPath, keyPath })
    const pairing = createEncryptedPairingStore({ path: path.join(root, 'binding.enc'), keyPath })

    // Started together on purpose: two record kinds racing to create one key file is the
    // case the shared queue exists for, and the loser must not be left holding a record it
    // cannot open.
    await Promise.all([
      keys.put({ label: 'work', provider: 'anthropic', secret: SECRET }),
      pairing.save({ runnerId: 'r', controlPlaneUrl: 'https://c.test', token: 't', pairedAt: 'now' }),
    ])

    expect((await keys.injectAs('work', 'K'))?.use(entries => entries.K)).toBe(SECRET)
    expect((await pairing.load())?.token).toBe('t')
  })

  // Named for what it asserts — the three answers — and not for atomicity, which it cannot
  // see: a two-call implementation with the same check satisfies every line of it. The
  // atomicity is proven by the rotation test below and by the resolver's own call-count
  // test, both of which go red when the operation is split.
  it('names why it will not inject, and seals the key when it will', async () => {
    const store = createMemoryApiKeyStore()
    await store.put({ label: 'work', provider: 'anthropic', secret: SECRET })

    expect(await store.injectAsForProvider('never-added', 'anthropic', 'K')).toEqual({ status: 'missing' })
    expect(await store.injectAsForProvider('work', 'openai', 'K')).toEqual({ status: 'provider-mismatch' })
    const injected = await store.injectAsForProvider('work', 'anthropic', 'K')
    expect(injected.status === 'injected' && injected.secrets.use(entries => entries.K)).toBe(SECRET)
  })

  it('never hands one vendor\'s key to a launch validated against another', async () => {
    const store = createMemoryApiKeyStore()
    await store.put({ label: 'work', provider: 'anthropic', secret: SECRET })

    // A rotation racing the injection. Split across a read and a fetch, this window is where
    // the new vendor's key gets injected under the old vendor's variable; as one operation
    // the answer is whichever landed first, and never a mixture of the two.
    const [injection] = await Promise.all([
      store.injectAsForProvider('work', 'anthropic', 'K'),
      store.put({ label: 'work', provider: 'openai', secret: 'sk-test-fedcba9876543210' }),
    ])

    if (injection.status === 'injected') expect(injection.secrets.use(entries => entries.K)).toBe(SECRET)
    else expect(injection.status).toBe('provider-mismatch')
    expect(await store.get('work')).toMatchObject({ provider: 'openai' })
  })

  it('refuses two record kinds over one file, and a record over its own key', () => {
    const { keysPath, keyPath } = workspace()

    expect(() => createEncryptedApiKeyStore({ path: keyPath, keyPath })).toThrow(/different files/)
    createEncryptedApiKeyStore({ path: keysPath, keyPath })
    expect(() => createEncryptedPairingStore({ path: keysPath, keyPath })).toThrow(/different files/)
  })

  it('refuses one record file held under two different key files', () => {
    const first = workspace()
    const second = workspace()
    createEncryptedApiKeyStore({ path: first.keysPath, keyPath: first.keyPath })

    // Each store would re-encrypt the shared record under a key the other cannot read, so
    // whichever wrote last would be the only one that could ever open it again. Neither
    // store can see this from inside its own custody, which is why the claim is global.
    expect(() => createEncryptedApiKeyStore({ path: first.keysPath, keyPath: second.keyPath })).toThrow(/different key file/)
  })

  it('refuses a record file that is another store\'s key file', () => {
    const first = workspace()
    const second = workspace()
    createEncryptedApiKeyStore({ path: first.keysPath, keyPath: first.keyPath })

    // Ciphertext would land on the first store's key, and the first store would never open
    // its own record again.
    expect(() => createEncryptedPairingStore({ path: first.keyPath, keyPath: second.keyPath })).toThrow(/different files/)
    // And the mirror of it: a key file pointed at a record another store already holds,
    // which would have the key minted over somebody's ciphertext.
    expect(() => createEncryptedPairingStore({ path: second.keysPath, keyPath: first.keysPath })).toThrow(/different files/)
  })

  it('refuses two spellings that turn out to be one file', async () => {
    const { root, keysPath, keyPath } = workspace()
    const store = createEncryptedApiKeyStore({ path: keysPath, keyPath })
    await store.put({ label: 'work', provider: 'anthropic', secret: SECRET })
    const alias = path.join(root, 'alias.enc')
    await symlink(keysPath, alias)

    // Nothing about the spellings is wrong, so the claim goes through; the collision only
    // exists once the filesystem is asked, which is what the deferred identity check is for.
    const aliased = createEncryptedPairingStore({ path: alias, keyPath })

    await expect(aliased.load()).rejects.toThrow(/resolve to the same file/)
  })
})

describe('provider names', () => {
  it('accepts exactly what the key variable can be derived from', () => {
    // One grammar, asserted from both ends: everything the store takes must produce a
    // variable an environment can carry, and everything it refuses must be refused for
    // that reason. Two validators that agree today are the defect this replaced.
    for (const provider of ['anthropic', 'openai', 'amazon-bedrock', 'x', 'a1']) {
      const variable = keyVariableFor(provider)
      expect(() => SecretEnv.of({ [variable]: 'value' })).not.toThrow()
      expect(variable.endsWith('_API_KEY')).toBe(true)
    }
    for (const provider of ['amazon.bedrock', '1password', 'has space', '', 'has/slash']) {
      expect(() => assertProviderName(provider)).toThrow(/provider name/)
      expect(() => keyVariableFor(provider)).toThrow(/provider name/)
    }
  })
})

describe('key fingerprints', () => {
  it('is the literal last four, and refuses a key too short to have one', () => {
    expect(lastFourOf(SECRET)).toBe('cdef')
    expect(() => lastFourOf('sk-short')).toThrow(/at least/)
  })
})

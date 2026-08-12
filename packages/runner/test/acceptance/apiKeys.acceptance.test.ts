import { randomBytes } from 'node:crypto'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import {
  LAST_FOUR_LENGTH,
  MAX_KEY_LABELS,
  MIN_API_KEY_LENGTH,
  SECRET_PLACEHOLDER,
  SecretEnv,
  createEncryptedApiKeyStore,
  createMemoryApiKeyStore,
  lastFourOf,
  runKeyAddCommand,
  runKeyListCommand,
  runKeyRemoveCommand,
  type ApiKeyStore,
} from '../../src/index.js'
import { apiKeyBody, apiKeyLastFour, apiKeySecret, captureRunnerOutput, temporaryRoot } from './accessSupport.js'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.map(path => rm(path, { recursive: true, force: true })))
  temporaryPaths.length = 0
})

async function encryptedStore() {
  const root = await temporaryRoot('runner-api-keys-')
  temporaryPaths.push(root)
  const path = join(root, 'keys.enc')
  const keyPath = join(root, 'keys.key')
  return { store: createEncryptedApiKeyStore({ path, keyPath }), path, keyPath }
}

function newKey(overrides: Partial<{ label: string; provider: string; secret: string }> = {}) {
  return { label: 'acceptance-key', provider: 'acceptance-provider', secret: apiKeySecret, ...overrides }
}

async function seeded(store: ApiKeyStore) {
  await store.put(newKey())
  return store
}

describe('FR-11 runner-local key store', () => {
  // FR-11 and docs/model-access.md "The key store": API keys live in the runner's encrypted
  // local store, under the custody the pairing binding already has.
  test('holds a key as authenticated ciphertext that never contains the key', async () => {
    const { store, path, keyPath } = await encryptedStore()

    await store.put(newKey())
    const first = await readFile(path)
    await store.put(newKey({ label: 'second-key' }))
    const second = await readFile(path)

    expect(first.includes(Buffer.from(apiKeySecret))).toBe(false)
    expect(second.includes(Buffer.from(apiKeySecret))).toBe(false)
    expect(second.equals(first)).toBe(false)
    expect(await readFile(keyPath)).toHaveLength(32)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600)
  })

  // docs/model-access.md "The key store": there is no API on this store that returns a key,
  // and what crosses the seam from here is a label and a last-four fingerprint.
  test('answers every metadata query with label, provider and fingerprint only', async () => {
    const { store } = await encryptedStore()
    await store.put(newKey())

    const listed = await store.list()
    const fetched = await store.get('acceptance-key')

    expect(listed).toHaveLength(1)
    expect(Object.keys(listed[0] ?? {}).sort()).toEqual(['createdAt', 'label', 'lastFour', 'provider'])
    expect(fetched).toEqual(listed[0])
    expect(JSON.stringify(listed)).not.toContain(apiKeyBody)
  })

  // docs/model-access.md "The fingerprint is the literal last four characters" — the only
  // key-derived value permitted to leave this machine, and the exemption is exactly four
  // characters wide.
  test('fingerprints a key as its literal last four characters and nothing more', async () => {
    const { store } = await encryptedStore()

    const record = await store.put(newKey())

    expect(record.lastFour).toBe(apiKeyLastFour)
    expect(record.lastFour).toHaveLength(LAST_FOUR_LENGTH)
    expect(lastFourOf(apiKeySecret)).toBe(apiKeyLastFour)
    expect(JSON.stringify(record)).not.toContain(apiKeyBody)
  })

  // docs/model-access.md: a key shorter than the minimum is refused rather than
  // fingerprinted — four characters only describe nothing if the key behind them is long.
  test('refuses to fingerprint a key too short to have one', async () => {
    const { store } = await encryptedStore()
    const short = 'x'.repeat(MIN_API_KEY_LENGTH - 1)

    await expect(store.put(newKey({ secret: short }))).rejects.toThrow()
    expect(() => lastFourOf(short)).toThrow()
    expect(await store.list()).toEqual([])
  })

  // docs/model-access.md "The key store": a label is a safe identifier because it reaches
  // the filesystem in the record and a surface as a label.
  test('refuses a label that could escape the store it is written into', async () => {
    const { store } = await encryptedStore()

    await expect(store.put(newKey({ label: '../outside' }))).rejects.toThrow()
    await expect(store.put(newKey({ label: 'has space' }))).rejects.toThrow()
    expect(await store.list()).toEqual([])
  })

  // The trust boundary in docs/model-access.md: a key is refused by name, never resolved to
  // a default and never resolved to "the only key we have".
  test('never substitutes another key for one it does not hold', async () => {
    const store = await seeded(createMemoryApiKeyStore())

    expect(await store.get('no-such-key')).toBeNull()
    expect(await store.injectAs('no-such-key', 'PROVIDER_API_KEY')).toBeNull()
    expect(await store.list()).toHaveLength(1)
  })

  // docs/model-access.md "The key store": removal is recorded, not erased — destroying the
  // record would destroy the evidence the key ever existed.
  test('records a removal and stops injecting the removed key', async () => {
    const store = await seeded(createMemoryApiKeyStore())

    await store.remove('acceptance-key')

    expect(await store.injectAs('acceptance-key', 'PROVIDER_API_KEY')).toBeNull()
    expect(await store.list()).toEqual([expect.objectContaining({
      label: 'acceptance-key', lastFour: apiKeyLastFour, removedAt: expect.any(String),
    })])
  })

  // Bounded like every other collection this runner keeps: MAX_KEY_LABELS is the stated cap.
  test('refuses to grow past the label bound it publishes', async () => {
    const store = createMemoryApiKeyStore()
    for (let index = 0; index < MAX_KEY_LABELS; index += 1) {
      await store.put(newKey({ label: `key-${index}` }))
    }

    await expect(store.put(newKey({ label: 'one-too-many' }))).rejects.toThrow()
    expect(await store.list()).toHaveLength(MAX_KEY_LABELS)
  })

  // Same custody the pairing store states: authenticated ciphertext, so tampering and a
  // wrong key both fail closed rather than returning something usable.
  test('fails closed on a tampered record and on a key that does not match', async () => {
    const tampered = await encryptedStore()
    await tampered.store.put(newKey())
    const ciphertext = await readFile(tampered.path)
    const middle = Math.floor(ciphertext.length / 2)
    ciphertext[middle] = (ciphertext[middle] ?? 0) ^ 1
    await writeFile(tampered.path, ciphertext)

    await expect(createEncryptedApiKeyStore({ path: tampered.path, keyPath: tampered.keyPath }).list()).rejects.toThrow()

    const rekeyed = await encryptedStore()
    await rekeyed.store.put(newKey())
    await writeFile(rekeyed.keyPath, randomBytes(32), { mode: 0o600 })
    await expect(createEncryptedApiKeyStore({ path: rekeyed.path, keyPath: rekeyed.keyPath }).list()).rejects.toThrow()
  })
})

describe('FR-11 the one door plaintext leaves by', () => {
  // docs/model-access.md "Plaintext has one door and it is not a getter": the stored secret
  // is sealed directly into an injectable value bound to a caller-chosen variable name.
  test('hands a stored key to an injection without ever returning it as a string', async () => {
    const store = await seeded(createMemoryApiKeyStore())

    const secrets = await store.injectAs('acceptance-key', 'PROVIDER_API_KEY')

    expect(secrets?.names).toEqual(['PROVIDER_API_KEY'])
    expect(secrets?.use(entries => entries.PROVIDER_API_KEY)).toBe(apiKeySecret)
  })

  // docs/model-access.md: the value renders as [secret] under JSON.stringify, string
  // interpolation and util.inspect — a launch plan in a log line is not a credential in a
  // log file, and that is made true by construction because remembering not to log is not
  // a mechanism.
  test('renders as a marker under every ordinary way of writing an object down', async () => {
    const secrets = SecretEnv.of({ PROVIDER_API_KEY: apiKeySecret })
    const plan = { runtime: 'stand-in', secrets }

    expect(JSON.stringify(plan)).not.toContain(apiKeyBody)
    expect(JSON.stringify(plan)).toContain(SECRET_PLACEHOLDER)
    expect(`${secrets}`).toBe(SECRET_PLACEHOLDER)
    expect(inspect(plan, { depth: 8 })).not.toContain(apiKeyBody)
    expect(inspect(secrets, { depth: 8 })).toContain(SECRET_PLACEHOLDER)
    // Variable names stay visible: a diagnostic that says which variables were injected is
    // useful and discloses nothing.
    expect(secrets.names).toEqual(['PROVIDER_API_KEY'])
    expect(secrets.size).toBe(1)
  })

  // docs/model-access.md: merge rejects a variable defined twice rather than picking a
  // winner — two sources disagreeing about one credential is a configuration error.
  test('refuses to merge two sources that disagree about one variable', async () => {
    const first = SecretEnv.of({ PROVIDER_API_KEY: apiKeySecret })
    const second = SecretEnv.of({ PROVIDER_API_KEY: 'a-different-value' })
    const other = SecretEnv.of({ ENDPOINT_BASE_URL: 'http://127.0.0.1:11434' })

    expect(() => first.merge(second)).toThrow()
    expect(first.merge(other).names).toEqual(['ENDPOINT_BASE_URL', 'PROVIDER_API_KEY'])
    expect(SecretEnv.empty().names).toEqual([])
  })
})

describe('FR-11 key entry is local and prompted', () => {
  // docs/model-access.md "Entry is through the local CLI, prompted": the key is read from a
  // hidden prompt, not from an argument, because arguments are readable by any local
  // process — and never over an inbound port, because the runner has none.
  test('takes the key from the prompt and never echoes it back', async () => {
    const keys = createMemoryApiKeyStore()
    const prompts: string[] = []
    const output = captureRunnerOutput()

    let result
    try {
      result = await runKeyAddCommand(['acceptance-key', '--provider', 'acceptance-provider'], {
        keys,
        readSecret: async prompt => { prompts.push(prompt); return apiKeySecret },
      })
    } finally {
      output.restore()
    }

    expect(result.exitCode).toBe(0)
    expect(prompts).toHaveLength(1)
    expect(result.output).not.toContain(apiKeyBody)
    expect(output.text()).not.toContain(apiKeyBody)
    expect(await keys.list()).toEqual([expect.objectContaining({
      label: 'acceptance-key', provider: 'acceptance-provider', lastFour: apiKeyLastFour,
    })])
  })

  // docs/model-access.md: never accepted as an argument, unlike a pairing code. An extra
  // argument that looks like a key is either refused or ignored — it is never the key.
  test('never treats a command-line argument as the key', async () => {
    const keys = createMemoryApiKeyStore()
    const decoy = 'sk-decoy-from-the-command-line-zzzz'

    const result = await runKeyAddCommand(['acceptance-key', '--provider', 'acceptance-provider', decoy], {
      keys,
      readSecret: async () => apiKeySecret,
    })

    const stored = await keys.get('acceptance-key')
    if (result.exitCode === 0) {
      expect(stored?.lastFour).toBe(apiKeyLastFour)
    } else {
      expect(stored).toBeNull()
    }
    expect(stored?.lastFour).not.toBe(decoy.slice(-LAST_FOUR_LENGTH))
    expect(result.output).not.toContain(decoy)
  })

  // docs/model-access.md: labels, providers and last-four only — there is no command, and
  // no store method, that prints a key.
  test('lists stored keys without disclosing any of them', async () => {
    const keys = await seeded(createMemoryApiKeyStore())
    const readSecret = async () => apiKeySecret

    const result = await runKeyListCommand([], { keys, readSecret })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('acceptance-key')
    expect(result.output).toContain(apiKeyLastFour)
    expect(result.output).not.toContain(apiKeyBody)
  })

  // docs/model-access.md: recorded as removed rather than erased, the same rule a revoked
  // binding follows.
  test('removes a key by label and keeps the evidence it existed', async () => {
    const keys = await seeded(createMemoryApiKeyStore())
    const readSecret = async () => apiKeySecret

    const result = await runKeyRemoveCommand(['acceptance-key'], { keys, readSecret })

    expect(result.exitCode).toBe(0)
    expect(result.output).not.toContain(apiKeyBody)
    expect(await keys.injectAs('acceptance-key', 'PROVIDER_API_KEY')).toBeNull()
    expect(await keys.list()).toEqual([expect.objectContaining({ removedAt: expect.any(String) })])
  })
})

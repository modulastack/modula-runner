import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  createEncryptedPairingStore,
  createMemoryPairingStore,
  createPairedClient,
  runPairCommand,
  runStatusCommand,
  RunnerIdentity,
  type PairingStore,
  type RunnerBinding,
} from '../../src/index.js'
import { StubControlPlane } from '../stubControlPlane.js'
import { testRunnerInfo, until } from '../helpers.js'
import { binding, identityWithBinding, startAuthRejectingServer, token } from './support.js'

const clients: { stop(): void }[] = []
const planes: StubControlPlane[] = []
const temporaryPaths: string[] = []

afterEach(async () => {
  for (const client of clients) client.stop()
  await Promise.all(planes.map(plane => plane.stop()))
  await Promise.all(temporaryPaths.map(path => rm(path, { recursive: true, force: true })))
  clients.length = 0
  planes.length = 0
  temporaryPaths.length = 0
  vi.restoreAllMocks()
})

describe('FR-6 pairing trust boundary', () => {
  // FRD FR-6 and the pairing trust boundary: the local `pair <code>` command is the code-entry path.
  test('accepts the pairing capability through the local command without echoing it', async () => {
    const store = createMemoryPairingStore()
    const identity = new RunnerIdentity(store)
    const paired = binding()
    const pair = vi.spyOn(identity, 'pair').mockImplementation(async () => {
      await store.save(paired)
      return paired
    })

    const result = await runPairCommand(['short-lived-code'], {
      identity,
      controlPlaneUrl: 'https://control.example.test',
      version: '1.2.3',
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).not.toContain('short-lived-code')
    expect(result.output).not.toContain(token)
    expect(pair).toHaveBeenCalledOnce()
    expect(pair).toHaveBeenCalledWith(expect.objectContaining({
      code: 'short-lived-code',
      controlPlaneUrl: 'https://control.example.test',
    }))
  })

  // FRD FR-6: ending a binding makes it unusable while retaining revocation evidence.
  test('records revocation and never returns the revoked binding as current', async () => {
    const original = binding()
    const { identity, store } = await identityWithBinding(original)

    expect(await identity.state()).toBe('paired')
    expect(await identity.current()).toEqual(original)
    await identity.endBinding()

    expect(await identity.state()).toBe('revoked')
    expect(await identity.current()).toBeNull()
    expect(await store.load()).toEqual(expect.objectContaining({
      runnerId: original.runnerId,
      token: original.token,
      revokedAt: expect.any(String),
    }))
  })

  // FRD FR-6: multiple runners can be bound without one runner's lifecycle mutating another.
  test('keeps independent runner bindings isolated', async () => {
    const root = await temporaryDirectory()
    const firstStore = encryptedStore(root, 'runner-one')
    const secondStore = encryptedStore(root, 'runner-two')
    await firstStore.save(binding({ runnerId: 'runner-one', token: 'token-one' }))
    await secondStore.save(binding({ runnerId: 'runner-two', token: 'token-two' }))
    const first = new RunnerIdentity(firstStore)
    const second = new RunnerIdentity(secondStore)

    await first.endBinding()

    expect(await first.state()).toBe('revoked')
    expect(await second.state()).toBe('paired')
    expect(await second.current()).toEqual(expect.objectContaining({
      runnerId: 'runner-two', token: 'token-two',
    }))
  })

  // SCHEMA "Transport": the runner token authenticates the WebSocket upgrade and never appears in a frame.
  test('uses the minted token only as the WebSocket bearer credential', async () => {
    const plane = await new StubControlPlane({ token }).start()
    planes.push(plane)
    const seeded = await identityWithBinding(binding({ controlPlaneUrl: plane.url }))
    const client = await createPairedClient(seeded.identity, { runner: testRunnerInfo })
    clients.push(client)

    client.connect()
    await until(() => client.isConnected())

    expect(plane.connectionCount).toBe(1)
    expect(plane.hellos).toHaveLength(1)
    expect(JSON.stringify(plane.hellos)).not.toContain(token)
    expect(JSON.stringify(plane.received)).not.toContain(token)
  })

  // FRD FR-6 and SCHEMA "Transport": an authorization rejection terminates and revokes the binding.
  test('treats WebSocket authorization rejection as terminal instead of reconnecting', async () => {
    const server = await startAuthRejectingServer()
    const seeded = await identityWithBinding(binding({ controlPlaneUrl: server.url }))
    const client = await createPairedClient(seeded.identity, {
      runner: testRunnerInfo,
      backoff: { baseMs: 10, capMs: 10, random: () => 0 },
    })
    clients.push(client)
    client.on('error', () => undefined)

    client.connect()
    await until(async () => (await seeded.identity.state()) === 'revoked')
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(server.attempts()).toBe(1)
    expect(client.isConnected()).toBe(false)
    expect(await seeded.identity.current()).toBeNull()
    await server.stop()
  })

  // FRD FR-6: local status composes identity state without exposing the revoked credential.
  test('reports a revoked binding locally without disclosing its token', async () => {
    const revoked = await identityWithBinding(binding())
    await revoked.identity.endBinding()

    const result = await runStatusCommand([], {
      identity: revoked.identity,
      controlPlaneUrl: 'https://control.example.test',
      version: '1.2.3',
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('revoked')
    expect(result.output).not.toContain(token)
  })

  // FRD FR-6: no usable WebSocket client exists before pairing or after local revocation.
  test('refuses to construct a client without a usable binding', async () => {
    const identity = new RunnerIdentity(createMemoryPairingStore())

    await expect(createPairedClient(identity, { runner: testRunnerInfo })).rejects.toMatchObject({
      state: 'unpaired',
    })

    const revoked = await identityWithBinding(binding())
    await revoked.identity.endBinding()
    await expect(createPairedClient(revoked.identity, { runner: testRunnerInfo })).rejects.toMatchObject({
      state: 'revoked',
    })
  })

  // Pairing revocation contract: persistence failure is surfaced as binding-error, never an unhandled rejection.
  test('surfaces failure to record an authorization revocation', async () => {
    const server = await startAuthRejectingServer()
    const store = revocationFailingStore(binding({ controlPlaneUrl: server.url }))
    const client = await createPairedClient(new RunnerIdentity(store), {
      runner: testRunnerInfo,
      backoff: { baseMs: 10, capMs: 10, random: () => 0 },
    })
    clients.push(client)
    client.on('error', () => undefined)
    const bindingError = new Promise<Error>(resolve => client.once('binding-error', resolve))

    try {
      client.connect()
      const error = await bindingError
      expect(error).toEqual(expect.objectContaining({ message: 'revocation persistence failed' }))
      expect(server.attempts()).toBe(1)
    } finally {
      await server.stop()
    }
  })

  // FRD FR-6: the per-runner token is encrypted at rest in a local-user-owned store.
  test('round-trips the binding with a separate 256-bit key and fresh ciphertext', async () => {
    const root = await temporaryDirectory()
    const dataPath = join(root, 'binding.enc')
    const keyPath = join(root, 'binding.key')
    const store = createEncryptedPairingStore({ path: dataPath, keyPath })
    const original: RunnerBinding = binding()

    await store.save(original)
    const firstCiphertext = await readFile(dataPath)
    await store.save(original)
    const secondCiphertext = await readFile(dataPath)

    expect(await store.load()).toEqual(original)
    expect(firstCiphertext.includes(Buffer.from(original.token))).toBe(false)
    expect(secondCiphertext.equals(firstCiphertext)).toBe(false)
    expect(await readFile(keyPath)).toHaveLength(32)
    expect((await stat(dataPath)).mode & 0o777).toBe(0o600)
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600)
  })

  // Pairing key-custody contract: authenticated ciphertext tampering fails closed.
  test('rejects a tampered binding instead of returning corrupted state', async () => {
    const root = await temporaryDirectory()
    const dataPath = join(root, 'binding.enc')
    const store = createEncryptedPairingStore({ path: dataPath, keyPath: join(root, 'binding.key') })
    await store.save(binding())
    const ciphertext = await readFile(dataPath)
    const changedByte = Math.floor(ciphertext.length / 2)
    ciphertext[changedByte] = (ciphertext[changedByte] ?? 0) ^ 1
    await writeFile(dataPath, ciphertext)

    await expect(store.load()).rejects.toThrow()
  })

  // Pairing key-custody contract: a wrong key is an explicit failure, never an empty binding.
  test('rejects a binding encrypted under a different key', async () => {
    const root = await temporaryDirectory()
    const dataPath = join(root, 'binding.enc')
    const keyPath = join(root, 'binding.key')
    const store = createEncryptedPairingStore({ path: dataPath, keyPath })
    await store.save(binding())
    await writeFile(keyPath, randomBytes(32), { mode: 0o600 })

    await expect(createEncryptedPairingStore({ path: dataPath, keyPath }).load()).rejects.toThrow()
  })

  // Pairing key-custody contract: a missing key beside an existing binding fails explicitly.
  test('rejects an existing binding whose key is missing', async () => {
    const root = await temporaryDirectory()
    const dataPath = join(root, 'binding.enc')
    const keyPath = join(root, 'binding.key')
    const store = createEncryptedPairingStore({ path: dataPath, keyPath })
    await store.save(binding())
    await rm(keyPath)

    await expect(createEncryptedPairingStore({ path: dataPath, keyPath }).load()).rejects.toThrow()
  })
})

async function temporaryDirectory() {
  const root = await mkdtemp(join(tmpdir(), 'runner-pairing-'))
  temporaryPaths.push(root)
  return root
}

function encryptedStore(root: string, name: string) {
  return createEncryptedPairingStore({
    path: join(root, `${name}.enc`),
    keyPath: join(root, `${name}.key`),
  })
}

function revocationFailingStore(value: RunnerBinding): PairingStore {
  return {
    load: async () => value,
    save: async () => undefined,
    markRevoked: async () => { throw new Error('revocation persistence failed') },
  }
}

import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunnerIdentity, createEncryptedPairingStore, createMemoryPairingStore, runStatusCommand, type PairingStore } from '../src/index.js'

// Not a credential: a fixture value the in-process stub control plane compares against
// itself. It authenticates nothing outside this test file.
const STUB_TOKEN = 'stub-control-plane-fixture'


const servers: Server[] = []
const paths: string[] = []

afterEach(async () => {
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(paths.map(target => rm(target, { recursive: true, force: true })))
  servers.length = 0
  paths.length = 0
})

type PlaneOptions = { confirmStatus?: number }

async function controlPlane(options: PlaneOptions = {}) {
  const calls: string[] = []
  const server = createServer((request, response) => {
    calls.push(request.url ?? '')
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      if (request.url === '/api/runner/v1/pair') {
        response.writeHead(200, { 'content-type': 'application/json' })
        return response.end(JSON.stringify({ runnerId: 'runner-two-phase', token: STUB_TOKEN }))
      }
      const status = options.confirmStatus ?? 200
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end('{}')
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no bound port')
  return { url: `http://127.0.0.1:${address.port}`, calls }
}

function request(url: string) {
  return { controlPlaneUrl: url, code: 'PAIR-CODE', runner: { name: 'qa', version: '0', os: 'linux', arch: 'x64' } }
}

describe('two-phase pairing', () => {
  it('stores the token before claiming activation, so a crash cannot spend a code for nothing', async () => {
    const plane = await controlPlane()
    const order: string[] = []
    const inner = createMemoryPairingStore()
    const store: PairingStore = {
      load: inner.load,
      save: async binding => {
        order.push(binding.pendingSince ? 'saved-pending' : 'saved-settled')
        await inner.save(binding)
      },
      markRevoked: inner.markRevoked,
    }

    const binding = await new RunnerIdentity(store).pair(request(plane.url))

    // Durable first, activation claimed second: the reverse order is what strands a
    // binding the runner does not hold.
    expect(order).toEqual(['saved-pending', 'saved-settled'])
    expect(plane.calls).toEqual(['/api/runner/v1/pair', '/api/runner/v1/pair/confirm'])
    expect(binding.pendingSince).toBeUndefined()
  })

  it('leaves the binding pending and unusable when confirmation fails', async () => {
    const plane = await controlPlane({ confirmStatus: 503 })
    const store = createMemoryPairingStore()
    const identity = new RunnerIdentity(store)

    await expect(identity.pair(request(plane.url))).rejects.toThrow()

    expect(await identity.state()).toBe('pending')
    // Unusable on purpose: the control plane may still expire it, and dialing with a token
    // about to be reclaimed would present as revocation.
    expect(await identity.current()).toBeNull()
    expect((await store.load())?.token).toBe(STUB_TOKEN)
  })

  it('resumes an interrupted confirmation instead of spending a fresh code', async () => {
    const plane = await controlPlane()
    const store = createMemoryPairingStore()
    await store.save({
      runnerId: 'runner-two-phase',
      controlPlaneUrl: plane.url,
      token: STUB_TOKEN,
      pairedAt: '2026-08-09T00:00:00.000Z',
      pendingSince: '2026-08-09T00:00:00.000Z',
    })
    const identity = new RunnerIdentity(store)

    const resumed = await identity.resumeConfirmation()

    expect(resumed?.pendingSince).toBeUndefined()
    expect(await identity.state()).toBe('paired')
    expect(await identity.current()).not.toBeNull()
    expect(plane.calls).toEqual(['/api/runner/v1/pair/confirm'])
  })

  it('recovers an unconfirmed pairing through status instead of reporting a broken one', async () => {
    const plane = await controlPlane()
    const store = createMemoryPairingStore()
    await store.save({
      runnerId: 'runner-two-phase',
      controlPlaneUrl: plane.url,
      token: STUB_TOKEN,
      pairedAt: '2026-08-09T00:00:00.000Z',
      pendingSince: '2026-08-09T00:00:00.000Z',
    })
    const identity = new RunnerIdentity(store)

    const result = await runStatusCommand([], { identity, controlPlaneUrl: plane.url, version: '0.1.0' })

    // A pending binding holds a usable token; status is where its activation is retried.
    // Reporting "paired as runner unknown" would strand it.
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('runner-two-phase')
    expect(result.output).not.toContain('unknown')
    expect(await identity.state()).toBe('paired')
  })

  it('ends the binding when confirmation is refused for good, instead of retrying forever', async () => {
    const plane = await controlPlane({ confirmStatus: 410 })
    const store = createMemoryPairingStore()
    const identity = new RunnerIdentity(store)

    await expect(identity.pair(request(plane.url))).rejects.toThrow()

    // The control plane expired the pending binding; retrying this token on every status
    // call would never succeed and would never tell the operator to pair again.
    expect(await identity.state()).toBe('revoked')
  })

  it('reports a settlement failure as recoverable, not as a reason to pair again', async () => {
    const plane = await controlPlane()
    const inner = createMemoryPairingStore()
    let failSettle = true
    const store: PairingStore = {
      load: inner.load,
      save: async binding => {
        if (!binding.pendingSince && failSettle) throw new Error('disk full')
        await inner.save(binding)
      },
      markRevoked: inner.markRevoked,
    }
    const identity = new RunnerIdentity(store)

    await expect(identity.pair(request(plane.url))).rejects.toMatchObject({ failure: 'settle-failed' })

    // The control plane activated this binding; only the local record is behind. Pairing
    // again would mint a second binding and overwrite the one usable record of the first.
    expect(await identity.state()).toBe('pending')
    expect((await store.load())?.token).toBe(STUB_TOKEN)

    failSettle = false
    await identity.resumeConfirmation()
    expect(await identity.state()).toBe('paired')
    // Recovery re-confirms, which is why the schema requires confirmation to be idempotent.
    expect(plane.calls.filter(call => call.endsWith('/confirm'))).toHaveLength(2)
  })

  // NOTE: the *conditional* in revocation is pinned by
  // previewHardening.test.ts ('does not revoke a newly minted binding when a stale client
  // is rejected'). What is deliberately NOT pinned here is its ATOMICITY — that the check
  // happens inside the store's queued mutation rather than in the caller. Two attempts at
  // a test for it passed with the race reintroduced, which makes them false evidence
  // rather than protection, so they were removed instead of kept. The guarantee rests on
  // the store serializing its mutations, which is itself covered by construction: the
  // caller no longer reads before deciding, so there is no window to test.

  it('will not let a stale settlement overwrite a newer binding', async () => {
    const store = createMemoryPairingStore()
    await store.save({ runnerId: 'r', controlPlaneUrl: 'https://c.test', token: 'new', pairedAt: 'now' })

    // What a settlement completing late looks like: it holds the token it read before its
    // network round trip, and writes it back after something newer has been installed.
    await store.save({ runnerId: 'r', controlPlaneUrl: 'https://c.test', token: 'old', pairedAt: 'then' }, 'old')

    expect((await store.load())?.token).toBe('new')

    await store.save({ runnerId: 'r', controlPlaneUrl: 'https://c.test', token: 'newer', pairedAt: 'now' }, 'new')
    expect((await store.load())?.token).toBe('newer')
  })

  it('refuses to use one file as both the binding and its key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-store-'))
    paths.push(root)
    const same = join(root, 'both.enc')

    // The first save would write ciphertext over the key it had just created, report
    // success, and leave nothing readable behind.
    expect(() => createEncryptedPairingStore({ path: same, keyPath: same })).toThrow(/different files/)
  })

  it('keeps a pending binding alive when confirmation merely times out', async () => {
    const plane = await controlPlane({ confirmStatus: 408 })
    const store = createMemoryPairingStore()
    const identity = new RunnerIdentity(store)

    await expect(identity.pair(request(plane.url))).rejects.toThrow()

    // A timeout is the server saying it waited, not that it decided. Treating it as a
    // refusal would permanently disable a credential nobody rejected.
    expect(await identity.state()).toBe('pending')
    expect((await store.load())?.revokedAt).toBeUndefined()
  })

  it('only revokes a pending binding for statuses that are actually a decision', async () => {
    // Anything nobody enumerated as a decision — a timeout, a proxy's invention, a
    // gateway's own opinion — must cost an attempt, never the pairing.
    for (const status of [408, 425, 429, 500, 502, 503, 504, 599]) {
      const plane = await controlPlane({ confirmStatus: status })
      const store = createMemoryPairingStore()
      const identity = new RunnerIdentity(store)
      await expect(identity.pair(request(plane.url))).rejects.toThrow()
      expect(await identity.state()).toBe('pending')
    }
    for (const status of [403, 410]) {
      const plane = await controlPlane({ confirmStatus: status })
      const store = createMemoryPairingStore()
      const identity = new RunnerIdentity(store)
      await expect(identity.pair(request(plane.url))).rejects.toThrow()
      expect(await identity.state()).toBe('revoked')
    }
  })

  it('reads an empty lifecycle marker as set, not as absent', async () => {
    const store = createMemoryPairingStore()
    const identity = new RunnerIdentity(store)
    await store.save({
      runnerId: 'r', controlPlaneUrl: 'https://c.test', token: 'tok', pairedAt: 'now', revokedAt: '',
    })

    // An empty string is a set field. Reading it as absent reported a revoked binding as
    // paired and handed back a token the account had disowned.
    expect(await identity.state()).toBe('revoked')
    expect(await identity.current()).toBeNull()
  })

  it('keeps the binding when the control plane has no confirmation route yet', async () => {
    const plane = await controlPlane({ confirmStatus: 404 })
    const store = createMemoryPairingStore()
    const identity = new RunnerIdentity(store)

    await expect(identity.pair(request(plane.url))).rejects.toThrow()

    // 404 at confirmation is an older deployment without two-phase pairing, not a verdict
    // on the code. Revoking here would destroy a credential that was minted successfully.
    expect(await identity.state()).toBe('pending')
    expect((await store.load())?.revokedAt).toBeUndefined()
  })

  it('treats a binding written before two-phase as already settled', async () => {
    const store = createMemoryPairingStore()
    await store.save({
      runnerId: 'legacy', controlPlaneUrl: 'https://control.test', token: 'legacy-token', pairedAt: 'then',
    })

    const identity = new RunnerIdentity(store)

    expect(await identity.state()).toBe('paired')
    expect(await identity.current()).not.toBeNull()
  })
})

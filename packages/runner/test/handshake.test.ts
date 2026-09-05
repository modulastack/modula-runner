import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { RunnerClient } from '../src/client.js'
import { StubControlPlane } from './stubControlPlane.js'
import { sleep, testRunnerInfo } from './helpers.js'

const fastBackoff = { baseMs: 20, capMs: 50 }
let stub: StubControlPlane | undefined
let client: RunnerClient | undefined

afterEach(async () => {
  client?.stop()
  await stub?.stop()
  client = undefined
  stub = undefined
})

function makeClient(url: string, overrides: Partial<ConstructorParameters<typeof RunnerClient>[0]> = {}) {
  client = new RunnerClient({ url, token: 'stub-token', runner: testRunnerInfo, backoff: fastBackoff, ...overrides })
  return client
}

describe('handshake', () => {
  it('negotiates the current version', async () => {
    stub = await new StubControlPlane({ supportedVersions: [1, 2] }).start()
    const connected = once(makeClient(stub.url), 'connected')
    client!.connect()
    const [detail] = await connected
    expect(detail).toEqual({ protocol: 2, heartbeat: { intervalMs: 200, timeoutMs: 1_000 } })
    expect(stub.hellos[0]?.protocol).toEqual({ min: 1, max: 2 })
    expect(stub.hellos[0]?.runner).toEqual(testRunnerInfo)
  })

  it('speaks N−1 against a newer control plane', async () => {
    stub = await new StubControlPlane({ supportedVersions: [2, 3] }).start()
    const connected = once(makeClient(stub.url), 'connected')
    client!.connect()
    const [detail] = await connected
    // The negotiated heartbeat rides the connected event: it is the window a peer must
    // see this runner go offline within, so presence reads it rather than re-deriving it.
    expect(detail).toEqual({ protocol: 2, heartbeat: { intervalMs: 200, timeoutMs: 1_000 } })
  })

  it('is rejected by a control plane that dropped its versions, and does not retry', async () => {
    stub = await new StubControlPlane({ supportedVersions: [3, 4] }).start()
    const rejected = once(makeClient(stub.url), 'rejected')
    client!.connect()
    const [detail] = await rejected
    expect(detail).toEqual({ reason: 'no common protocol version', supported: [3, 4] })
    await sleep(200)
    expect(stub.connectionCount).toBe(1)
    expect(client!.isConnected()).toBe(false)
  })

  it('treats an auth failure as terminal, not retryable', async () => {
    stub = await new StubControlPlane({ token: 'the-real-token' }).start()
    const failed = once(makeClient(stub.url, { token: 'wrong-token' }), 'auth-failed')
    client!.connect()
    const [detail] = await failed
    expect(detail).toEqual({ statusCode: 401 })
    await sleep(200)
    expect(stub.connectionCount).toBe(0)
    expect(client!.isConnected()).toBe(false)
  })

  it('refuses plaintext toward anything but loopback', () => {
    expect(() => new RunnerClient({ url: 'ws://control.example.com', token: 't', runner: testRunnerInfo })).toThrow(/loopback/)
    expect(() => new RunnerClient({ url: 'ws://127.0.0.1:9', token: 't', runner: testRunnerInfo })).not.toThrow()
    expect(() => new RunnerClient({ url: 'wss://control.example.com', token: 't', runner: testRunnerInfo })).not.toThrow()
    expect(() => new RunnerClient({ url: 'wss://control.example.com/#frag', token: 't', runner: testRunnerInfo })).toThrow(/fragment/)
  })

  it('refuses a configured protocol range this build does not implement', () => {
    const base = { url: 'wss://control.example.com', token: 't', runner: testRunnerInfo }
    expect(() => new RunnerClient({ ...base, protocol: { min: 3, max: 3 } })).toThrow(/implemented versions/)
    expect(() => new RunnerClient({ ...base, protocol: { min: 0, max: 1 } })).toThrow(/implemented versions/)
    expect(() => new RunnerClient({ ...base, protocol: { min: NaN, max: NaN } })).toThrow(/implemented versions/)
    expect(() => new RunnerClient({ ...base, protocol: { min: 1, max: 1 } })).not.toThrow()
    expect(() => new RunnerClient({ ...base, protocol: { min: 2, max: 2 } })).not.toThrow()
  })
})

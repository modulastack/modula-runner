import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import type { Payload } from '@modulastack/runner-protocol'
import { RunnerClient } from '../src/client.js'
import { StubControlPlane } from './stubControlPlane.js'
import { testRunnerInfo, until } from './helpers.js'

let stub: StubControlPlane | undefined
let client: RunnerClient | undefined

afterEach(async () => {
  client?.stop()
  await stub?.stop()
  client = undefined
  stub = undefined
})

async function connectedClient(url: string) {
  client = new RunnerClient({ url, token: 'stub-token', runner: testRunnerInfo, backoff: { baseMs: 20, capMs: 50 } })
  const connected = once(client, 'connected')
  client.connect()
  await connected
  return client
}

describe('stub round-trip', () => {
  it('round-trips a json payload through the control plane', async () => {
    stub = await new StubControlPlane({ echo: true }).start()
    const runner = await connectedClient(stub.url)
    const channel = runner.openChannel('terminal')
    const received = once(runner, 'data')
    channel.send({ codec: 'json', body: { answer: 42 } })
    const [detail] = await received
    expect(detail).toEqual({ channel: channel.id, seq: 1, payload: { codec: 'json', body: { answer: 42 } } })
  })

  it('relays sealed payloads opaquely, byte for byte', async () => {
    stub = await new StubControlPlane({ echo: true }).start()
    const runner = await connectedClient(stub.url)
    const channel = runner.openChannel('terminal')
    const sealed: Payload = { codec: 'sealed', alg: 'xchacha20poly1305', nonce: 'bm9uY2U', body: 'Y2lwaGVydGV4dA' }
    const received = once(runner, 'data')
    channel.send(sealed)
    const [detail] = await received
    expect(detail.payload).toEqual(sealed)
    expect(stub.received[0]?.payload).toEqual(sealed)
  })

  it('delivers control-plane data down to the runner', async () => {
    stub = await new StubControlPlane().start()
    const runner = await connectedClient(stub.url)
    const channel = runner.openChannel('terminal')
    await until(() => stub!.channels.has(channel.id))
    const received = once(runner, 'data')
    stub.sendToRunner(channel.id, { codec: 'text', body: 'operator input' })
    const [detail] = await received
    expect(detail).toEqual({ channel: channel.id, seq: 1, payload: { codec: 'text', body: 'operator input' } })
  })

  it('keeps heartbeats flowing in both directions', async () => {
    stub = await new StubControlPlane({ heartbeat: { intervalMs: 200, timeoutMs: 1_000 } }).start()
    const runner = await connectedClient(stub.url)
    await until(() => stub!.runnerPings.length >= 2)
    stub.pingRunner('cp-hb-1')
    await until(() => stub!.runnerPongs.includes('cp-hb-1'))
    expect(runner.isConnected()).toBe(true)
  })

  it('treats a silent control plane as dead and reconnects', async () => {
    stub = await new StubControlPlane({ heartbeat: { intervalMs: 200, timeoutMs: 400 }, mutePings: true }).start()
    await connectedClient(stub.url)
    await until(() => stub!.connectionCount >= 2)
    expect(stub.runnerPings.length).toBeGreaterThan(0)
  })
})

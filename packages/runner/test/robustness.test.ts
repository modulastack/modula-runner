import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_FRAME_BYTES, type Payload } from '@modulastack/runner-protocol'
import { RunnerClient } from '../src/client.js'
import { StubControlPlane } from './stubControlPlane.js'
import { sleep, testRunnerInfo, until } from './helpers.js'

let stub: StubControlPlane | undefined
let client: RunnerClient | undefined

afterEach(async () => {
  client?.stop()
  await stub?.stop()
  client = undefined
  stub = undefined
})

function text(body: string): Payload {
  return { codec: 'text', body }
}

function makeClient(url: string, overrides: Partial<ConstructorParameters<typeof RunnerClient>[0]> = {}) {
  client = new RunnerClient({ url, token: 'stub-token', runner: testRunnerInfo, backoff: { baseMs: 30, capMs: 80 }, ...overrides })
  return client
}

describe('misbehaving control plane', () => {
  it('drops the connection on an oversized frame instead of buffering it', async () => {
    stub = await new StubControlPlane().start()
    const runner = makeClient(stub.url)
    const connected = once(runner, 'connected')
    runner.connect()
    await connected
    const data: unknown[] = []
    runner.on('data', detail => data.push(detail))
    const offline = once(runner, 'offline')
    const reconnected = once(runner, 'connected')
    stub.sendTextToAll(`{"pad":"${'x'.repeat(MAX_FRAME_BYTES)}"}`)
    await offline
    await reconnected
    expect(data).toEqual([])
    expect(runner.isConnected()).toBe(true)
  })

  it('rejects a welcome that selects a version outside the offered range', async () => {
    stub = await new StubControlPlane({ welcomeVersionOverride: 42 }).start()
    const runner = makeClient(stub.url)
    const failed = once(runner, 'protocol-error')
    runner.connect()
    const [detail] = await failed
    expect(detail).toEqual({ message: 'welcome selected an unsupported protocol version', protocol: 42 })
    await sleep(200)
    expect(stub.connectionCount).toBe(1)
    expect(runner.isConnected()).toBe(false)
  })

  it('survives a resume result for a channel it never presented', async () => {
    stub = await new StubControlPlane({ extraResumeIds: ['ghost-chan-01'] }).start()
    const runner = makeClient(stub.url)
    const errors: unknown[] = []
    runner.on('protocol-error', detail => errors.push(detail))
    const connected = once(runner, 'connected')
    runner.connect()
    await connected
    expect(errors).toContainEqual({ message: 'resume result for unknown channel', channel: 'ghost-chan-01' })
    expect(runner.isConnected()).toBe(true)
  })

  it('gives up on a handshake the control plane never answers', async () => {
    stub = await new StubControlPlane({ muteWelcome: true }).start()
    const runner = makeClient(stub.url, { handshakeTimeoutMs: 150 })
    runner.connect()
    await until(() => stub!.connectionCount >= 2)
    expect(runner.isConnected()).toBe(false)
  })
})

describe('channel lifecycle under pressure', () => {
  it('delivers a close issued while offline once reconnected', async () => {
    stub = await new StubControlPlane().start()
    const runner = makeClient(stub.url, { backoff: { baseMs: 150, capMs: 300 } })
    const connected = once(runner, 'connected')
    runner.connect()
    await connected
    const channel = runner.openChannel('terminal')
    channel.send(text('one'))
    await until(() => stub!.received.length === 1)

    const offline = once(runner, 'offline')
    const reconnected = once(runner, 'connected')
    stub.dropConnections()
    await offline
    channel.close('abandoned')
    await reconnected
    await until(() => stub!.closes.length === 1)
    await until(() => runner.channelIds().length === 0)

    expect(stub.closes).toEqual([{ channel: channel.id, reason: 'abandoned' }])
    expect(stub.channels.has(channel.id)).toBe(false)
    expect(() => channel.send(text('after-close'))).toThrow(/closing|unknown channel/)
  })

  it('drains buffered frames before delivering a close', async () => {
    stub = await new StubControlPlane().start()
    const runner = makeClient(stub.url, { highWaterBytes: 1 })
    const connected = once(runner, 'connected')
    runner.connect()
    await connected
    const channel = runner.openChannel('terminal')
    channel.send(text('one'))
    channel.send(text('two'))
    channel.send(text('three'))
    channel.close('done')
    await until(() => stub!.closes.length === 1)

    expect(stub.received.map(entry => entry.seq)).toEqual([1, 2, 3])
    expect(stub.closes).toEqual([{ channel: channel.id, reason: 'done' }])
    await until(() => runner.channelIds().length === 0)
  })

  it('re-announces and fully replays a presented channel the welcome omitted', async () => {
    stub = await new StubControlPlane({ omitResume: true }).start()
    const runner = makeClient(stub.url, { backoff: { baseMs: 150, capMs: 300 } })
    const errors: { message: string }[] = []
    runner.on('protocol-error', detail => errors.push(detail as { message: string }))
    const connected = once(runner, 'connected')
    runner.connect()
    await connected
    const channel = runner.openChannel('terminal')
    channel.send(text('one'))
    channel.send(text('two'))
    await until(() => stub!.received.length === 2)

    const reconnected = once(runner, 'connected')
    stub.dropConnections()
    await reconnected
    await until(() => stub!.received.length === 4)

    expect(errors.map(entry => entry.message)).toContain('welcome omitted a presented channel')
    expect(stub.received.slice(-2).map(entry => entry.seq)).toEqual([1, 2])
  })

  it('reports disconnected immediately after stop', async () => {
    stub = await new StubControlPlane().start()
    const runner = makeClient(stub.url)
    const connected = once(runner, 'connected')
    runner.connect()
    await connected
    runner.stop()
    expect(runner.isConnected()).toBe(false)
  })

  it('discards session frames injected before welcome', async () => {
    stub = await new StubControlPlane().start()
    const runner = makeClient(stub.url, { backoff: { baseMs: 100, capMs: 200 } })
    const events: { data: unknown[]; errors: { message: string }[] } = { data: [], errors: [] }
    runner.on('data', detail => events.data.push(detail))
    runner.on('protocol-error', detail => events.errors.push(detail as { message: string }))
    const connected = once(runner, 'connected')
    runner.connect()
    await connected
    const channel = runner.openChannel('terminal')
    await until(() => stub!.channels.has(channel.id))
    stub.sendToRunner(channel.id, text('legit'))
    await until(() => events.data.length === 1)

    stub.options.delayWelcomeMs = 250
    const reconnected = once(runner, 'connected')
    stub.dropConnections()
    await until(() => stub!.hellos.length === 2)
    stub.sendToRunner(channel.id, text('injected before welcome'))
    await reconnected

    expect(events.data).toHaveLength(1)
    expect(events.errors.map(entry => entry.message)).toContain('frame before welcome')
  })

  it('does not reconnect when stop() is called from the offline handler', async () => {
    stub = await new StubControlPlane().start()
    const runner = makeClient(stub.url, { backoff: { baseMs: 20, capMs: 40 } })
    const connected = once(runner, 'connected')
    runner.connect()
    await connected
    runner.on('offline', () => runner.stop())
    const before = stub.connectionCount
    stub.dropConnections()
    await sleep(300)
    expect(stub.connectionCount).toBe(before)
    expect(runner.isConnected()).toBe(false)
  })

  it('prunes control-plane channels absent from a reconnect hello', async () => {
    stub = await new StubControlPlane().start()
    const first = makeClient(stub.url)
    const connected = once(first, 'connected')
    first.connect()
    await connected
    const channel = first.openChannel('terminal')
    channel.send(text('one'))
    await until(() => stub!.received.length === 1)
    first.stop()

    client = new RunnerClient({ url: stub.url, token: 'stub-token', runner: testRunnerInfo, backoff: { baseMs: 20, capMs: 40 } })
    const fresh = once(client, 'connected')
    client.connect()
    await fresh
    expect(stub.channels.has(channel.id)).toBe(false)
  })

  it('abandons an upgrade the server never completes', async () => {
    const net = await import('node:net')
    let connections = 0
    const sockets = new Set<import('node:net').Socket>()
    const server = net.createServer(socket => {
      connections += 1
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    const runner = makeClient(`ws://127.0.0.1:${address.port}`, { handshakeTimeoutMs: 150 })
    runner.connect()
    await until(() => connections >= 2)
    runner.stop()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('announces a channel opened between hello and welcome', async () => {
    stub = await new StubControlPlane({ delayWelcomeMs: 150 }).start()
    const runner = makeClient(stub.url)
    const connected = once(runner, 'connected')
    runner.connect()
    await until(() => stub!.hellos.length === 1)
    const channel = runner.openChannel('terminal')
    await connected
    await until(() => stub!.channels.has(channel.id))
    channel.send(text('late but registered'))
    await until(() => stub!.received.length === 1)
    expect(stub.received[0]?.channel).toBe(channel.id)
  })

  it('keeps frames ordered and complete under socket backpressure', async () => {
    stub = await new StubControlPlane().start()
    const runner = makeClient(stub.url, { highWaterBytes: 1 })
    const connected = once(runner, 'connected')
    runner.connect()
    await connected
    const channel = runner.openChannel('terminal')
    for (let i = 1; i <= 6; i++) channel.send(text(`frame-${i}`))
    await until(() => stub!.received.length === 6)
    expect(stub.received.map(entry => entry.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(stub.received.map(entry => (entry.payload as { body: string }).body)).toEqual(
      ['frame-1', 'frame-2', 'frame-3', 'frame-4', 'frame-5', 'frame-6'],
    )
  })
})

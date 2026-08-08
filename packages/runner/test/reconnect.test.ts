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

function text(body: string): Payload {
  return { codec: 'text', body }
}

async function connectedClient(url: string, overrides: Partial<ConstructorParameters<typeof RunnerClient>[0]> = {}) {
  client = new RunnerClient({ url, token: 'stub-token', runner: testRunnerInfo, backoff: { baseMs: 200, capMs: 400 }, ...overrides })
  const connected = once(client, 'connected')
  client.connect()
  await connected
  return client
}

describe('reconnect continuity', () => {
  it('replays exactly the gap: no loss, no duplicates, in order', async () => {
    stub = await new StubControlPlane().start()
    const runner = await connectedClient(stub.url)
    const channel = runner.openChannel('terminal')
    channel.send(text('one'))
    channel.send(text('two'))
    channel.send(text('three'))
    await until(() => stub!.received.length === 3)

    const offline = once(runner, 'offline')
    const reconnected = once(runner, 'connected')
    const resumed = once(runner, 'channel-resumed')
    stub.dropConnections()
    await offline
    channel.send(text('four'))
    channel.send(text('five'))
    await reconnected
    const [resume] = await resumed
    await until(() => stub!.received.length === 5)

    expect(resume).toEqual({ channel: channel.id, replayed: 2, reset: false })
    expect(stub.received.map(entry => entry.seq)).toEqual([1, 2, 3, 4, 5])
    expect(stub.received.map(entry => (entry.payload as { body: string }).body)).toEqual(['one', 'two', 'three', 'four', 'five'])
    expect(stub.resets).toEqual([])
  })

  it('presents resume state in the reconnect hello', async () => {
    stub = await new StubControlPlane().start()
    const runner = await connectedClient(stub.url)
    const channel = runner.openChannel('terminal')
    channel.send(text('one'))
    await until(() => stub!.received.length === 1)

    const reconnected = once(runner, 'connected')
    stub.dropConnections()
    await reconnected

    const resumeHello = stub.hellos.at(-1)
    expect(resumeHello?.channels).toEqual([
      { id: channel.id, kind: 'terminal', attachToken: expect.any(String), sentSeq: 1, receivedSeq: 0 },
    ])
  })

  it('expires a channel whose attach token does not match', async () => {
    stub = await new StubControlPlane().start()
    const runner = await connectedClient(stub.url)
    const channel = runner.openChannel('terminal')
    channel.send(text('one'))
    await until(() => stub!.received.length === 1)

    stub.channels.get(channel.id)!.attachToken = 'tampered-0123456789abcdef'
    const expired = once(runner, 'channel-expired')
    stub.dropConnections()
    const [detail] = await expired

    expect(detail).toEqual({ channel: channel.id })
    expect(runner.channelIds()).toEqual([])
    expect(() => channel.send(text('after-expiry'))).toThrow(/unknown channel/)
  })

  it('announces a reset when the gap outruns the replay buffer', async () => {
    stub = await new StubControlPlane().start()
    const runner = await connectedClient(stub.url, { bufferBytes: 1 })
    const channel = runner.openChannel('terminal')
    channel.send(text('one'))
    await until(() => stub!.received.length === 1)

    const offline = once(runner, 'offline')
    const resumed = once(runner, 'channel-resumed')
    stub.dropConnections()
    await offline
    channel.send(text('two'))
    channel.send(text('three'))
    channel.send(text('four'))
    const [resume] = await resumed
    await until(() => stub!.received.length === 2)

    expect(resume).toEqual({ channel: channel.id, replayed: 1, reset: true })
    expect(stub.resets).toEqual([{ channel: channel.id, seq: 4 }])
    expect(stub.received.map(entry => entry.seq)).toEqual([1, 4])
  })

  it('survives a cold control-plane restart through channel adoption', async () => {
    stub = await new StubControlPlane().start()
    const port = stub.port
    const runner = await connectedClient(stub.url, { backoff: { baseMs: 50, capMs: 100 } })
    const channel = runner.openChannel('terminal')
    channel.send(text('one'))
    channel.send(text('two'))
    await until(() => stub!.received.length === 2)

    const reconnected = once(runner, 'connected')
    await stub.stop()
    stub = await new StubControlPlane().start(port)
    await reconnected
    await until(() => stub!.received.length === 2)

    expect(stub.received.map(entry => entry.seq)).toEqual([1, 2])
    expect(stub.received.map(entry => (entry.payload as { body: string }).body)).toEqual(['one', 'two'])
  })
})

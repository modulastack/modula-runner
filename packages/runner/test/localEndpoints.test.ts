import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_LOCAL_ENDPOINTS, LocalEndpointRegistry, probeLocalEndpoint } from '../src/localEndpoints.js'

// The probe shapes are a proposal (docs/model-access.md), so what these tests pin is the
// proposal: which path is asked, which field is read, and what each failure is called. The
// other half is what must never come back — the answer carries the fact of an endpoint and
// never its address, because a reason string that quoted the URL would leak exactly what
// the opaque id withholds.

type Fixture = { server: Server; baseUrl: string }

const servers: Server[] = []

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections()
    server.close()
  }
  servers.length = 0
})

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<Fixture> {
  const server = createServer(handler)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the fixture server did not bind a port')
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

// A port nothing is listening on: bound, read, and released, so the number is real and
// free rather than a guess that might collide with something on the machine.
async function closedPort() {
  const { server, baseUrl } = await serve(() => {})
  await new Promise<void>(resolve => server.close(() => resolve()))
  return baseUrl
}

async function answering(path: string, body: unknown, status = 200) {
  const asked: string[] = []
  const fixture = await serve((request, response) => {
    asked.push(request.url ?? '')
    if (request.url !== path) return void response.writeHead(404).end()
    response.writeHead(status, { 'content-type': 'application/json' }).end(typeof body === 'string' ? body : JSON.stringify(body))
  })
  return { ...fixture, asked }
}

describe('local endpoint probes', () => {
  it('reads an Ollama inventory from the documented path and field', async () => {
    const { baseUrl, asked } = await answering('/api/tags', { models: [{ name: 'llama3.1:8b-instruct-q4_K_M' }, { name: 'qwen2.5:3b' }] })

    const capability = await probeLocalEndpoint({ endpointId: 'ollama', kind: 'ollama', baseUrl })

    expect(capability).toEqual({
      endpointId: 'ollama',
      kind: 'ollama',
      reachable: true,
      models: ['llama3.1:8b-instruct-q4_K_M', 'qwen2.5:3b'],
      modelCount: 2,
    })
    expect(asked).toEqual(['/api/tags'])
  })

  it('reads an OpenAI-compatible inventory from its own path and field', async () => {
    const { baseUrl, asked } = await answering('/v1/models', { data: [{ id: 'local-model' }] })

    const capability = await probeLocalEndpoint({ endpointId: 'lab', kind: 'openai-compatible', baseUrl })

    expect(capability).toMatchObject({ endpointId: 'lab', reachable: true, models: ['local-model'], modelCount: 1 })
    expect(asked).toEqual(['/v1/models'])
  })

  it('never carries the address it reached, reachable or not', async () => {
    const { baseUrl } = await answering('/api/tags', { models: [{ name: 'qwen2.5:3b' }] })
    const port = new URL(baseUrl).port

    const up = await probeLocalEndpoint({ endpointId: 'ollama', kind: 'ollama', baseUrl })
    const down = await probeLocalEndpoint({ endpointId: 'ollama', kind: 'ollama', baseUrl: await closedPort() })

    for (const rendered of [JSON.stringify(up), JSON.stringify(down)]) {
      expect(rendered).not.toContain('127.0.0.1')
      expect(rendered).not.toContain('http')
    }
    expect(JSON.stringify(up)).not.toContain(port)
  })

  it('announces truncation through the count rather than a quietly shorter list', async () => {
    const models = Array.from({ length: 100 }, (_unused, index) => ({ name: `model-${index}:latest` }))
    const { baseUrl } = await answering('/api/tags', { models })

    const capability = await probeLocalEndpoint({ endpointId: 'ollama', kind: 'ollama', baseUrl }, { maxModels: 3 })

    expect(capability.models).toEqual(['model-0:latest', 'model-1:latest', 'model-2:latest'])
    expect(capability.modelCount).toBe(100)
  })

  it('reports an installed-nothing endpoint as reachable and empty, which is not a failure', async () => {
    const { baseUrl } = await answering('/api/tags', { models: [] })

    expect(await probeLocalEndpoint({ endpointId: 'ollama', kind: 'ollama', baseUrl })).toMatchObject({ reachable: true, models: [], modelCount: 0 })
  })

  it('names why it could not read an endpoint, never in free text', async () => {
    const unauthorized = await answering('/api/tags', { models: [] }, 401)
    const broken = await answering('/api/tags', 'not json at all')
    const wrongShape = await answering('/api/tags', { models: [{ label: 'no name field' }] })
    const failing = await answering('/api/tags', { models: [] }, 500)

    const reasons = await Promise.all([
      probeLocalEndpoint({ endpointId: 'a', kind: 'ollama', baseUrl: unauthorized.baseUrl }),
      probeLocalEndpoint({ endpointId: 'b', kind: 'ollama', baseUrl: broken.baseUrl }),
      probeLocalEndpoint({ endpointId: 'c', kind: 'ollama', baseUrl: wrongShape.baseUrl }),
      probeLocalEndpoint({ endpointId: 'd', kind: 'ollama', baseUrl: failing.baseUrl }),
      probeLocalEndpoint({ endpointId: 'e', kind: 'ollama', baseUrl: await closedPort() }),
      probeLocalEndpoint({ endpointId: 'f', kind: 'ollama', baseUrl: 'not-a-url' }),
    ])

    expect(reasons.map(reason => reason.reason)).toEqual([
      'unauthorized',
      'unreadable-response',
      'unreadable-response',
      'unreadable-response',
      'not-running',
      'not-running',
    ])
    for (const answer of reasons) expect(answer).toMatchObject({ reachable: false, models: [], modelCount: 0 })
  })

  it('answers timed-out for an endpoint that accepts the connection and then says nothing', async () => {
    // The case an ECONNREFUSED-only reading misses entirely, and the one where waiting on
    // the OS default is a two-minute hang rather than an instant answer.
    const { baseUrl } = await serve(() => {})

    const capability = await probeLocalEndpoint({ endpointId: 'blackhole', kind: 'ollama', baseUrl }, { timeoutMs: 150 })

    expect(capability).toMatchObject({ reachable: false, reason: 'timed-out' })
  })

  it('reads the response through a byte cap', async () => {
    const oversized = JSON.stringify({ models: Array.from({ length: 80_000 }, (_unused, index) => ({ name: `model-${index}` })) })
    const { baseUrl } = await answering('/api/tags', oversized)

    expect(await probeLocalEndpoint({ endpointId: 'huge', kind: 'ollama', baseUrl })).toMatchObject({ reachable: false, reason: 'unreadable-response' })
  })
})

describe('the local endpoint registry', () => {
  it('refuses a configuration the wire could not carry', () => {
    expect(() => new LocalEndpointRegistry([{ endpointId: 'has spaces', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' }])).toThrow(/safe identifier/)
    expect(() => new LocalEndpointRegistry([{ endpointId: 'a', kind: 'ollama', baseUrl: 'file:///etc/passwd' }])).toThrow(/base URL/)
    expect(() => new LocalEndpointRegistry([{ endpointId: 'a', kind: 'ollama', baseUrl: 'https://user:secret@example.test' }])).toThrow(/base URL/)
    expect(() => new LocalEndpointRegistry([{ endpointId: 'a', kind: 'ollama', baseUrl: 'https://example.test?token=secret' }])).toThrow(/base URL/)
    expect(() => new LocalEndpointRegistry([{ endpointId: 'a', kind: 'ollama', baseUrl: 'https://example.test#secret' }])).toThrow(/base URL/)
    for (const baseUrl of ['https://example.test?', 'https://example.test#', 'https://example.test/path?#']) {
      expect(() => new LocalEndpointRegistry([{ endpointId: 'a', kind: 'ollama', baseUrl }])).toThrow(/base URL/)
    }
    expect(() => new LocalEndpointRegistry([
      { endpointId: 'twice', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
      { endpointId: 'twice', kind: 'ollama', baseUrl: 'http://127.0.0.1:11435' },
    ])).toThrow(/unique/)
    const tooMany = Array.from({ length: 9 }, (_unused, index) => ({ endpointId: `e${index}`, kind: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434' }))
    expect(() => new LocalEndpointRegistry(tooMany)).toThrow(/at most/)
  })

  it('ships a default Ollama entry as configuration, which is not a scan', () => {
    // The difference the contract insists on: a default the operator can delete, rather
    // than a sweep of loopback that would advertise a colleague's model server.
    expect(DEFAULT_LOCAL_ENDPOINTS).toEqual([{ endpointId: 'ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' }])
    expect(new LocalEndpointRegistry([]).list()).toEqual([])
  })

  it('holds the address locally and answers by id', async () => {
    const { baseUrl } = await answering('/api/tags', { models: [{ name: 'qwen2.5:3b' }] })
    const registry = new LocalEndpointRegistry([{ endpointId: 'ollama', kind: 'ollama', baseUrl }])

    expect(registry.get('ollama')?.baseUrl).toBe(baseUrl)
    expect(registry.get('never-configured')).toBeNull()
    expect(await registry.probeAll()).toEqual([{ endpointId: 'ollama', kind: 'ollama', reachable: true, models: ['qwen2.5:3b'], modelCount: 1 }])
  })

  it('probes every configured endpoint and keeps them in configuration order', async () => {
    const first = await answering('/api/tags', { models: [{ name: 'one' }] })
    const second = await answering('/api/tags', { models: [{ name: 'two' }] })
    const registry = new LocalEndpointRegistry([
      { endpointId: 'first', kind: 'ollama', baseUrl: first.baseUrl },
      { endpointId: 'down', kind: 'ollama', baseUrl: await closedPort() },
      { endpointId: 'second', kind: 'ollama', baseUrl: second.baseUrl },
    ])

    const probed = await registry.probeAll()

    expect(probed.map(entry => entry.endpointId)).toEqual(['first', 'down', 'second'])
    expect(probed.map(entry => entry.reachable)).toEqual([true, false, true])
  })
})

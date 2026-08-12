import { afterEach, describe, expect, test } from 'vitest'
import {
  isEndpointUnreachableReason,
  isSafeIdentifier,
  MAX_ENDPOINT_MODELS,
  parseRunnerCapabilities,
  type LocalEndpointCapability,
} from '@modulastack/runner-protocol'
import {
  DEFAULT_ENDPOINT_PROBE_TIMEOUT_MS,
  DEFAULT_LOCAL_ENDPOINTS,
  LocalEndpointRegistry,
  MAX_PROBE_RESPONSE_BYTES,
  probeLocalEndpoint,
  type LocalEndpointConfig,
} from '../../src/index.js'
import { startBlackHoleServer, startEndpointServer, type EndpointServer } from './accessSupport.js'

const servers: { stop(): Promise<void> }[] = []

afterEach(async () => {
  await Promise.all(servers.map(server => server.stop()))
  servers.length = 0
})

async function endpoint(options: Parameters<typeof startEndpointServer>[0] = {}) {
  const server = await startEndpointServer(options)
  servers.push(server)
  return server
}

function ollama(server: EndpointServer, endpointId = 'workstation-ollama'): LocalEndpointConfig {
  return { endpointId, kind: 'ollama', baseUrl: server.baseUrl }
}

function openAi(server: EndpointServer, endpointId = 'workstation-compatible'): LocalEndpointConfig {
  return { endpointId, kind: 'openai-compatible', baseUrl: server.baseUrl }
}

function discloses(value: LocalEndpointCapability, server: EndpointServer) {
  const serialized = JSON.stringify(value)
  return serialized.includes(server.baseUrl)
    || serialized.includes(String(server.port))
    || serialized.includes(server.host)
    || serialized.includes('http')
}

describe('FR-12 local model endpoints', () => {
  // docs/model-access.md "Probe shapes — PROPOSAL": ollama health and inventory is
  // GET {baseUrl}/api/tags, read from models[].name.
  test('reports an ollama endpoint as reachable with the inventory it published', async () => {
    const server = await endpoint({ models: ['llama3.1:8b-instruct-q4_K_M', 'qwen2.5-coder:7b'] })

    const capability = await probeLocalEndpoint(ollama(server))

    expect(capability).toEqual({
      endpointId: 'workstation-ollama',
      kind: 'ollama',
      reachable: true,
      models: ['llama3.1:8b-instruct-q4_K_M', 'qwen2.5-coder:7b'],
      modelCount: 2,
    })
    expect(server.paths()).toEqual(['/api/tags'])
  })

  // docs/model-access.md "Probe shapes": the OpenAI-compatible shape is GET
  // {baseUrl}/v1/models read from data[].id, and "compatible" means exactly that much —
  // a plain node:http server answering it is accepted identically to Ollama.
  test('accepts any server answering the documented OpenAI-compatible shape', async () => {
    const server = await endpoint({ models: ['local-model-a'] })

    const capability = await probeLocalEndpoint(openAi(server))

    expect(capability).toEqual(expect.objectContaining({ reachable: true, models: ['local-model-a'], modelCount: 1 }))
    expect(server.paths()).toEqual(['/v1/models'])
  })

  // docs/model-access.md "Local endpoints": an endpoint with nothing installed is a
  // reachable endpoint with an empty inventory, not a failure.
  test('treats an endpoint with no models installed as reachable and empty', async () => {
    const server = await endpoint({ models: [] })

    const capability = await probeLocalEndpoint(ollama(server))

    expect(capability.reachable).toBe(true)
    expect(capability.models).toEqual([])
    expect(capability.modelCount).toBe(0)
    expect(capability.reason).toBeUndefined()
  })

  // docs/model-access.md "Model names are not safe identifiers": real ones contain a colon,
  // which the wire's safe-segment rule rejects, so they cross under their own rule intact.
  test('carries a colon-bearing model name through unaltered', async () => {
    const server = await endpoint({ models: ['llama3.1:8b-instruct-q4_K_M'] })

    const capability = await probeLocalEndpoint(ollama(server))

    expect(capability.models[0]).toBe('llama3.1:8b-instruct-q4_K_M')
    expect(parseRunnerCapabilities({ runtimes: [], endpoints: [capability] })).not.toBeNull()
  })

  // docs/model-access.md "Inventories are bounded and truncation is visible": modelCount
  // carries the true total, so a shortened list says so rather than quietly lying.
  test('announces a truncated inventory instead of silently shortening it', async () => {
    const names = Array.from({ length: 12 }, (_, index) => `model-${index}`)
    const server = await endpoint({ models: names })

    const capability = await probeLocalEndpoint(ollama(server), { maxModels: 4 })

    expect(capability.models).toHaveLength(4)
    expect(capability.modelCount).toBe(12)
    expect(capability.reachable).toBe(true)
  })

  // The same bound applies without being asked for: MAX_ENDPOINT_MODELS is what keeps a
  // capability snapshot inside the frame budget it shares.
  test('never publishes more models than the wire bound allows', async () => {
    const names = Array.from({ length: MAX_ENDPOINT_MODELS + 5 }, (_, index) => `model-${index}`)
    const server = await endpoint({ models: names })

    const capability = await probeLocalEndpoint(ollama(server))

    expect(capability.models.length).toBeLessThanOrEqual(MAX_ENDPOINT_MODELS)
    expect(capability.modelCount).toBe(names.length)
  })

  // docs/model-access.md "Probe shapes": a connection refused is `not-running`.
  test('reports a stopped service as unreachable with a named reason', async () => {
    const server = await endpoint({ models: ['gone'] })
    const config = ollama(server)
    await server.stop()

    const capability = await probeLocalEndpoint(config)

    expect(capability).toEqual(expect.objectContaining({ reachable: false, reason: 'not-running', models: [] }))
  })

  // docs/model-access.md "Probe shapes": a 401 or 403 is `unauthorized`.
  test('names an authorization failure rather than calling the endpoint absent', async () => {
    const server = await endpoint({ status: 401 })

    expect(await probeLocalEndpoint(ollama(server))).toEqual(expect.objectContaining({
      reachable: false, reason: 'unauthorized',
    }))
    server.update({ status: 403 })
    expect(await probeLocalEndpoint(ollama(server))).toEqual(expect.objectContaining({
      reachable: false, reason: 'unauthorized',
    }))
  })

  // docs/model-access.md "Local endpoints": an unreachable endpoint reports an enumerated
  // reason. A server error is not one of the four cases the contract maps by name, so what
  // is asserted here is the invariant that covers all of them — an answer, from the closed
  // vocabulary, and never a crash or a hang.
  test('answers a server error with an enumerated reason rather than crashing', async () => {
    const server = await endpoint({ status: 500 })
    const started = Date.now()

    const capability = await probeLocalEndpoint(ollama(server), { timeoutMs: 1_000 })

    expect(capability.reachable).toBe(false)
    expect(isEndpointUnreachableReason(capability.reason)).toBe(true)
    expect(capability.models).toEqual([])
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  // docs/model-access.md "Probe shapes": a 200 whose body does not parse is
  // `unreadable-response` — strictly validated, so a drifting server fails loudly.
  test('refuses to read a 200 whose body is not the documented shape', async () => {
    const server = await endpoint({ body: '<html>not json</html>' })

    expect(await probeLocalEndpoint(ollama(server))).toEqual(expect.objectContaining({
      reachable: false, reason: 'unreadable-response',
    }))
    server.update({ body: '{"models":"not-a-list"}' })
    expect(await probeLocalEndpoint(ollama(server))).toEqual(expect.objectContaining({
      reachable: false, reason: 'unreadable-response',
    }))
  })

  // docs/model-access.md "Timing": the case that an ECONNREFUSED-only reading misses — a
  // host that accepts the connection and then answers nothing, where the OS default wait
  // is two minutes.
  test('gives up on an endpoint that accepts the connection and never answers', async () => {
    const blackHole = await startBlackHoleServer()
    servers.push(blackHole)
    const config: LocalEndpointConfig = { endpointId: 'black-hole', kind: 'ollama', baseUrl: blackHole.baseUrl }
    const started = Date.now()

    const capability = await probeLocalEndpoint(config, { timeoutMs: 300 })

    expect(capability).toEqual(expect.objectContaining({ reachable: false, reason: 'timed-out' }))
    expect(Date.now() - started).toBeLessThan(2_000)

    // And the deadline holds without being asked for, because the launch path relies on it.
    const withDefault = Date.now()
    expect(await probeLocalEndpoint(config)).toEqual(expect.objectContaining({ reason: 'timed-out' }))
    expect(Date.now() - withDefault).toBeLessThan(DEFAULT_ENDPOINT_PROBE_TIMEOUT_MS + 1_500)
  })

  // docs/model-access.md "Local endpoints": an unreachable endpoint reports an enumerated
  // reason and never an error string, because a transport error carries the address it
  // failed to reach — which is the one thing the seam says never crosses.
  test('never lets a probe result carry the address it dialed', async () => {
    const reachable = await endpoint({ models: ['visible'] })
    const denied = await endpoint({ status: 403 })
    const unparseable = await endpoint({ body: 'nope' })

    const results = await Promise.all([
      probeLocalEndpoint(ollama(reachable)),
      probeLocalEndpoint(ollama(denied, 'denied-endpoint')),
      probeLocalEndpoint(ollama(unparseable, 'unparseable-endpoint')),
    ])

    expect(discloses(results[0] as LocalEndpointCapability, reachable)).toBe(false)
    expect(discloses(results[1] as LocalEndpointCapability, denied)).toBe(false)
    expect(discloses(results[2] as LocalEndpointCapability, unparseable)).toBe(false)
    for (const result of results) {
      if (result.reachable) continue
      expect(isEndpointUnreachableReason(result.reason)).toBe(true)
    }
  })

  // docs/model-access.md "Probe shapes": responses are read through a byte cap, like every
  // other external response this runner reads. A cap that parses the body anyway is not a cap.
  test('stops reading a response that outruns the byte cap', async () => {
    const server = await endpoint({ padBytes: MAX_PROBE_RESPONSE_BYTES + 4_096 })
    const started = Date.now()

    const capability = await probeLocalEndpoint(ollama(server), { timeoutMs: 4_000 })

    expect(capability.reachable).toBe(false)
    expect(isEndpointUnreachableReason(capability.reason)).toBe(true)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  // docs/model-access.md "Local endpoints": a probe answers, it does not throw — a caller
  // that had to convert an exception back into an unreachable answer would eventually
  // convert it into "no endpoints" instead.
  test('answers rather than throwing when an endpoint cannot be reached at all', async () => {
    const capability = await probeLocalEndpoint(
      { endpointId: 'never-listening', kind: 'ollama', baseUrl: 'http://127.0.0.1:1' },
      { timeoutMs: 500 },
    )

    expect(capability.endpointId).toBe('never-listening')
    expect(capability.reachable).toBe(false)
    expect(isEndpointUnreachableReason(capability.reason)).toBe(true)
  })

  // docs/model-access.md "Local endpoints": endpoints are configured, never discovered —
  // the registry answers about what the operator configured and nothing else.
  test('resolves only endpoints the operator configured, by their chosen id', async () => {
    const server = await endpoint({ models: ['configured'] })
    const registry = new LocalEndpointRegistry([ollama(server, 'the-one-configured')])

    expect(registry.list().map(config => config.endpointId)).toEqual(['the-one-configured'])
    expect(registry.get('the-one-configured')?.baseUrl).toBe(server.baseUrl)
    expect(registry.get('some-other-endpoint')).toBeNull()
    expect(server.requestCount()).toBe(0)
  })

  // docs/model-access.md "Local endpoints": a default Ollama entry ships in the default
  // configuration — a default the operator can remove, not a scan — and `endpointId` is
  // operator-chosen and never derived from the address, because a hash of
  // `http://127.0.0.1:<port>` is brute-forced back to the port in milliseconds.
  test('ships a removable default endpoint whose id is not derived from its address', () => {
    expect(DEFAULT_LOCAL_ENDPOINTS.length).toBeGreaterThan(0)
    for (const config of DEFAULT_LOCAL_ENDPOINTS) {
      const port = new URL(config.baseUrl).port
      expect(isSafeIdentifier(config.endpointId)).toBe(true)
      expect(config.endpointId).not.toContain(port)
      expect(config.endpointId).not.toContain(new URL(config.baseUrl).hostname)
      expect(['127.0.0.1', 'localhost', '::1']).toContain(new URL(config.baseUrl).hostname)
    }
    // A default, not a fixture: a registry built without it holds nothing.
    expect(new LocalEndpointRegistry([]).list()).toEqual([])
  })

  // docs/model-access.md "Local endpoints": a hung endpoint costs one unreachable answer,
  // never a delayed handshake — so one black hole does not stall the other probes.
  test('lets one unreachable endpoint answer without stalling the rest', async () => {
    const healthy = await endpoint({ models: ['alive'] })
    const blackHole = await startBlackHoleServer()
    servers.push(blackHole)
    const registry = new LocalEndpointRegistry([
      ollama(healthy, 'healthy-endpoint'),
      { endpointId: 'stalled-endpoint', kind: 'ollama', baseUrl: blackHole.baseUrl },
    ])

    const capabilities = await registry.probeAll({ timeoutMs: 500 })

    expect(capabilities.map(entry => entry.endpointId).sort()).toEqual(['healthy-endpoint', 'stalled-endpoint'])
    expect(capabilities.find(entry => entry.endpointId === 'healthy-endpoint')?.reachable).toBe(true)
    expect(capabilities.find(entry => entry.endpointId === 'stalled-endpoint')).toEqual(
      expect.objectContaining({ reachable: false, reason: 'timed-out' }),
    )
  })
})

import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import type { CliAuthState, RunnerCapabilities } from '@modulastack/runner-protocol'
import { ACCESS_REFUSALS, AccessResolver, accessRefusalGuidance, type AccessResolution, type LocalModelProfile } from '../src/accessProfiles.js'
import { createMemoryApiKeyStore, type ApiKeyStore } from '../src/apiKeys.js'
import type { RuntimeSpec } from '../src/capabilities.js'
import { LocalEndpointRegistry } from '../src/localEndpoints.js'

// The resolver is where a name the control plane could one day send meets a credential this
// machine holds, so these tests are mostly about what it refuses and what a resolved plan is
// allowed to contain. Every refusal is a value; none of them spawns anything.

const SECRET = 'sk-test-0123456789abcdef'
const servers: Server[] = []

afterEach(() => {
  for (const server of servers) {
    server.closeAllConnections()
    server.close()
  }
  servers.length = 0
})

async function ollama(models: string[]) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ models: models.map(name => ({ name })) }))
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the fixture server did not bind a port')
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

const catalog: RuntimeSpec[] = [
  {
    runtime: 'stub',
    command: '/bin/echo',
    versionArgs: ['--version'],
    authArgs: ['auth'],
    access: ['subscription', 'api-key', 'local'],
    accessArgs: { local: ['--oss'] },
  },
  { runtime: 'subscription-only', command: '/bin/echo', versionArgs: ['--version'], authArgs: null, access: ['subscription'] },
]

function snapshotOf(auth: CliAuthState = 'authenticated', runtimes = ['stub', 'subscription-only']): RunnerCapabilities {
  return {
    runtimes: runtimes.map(runtime => ({ runtime, version: '1.0.0', auth, access: catalog.find(spec => spec.runtime === runtime)?.access ?? [] })).map(entry => ({ ...entry, access: [...entry.access] })),
    endpoints: [],
  }
}

function resolverFor(profiles: LocalModelProfile[], options: { keys?: ApiKeyStore; endpoints?: LocalEndpointRegistry; capabilities?: () => RunnerCapabilities | null } = {}) {
  return new AccessResolver({
    profiles,
    runtimes: catalog,
    keys: options.keys ?? createMemoryApiKeyStore(),
    endpoints: options.endpoints ?? new LocalEndpointRegistry([]),
    capabilities: options.capabilities ?? (() => snapshotOf()),
  })
}

function refusalOf(resolution: AccessResolution) {
  return resolution.status === 'refused' ? resolution.reason : `resolved: ${JSON.stringify(resolution.plan)}`
}

describe('resolving a subscription profile', () => {
  it('launches with no secret at all, because the CLI holds its own login', async () => {
    const resolver = resolverFor([{ modelProfileId: 'daily', access: 'subscription', runtime: 'stub', model: 'opus' }])

    const resolution = await resolver.resolve('daily')

    expect(resolution).toMatchObject({ status: 'resolved' })
    if (resolution.status !== 'resolved') throw new Error(refusalOf(resolution))
    expect(resolution.plan).toMatchObject({ command: '/bin/echo', args: ['--model', 'opus'], env: {} })
    expect(resolution.plan.secrets.size).toBe(0)
  })

  it('refuses when the CLI says it holds no credentials, and launches when it will not say', async () => {
    const profile: LocalModelProfile = { modelProfileId: 'daily', access: 'subscription', runtime: 'stub' }

    const signedOut = await resolverFor([profile], { capabilities: () => snapshotOf('unauthenticated') }).resolve('daily')
    const silent = await resolverFor([profile], { capabilities: () => snapshotOf('unknown') }).resolve('daily')

    expect(refusalOf(signedOut)).toBe('runtime-unauthenticated')
    // `unknown` is not a refusal: rendering sign-in guidance at somebody already signed in
    // is the failure this distinction exists to prevent.
    expect(silent.status).toBe('resolved')
  })
})

describe('resolving an api-key profile', () => {
  async function withKey(provider = 'anthropic') {
    const keys = createMemoryApiKeyStore()
    await keys.put({ label: 'work', provider, secret: SECRET })
    return keys
  }

  it('injects the key as a secret, under a variable derived from the provider', async () => {
    const resolver = resolverFor([{ modelProfileId: 'metered', access: 'api-key', runtime: 'stub', provider: 'anthropic', keyLabel: 'work', model: 'claude-opus-5' }], { keys: await withKey() })

    const resolution = await resolver.resolve('metered')

    if (resolution.status !== 'resolved') throw new Error(refusalOf(resolution))
    expect(resolution.plan.secrets.names).toEqual(['ANTHROPIC_API_KEY'])
    expect(resolution.plan.secrets.use(entries => entries.ANTHROPIC_API_KEY)).toBe(SECRET)
    // The key is in the environment and nowhere else: not in the command, not in the
    // arguments, and not in anything a log line would render.
    expect(JSON.stringify(resolution.plan)).not.toContain(SECRET)
    expect([resolution.plan.command, ...resolution.plan.args].join(' ')).not.toContain(SECRET)
  })

  it('asks the store once, so nothing can rotate between the check and the seal', async () => {
    const keys = await withKey()
    const asked: string[] = []
    const watched: ApiKeyStore = {
      list: () => { asked.push('list'); return keys.list() },
      get: label => { asked.push('get'); return keys.get(label) },
      put: entry => { asked.push('put'); return keys.put(entry) },
      remove: label => { asked.push('remove'); return keys.remove(label) },
      injectAs: (label, variable) => { asked.push('injectAs'); return keys.injectAs(label, variable) },
      injectAsForProvider: (label, provider, variable) => {
        asked.push('injectAsForProvider')
        return keys.injectAsForProvider(label, provider, variable)
      },
    }
    const resolver = resolverFor([{ modelProfileId: 'metered', access: 'api-key', runtime: 'stub', provider: 'anthropic', keyLabel: 'work' }], { keys: watched })

    await resolver.resolve('metered')

    // Two calls is the defect this replaced: read the record, compare its provider, then ask
    // for the key — and a rotation landing in that window hands the new vendor's key to a
    // launch validated against the old vendor.
    expect(asked).toEqual(['injectAsForProvider'])
  })

  it('lets a runtime name the variable it actually reads', async () => {
    const resolver = new AccessResolver({
      profiles: [{ modelProfileId: 'metered', access: 'api-key', runtime: 'odd', provider: 'anthropic', keyLabel: 'work' }],
      runtimes: [{ runtime: 'odd', command: '/bin/echo', versionArgs: ['--version'], authArgs: null, access: ['api-key'], keyVariable: 'ODD_TOKEN' }],
      keys: await withKey(),
      endpoints: new LocalEndpointRegistry([]),
      capabilities: () => ({ runtimes: [{ runtime: 'odd', version: null, auth: 'unknown', access: ['api-key'] }], endpoints: [] }),
    })

    const resolution = await resolver.resolve('metered')

    if (resolution.status !== 'resolved') throw new Error(refusalOf(resolution))
    expect(resolution.plan.secrets.names).toEqual(['ODD_TOKEN'])
  })

  it('fails closed on every way a key can be the wrong one', async () => {
    const keys = await withKey()
    const profiles: LocalModelProfile[] = [
      { modelProfileId: 'no-provider', access: 'api-key', runtime: 'stub', keyLabel: 'work' },
      { modelProfileId: 'no-label', access: 'api-key', runtime: 'stub', provider: 'anthropic' },
      { modelProfileId: 'wrong-label', access: 'api-key', runtime: 'stub', provider: 'anthropic', keyLabel: 'never-added' },
      { modelProfileId: 'wrong-provider', access: 'api-key', runtime: 'stub', provider: 'openai', keyLabel: 'work' },
    ]
    const resolver = resolverFor(profiles, { keys })

    const refusals = await Promise.all(profiles.map(async profile => refusalOf(await resolver.resolve(profile.modelProfileId))))

    expect(refusals).toEqual(['profile-incomplete', 'profile-incomplete', 'unknown-key', 'key-provider-mismatch'])
  })

  it('refuses a removed key by name rather than resolving to another one', async () => {
    const keys = await withKey()
    await keys.put({ label: 'spare', provider: 'anthropic', secret: 'sk-test-fedcba9876543210' })
    await keys.remove('work')
    const resolver = resolverFor([{ modelProfileId: 'metered', access: 'api-key', runtime: 'stub', provider: 'anthropic', keyLabel: 'work' }], { keys })

    expect(refusalOf(await resolver.resolve('metered'))).toBe('unknown-key')
  })
})

describe('resolving a local profile', () => {
  it('carries the endpoint address in the environment and the mode in the arguments', async () => {
    const { baseUrl } = await ollama(['llama3.1:8b-instruct-q4_K_M'])
    const endpoints = new LocalEndpointRegistry([{ endpointId: 'ollama', kind: 'ollama', baseUrl }])
    const resolver = resolverFor([{ modelProfileId: 'oss', access: 'local', runtime: 'stub', endpointId: 'ollama', model: 'llama3.1:8b-instruct-q4_K_M' }], { endpoints })

    const resolution = await resolver.resolve('oss')

    if (resolution.status !== 'resolved') throw new Error(refusalOf(resolution))
    expect(resolution.plan.args).toEqual(['--oss', '--model', 'llama3.1:8b-instruct-q4_K_M'])
    expect(resolution.plan.secrets.names).toEqual(['OLLAMA_HOST'])
    expect(resolution.plan.secrets.use(entries => entries.OLLAMA_HOST)).toBe(baseUrl)
    // The address is not a credential, but it is on the never-crosses list and it takes the
    // same non-argv path a credential does.
    expect(JSON.stringify(resolution.plan)).not.toContain(new URL(baseUrl).port)
  })

  it('re-probes before it spawns, so a stopped service is refused rather than launched', async () => {
    const { server, baseUrl } = await ollama(['qwen2.5:3b'])
    const endpoints = new LocalEndpointRegistry([{ endpointId: 'ollama', kind: 'ollama', baseUrl }])
    // The snapshot still says the endpoint is up: the launch-time probe is what makes the
    // promise, not the cadence, and this is the case where the two disagree.
    const capabilities = (): RunnerCapabilities => ({
      runtimes: snapshotOf().runtimes,
      endpoints: [{ endpointId: 'ollama', kind: 'ollama', reachable: true, models: ['qwen2.5:3b'], modelCount: 1 }],
    })
    const resolver = resolverFor([{ modelProfileId: 'oss', access: 'local', runtime: 'stub', endpointId: 'ollama', model: 'qwen2.5:3b' }], { endpoints, capabilities })
    expect((await resolver.resolve('oss')).status).toBe('resolved')

    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))

    expect(refusalOf(await resolver.resolve('oss'))).toBe('endpoint-unavailable')
  })

  it('refuses a model the endpoint does not report, and an endpoint it does not hold', async () => {
    const { baseUrl } = await ollama(['qwen2.5:3b'])
    const endpoints = new LocalEndpointRegistry([{ endpointId: 'ollama', kind: 'ollama', baseUrl }])
    const profiles: LocalModelProfile[] = [
      { modelProfileId: 'missing-model', access: 'local', runtime: 'stub', endpointId: 'ollama', model: 'not-installed:70b' },
      { modelProfileId: 'missing-endpoint', access: 'local', runtime: 'stub', endpointId: 'never-configured', model: 'qwen2.5:3b' },
      { modelProfileId: 'no-model', access: 'local', runtime: 'stub', endpointId: 'ollama' },
    ]
    const resolver = resolverFor(profiles, { endpoints })

    const refusals = await Promise.all(profiles.map(async profile => refusalOf(await resolver.resolve(profile.modelProfileId))))

    expect(refusals).toEqual(['model-unavailable', 'unknown-endpoint', 'profile-incomplete'])
  })
})

describe('the resolver as a trust boundary', () => {
  it('refuses a name it does not hold, never resolving it to a default', async () => {
    const resolver = resolverFor([{ modelProfileId: 'daily', access: 'subscription', runtime: 'stub' }])

    expect(refusalOf(await resolver.resolve('anything-else'))).toBe('unknown-profile')
    expect(resolver.list().map(profile => profile.modelProfileId)).toEqual(['daily'])
  })

  it('refuses a runtime outside the local catalog and a mode the runtime cannot serve', async () => {
    const profiles: LocalModelProfile[] = [
      { modelProfileId: 'off-catalog', access: 'subscription', runtime: 'not-in-the-catalog' },
      { modelProfileId: 'wrong-mode', access: 'local', runtime: 'subscription-only', endpointId: 'ollama', model: 'qwen2.5:3b' },
    ]
    const resolver = resolverFor(profiles)

    const refusals = await Promise.all(profiles.map(async profile => refusalOf(await resolver.resolve(profile.modelProfileId))))

    expect(refusals).toEqual(['runtime-unknown', 'access-unsupported'])
  })

  it('refuses rather than launching optimistically before the first probe lands', async () => {
    const profile: LocalModelProfile = { modelProfileId: 'daily', access: 'subscription', runtime: 'stub' }

    const unprobed = await resolverFor([profile], { capabilities: () => null }).resolve('daily')
    const notInstalled = await resolverFor([profile], { capabilities: () => snapshotOf('authenticated', ['subscription-only']) }).resolve('daily')

    expect([refusalOf(unprobed), refusalOf(notInstalled)]).toEqual(['runtime-unavailable', 'runtime-unavailable'])
  })

  it('refuses two configurations claiming one name, rather than letting the last win', () => {
    const daily: LocalModelProfile = { modelProfileId: 'daily', access: 'subscription', runtime: 'stub' }

    // Silently keeping the last would resolve a control-plane-named profile to a binding the
    // operator did not intend, with nothing to say which one it got.
    expect(() => resolverFor([daily, { ...daily, runtime: 'subscription-only' }])).toThrow(/model profile ids must be unique/)
    expect(() => new AccessResolver({
      profiles: [daily],
      runtimes: [...catalog, { ...catalog[0]!, command: '/bin/false' }],
      keys: createMemoryApiKeyStore(),
      endpoints: new LocalEndpointRegistry([]),
      capabilities: () => snapshotOf(),
    })).toThrow(/runtime names must be unique/)
  })

  it('refuses local configuration the wire could never carry', () => {
    expect(() => resolverFor([{ modelProfileId: 'has spaces', access: 'subscription', runtime: 'stub' }])).toThrow(/safe identifier/)
    expect(() => resolverFor([{ modelProfileId: 'daily', access: 'subscription', runtime: 'stub', model: `bad${String.fromCharCode(10)}model` }])).toThrow(/control characters/)
    expect(() => resolverFor([{ modelProfileId: 'daily', access: 'subscription', runtime: 'stub', provider: '1password' }])).toThrow(/provider name/)
  })
})

describe('refusal guidance', () => {
  it('answers for every refusal, in one sentence, carrying nothing local', () => {
    for (const reason of ACCESS_REFUSALS) {
      const guidance = accessRefusalGuidance(reason)

      expect(guidance.length).toBeGreaterThan(20)
      expect(guidance).not.toMatch(/\/|http|sk-/)
    }
  })
})

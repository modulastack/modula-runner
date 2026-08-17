import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  ACCESS_REFUSALS,
  AccessResolver,
  CapabilityMonitor,
  LocalEndpointRegistry,
  accessRefusalGuidance,
  createMemoryApiKeyStore,
  type AccessRefusal,
  type AccessResolution,
  type ApiKeyStore,
  type LaunchPlan,
  type LocalModelProfile,
  type RuntimeSpec,
} from '../../src/index.js'
import {
  apiKeyBody,
  apiKeySecret,
  startEndpointServer,
  temporaryRoot,
  writeStandInRuntime,
  type EndpointServer,
} from './accessSupport.js'
import { permissiveSpawnSeam } from '../spawnSeamSupport.js'

const monitors: CapabilityMonitor[] = []
const servers: EndpointServer[] = []
const temporaryPaths: string[] = []

afterEach(async () => {
  for (const monitor of monitors) monitor.stop()
  await Promise.all(servers.map(server => server.stop()))
  await Promise.all(temporaryPaths.map(path => rm(path, { recursive: true, force: true })))
  monitors.length = 0
  servers.length = 0
  temporaryPaths.length = 0
})

const installedModel = 'llama3.1:8b-instruct-q4_K_M'

type Rig = {
  resolver: AccessResolver
  keys: ApiKeyStore
  endpoint: EndpointServer
  runtimes: RuntimeSpec[]
  missingCommand: string
}

// One machine's worth of local configuration: a runtime that can serve every mode, a
// runtime that cannot serve `local` (Claude Code's shape, per FR-12), a runtime in the
// catalog whose binary is not installed, one stored key, and one configured endpoint.
async function rig(profiles: readonly LocalModelProfile[], options: { authenticated?: boolean } = {}): Promise<Rig> {
  const root = await temporaryRoot('runner-model-access-')
  temporaryPaths.push(root)
  const command = await writeStandInRuntime(root, 'runtime', { authenticated: options.authenticated ?? true })
  const missingCommand = join(root, 'never-installed')
  const endpoint = await startEndpointServer({ models: [installedModel] })
  servers.push(endpoint)
  const probeArgs = { versionArgs: ['--version'], authArgs: ['--auth'] }
  const runtimes: RuntimeSpec[] = [
    { runtime: 'local-capable', command, ...probeArgs, access: ['subscription', 'api-key', 'local'] },
    { runtime: 'subscription-only', command, ...probeArgs, access: ['subscription', 'api-key'] },
    { runtime: 'not-installed', command: missingCommand, ...probeArgs, access: ['subscription'] },
    // Codex's shape: a runtime whose local mode needs an argument the requirement names.
    { runtime: 'oss-capable', command, ...probeArgs, access: ['subscription', 'local'], accessArgs: { local: ['--oss'] } },
    { runtime: 'short-flag', command, ...probeArgs, access: ['local'], modelFlag: '-m' },
    { runtime: 'explicit-key', command, ...probeArgs, access: ['api-key'], keyVariable: 'CUSTOM_PROVIDER_TOKEN' },
  ]
  const endpoints = new LocalEndpointRegistry([
    { endpointId: 'desk-ollama', kind: 'ollama', baseUrl: endpoint.baseUrl },
    { endpointId: 'desk-compatible', kind: 'openai-compatible', baseUrl: endpoint.baseUrl },
  ])
  const capabilities = new CapabilityMonitor({ seam: permissiveSpawnSeam(), runtimes, endpoints })
  monitors.push(capabilities)
  await capabilities.refresh()
  const keys = createMemoryApiKeyStore()
  await keys.put({ label: 'the-only-key', provider: 'acceptance-provider', secret: apiKeySecret })
  const resolver = new AccessResolver({
    profiles,
    runtimes,
    keys,
    endpoints,
    capabilities: () => capabilities.snapshot(),
  })
  return { resolver, keys, endpoint, runtimes, missingCommand }
}

function planOf(resolution: AccessResolution): LaunchPlan {
  if (resolution.status !== 'resolved') throw new Error(`expected a resolved plan, got ${resolution.reason}`)
  return resolution.plan
}

function secretValues(plan: LaunchPlan) {
  return plan.secrets.use(entries => Object.values(entries)).join('\n')
}

const subscriptionProfile: LocalModelProfile = {
  modelProfileId: 'team-subscription',
  access: 'subscription',
  runtime: 'subscription-only',
}

const apiKeyProfile: LocalModelProfile = {
  modelProfileId: 'team-metered',
  access: 'api-key',
  runtime: 'subscription-only',
  provider: 'acceptance-provider',
  keyLabel: 'the-only-key',
}

const localProfile: LocalModelProfile = {
  modelProfileId: 'team-local',
  access: 'local',
  runtime: 'local-capable',
  endpointId: 'desk-ollama',
  model: installedModel,
}

describe('FR-9 tri-modal resolution', () => {
  // FR-9: mode resolution, credential injection and endpoint dialing happen entirely
  // runner-side; the only control-plane-supplied input is the profile's name.
  test('resolves a subscription profile to a launch that carries no credential at all', async () => {
    const { resolver } = await rig([subscriptionProfile])

    const plan = planOf(await resolver.resolve('team-subscription'))

    expect(plan.access).toBe('subscription')
    expect(plan.runtime).toBe('subscription-only')
    expect(plan.modelProfileId).toBe('team-subscription')
    expect(plan.secrets.size).toBe(0)
  })

  // FR-11 and docs/model-access.md "Injection is env-only, and env means env": the key
  // travels in the secret environment, and no argument vector ever carries it.
  test('resolves an api-key profile with the key in the environment and never in argv', async () => {
    const { resolver } = await rig([apiKeyProfile])

    const plan = planOf(await resolver.resolve('team-metered'))

    expect(plan.access).toBe('api-key')
    expect(secretValues(plan)).toContain(apiKeySecret)
    expect(plan.args.join(' ')).not.toContain(apiKeyBody)
    expect(JSON.stringify(plan.env)).not.toContain(apiKeyBody)
    expect(JSON.stringify(plan)).not.toContain(apiKeyBody)
  })

  // docs/model-access.md "Local endpoints": the endpoint URL reaches the CLI through the
  // environment, never argv — it is not a secret, but the reason for the argv rule applies
  // to it verbatim.
  test('resolves a local profile with the endpoint address in the environment, never in argv', async () => {
    const { resolver, endpoint } = await rig([localProfile])

    const plan = planOf(await resolver.resolve('team-local'))

    expect(plan.access).toBe('local')
    expect(secretValues(plan)).toContain(String(endpoint.port))
    expect(plan.args.join(' ')).not.toContain(String(endpoint.port))
    expect(plan.args.join(' ')).not.toContain('http')
    expect(JSON.stringify(plan.env)).not.toContain(String(endpoint.port))
  })

  // docs/model-access.md "What the control plane may do, and may not": resolution reads
  // local configuration and answers; it never writes.
  test('leaves local configuration untouched whether it resolves or refuses', async () => {
    const { resolver, keys } = await rig([apiKeyProfile])
    const before = await keys.list()

    await resolver.resolve('team-metered')
    await resolver.resolve('a-profile-that-does-not-exist')

    expect(resolver.list().map(profile => profile.modelProfileId)).toEqual(['team-metered'])
    expect(await keys.list()).toEqual(before)
  })
})

describe('FR-9 the control plane may name a profile and nothing else', () => {
  // docs/model-access.md: a name this runner does not hold is refused by name — never
  // resolved to a default, never resolved to "the only key we have", and never treated as
  // a request to create one.
  test('refuses a profile it does not hold instead of resolving the only one it has', async () => {
    const { resolver } = await rig([apiKeyProfile])

    const resolution = await resolver.resolve('a-profile-the-operator-never-created')

    expect(resolution).toEqual({ status: 'refused', reason: 'unknown-profile' })
    expect(resolver.list()).toHaveLength(1)
  })

  // docs/model-access.md "Refusals name their reason": an api-key profile whose key is
  // absent is refused by name — not a spawn, not a silence, and not a fall back to
  // subscription.
  test('refuses an api-key profile whose key is absent instead of falling back to subscription', async () => {
    const { resolver } = await rig([{ ...apiKeyProfile, keyLabel: 'a-key-that-was-never-added' }])

    const resolution = await resolver.resolve('team-metered')

    expect(resolution).toEqual({ status: 'refused', reason: 'unknown-key' })
  })

  // FR-12: Claude Code stays subscription/api-key only — a runtime property. A profile
  // asking a runtime for a mode it cannot serve fails closed.
  test('refuses a local profile on a runtime that cannot serve local backends', async () => {
    const { resolver } = await rig([{ ...localProfile, runtime: 'subscription-only' }])

    const resolution = await resolver.resolve('team-local')

    expect(resolution).toEqual({ status: 'refused', reason: 'access-unsupported' })
  })

  // docs/model-access.md "The runtime catalog is the pane-level allowlist": a runtime that
  // is not held locally is not launchable, because the control plane naming a runtime is
  // the control plane naming a command by proxy.
  test('refuses a runtime that is not in the local catalog', async () => {
    const { resolver } = await rig([{ ...subscriptionProfile, runtime: 'something-the-operator-never-allowlisted' }])

    const resolution = await resolver.resolve('team-subscription')

    expect(resolution).toEqual({ status: 'refused', reason: 'runtime-unknown' })
  })

  // docs/model-access.md "Runtimes": absence is how a missing runtime is expressed, so a
  // catalog entry this machine does not actually have refuses rather than spawning.
  test('refuses a catalogued runtime this machine does not have installed', async () => {
    const { resolver } = await rig([{ ...subscriptionProfile, runtime: 'not-installed' }])

    const resolution = await resolver.resolve('team-subscription')

    expect(resolution).toEqual({ status: 'refused', reason: 'runtime-unavailable' })
  })

  // docs/model-access.md "Refusals name their reason": a subscription profile is served by
  // the CLI's own login, so a CLI that reports itself signed out is refused by name.
  test('refuses a subscription profile whose runtime reports itself signed out', async () => {
    const { resolver } = await rig([subscriptionProfile], { authenticated: false })

    const resolution = await resolver.resolve('team-subscription')

    expect(resolution).toEqual({ status: 'refused', reason: 'runtime-unauthenticated' })
  })

  // docs/model-access.md: the control plane may not supply an endpoint address, so a
  // profile naming an endpoint this runner does not hold is refused by name — and refused
  // without dialing anything.
  test('refuses an endpoint it was never configured with, without dialing at all', async () => {
    const { resolver, endpoint } = await rig([{ ...localProfile, endpointId: 'an-endpoint-nobody-configured' }])
    const before = endpoint.requestCount()

    const resolution = await resolver.resolve('team-local')

    expect(resolution).toEqual({ status: 'refused', reason: 'unknown-endpoint' })
    expect(endpoint.requestCount()).toBe(before)
  })

  // docs/model-access.md "Refusals name their reason": a model the endpoint does not hold
  // is its own answer, distinct from an endpoint that is down.
  test('refuses a model the configured endpoint does not have', async () => {
    const { resolver } = await rig([{ ...localProfile, model: 'a-model-nobody-pulled' }])

    const resolution = await resolver.resolve('team-local')

    expect(resolution).toEqual({ status: 'refused', reason: 'model-unavailable' })
  })

  // docs/model-access.md "Refusals name their reason": unknown runtimes, undeclared access
  // modes and incomplete profiles all fail closed. A profile missing the half that names
  // its credential or its address cannot be completed from a default.
  test('refuses an incomplete profile rather than completing it from a default', async () => {
    const { resolver } = await rig([
      { modelProfileId: 'metered-without-key', access: 'api-key', provider: 'acceptance-provider', runtime: 'subscription-only' },
      { modelProfileId: 'local-without-endpoint', access: 'local', runtime: 'local-capable', model: installedModel },
    ])

    expect(await resolver.resolve('metered-without-key')).toEqual({ status: 'refused', reason: 'profile-incomplete' })
    expect(await resolver.resolve('local-without-endpoint')).toEqual({ status: 'refused', reason: 'profile-incomplete' })
  })

  // docs/model-access.md "Provider mismatch fails closed": an api-key profile must name its
  // provider, and absent is `profile-incomplete` rather than "no mismatch is possible" — a
  // check that switches itself off when a field is missing is the permissive default this
  // contract refuses everywhere else.
  test('refuses an api-key profile that never said which vendor it talks to', async () => {
    const { resolver } = await rig([
      { modelProfileId: 'metered-without-provider', access: 'api-key', runtime: 'subscription-only', keyLabel: 'the-only-key' },
    ])

    expect(await resolver.resolve('metered-without-provider')).toEqual({ status: 'refused', reason: 'profile-incomplete' })
  })

  // docs/model-access.md "Provider mismatch fails closed": a key whose own provider differs
  // from the profile's is refused, because sending one vendor's key to another vendor's
  // endpoint is credential disclosure to a third party.
  test('refuses to hand a key to a profile that talks to a different vendor', async () => {
    const { resolver } = await rig([{ ...apiKeyProfile, provider: 'a-different-vendor' }])

    expect(await resolver.resolve('team-metered')).toEqual({ status: 'refused', reason: 'key-provider-mismatch' })
  })

  // docs/model-access.md "Capabilities": null before the first probe completes is a refusal
  // rather than an optimistic launch — "nothing installed" and "did not say" are different
  // facts and only one of them may be launched against.
  test('refuses to launch against a machine that has not answered for itself yet', async () => {
    const root = await temporaryRoot('runner-unprobed-')
    temporaryPaths.push(root)
    const command = await writeStandInRuntime(root, 'runtime')
    const runtimes: RuntimeSpec[] = [
      { runtime: 'subscription-only', command, versionArgs: ['--version'], authArgs: ['--auth'], access: ['subscription'] },
    ]
    const resolver = new AccessResolver({
      profiles: [subscriptionProfile],
      runtimes,
      keys: createMemoryApiKeyStore(),
      endpoints: new LocalEndpointRegistry([]),
      capabilities: () => null,
    })

    const resolution = await resolver.resolve('team-subscription')

    expect(resolution.status).toBe('refused')
  })
})

describe('FR-9 the runtime catalog supplies the arguments', () => {
  // docs/model-access.md "The runtime catalog supplies the arguments": `keyVariable` defaults
  // to `<PROVIDER>_API_KEY`. The fixed suffix is load-bearing rather than cosmetic — a
  // derived name can never collide with `PATH`, `LD_PRELOAD` or anything else that matters,
  // so operator-chosen text cannot become an arbitrary variable.
  test('derives a key variable that operator text can never turn into another variable', async () => {
    const { resolver, keys } = await rig([
      apiKeyProfile,
      { modelProfileId: 'hostile-provider', access: 'api-key', runtime: 'subscription-only', provider: 'ld-preload', keyLabel: 'hostile-key' },
    ])
    await keys.put({ label: 'hostile-key', provider: 'ld-preload', secret: apiKeySecret })

    expect(planOf(await resolver.resolve('team-metered')).secrets.names).toEqual(['ACCEPTANCE_PROVIDER_API_KEY'])
    const hostile = planOf(await resolver.resolve('hostile-provider'))
    expect(hostile.secrets.names).toEqual(['LD_PRELOAD_API_KEY'])
    expect(hostile.secrets.names).not.toContain('LD_PRELOAD')
  })

  // docs/model-access.md: the defaults exist so the common case needs no configuration; the
  // overrides exist so a runtime that disagrees can say so instead of being wrong.
  test('lets a runtime name the variable it actually reads a key from', async () => {
    const { resolver } = await rig([{ ...apiKeyProfile, runtime: 'explicit-key' }])

    expect(planOf(await resolver.resolve('team-metered')).secrets.names).toEqual(['CUSTOM_PROVIDER_TOKEN'])
  })

  // docs/model-access.md: `endpointVariable` defaults by kind — ollama → OLLAMA_HOST,
  // openai-compatible → OPENAI_BASE_URL — because the variable a CLI reads is a property of
  // the CLI, not of the endpoint.
  test('carries a local endpoint address in the variable its kind implies', async () => {
    const { resolver } = await rig([
      localProfile,
      { modelProfileId: 'team-compatible', access: 'local', runtime: 'local-capable', endpointId: 'desk-compatible', model: installedModel },
    ])

    expect(planOf(await resolver.resolve('team-local')).secrets.names).toEqual(['OLLAMA_HOST'])
    expect(planOf(await resolver.resolve('team-compatible')).secrets.names).toEqual(['OPENAI_BASE_URL'])
  })

  // docs/model-access.md: `modelFlag` — how this runtime is told which model to run,
  // defaulting to `--model`. A profile names a model; it does not name a command line.
  test('names the model with the flag the runtime declares', async () => {
    const { resolver } = await rig([
      localProfile,
      { modelProfileId: 'team-short-flag', access: 'local', runtime: 'short-flag', endpointId: 'desk-ollama', model: installedModel },
    ])

    expect(planOf(await resolver.resolve('team-local')).args.join(' ')).toContain(`--model ${installedModel}`)
    expect(planOf(await resolver.resolve('team-short-flag')).args.join(' ')).toContain(`-m ${installedModel}`)
  })

  // FR-12 names Codex `--oss` explicitly, and docs/model-access.md puts that knowledge in
  // the local catalog as `accessArgs` — argument knowledge is exactly what may not cross the
  // wire. The arguments belong to the mode, so the other modes must not carry them.
  test('carries a mode\'s declared arguments only for that mode', async () => {
    const { resolver } = await rig([
      { modelProfileId: 'oss-local', access: 'local', runtime: 'oss-capable', endpointId: 'desk-ollama', model: installedModel },
      { modelProfileId: 'oss-subscription', access: 'subscription', runtime: 'oss-capable' },
    ])

    expect(planOf(await resolver.resolve('oss-local')).args).toContain('--oss')
    expect(planOf(await resolver.resolve('oss-subscription')).args).not.toContain('--oss')
  })

  // The derived name reaches a real process's environment, so it has to be a name a process
  // can carry. There are three honest places to enforce that — refusing the configuration,
  // refusing the resolution, or deriving a name that is always valid — and the obligation is
  // that an unusable variable name never reaches a launch, whichever one is chosen.
  test('never derives an environment variable name a process could not carry', async () => {
    const hostile = ['weird provider!', 'has space', '1leading-digit', 'semi;colon', '']

    for (const provider of hostile) {
      const profile: LocalModelProfile = {
        modelProfileId: 'awkward-provider', access: 'api-key', runtime: 'subscription-only', provider, keyLabel: 'awkward-key',
      }
      const built = await rig([profile]).then(value => value, () => null)
      if (!built) continue
      const stored = await built.keys.put({ label: 'awkward-key', provider, secret: apiKeySecret }).then(() => true, () => false)
      if (!stored) continue

      const resolution = await built.resolver.resolve('awkward-provider')

      if (resolution.status !== 'resolved') continue
      for (const name of resolution.plan.secrets.names) expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
      for (const name of Object.keys(resolution.plan.env)) expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
    }
  })
})

describe('FR-10 detect-and-guide has a shape', () => {
  // The CP-4 adjudication of "detect-and-guide, never bundling": guidance is a refusal code
  // plus a single sentence derived from it, carrying no endpoint, no key material and no
  // path — a test asserting a non-empty human string would be theatre, so this asserts what
  // guidance may not contain as well as that it exists for every reason the resolver has.
  test('answers every refusal with guidance that discloses nothing', () => {
    for (const reason of ACCESS_REFUSALS) {
      const guidance = accessRefusalGuidance(reason as AccessRefusal)
      expect(guidance.length).toBeGreaterThan(0)
      expect(guidance).not.toContain('http')
      expect(guidance).not.toMatch(/(^|\s)\/\S/)
      expect(guidance).not.toContain(apiKeyBody)
    }
  })
})

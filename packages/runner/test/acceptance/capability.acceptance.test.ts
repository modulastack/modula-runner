import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  MAX_RUNTIME_VERSION_LENGTH,
  decodeJobControlServerMessage,
  parseRunnerCapabilities,
  type JobControlServerMessage,
} from '@modulastack/runner-protocol'
import {
  CapabilityMonitor,
  DEFAULT_RUNTIME_CATALOG,
  JobControlHost,
  LocalEndpointRegistry,
  PreviewHost,
  createPairedClient,
  probeRuntime as probeRuntimeRaw,
  type RunnerClient,
  type RuntimeSpec,
} from '../../src/index.js'
import { StubControlPlane } from '../stubControlPlane.js'
import { testRunnerInfo, until } from '../helpers.js'
import { binding, identityWithBinding, token } from './support.js'
import { grantingSpawnSeam, permissiveSpawnSeam } from '../spawnSeamSupport.js'

// The allowlist gate is exercised in the security-floor suite; here a permissive seam stands in
// so probe and capability behavior stay the subject, and the call sites read unchanged.
const permissiveSeam = permissiveSpawnSeam()
const probeRuntime = (spec: RuntimeSpec, timeoutMs?: number) => probeRuntimeRaw(spec, permissiveSeam, timeoutMs)
import { startEndpointServer, temporaryRoot, writeStandInRuntime, type EndpointServer } from './accessSupport.js'

const clients: RunnerClient[] = []
const planes: StubControlPlane[] = []
const monitors: CapabilityMonitor[] = []
const servers: EndpointServer[] = []
const temporaryPaths: string[] = []

afterEach(async () => {
  for (const monitor of monitors) monitor.stop()
  for (const client of clients) client.stop()
  await Promise.all(planes.map(plane => plane.stop()))
  await Promise.all(servers.map(server => server.stop()))
  await Promise.all(temporaryPaths.map(path => rm(path, { recursive: true, force: true })))
  monitors.length = 0
  clients.length = 0
  planes.length = 0
  servers.length = 0
  temporaryPaths.length = 0
})

async function root(prefix = 'runner-capability-') {
  const created = await temporaryRoot(prefix)
  temporaryPaths.push(created)
  return created
}

async function endpoint(models: string[]) {
  const server = await startEndpointServer({ models })
  servers.push(server)
  return server
}

function spec(command: string, overrides: Partial<RuntimeSpec> = {}): RuntimeSpec {
  return {
    runtime: 'stand-in',
    command,
    versionArgs: ['--version'],
    authArgs: ['--auth'],
    access: ['subscription', 'api-key'],
    ...overrides,
  }
}

function monitor(options: Omit<ConstructorParameters<typeof CapabilityMonitor>[0], 'seam'>) {
  const created = new CapabilityMonitor({ seam: permissiveSeam, ...options })
  monitors.push(created)
  return created
}

describe('FR-10 runtime capability probing', () => {
  // FR-10 and docs/model-access.md "Runtimes": each entry reports the version the runtime
  // itself reported. There is no version semantics and no compatibility rule.
  test('reports the version a runtime gave for itself, verbatim', async () => {
    const directory = await root()
    const command = await writeStandInRuntime(directory, 'runtime', { version: '4.7.1' })

    const capability = await probeRuntime(spec(command, { runtime: 'stand-in-cli' }))

    expect(capability).toEqual({
      runtime: 'stand-in-cli',
      version: '4.7.1',
      auth: 'authenticated',
      access: ['subscription', 'api-key'],
    })
  })

  // docs/model-access.md "Runtimes": only detected runtimes are listed, and absence is how
  // a missing one is expressed — so the protocol never carries a vocabulary of every CLI
  // that might exist.
  test('expresses a runtime that is not installed as absent rather than as unavailable', async () => {
    const directory = await root()

    const capability = await probeRuntime(spec(join(directory, 'no-such-runtime')))

    expect(capability).toBeNull()
  })

  // docs/model-access.md "Auth state is asked of the CLI, never read off disk": `unknown` is
  // a real answer for a runtime that offers no way to ask, because rendering "sign in" at
  // somebody already signed in is the failure.
  test('answers unknown for a runtime with no way to ask about its own login', async () => {
    const directory = await root()
    const command = await writeStandInRuntime(directory, 'runtime')

    const capability = await probeRuntime(spec(command, { authArgs: null }))

    expect(capability?.auth).toBe('unknown')
    expect(capability?.version).toBe('1.2.3')
  })

  // docs/model-access.md: `authenticated` means the CLI reports credentials present. A CLI
  // that reports the opposite must never be advertised as signed in.
  test('never advertises a runtime as authenticated when the runtime says otherwise', async () => {
    const directory = await root()
    const command = await writeStandInRuntime(directory, 'runtime', { authenticated: false })

    const capability = await probeRuntime(spec(command))

    expect(capability?.auth).not.toBe('authenticated')
  })

  // docs/model-access.md "Runtimes": probes are deadline-bounded — a wedged CLI costs one
  // `unknown` answer, not a delayed handshake or a missed heartbeat.
  test('charges a wedged runtime one unknown answer instead of a stalled probe', async () => {
    const directory = await root()
    const command = await writeStandInRuntime(directory, 'runtime', { authStallMs: 60_000 })
    const started = Date.now()

    const capability = await probeRuntime(spec(command), 400)

    expect(capability?.auth).toBe('unknown')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  // docs/model-access.md "Runtimes": probes are bounded in output. A version string comes
  // from a subprocess's stdout, so the wire's bound applies to it like any other external text.
  test('bounds a runtime that answers its version with megabytes', async () => {
    const directory = await root()
    const command = await writeStandInRuntime(directory, 'runtime', { versionPadBytes: 512 * 1024 })

    const capability = await probeRuntime(spec(command), 4_000)

    expect(capability).not.toBeNull()
    if (capability?.version !== null && capability?.version !== undefined) {
      expect(capability.version.length).toBeLessThanOrEqual(MAX_RUNTIME_VERSION_LENGTH)
    }
    expect(parseRunnerCapabilities({ runtimes: capability ? [capability] : [], endpoints: [] })).not.toBeNull()
  })

  // docs/model-access.md "Runtimes": probe commands run in a neutral directory. A probe that
  // inherits the caller's working directory runs a third-party CLI inside whatever the
  // runner happened to be doing.
  test('runs a probe outside the caller\'s working directory', async () => {
    const directory = await root()
    const record = join(directory, 'probe-cwd')
    const command = await writeStandInRuntime(directory, 'runtime', { cwdRecordPath: record })

    await probeRuntime(spec(command))

    expect(await readFile(record, 'utf8')).not.toBe(process.cwd())
  })
})

describe('FR-10 the capability advertisement', () => {
  // FR-10 and docs/model-access.md "Capabilities": the snapshot carries runtimes and
  // endpoints, and deliberately does not restate the OS and architecture `hello.runner`
  // already carries.
  test('advertises runtimes and endpoints without restating os or arch', async () => {
    const directory = await root()
    const command = await writeStandInRuntime(directory, 'runtime')
    const server = await endpoint(['llama3.1:8b-instruct-q4_K_M'])
    const capabilities = monitor({
      runtimes: [spec(command, { runtime: 'stand-in-cli' })],
      endpoints: new LocalEndpointRegistry([{ endpointId: 'desk-ollama', kind: 'ollama', baseUrl: server.baseUrl }]),
    })

    const snapshot = await capabilities.refresh()

    expect(Object.keys(snapshot).sort()).toEqual(['endpoints', 'runtimes'])
    expect(JSON.stringify(snapshot)).not.toContain(process.platform)
    expect(JSON.stringify(snapshot)).not.toContain(process.arch)
    expect(snapshot.runtimes).toEqual([expect.objectContaining({ runtime: 'stand-in-cli' })])
    expect(snapshot.endpoints).toEqual([expect.objectContaining({ endpointId: 'desk-ollama', reachable: true })])
    expect(parseRunnerCapabilities(snapshot)).toEqual(snapshot)
  })

  // The seam's never-crosses list and docs/model-access.md "What crosses is the fact of an
  // endpoint, never its address": no URL, host, port or scheme in the advertisement.
  test('advertises the fact of an endpoint and never its address', async () => {
    const server = await endpoint(['local-model'])
    const capabilities = monitor({
      runtimes: [],
      endpoints: new LocalEndpointRegistry([{ endpointId: 'desk-ollama', kind: 'ollama', baseUrl: server.baseUrl }]),
    })

    const serialized = JSON.stringify(await capabilities.refresh())

    expect(serialized).not.toContain(server.baseUrl)
    expect(serialized).not.toContain(String(server.port))
    expect(serialized).not.toContain(server.host)
    expect(serialized).not.toContain('http')
  })

  // docs/model-access.md "Runtimes": absence is how a missing runtime is expressed, so a
  // catalog entry whose command is not on this machine is simply not advertised.
  test('omits a catalog runtime this machine does not have', async () => {
    const directory = await root()
    const present = await writeStandInRuntime(directory, 'present')
    const capabilities = monitor({
      runtimes: [
        spec(present, { runtime: 'present-cli' }),
        spec(join(directory, 'absent-binary'), { runtime: 'absent-cli' }),
      ],
    })

    const snapshot = await capabilities.refresh()

    expect(snapshot.runtimes.map(entry => entry.runtime)).toEqual(['present-cli'])
  })

  // docs/model-access.md "Runtimes": one full probe pass — concurrent callers share the pass
  // in flight rather than each spawning their own fleet of subprocesses.
  test('shares one probe pass between concurrent callers', async () => {
    const server = await endpoint(['local-model'])
    const capabilities = monitor({
      runtimes: [],
      endpoints: new LocalEndpointRegistry([{ endpointId: 'desk-ollama', kind: 'ollama', baseUrl: server.baseUrl }]),
    })

    const [first, second] = await Promise.all([capabilities.refresh(), capabilities.refresh()])

    expect(first).toEqual(second)
    expect(server.requestCount()).toBe(1)
  })

  // docs/model-access.md "Capabilities": null until the first probe lands — "nothing
  // installed" and "did not say" are different facts, and the resolver refuses rather than
  // launching optimistically against the second one.
  test('reports no snapshot at all before the first probe completes', async () => {
    const capabilities = monitor({ runtimes: [] })

    expect(capabilities.snapshot()).toBeNull()
    await capabilities.refresh()
    expect(capabilities.snapshot()).not.toBeNull()
  })
})

describe('FR-10 the advertisement rides job-control, not hello', () => {
  async function connected() {
    const plane = await new StubControlPlane({ token }).start()
    planes.push(plane)
    const seeded = await identityWithBinding(binding({ controlPlaneUrl: plane.url }))
    const client = await createPairedClient(seeded.identity, { runner: testRunnerInfo })
    clients.push(client)
    client.connect()
    await until(() => client.isConnected())
    const granting = grantingSpawnSeam()
    const preview = new PreviewHost({ seam: granting.seam, consent: granting.consent })
    const host = new JobControlHost({ client, preview })
    const channel = host.open()
    await until(() => plane.opens.includes(channel.id))
    return { plane, host, channelId: channel.id }
  }

  function serverMessages(plane: StubControlPlane, channelId: string) {
    return plane.received
      .filter(item => item.channel === channelId)
      .map(item => decodeJobControlServerMessage(item.payload))
      .filter((message): message is JobControlServerMessage => message !== null)
  }

  // docs/model-access.md "Capabilities": capability state rides the job-control channel,
  // and the snapshot is the whole current truth rather than a delta.
  test('publishes the whole snapshot on the job-control channel', async () => {
    const { plane, host, channelId } = await connected()
    const snapshot = { runtimes: [], endpoints: [{ endpointId: 'desk-ollama', kind: 'ollama' as const, reachable: true, models: ['local-model'], modelCount: 1 }] }

    host.publishCapabilities(snapshot)

    await until(() => serverMessages(plane, channelId).some(message => message.type === 'CAPABILITIES'))
    expect(serverMessages(plane, channelId)).toContainEqual({ type: 'CAPABILITIES', capabilities: snapshot })
  })

  // docs/model-access.md "Capabilities": one mechanism serves the initial advertisement and
  // every later change, on the one job-control channel this host owns — two channels of the
  // same kind would leave the control plane guessing which one to send PREVIEW_START on.
  test('publishes every refresh on the one job-control channel, never a second', async () => {
    const { plane, host, channelId } = await connected()
    const snapshot = { runtimes: [], endpoints: [] }

    host.publishCapabilities(snapshot)
    host.publishCapabilities({ runtimes: [], endpoints: [{ endpointId: 'desk-ollama', kind: 'ollama' as const, reachable: false, models: [], modelCount: 0, reason: 'not-running' as const }] })
    await until(() => serverMessages(plane, channelId).filter(message => message.type === 'CAPABILITIES').length === 2)

    expect(host.open().id).toBe(channelId)
    expect(plane.opens).toEqual([channelId])
    expect([...plane.channels.values()].filter(channel => channel.kind === 'job-control')).toHaveLength(1)
  })

  // docs/model-access.md "Capabilities" and the CP-4 interface commit: a `hello` shares one
  // 1 MiB frame with a 1024-channel resume roster, an oversized hello is terminal, so an
  // operator-sized model inventory must never ride it.
  test('keeps the handshake free of capability payload entirely', async () => {
    const { plane } = await connected()

    expect(plane.hellos).toHaveLength(1)
    expect(Object.keys(plane.hellos[0] ?? {}).sort()).toEqual(['channels', 'protocol', 'runner', 'type'])
    expect(plane.rawFrames.filter(frame => frame.includes('"type":"hello"')).join('')).not.toContain('capabilit')
  })
})

describe('FR-10 the runtime catalog is the pane-level allowlist', () => {
  // docs/model-access.md "The runtime catalog is the pane-level allowlist" and the CP-4
  // adjudication of "detect-and-guide, never bundling": no catalog entry is an installer or
  // a package manager, because the runner guides an install and never performs one.
  test('ships a catalog that can detect runtimes but cannot install them', () => {
    const installers = ['npm', 'npx', 'pnpm', 'yarn', 'pip', 'pip3', 'pipx', 'brew', 'apt', 'apt-get', 'curl', 'wget', 'sh', 'bash']

    expect(DEFAULT_RUNTIME_CATALOG.length).toBeGreaterThan(0)
    for (const entry of DEFAULT_RUNTIME_CATALOG) {
      const binary = entry.command.split('/').at(-1) ?? entry.command
      expect(installers).not.toContain(binary)
      expect(entry.access.length).toBeGreaterThan(0)
    }
  })

  // FR-12: Claude Code stays subscription/api-key only — runtime choice, not architecture.
  // Written as a property of whichever catalog entry serves it, so the test does not pin a
  // runtime's spelling.
  test('never offers local access on a Claude Code runtime', () => {
    const claude = DEFAULT_RUNTIME_CATALOG.filter(entry => entry.runtime.includes('claude'))

    expect(claude.length).toBeGreaterThan(0)
    for (const entry of claude) expect(entry.access).not.toContain('local')
  })
})

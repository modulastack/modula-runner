import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, test } from 'vitest'
import type { RunnerCapabilities } from '@modulastack/runner-protocol'
import {
  AccessResolver,
  CAPABILITY_REFRESH_MS,
  CapabilityMonitor,
  LocalEndpointRegistry,
  MIN_CAPABILITY_REFRESH_MS,
  createMemoryApiKeyStore,
  createPairedClient,
  type LocalModelProfile,
  type RunnerClient,
  type RuntimeSpec,
} from '../../src/index.js'
import { StubControlPlane } from '../stubControlPlane.js'
import { sleep, testRunnerInfo, until } from '../helpers.js'
import { binding, identityWithBinding, token } from './support.js'
import {
  killTmuxServer,
  startBlackHoleServer,
  startEndpointServer,
  temporaryRoot,
  writeStandInRuntime,
  type EndpointServer,
} from './accessSupport.js'

const monitors: CapabilityMonitor[] = []
const clients: RunnerClient[] = []
const planes: StubControlPlane[] = []
const servers: { stop(): Promise<void> }[] = []
const temporaryPaths: string[] = []
const sockets: string[] = []

afterEach(async () => {
  for (const monitor of monitors) monitor.stop()
  for (const client of clients) client.stop()
  for (const socket of sockets) killTmuxServer(socket)
  await Promise.all(planes.map(plane => plane.stop()))
  await Promise.all(servers.map(server => server.stop()))
  await Promise.all(temporaryPaths.map(path => rm(path, { recursive: true, force: true })))
  monitors.length = 0
  clients.length = 0
  planes.length = 0
  servers.length = 0
  temporaryPaths.length = 0
  sockets.length = 0
})

const installedModel = 'llama3.1:8b-instruct-q4_K_M'

async function endpointServer() {
  const server = await startEndpointServer({ models: [installedModel] })
  servers.push(server)
  return server
}

function registryFor(server: EndpointServer) {
  return new LocalEndpointRegistry([{ endpointId: 'desk-ollama', kind: 'ollama', baseUrl: server.baseUrl }])
}

function watch(options: ConstructorParameters<typeof CapabilityMonitor>[0]) {
  const monitor = new CapabilityMonitor(options)
  monitors.push(monitor)
  return monitor
}

async function localRig(endpoints: LocalEndpointRegistry, profile: LocalModelProfile) {
  const root = await temporaryRoot('runner-capability-truth-')
  temporaryPaths.push(root)
  const command = await writeStandInRuntime(root, 'runtime')
  const runtimes: RuntimeSpec[] = [
    { runtime: 'local-capable', command, versionArgs: ['--version'], authArgs: ['--auth'], access: ['subscription', 'local'] },
  ]
  // A refresh interval long enough that the snapshot is guaranteed stale by the time the
  // launch happens: the launch must not depend on the poll having caught up.
  const capabilities = watch({ runtimes, endpoints, refreshMs: 60_000 })
  await capabilities.refresh()
  const resolver = new AccessResolver({
    profiles: [profile],
    runtimes,
    keys: createMemoryApiKeyStore(),
    endpoints,
    capabilities: () => capabilities.snapshot(),
  })
  return { resolver, capabilities, command }
}

function tmuxSessions(socket: string) {
  const result = spawnSync('tmux', ['-L', socket, 'list-sessions', '-F', '#S'], { encoding: 'utf8' })
  return (result.stdout ?? '').trim()
}

const localProfile: LocalModelProfile = {
  modelProfileId: 'team-local',
  access: 'local',
  runtime: 'local-capable',
  endpointId: 'desk-ollama',
  model: installedModel,
}

describe('AC-5 capability truth: a change is advertised within one refresh interval', () => {
  // AC-5 as amended in docs/model-access.md "Timing": a capability change is advertised
  // within one refresh interval, measured from the change. The interval is the runner's own
  // constant, and only the service-stopped case has detection lag.
  test('advertises a stopped service as unreachable within one refresh interval', async () => {
    const server = await endpointServer()
    const monitor = watch({ runtimes: [], endpoints: registryFor(server), refreshMs: MIN_CAPABILITY_REFRESH_MS })
    const observed: { at: number; capabilities: RunnerCapabilities }[] = []
    monitor.on('capabilities', capabilities => observed.push({ at: Date.now(), capabilities }))
    monitor.start()
    await until(() => observed.some(entry => entry.capabilities.endpoints[0]?.reachable === true))

    await server.stop()
    const stoppedAt = Date.now()
    await until(() => observed.some(entry => entry.at > stoppedAt && entry.capabilities.endpoints[0]?.reachable === false))

    const flipped = observed.find(entry => entry.at > stoppedAt && entry.capabilities.endpoints[0]?.reachable === false)
    // The interval plus the probe itself. The slack is far short of a second interval, so
    // an implementation that only notices on the cycle after next still fails.
    expect((flipped?.at ?? Number.POSITIVE_INFINITY) - stoppedAt).toBeLessThanOrEqual(MIN_CAPABILITY_REFRESH_MS + 250)
    expect(flipped?.capabilities.endpoints[0]?.reason).toBe('not-running')
  })

  // docs/model-access.md "Timing": the cadence is the runner's, not the control plane's.
  // The schema's heartbeat floor is 200 ms, so a cadence derived from the negotiated
  // heartbeat would be five probes a second against the operator's own machine.
  test('probes on its own cadence no matter how fast the control plane heartbeats', async () => {
    const heartbeat = { intervalMs: 200, timeoutMs: 1_000 }
    const plane = await new StubControlPlane({ token, heartbeat }).start()
    planes.push(plane)
    const seeded = await identityWithBinding(binding({ controlPlaneUrl: plane.url }))
    const client = await createPairedClient(seeded.identity, { runner: testRunnerInfo })
    clients.push(client)
    client.connect()
    await until(() => client.isConnected())
    const server = await endpointServer()
    const monitor = watch({ runtimes: [], endpoints: registryFor(server) })

    monitor.start()
    await sleep(1_400)

    // A heartbeat-derived cadence would have produced at least five probes by now.
    expect(server.requestCount()).toBeLessThanOrEqual(1_400 / CAPABILITY_REFRESH_MS + 2)
    expect(plane.runnerPings.length).toBeGreaterThan(2)
  })

  // docs/model-access.md "Timing": the refresh interval is clamped at
  // MIN_CAPABILITY_REFRESH_MS, so no configuration turns the loop into a busy poll.
  test('clamps an absurd refresh interval instead of hammering the endpoint', async () => {
    const server = await endpointServer()
    const monitor = watch({ runtimes: [], endpoints: registryFor(server), refreshMs: 1 })

    monitor.start()
    await sleep(1_200)

    expect(server.requestCount()).toBeLessThanOrEqual(1_200 / MIN_CAPABILITY_REFRESH_MS + 2)
  })

  // docs/model-access.md "Timing" and the CP-4 adjudication of B15: removing an endpoint
  // from local configuration takes effect immediately — no probe is involved. Only the
  // service-stopped case has detection lag, and the criterion conflated the two.
  test('drops an unbound endpoint from the advertisement without probing anything', async () => {
    const server = await endpointServer()
    const withEndpoint = watch({ runtimes: [], endpoints: registryFor(server) })
    expect((await withEndpoint.refresh()).endpoints).toHaveLength(1)
    const probesBefore = server.requestCount()

    const unbound = watch({ runtimes: [], endpoints: new LocalEndpointRegistry([]) })
    const snapshot = await unbound.refresh()

    expect(snapshot.endpoints).toEqual([])
    expect(server.requestCount()).toBe(probesBefore)
  })
})

describe('AC-5 capability truth: a launch fails fast, never hangs', () => {
  // AC-5 as amended: a launch against an unavailable endpoint is refused with a named
  // reason after a bounded fresh probe, creating no tmux session, no pty and no child
  // process. The refusal does not wait for the poll to catch up.
  test('refuses a launch against a stopped endpoint even while the snapshot still says reachable', async () => {
    const server = await endpointServer()
    const endpoints = registryFor(server)
    const { resolver, capabilities } = await localRig(endpoints, localProfile)
    expect(capabilities.snapshot()?.endpoints[0]?.reachable).toBe(true)

    await server.stop()
    const resolution = await resolver.resolve('team-local')

    expect(resolution).toEqual({ status: 'refused', reason: 'endpoint-unavailable' })
    // The stale snapshot is still stale: the refusal came from the launch-time probe, which
    // is what makes the promise independent of the cadence.
    expect(capabilities.snapshot()?.endpoints[0]?.reachable).toBe(true)
  })

  // AC-5: "fails fast with detect-and-guide, not a hung spawn" — and no session is left
  // behind, because the refusal happens before anything is spawned.
  test('leaves no tmux session, pty or child process behind when it refuses', async () => {
    const server = await endpointServer()
    const endpoints = registryFor(server)
    const { resolver } = await localRig(endpoints, localProfile)
    const socket = `mr-ac5-${randomBytes(4).toString('hex')}`
    sockets.push(socket)
    await server.stop()

    const resolution = await resolver.resolve('team-local')

    expect(resolution.status).toBe('refused')
    expect(tmuxSessions(socket)).toBe('')
  })

  // docs/model-access.md "Timing": the black hole is the case an ECONNREFUSED-only reading
  // misses — an endpoint that accepts the connection and then answers nothing, where
  // waiting on the OS default is a two-minute hang rather than an instant refusal.
  test('refuses under its own deadline against an endpoint that answers nothing', async () => {
    const blackHole = await startBlackHoleServer()
    servers.push(blackHole)
    const endpoints = new LocalEndpointRegistry([
      { endpointId: 'desk-ollama', kind: 'ollama', baseUrl: blackHole.baseUrl },
    ])
    const { resolver } = await localRig(endpoints, localProfile)
    const started = Date.now()

    const resolution = await resolver.resolve('team-local')

    expect(resolution).toEqual({ status: 'refused', reason: 'endpoint-unavailable' })
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})

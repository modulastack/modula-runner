import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  AccessResolver,
  CapabilityMonitor,
  LocalEndpointRegistry,
  TerminalHost,
  createMemoryApiKeyStore,
  createPairedClient,
  type ApiKeyStore,
  type LaunchPlan,
  type LocalModelProfile,
  type RunnerClient,
  type RuntimeSpec,
} from '../../src/index.js'
import { StubControlPlane } from '../stubControlPlane.js'
import { testRunnerInfo, until } from '../helpers.js'
import { binding, identityWithBinding, token } from './support.js'
import { permissiveSpawnSeam } from '../spawnSeamSupport.js'
import {
  allProcessArguments,
  apiKeyBody,
  apiKeyLastFour,
  apiKeySecret,
  captureRunnerOutput,
  killTmuxServer,
  readDump,
  startEndpointServer,
  temporaryRoot,
  writeStandInRuntime,
  type EndpointServer,
  type LaunchDump,
} from './accessSupport.js'

const clients: RunnerClient[] = []
const planes: StubControlPlane[] = []
const hosts: TerminalHost[] = []
const monitors: CapabilityMonitor[] = []
const servers: EndpointServer[] = []
const temporaryPaths: string[] = []
const sockets: string[] = []

afterEach(async () => {
  await Promise.all(hosts.map(host => host.killAll()))
  for (const socket of sockets) killTmuxServer(socket)
  for (const monitor of monitors) monitor.stop()
  for (const client of clients) client.stop()
  await Promise.all(planes.map(plane => plane.stop()))
  await Promise.all(servers.map(server => server.stop()))
  await Promise.all(temporaryPaths.map(path => rm(path, { recursive: true, force: true })))
  hosts.length = 0
  sockets.length = 0
  monitors.length = 0
  clients.length = 0
  planes.length = 0
  servers.length = 0
  temporaryPaths.length = 0
})

const installedModel = 'llama3.1:8b-instruct-q4_K_M'

const profiles: LocalModelProfile[] = [
  { modelProfileId: 'pane-metered', access: 'api-key', runtime: 'metered-runtime', provider: 'acceptance-provider', keyLabel: 'acceptance-key' },
  { modelProfileId: 'pane-local', access: 'local', runtime: 'local-runtime', endpointId: 'desk-ollama', model: installedModel },
  { modelProfileId: 'pane-subscription', access: 'subscription', runtime: 'subscription-runtime' },
]

// AC-2's shape, with the three external backends replaced by things this repository owns:
// stand-in executables that record the environment and argument vector they were launched
// with, and a real local HTTP server answering the documented probe shape. What is being
// verified is the runner's half — resolution, injection, concurrency and secrecy — never
// that a real Claude Code or a real Ollama produced tokens.
async function project() {
  const root = await temporaryRoot('runner-tri-modal-')
  temporaryPaths.push(root)
  const socket = `mr-tri-${randomBytes(4).toString('hex')}`
  sockets.push(socket)
  const dumps = {
    metered: join(root, 'metered.json'),
    local: join(root, 'local.json'),
    subscription: join(root, 'subscription.json'),
  }
  const runtimes: RuntimeSpec[] = [
    await runtime(root, 'metered-runtime', dumps.metered, ['subscription', 'api-key']),
    await runtime(root, 'local-runtime', dumps.local, ['subscription', 'local']),
    await runtime(root, 'subscription-runtime', dumps.subscription, ['subscription']),
  ]
  const endpoint = await startEndpointServer({ models: [installedModel] })
  servers.push(endpoint)
  const endpoints = new LocalEndpointRegistry([{ endpointId: 'desk-ollama', kind: 'ollama', baseUrl: endpoint.baseUrl }])
  const capabilities = new CapabilityMonitor({ seam: permissiveSpawnSeam(), runtimes, endpoints })
  monitors.push(capabilities)
  await capabilities.refresh()
  const keys: ApiKeyStore = createMemoryApiKeyStore()
  await keys.put({ label: 'acceptance-key', provider: 'acceptance-provider', secret: apiKeySecret })
  const resolver = new AccessResolver({ profiles, runtimes, keys, endpoints, capabilities: () => capabilities.snapshot() })

  const plane = await new StubControlPlane({ token }).start()
  planes.push(plane)
  const seeded = await identityWithBinding(binding({ controlPlaneUrl: plane.url }))
  const client = await createPairedClient(seeded.identity, { runner: testRunnerInfo })
  clients.push(client)
  client.connect()
  await until(() => client.isConnected())
  const host = new TerminalHost(client, { seam: permissiveSpawnSeam(), pollMs: 50 })
  hosts.push(host)
  return { root, socket, dumps, resolver, keys, endpoint, plane, host }
}

async function runtime(root: string, name: string, dumpPath: string, access: RuntimeSpec['access']): Promise<RuntimeSpec> {
  const command = await writeStandInRuntime(root, name, { dumpPath })
  return { runtime: name, command, versionArgs: ['--version'], authArgs: ['--auth'], access }
}

async function launch(host: TerminalHost, plan: LaunchPlan, cwd: string, socket: string) {
  return host.launch({
    command: plan.command,
    args: [...plan.args],
    cwd,
    socket,
    env: { ...plan.env },
    secrets: plan.secrets,
  })
}

async function resolvedPlan(resolver: AccessResolver, modelProfileId: string) {
  const resolution = await resolver.resolve(modelProfileId)
  if (resolution.status !== 'resolved') throw new Error(`${modelProfileId} was refused: ${resolution.reason}`)
  return resolution.plan
}

function environmentOf(dump: LaunchDump) {
  return Object.values(dump.env).join('\n')
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function tmuxServerEnvironment(socket: string) {
  const result = spawnSync('tmux', ['-L', socket, 'display-message', '-p', '#{pid}'], { encoding: 'utf8' })
  const pid = Number((result.stdout ?? '').trim())
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8')
  } catch {
    return null
  }
}

describe('AC-2 tri-modal coverage on one project', () => {
  // AC-2: three panes run side by side — one on subscription, one on an API key, one on a
  // local model via a local-capable runtime — on one project, and a sweep finds no key
  // material, token or endpoint secret.
  test('runs subscription, api-key and local panes side by side on one project', async () => {
    const rig = await project()
    const output = captureRunnerOutput()

    try {
      // Deliberately in this order and on one tmux socket: the api-key pane goes first, so a
      // key that leaked into the shared tmux server would be waiting for the two that follow.
      const metered = await launch(rig.host, await resolvedPlan(rig.resolver, 'pane-metered'), rig.root, rig.socket)
      const local = await launch(rig.host, await resolvedPlan(rig.resolver, 'pane-local'), rig.root, rig.socket)
      const subscription = await launch(rig.host, await resolvedPlan(rig.resolver, 'pane-subscription'), rig.root, rig.socket)
      const panes = [metered.channelId, local.channelId, subscription.channelId]
      await until(() => panes.every(channelId => rig.plane.opens.includes(channelId)))

      const dumps = await allDumps(rig.dumps)

      // Side by side: three live processes at the same time, not three in sequence.
      expect(dumps.map(dump => alive(dump.pid))).toEqual([true, true, true])
      expect(new Set(dumps.map(dump => dump.pid)).size).toBe(3)

      // Each mode gets exactly what its access needs, and nothing another mode needed.
      expect(environmentOf(dumps[0] as LaunchDump)).toContain(apiKeySecret)
      expect(environmentOf(dumps[1] as LaunchDump)).toContain(String(rig.endpoint.port))
      expect(environmentOf(dumps[2] as LaunchDump)).not.toContain(apiKeyBody)

      // FR-11 as ruled in docs/model-access.md: the key is scoped to the process it was
      // injected into and nothing else. A tmux server is shared per worktree, so
      // server-level inheritance would hand a provider key to a `local` pane.
      expect(environmentOf(dumps[1] as LaunchDump)).not.toContain(apiKeyBody)
      expect(JSON.stringify(dumps[1])).not.toContain(apiKeyBody)
      expect(JSON.stringify(dumps[2])).not.toContain(apiKeyBody)
      if (process.platform === 'linux') {
        expect(tmuxServerEnvironment(rig.socket) ?? '').not.toContain(apiKeyBody)
      }

      // Trust boundary 2: env-only means no process in the chain carries it in argv — not
      // the CLI, not the shell, not the tmux client, not the tmux server.
      for (const dump of dumps) expect(dump.argv.join(' ')).not.toContain(apiKeyBody)
      const arguments_ = allProcessArguments()
      expect(arguments_).not.toContain(apiKeyBody)
      expect(arguments_).not.toContain(rig.endpoint.baseUrl)
      expect(arguments_).not.toContain(`${rig.endpoint.host}:${rig.endpoint.port}`)

      // AC-2's sweep, over everything this runner wrote to the wire — recorded before
      // decoding, so an undecodable frame counts too. "local-model endpoint URLs" are on
      // the seam's never-crosses list, so the host and the scheme are swept for as well as
      // the whole address.
      const wire = rig.plane.rawFrames.join('\n')
      expect(wire).not.toContain(apiKeyBody)
      expect(wire).not.toContain(apiKeySecret)
      expect(wire).not.toContain(rig.endpoint.baseUrl)
      expect(wire).not.toContain(rig.endpoint.host)
      expect(wire).not.toContain('http')

      // The CP-4 adjudication of A13 extends the sweep to the runner's own output: a key in
      // a local log is the same disclosure class and the more likely bug.
      expect(output.text()).not.toContain(apiKeyBody)
    } finally {
      output.restore()
    }
  })

  // docs/model-access.md "The fingerprint is the literal last four characters": the only
  // key-derived value permitted to leave this machine, and the exemption is exactly four
  // characters wide — so the sweep looks for the key and for the key minus its last four.
  test('keeps every character of a key off the wire except the four the contract exempts', async () => {
    const rig = await project()

    await launch(rig.host, await resolvedPlan(rig.resolver, 'pane-metered'), rig.root, rig.socket)
    await until(async () => Boolean(await readDump(rig.dumps.metered).catch(() => null)))

    const wire = rig.plane.rawFrames.join('\n')
    expect(wire).not.toContain(apiKeyBody)
    expect(wire).not.toContain(apiKeySecret)
    const record = await rig.keys.get('acceptance-key')
    expect(record?.lastFour).toBe(apiKeyLastFour)
  })

  // docs/model-access.md "A running pane keeps working after its key is removed or
  // rotated": the value is in that process's own environment and the runner cannot reach
  // in. A documented limitation, asserted so it stays a decision rather than a discovery.
  test('leaves a running pane working after its key is removed', async () => {
    const rig = await project()
    await launch(rig.host, await resolvedPlan(rig.resolver, 'pane-metered'), rig.root, rig.socket)
    await until(async () => Boolean(await readDump(rig.dumps.metered).catch(() => null)))
    const before = await readDump(rig.dumps.metered)

    await rig.keys.remove('acceptance-key')

    expect(alive(before.pid)).toBe(true)
    expect(environmentOf(before)).toContain(apiKeySecret)
    // And the next launch is refused, because the key is gone from the store.
    expect(await rig.resolver.resolve('pane-metered')).toEqual({ status: 'refused', reason: 'unknown-key' })
  })
})

async function allDumps(paths: { metered: string; local: string; subscription: string }) {
  await until(async () => {
    for (const path of [paths.metered, paths.local, paths.subscription]) {
      const dump = await readDump(path).catch(() => null)
      if (!dump) return false
    }
    return true
  }, 10_000)
  return Promise.all([readDump(paths.metered), readDump(paths.local), readDump(paths.subscription)])
}

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decodeJobControlServerMessage,
  jobControlPayload,
  type JobControlClientMessage,
  type JobControlServerMessage,
} from '@modulastack/runner-protocol'
import { afterEach, describe, expect, test } from 'vitest'
import {
  createPairedClient,
  JobControlHost,
  PresenceTracker,
  PreviewHost,
  type PreviewRecipe,
  type RunnerClient,
} from '../../src/index.js'
import { StubControlPlane } from '../stubControlPlane.js'
import { sleep, testRunnerInfo, until } from '../helpers.js'
import { binding, identityWithBinding, token } from './support.js'

const clients: RunnerClient[] = []
const planes: StubControlPlane[] = []
const previews: PreviewHost[] = []
const trackers: PresenceTracker[] = []
const temporaryPaths: string[] = []

afterEach(async () => {
  for (const tracker of trackers) tracker.stop()
  await Promise.all(previews.map(preview => preview.stopAll()))
  for (const client of clients) client.stop()
  await Promise.all(planes.map(plane => plane.stop()))
  await Promise.all(temporaryPaths.map(path => rm(path, { recursive: true, force: true })))
  clients.length = 0
  planes.length = 0
  previews.length = 0
  trackers.length = 0
  temporaryPaths.length = 0
})

type Harness = {
  client: RunnerClient
  plane: StubControlPlane
  preview: PreviewHost
  control: JobControlHost
  channelId: string
  root: string
  spawnCountPath: string
}

async function harness(presence?: PresenceTracker): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'runner-job-control-'))
  temporaryPaths.push(root)
  const fixtures = await previewRecipes(root)
  const preview = new PreviewHost({
    allowlist: { recipes: fixtures.recipes, grantedPaths: [root] },
    readyTimeoutMs: 4_000,
  })
  previews.push(preview)
  const plane = await new StubControlPlane({ token }).start()
  planes.push(plane)
  const seeded = await identityWithBinding(binding({ controlPlaneUrl: plane.url }))
  const client = await createPairedClient(seeded.identity, { runner: testRunnerInfo })
  clients.push(client)
  client.connect()
  await until(() => client.isConnected())
  const control = new JobControlHost({ client, preview, ...(presence ? { presence } : {}) })
  const channel = control.open()
  await until(() => plane.opens.includes(channel.id))
  return { client, plane, preview, control, channelId: channel.id, root, spawnCountPath: fixtures.spawnCountPath }
}

function serverMessages(value: Harness) {
  return value.plane.received
    .filter(item => item.channel === value.channelId)
    .map(item => decodeJobControlServerMessage(item.payload))
    .filter((message): message is JobControlServerMessage => message !== null)
}

async function request(value: Harness, requestMessage: JobControlClientMessage) {
  const before = serverMessages(value).length
  value.plane.sendToRunner(value.channelId, jobControlPayload(requestMessage))
  await until(() => serverMessages(value).slice(before).some(message => answers(message, requestMessage)))
  return serverMessages(value).slice(before).filter(message => answers(message, requestMessage))
}

function answers(message: JobControlServerMessage, requestMessage: JobControlClientMessage) {
  if (message.type === 'REFUSED') return message.requestId === requestMessage.previewId
  return message.previewId === requestMessage.previewId
}

async function previewScript(root: string, host: string) {
  const path = join(root, `${host.replaceAll('.', '-')}.mjs`)
  await writeFile(path, `
import { createServer } from 'node:http'
const server = createServer((_request, response) => response.end('ready'))
server.listen(0, ${JSON.stringify(host)})
process.on('SIGTERM', () => server.close(() => process.exit(0)))
`)
  return path
}

async function previewRecipes(root: string) {
  const local = await previewScript(root, '127.0.0.1')
  const exposed = await previewScript(root, '0.0.0.0')
  const counted = join(root, 'counted.mjs')
  const spawnCountPath = join(root, 'spawn-count')
  await writeFile(counted, countedServerSource())
  const recipes: Record<string, PreviewRecipe> = {
    app: { command: process.execPath, args: [local] },
    exposed: { command: process.execPath, args: [exposed] },
    counted: { command: process.execPath, args: [counted, spawnCountPath] },
    missing: { command: join(root, 'missing-preview-command'), args: [] },
  }
  return { recipes, spawnCountPath }
}

function countedServerSource() {
  return `
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
appendFileSync(process.argv[2], 'spawn\\n')
const server = createServer((_request, response) => response.end('ready'))
server.listen(0, '127.0.0.1')
process.on('SIGTERM', () => server.close(() => process.exit(0)))
`
}

function startMessage(previewId: string, recipe: string, cwd: string): JobControlClientMessage {
  return { type: 'PREVIEW_START', previewId, recipe, cwd }
}

describe('FR-7 and FR-8 job-control dispatch', () => {
  // SCHEMA "Refusals are answers": an offline request is refused once and never held for reconnect.
  test('refuses paused work immediately without starting or retrying it later', async () => {
    const plane = await new StubControlPlane({ token }).start()
    planes.push(plane)
    const pausedIdentity = await identityWithBinding(binding({ controlPlaneUrl: plane.url }))
    const pausedClient = await createPairedClient(pausedIdentity.identity, { runner: testRunnerInfo })
    const presence = new PresenceTracker({ client: pausedClient })
    clients.push(pausedClient)
    trackers.push(presence)
    expect(presence.canAcceptWork()).toBe(false)
    const value = await harness(presence)

    const messages = await request(value, startMessage('paused-preview', 'app', value.root))
    expect(messages).toContainEqual({ type: 'REFUSED', requestId: 'paused-preview', reason: 'runner-paused' })
    expect(value.preview.list()).toEqual([])

    pausedClient.connect()
    await until(() => presence.canAcceptWork())
    await sleep(100)
    expect(value.preview.list()).toEqual([])
    expect(serverMessages(value).filter(message => message.type === 'REFUSED')).toHaveLength(1)
  })

  // SCHEMA "Refusals are answers": every locally rejected preview start produces its named wire refusal.
  test('maps every preview-start failure to a visible refusal', async () => {
    const value = await harness()
    const outside = await mkdtemp(join(tmpdir(), 'runner-job-control-outside-'))
    temporaryPaths.push(outside)
    await expectRefusal(value, startMessage('not-allowed', 'unknown-recipe', value.root), 'not-allowlisted')
    expect(value.preview.list()).toEqual([])
    await expectRefusal(value, startMessage('outside', 'app', outside), 'path-not-granted')
    await expectRefusal(value, startMessage('missing', 'missing', value.root), 'spawn-failed')
    await expectRefusal(value, startMessage('exposed', 'exposed', value.root), 'non-loopback-bind')

    const ready = await request(value, startMessage('duplicate', 'app', value.root))
    expect(ready).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'PREVIEW_READY', previewId: 'duplicate' }),
    ]))
    await expectRefusal(value, startMessage('duplicate', 'app', value.root), 'already-running')
  })

  // SCHEMA "Preview lifecycle": adjacent requests reserve one id synchronously and spawn exactly once.
  test('spawns exactly once for two adjacent starts with the same preview id', async () => {
    const value = await harness()
    const message = startMessage('adjacent-preview', 'counted', value.root)
    const before = serverMessages(value).length

    value.plane.sendToRunner(value.channelId, jobControlPayload(message))
    value.plane.sendToRunner(value.channelId, jobControlPayload(message))
    await until(() => serverMessages(value).slice(before).filter(item => answers(item, message)).length >= 2)
    const responses = serverMessages(value).slice(before).filter(item => answers(item, message))

    expect(responses.filter(item => item.type === 'PREVIEW_READY')).toHaveLength(1)
    expect(responses).toContainEqual({
      type: 'REFUSED', requestId: 'adjacent-preview', reason: 'already-running',
    })
    expect((await readFile(value.spawnCountPath, 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  // SCHEMA "Refusals are answers": stopping a preview this runner does not hold is answered explicitly.
  test('refuses an unknown preview stop instead of dropping the request', async () => {
    const value = await harness()

    const messages = await request(value, { type: 'PREVIEW_STOP', previewId: 'unknown-preview' })

    expect(messages).toContainEqual({
      type: 'REFUSED', requestId: 'unknown-preview', reason: 'unknown-preview',
    })
  })

  // SCHEMA "Job-control channel payloads": readiness and process exit both cross the same channel.
  test('reports the discovered port and later process exit', async () => {
    const value = await harness()
    const ready = await request(value, startMessage('lifecycle', 'app', value.root))
    expect(ready).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'PREVIEW_READY', previewId: 'lifecycle', port: expect.any(Number) }),
    ]))

    const stopped = await request(value, { type: 'PREVIEW_STOP', previewId: 'lifecycle' })

    expect(stopped).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'PREVIEW_EXIT', previewId: 'lifecycle' }),
    ]))
  })

  // SCHEMA "Channels": opening the job-control dispatcher repeatedly does not create competing channels.
  test('opens exactly one idempotent job-control channel', async () => {
    const value = await harness()
    const first = value.control.open()
    const second = value.control.open()

    expect(second).toBe(first)
    expect(value.plane.opens.filter(id => id === value.channelId)).toHaveLength(1)
  })
})

async function expectRefusal(value: Harness, message: JobControlClientMessage, reason: string) {
  const messages = await request(value, message)
  expect(messages).toContainEqual({ type: 'REFUSED', requestId: message.previewId, reason })
}

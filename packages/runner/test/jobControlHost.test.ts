import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeJobControlServerMessage, jobControlPayload, type JobControlServerMessage, type RunnerCapabilities } from '@modulastack/runner-protocol'
import { JobControlHost, PreviewHost, RunnerClient } from '../src/index.js'
import { StubControlPlane } from './stubControlPlane.js'
import { sleep, testRunnerInfo, until } from './helpers.js'

// Not a credential: a fixture value the in-process stub control plane compares against
// itself. It authenticates nothing outside this test file.
const STUB_TOKEN = 'stub-control-plane-fixture'


const previews: PreviewHost[] = []
const clients: RunnerClient[] = []
const planes: StubControlPlane[] = []
const paths: string[] = []

afterEach(async () => {
  await Promise.all(previews.map(preview => preview.stopAll()))
  for (const client of clients) client.stop()
  await Promise.all(planes.map(plane => plane.stop()))
  await Promise.all(paths.map(target => rm(target, { recursive: true, force: true })))
  previews.length = 0
  clients.length = 0
  planes.length = 0
  paths.length = 0
})

async function lane(capabilities?: () => RunnerCapabilities | null) {
  const root = await mkdtemp(join(tmpdir(), 'runner-job-control-'))
  paths.push(root)
  const script = join(root, 'server.mjs')
  await writeFile(script, "import { createServer } from 'node:http'\ncreateServer((_q, s) => s.end('ok')).listen(0, '127.0.0.1')\n")
  const plane = await new StubControlPlane({ token: STUB_TOKEN }).start()
  planes.push(plane)
  const client = new RunnerClient({ url: plane.url, token: STUB_TOKEN, runner: testRunnerInfo, backoff: { baseMs: 20, capMs: 50 } })
  clients.push(client)
  const preview = new PreviewHost({
    allowlist: { recipes: { docs: { command: process.execPath, args: [script] } }, grantedPaths: [root] },
    readyTimeoutMs: 5_000,
  })
  previews.push(preview)
  const host = new JobControlHost({ client, preview, ...(capabilities ? { capabilities } : {}) })
  client.connect()
  await until(() => client.isConnected())
  const channel = host.open()
  await until(() => plane.opens.includes(channel.id))
  return { plane, channel, host, script, root }
}

const CAPABILITIES: RunnerCapabilities = {
  runtimes: [{ runtime: 'claude', version: '2.1.219', auth: 'authenticated', access: ['subscription', 'api-key'] }],
  endpoints: [{ endpointId: 'ollama', kind: 'ollama', reachable: true, models: ['qwen2.5:3b'], modelCount: 1 }],
}

function messages(plane: StubControlPlane, channel: string): JobControlServerMessage[] {
  return plane.received
    .filter(item => item.channel === channel)
    .map(item => decodeJobControlServerMessage(item.payload))
    .filter((message): message is JobControlServerMessage => message !== null)
}

describe('job-control host', () => {
  it('reports the port a preview actually bound', async () => {
    const { plane, channel, script, root } = await lane()

    plane.sendToRunner(channel.id, jobControlPayload({
      type: 'PREVIEW_START', previewId: 'docs-preview', recipe: 'docs', cwd: root,
    }))

    await until(() => messages(plane, channel.id).some(message => message.type === 'PREVIEW_READY'))
    const ready = messages(plane, channel.id).find(message => message.type === 'PREVIEW_READY')
    expect(ready).toEqual({ type: 'PREVIEW_READY', previewId: 'docs-preview', port: expect.any(Number) })
    if (ready?.type !== 'PREVIEW_READY') throw new Error('no readiness reported')
    expect(await (await fetch(`http://127.0.0.1:${ready.port}`)).text()).toBe('ok')
  })

  it('answers a refused start with a named reason instead of silence', async () => {
    const { plane, channel, root } = await lane()

    plane.sendToRunner(channel.id, jobControlPayload({
      type: 'PREVIEW_START', previewId: 'blocked-preview', recipe: 'not-on-the-allowlist', cwd: root,
    }))

    await until(() => messages(plane, channel.id).length > 0)
    expect(messages(plane, channel.id)).toEqual([
      { type: 'REFUSED', requestId: 'blocked-preview', reason: 'not-allowlisted' },
    ])
  })

  it('refuses a stop for a preview it does not hold', async () => {
    const { plane, channel } = await lane()

    plane.sendToRunner(channel.id, jobControlPayload({ type: 'PREVIEW_STOP', previewId: 'never-started' }))

    await until(() => messages(plane, channel.id).length > 0)
    expect(messages(plane, channel.id)).toEqual([
      { type: 'REFUSED', requestId: 'never-started', reason: 'unknown-preview' },
    ])
  })

  it('publishes the whole capability snapshot on the channel it already owns', async () => {
    const { plane, channel, host } = await lane()

    host.publishCapabilities(CAPABILITIES)

    await until(() => messages(plane, channel.id).length > 0)
    // Whole, never a delta: a peer that missed an update must not be left reconstructing
    // state from a partial history, which is also what makes a replayed duplicate harmless.
    expect(messages(plane, channel.id)).toEqual([{ type: 'CAPABILITIES', capabilities: CAPABILITIES }])
    expect(plane.opens).toHaveLength(1)
  })

  it('advertises on open, because that is where "at connect" now lives', async () => {
    const { plane, channel, host } = await lane(() => CAPABILITIES)

    await until(() => messages(plane, channel.id).length > 0)

    expect(messages(plane, channel.id)).toEqual([{ type: 'CAPABILITIES', capabilities: CAPABILITIES }])
    // Asking for the handle again opens nothing, so it advertises nothing.
    host.open()
    await sleep(50)
    expect(messages(plane, channel.id)).toHaveLength(1)
  })

  it('advertises again on the channel it reopens after an expiry', async () => {
    const { plane, channel } = await lane(() => CAPABILITIES)
    await until(() => messages(plane, channel.id).length > 0)

    // Expiry as a control plane actually produces it: the resume presents an attach token
    // it no longer recognises, so the channel comes back expired rather than resumed.
    const known = plane.channels.get(channel.id)
    if (!known) throw new Error('the stub never registered the channel')
    known.attachToken = 'no-longer-the-token-0123456789ab'
    plane.dropConnections()

    await until(() => plane.opens.length === 2)
    const reopened = plane.opens[1] ?? ''
    // The silent path: the monitor speaks only on change, so without this the peer would
    // hold no snapshot at all until something on the machine happened to change.
    await until(() => messages(plane, reopened).length > 0)
    expect(messages(plane, reopened)).toEqual([{ type: 'CAPABILITIES', capabilities: CAPABILITIES }])
  })

  it('says nothing when the first probe has not landed, and survives a source that throws', async () => {
    const silent = await lane(() => null)
    const broken = await lane(() => {
      throw new Error('the probe pass exploded')
    })

    await sleep(50)
    expect(messages(silent.plane, silent.channel.id)).toEqual([])
    // The channel previews depend on is still there: an advertisement that cannot be made
    // must not take it down.
    broken.plane.sendToRunner(broken.channel.id, jobControlPayload({
      type: 'PREVIEW_START', previewId: 'still-answering', recipe: 'not-on-the-allowlist', cwd: broken.root,
    }))
    await until(() => messages(broken.plane, broken.channel.id).length > 0)
    expect(messages(broken.plane, broken.channel.id)).toEqual([
      { type: 'REFUSED', requestId: 'still-answering', reason: 'not-allowlisted' },
    ])
  })

  it('drops a snapshot it has no channel for rather than queueing a stale one', async () => {
    const { plane, channel, host } = await lane()

    host.close('done')
    host.publishCapabilities(CAPABILITIES)

    await sleep(50)
    expect(messages(plane, channel.id)).toEqual([])
  })

  it('reports a preview exit so a stopped server is not left looking live', async () => {
    const { plane, channel, script, root } = await lane()
    plane.sendToRunner(channel.id, jobControlPayload({
      type: 'PREVIEW_START', previewId: 'ending-preview', recipe: 'docs', cwd: root,
    }))
    await until(() => messages(plane, channel.id).some(message => message.type === 'PREVIEW_READY'))

    plane.sendToRunner(channel.id, jobControlPayload({ type: 'PREVIEW_STOP', previewId: 'ending-preview' }))

    await until(() => messages(plane, channel.id).some(message => message.type === 'PREVIEW_EXIT'))
    expect(messages(plane, channel.id).some(message => message.type === 'REFUSED')).toBe(false)
  })
})

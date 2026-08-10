import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeJobControlServerMessage, jobControlPayload, type JobControlServerMessage } from '@modulastack/runner-protocol'
import { JobControlHost, PreviewHost, RunnerClient } from '../src/index.js'
import { StubControlPlane } from './stubControlPlane.js'
import { testRunnerInfo, until } from './helpers.js'

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

async function lane() {
  const root = await mkdtemp(join(tmpdir(), 'runner-job-control-'))
  paths.push(root)
  const script = join(root, 'server.mjs')
  await writeFile(script, "import { createServer } from 'node:http'\ncreateServer((_q, s) => s.end('ok')).listen(0, '127.0.0.1')\n")
  const plane = await new StubControlPlane({ token: STUB_TOKEN }).start()
  planes.push(plane)
  const client = new RunnerClient({ url: plane.url, token: STUB_TOKEN, runner: testRunnerInfo })
  clients.push(client)
  const preview = new PreviewHost({
    allowlist: { recipes: { docs: { command: process.execPath, args: [script] } }, grantedPaths: [root] },
    readyTimeoutMs: 5_000,
  })
  previews.push(preview)
  const host = new JobControlHost({ client, preview })
  client.connect()
  await until(() => client.isConnected())
  const channel = host.open()
  await until(() => plane.opens.includes(channel.id))
  return { plane, channel, script, root }
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

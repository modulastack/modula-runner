import { createHash } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  PROTOCOL_VERSION,
  decodeFrame,
  decodeTerminalServerMessage,
  encodeFrame,
  type Frame,
} from '@modulastack/runner-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AccessResolver,
  LocalEndpointRegistry,
  RunnerClient,
  RunnerIdentity,
  TerminalHost,
  createGrants,
  createMemoryApiKeyStore,
  createMemoryGrantStore,
  createMemoryPairingStore,
  createSpawnSeam,
  type AuditRecord,
  type CommandPolicy,
  type RuntimeSpec,
} from '../src/index.js'
import { StubControlPlane } from './stubControlPlane.js'
import { recordingAudit } from './spawnSeamSupport.js'

const directories: string[] = []
const clients: RunnerClient[] = []
const controlPlanes: StubControlPlane[] = []
const servers: Server[] = []

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'runner-credential-acceptance-'))
  directories.push(directory)
  return directory
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const started = Date.now()
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.stop()
  await Promise.all(controlPlanes.splice(0).map(controlPlane => controlPlane.stop().catch(() => undefined)))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function productionSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return productionSources(path)
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : []
  }))
  return nested.flat()
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function runnerInfo() {
  return { name: 'credential-acceptance', version: '1.0.0', os: process.platform, arch: process.arch }
}

describe('CP-5 IC-4 credential boundaries', () => {
  it('AS-24 constructs no Claude or Codex auth-store path in production source or the bundled runner', async () => {
    const sourcePaths = await productionSources('packages/runner/src')
    const sources = (await Promise.all(sourcePaths.map(path => readFile(path, 'utf8')))).map(withoutComments).join('\n')
    const bundle = await build({
      entryPoints: ['packages/runner/src/index.ts'],
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      write: false,
      legalComments: 'none',
      minifyWhitespace: true,
    })
    const production = `${sources}\n${bundle.outputFiles.map(file => file.text).join('\n')}`
    expect(production).not.toMatch(/(?:^|[\\/])\.claude(?:[\\/]|\b)/i)
    expect(production).not.toMatch(/(?:^|[\\/])\.codex(?:[\\/]|\b)/i)
  })

  it('AS-28 confines a paired runner token to WebSocket upgrade Authorization headers', async () => {
    const token = 'runner-token-canary-7f63aa6d'
    const requests: { url: string; headers: IncomingHttpHeaders; body: string }[] = []
    const upgrades: { url: string; headers: IncomingHttpHeaders }[] = []
    const frames: string[] = []
    const diagnostics: unknown[] = []
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => {
        body += String(chunk)
      })
      request.on('end', () => {
        requests.push({ url: request.url ?? '', headers: request.headers, body })
        if (request.url === '/api/runner/v1/pair') {
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ runnerId: 'credential-runner', token }))
          return
        }
        if (request.url === '/api/runner/v1/pair/confirm') {
          response.statusCode = 204
          response.end()
          return
        }
        response.statusCode = 404
        response.end()
      })
    })
    servers.push(server)
    const wss = new WebSocketServer({ noServer: true })
    const sockets = new Set<WebSocket>()
    server.on('upgrade', (request, socket, head) => {
      upgrades.push({ url: request.url ?? '', headers: request.headers })
      wss.handleUpgrade(request, socket, head, ws => {
        sockets.add(ws)
        ws.on('close', () => sockets.delete(ws))
        ws.on('message', raw => {
          const text = String(raw)
          frames.push(text)
          const frame = decodeFrame(text)
          if (frame?.type !== 'hello') return
          ws.send(encodeFrame({
            type: 'welcome',
            protocol: PROTOCOL_VERSION,
            heartbeat: { intervalMs: 200, timeoutMs: 1_000 },
            channels: frame.channels.map(channel => ({ id: channel.id, status: 'resumed', receivedSeq: channel.sentSeq })),
          }))
          if (upgrades.length === 1) setTimeout(() => ws.terminate(), 20)
        })
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('capture server did not bind')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const identity = new RunnerIdentity(createMemoryPairingStore())
    const binding = await identity.pair({ controlPlaneUrl: baseUrl, code: 'pair-code', runner: runnerInfo() })
    const client = new RunnerClient({
      url: `ws://127.0.0.1:${address.port}`,
      token: binding.token,
      runner: runnerInfo(),
      backoff: { baseMs: 10, capMs: 10, random: () => 0 },
    })
    clients.push(client)
    for (const event of ['connected', 'reconnecting', 'offline', 'stopped', 'protocol-error', 'failed'] as const) {
      client.on(event, detail => diagnostics.push({ event, detail }))
    }
    client.connect()
    await waitUntil(() => upgrades.length >= 2 && client.isConnected()).catch(() => {
      throw new Error(`reconnect capture failed: ${JSON.stringify({ upgrades: upgrades.length, frames, diagnostics, connected: client.isConnected() })}`)
    })
    const channel = client.openChannel('job-control')
    channel.send({ codec: 'json', body: { type: 'representative-job' } })
    await waitUntil(() => frames.some(raw => decodeFrame(raw)?.type === 'data'))
    channel.close('done')
    client.stop()
    for (const socket of sockets) socket.terminate()
    wss.close()

    const auditRecords: AuditRecord[] = [{
      kind: 'refused',
      requestId: 'representative-job',
      spawnKind: 'pane',
      executable: null,
      recipeId: null,
      cwd: null,
      reason: 'runner-paused',
      at: new Date(0).toISOString(),
    }]
    expect(upgrades.length).toBeGreaterThanOrEqual(2)
    for (const upgrade of upgrades) expect(upgrade.headers.authorization).toBe(`Bearer ${token}`)
    expect(frames.join('\n')).not.toContain(token)
    expect(JSON.stringify(auditRecords)).not.toContain(token)
    expect(JSON.stringify(diagnostics)).not.toContain(token)
    expect(JSON.stringify(requests)).not.toContain(token)
    const confirmation = requests.find(request => request.url === '/api/runner/v1/pair/confirm')
    expect(confirmation?.headers.authorization).toBeUndefined()
    expect(JSON.parse(confirmation?.body ?? '{}')).toEqual({
      runnerId: 'credential-runner',
      tokenProof: createHash('sha256').update(token).digest('hex'),
    })
    expect(() => new RunnerClient({ url: `ws://127.0.0.1:${address.port}`, token: `${token}\nsmuggled`, runner: runnerInfo() })).toThrow()
  }, 15_000)

  it('AS-29 keeps model credentials and local endpoints env-only and out of runner-generated frames', async () => {
    const directory = await workspace()
    const apiKey = 'sk-model-canary-0123456789abcdef'
    const endpointServer = createServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ data: [{ id: 'canary-model' }] }))
    })
    servers.push(endpointServer)
    await new Promise<void>(resolve => endpointServer.listen(0, '127.0.0.1', resolve))
    const endpointAddress = endpointServer.address()
    if (!endpointAddress || typeof endpointAddress === 'string') throw new Error('endpoint server did not bind')
    const endpoint = `http://127.0.0.1:${endpointAddress.port}`
    const keys = createMemoryApiKeyStore()
    await keys.put({ label: 'canary-key', provider: 'canary-provider', secret: apiKey })
    const captureScript = [
      "const fs = require('node:fs')",
      "const target = process.argv.find(value => value.endsWith('.json'))",
      "fs.writeFileSync(target, JSON.stringify({ argv: process.argv, apiKey: process.env.CANARY_API_KEY, endpoint: process.env.CANARY_ENDPOINT }))",
    ].join(';')
    const apiCapture = join(directory, 'api-capture.json')
    const localCapture = join(directory, 'local-capture.json')
    const runtime: RuntimeSpec = {
      runtime: 'fixture-runtime',
      command: process.execPath,
      versionArgs: ['--version'],
      authArgs: null,
      access: ['api-key', 'local'],
      keyVariable: 'CANARY_API_KEY',
      endpointVariable: 'CANARY_ENDPOINT',
      accessArgs: {
        'api-key': ['-e', captureScript, apiCapture],
        local: ['-e', captureScript, localCapture],
      },
    }
    const resolver = new AccessResolver({
      profiles: [
        { modelProfileId: 'api-profile', access: 'api-key', runtime: runtime.runtime, provider: 'canary-provider', keyLabel: 'canary-key' },
        { modelProfileId: 'local-profile', access: 'local', runtime: runtime.runtime, endpointId: 'canary-endpoint', model: 'canary-model' },
      ],
      runtimes: [runtime],
      keys,
      endpoints: new LocalEndpointRegistry([{ endpointId: 'canary-endpoint', kind: 'openai-compatible', baseUrl: endpoint }]),
      capabilities: () => ({
        runtimes: [{ runtime: runtime.runtime, version: '1.0.0', auth: 'authenticated', access: ['api-key', 'local'] }],
        endpoints: [],
      }),
    })
    const apiResolution = await resolver.resolve('api-profile')
    const localResolution = await resolver.resolve('local-profile')
    expect(apiResolution.status).toBe('resolved')
    expect(localResolution.status).toBe('resolved')
    if (apiResolution.status !== 'resolved' || localResolution.status !== 'resolved') throw new Error('model profiles did not resolve')

    const audit = recordingAudit()
    const commandPolicy: CommandPolicy = {
      allowsExecutable: executable => executable === process.execPath || executable === 'tmux',
      recipe: () => null,
      executables: [process.execPath, 'tmux'],
      keyId: 'credential-acceptance',
    }
    const grants = createGrants({ store: createMemoryGrantStore() })
    await grants.grant(directory)
    const seam = createSpawnSeam({ policy: commandPolicy, audit, consent: grants })
    const controlPlane = await new StubControlPlane({ holdExitedChannels: true, token: 'frame-token' }).start()
    controlPlanes.push(controlPlane)
    const client = new RunnerClient({ url: controlPlane.url, token: 'frame-token', runner: runnerInfo() })
    clients.push(client)
    const connected = new Promise<void>(resolve => client.once('connected', () => resolve()))
    client.connect()
    await connected
    const terminals = new TerminalHost(client, { seam, pollMs: 50 })
    for (const resolution of [apiResolution, localResolution]) {
      await terminals.launch({
        command: resolution.plan.command,
        args: [...resolution.plan.args],
        cwd: directory,
        env: { ...resolution.plan.env },
        secrets: resolution.plan.secrets,
      })
    }
    await waitUntil(async () => Promise.all([apiCapture, localCapture].map(path => stat(path).then(() => true, () => false))).then(results => results.every(Boolean)))
    const apiChild = JSON.parse(await readFile(apiCapture, 'utf8')) as { argv: string[]; apiKey?: string; endpoint?: string }
    const localChild = JSON.parse(await readFile(localCapture, 'utf8')) as { argv: string[]; apiKey?: string; endpoint?: string }
    expect(apiChild.apiKey).toBe(apiKey)
    expect(apiChild.endpoint).toBeUndefined()
    expect(localChild.endpoint).toBe(endpoint)
    expect(localChild.apiKey).toBeUndefined()
    expect(JSON.stringify([apiChild.argv, localChild.argv])).not.toContain(apiKey)
    expect(JSON.stringify([apiChild.argv, localChild.argv])).not.toContain(endpoint)
    const runnerGeneratedFrames = controlPlane.rawFrames.filter(raw => {
      const frame: Frame | null = decodeFrame(raw)
      return !(frame?.type === 'data' && decodeTerminalServerMessage(frame.payload)?.type === 'OUTPUT')
    })
    expect(runnerGeneratedFrames.join('\n')).not.toContain(apiKey)
    expect(runnerGeneratedFrames.join('\n')).not.toContain(endpoint)
    expect(JSON.stringify(audit.records)).not.toContain(apiKey)
    expect(JSON.stringify(audit.records)).not.toContain(endpoint)
    await terminals.killAll()
  }, 20_000)
})

import { createServer } from 'node:http'
import {
  CapabilityMonitor,
  PreviewHost,
  RunnerClient,
  RunnerIdentity,
  TerminalHost,
  createGrants,
  createMemoryGrantStore,
  createMemoryPairingStore,
  createSpawnSeam,
  type AuditLog,
  type CommandPolicy,
} from '../../src/index.js'
import { StubControlPlane } from '../stubControlPlane.js'

const [workspace, claudeCanary, codexCanary] = process.argv.slice(2)
if (!workspace || !claudeCanary || !codexCanary) throw new Error('trace fixture requires workspace and canary paths')
console.log(`RUNNER_PID=${process.pid}`)

const audit: AuditLog = { append: async () => undefined }
const previewScript = [
  "const net = require('node:net')",
  'const server = net.createServer()',
  "server.listen(0, '127.0.0.1')",
  'setInterval(() => {}, 1000)',
].join(';')
const commandPolicy: CommandPolicy = {
  allowsExecutable: executable => executable === process.execPath || executable === 'tmux',
  recipe: id => (id === 'trace-preview' ? { command: process.execPath, args: ['-e', previewScript] } : null),
  executables: [process.execPath, 'tmux'],
  keyId: 'trace-fixture',
}
const grants = createGrants({ store: createMemoryGrantStore() })
await grants.grant(workspace)
const seam = createSpawnSeam({ policy: commandPolicy, audit, consent: grants })

const pairingServer = createServer((request, response) => {
  if (request.url === '/api/runner/v1/pair') {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ runnerId: 'trace-runner', token: 'trace-runner-token' }))
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
await new Promise<void>(resolve => pairingServer.listen(0, '127.0.0.1', resolve))
const address = pairingServer.address()
if (!address || typeof address === 'string') throw new Error('pairing server did not bind')
try {
  const identity = new RunnerIdentity(createMemoryPairingStore())
  await identity.pair({
    controlPlaneUrl: `http://127.0.0.1:${address.port}`,
    code: 'trace-code',
    runner: { name: 'trace-runner', version: '1.0.0', os: process.platform, arch: process.arch },
  })
} finally {
  const closed = new Promise<void>(resolve => pairingServer.close(() => resolve()))
  pairingServer.closeAllConnections()
  await closed
}

const controlPlane = await new StubControlPlane({ token: 'trace-runner-token' }).start()
const client = new RunnerClient({
  url: controlPlane.url,
  token: 'trace-runner-token',
  runner: { name: 'trace-runner', version: '1.0.0', os: process.platform, arch: process.arch },
})
const terminals = new TerminalHost(client, { seam, pollMs: 50 })
const previews = new PreviewHost({ seam, consent: grants, readyTimeoutMs: 5_000 })
try {
  const connected = new Promise<void>(resolve => client.once('connected', () => resolve()))
  client.connect()
  await connected
  await terminals.launch({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: workspace })

  const openCanaries = [
    "const fs = require('node:fs')",
    `fs.readFileSync(${JSON.stringify(claudeCanary)})`,
    `fs.readFileSync(${JSON.stringify(codexCanary)})`,
    "process.stdout.write('fixture 1.0 authenticated')",
  ].join(';')
  const monitor = new CapabilityMonitor({
    seam,
    runtimes: [{
      runtime: 'trace-cli',
      command: process.execPath,
      versionArgs: ['-e', openCanaries],
      authArgs: ['-e', openCanaries],
      access: ['subscription'],
    }],
    probeTimeoutMs: 2_000,
  })
  await monitor.refresh()
  const preview = await previews.start({ previewId: 'trace-preview', recipe: 'trace-preview', cwd: workspace })
  if (preview.status !== 'ready') throw new Error(`trace preview was not ready: ${preview.reason}`)
} finally {
  client.stop()
  await terminals.killAll()
  await previews.stopAll()
  await controlPlane.stop()
}
console.log('SCENARIO_OK')

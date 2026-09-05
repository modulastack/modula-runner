import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PreviewHost,
  createGrants,
  createMemoryGrantStore,
  createSpawnSeam,
  detectPreviewContainment,
  networkNamespaceOf,
  type CommandPolicy,
  type PreviewContainment,
  type PreviewHost as PreviewHostType,
  type PreviewRecipe,
} from '../src/index.js'
import { probeContainmentEvidence, requireContainmentPass } from './containmentEvidenceHarness.js'
import { recordingAudit } from './spawnSeamSupport.js'

const execFileAsync = promisify(execFile)
const directories: string[] = []
const hosts: PreviewHostType[] = []
const escapedPids: number[] = []

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'runner-containment-acceptance-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.stopAll().catch(() => undefined)))
  for (const pid of escapedPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function listenerScript(address: string, port: number, response = address): string {
  return [
    "const net = require('node:net')",
    `const server = net.createServer(socket => socket.end(${JSON.stringify(response)}))`,
    `server.listen(${port}, ${JSON.stringify(address)})`,
    'setInterval(() => {}, 1000)',
  ].join(';')
}

function commandPolicy(recipes: Readonly<Record<string, PreviewRecipe>>): CommandPolicy {
  return {
    allowsExecutable: executable => [process.execPath, 'tmux'].includes(executable),
    recipe: id => recipes[id] ?? null,
    executables: [process.execPath, 'tmux'],
    keyId: 'containment-acceptance',
  }
}

async function previewHost(directory: string, containment: PreviewContainment, recipes: Readonly<Record<string, PreviewRecipe>>): Promise<PreviewHostType> {
  const grants = createGrants({ store: createMemoryGrantStore() })
  await grants.grant(directory)
  const seam = createSpawnSeam({ policy: commandPolicy(recipes), audit: recordingAudit(), consent: grants })
  const host = new PreviewHost({ seam, consent: grants, containment, readyTimeoutMs: 12_000 })
  hosts.push(host)
  return host
}

async function unusedPort(host = '0.0.0.0'): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('port reservation did not bind')
  await new Promise<void>(resolve => server.close(() => resolve()))
  return address.port
}

function request(host: string, port: number, timeoutMs = 1_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port })
    let body = ''
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('connection timed out')))
    socket.on('data', chunk => {
      body += String(chunk)
    })
    socket.once('error', reject)
    socket.once('end', () => resolve(body))
  })
}

async function canConnect(host: string, port: number, timeoutMs = 300): Promise<boolean> {
  return await new Promise(resolve => {
    const socket = connect({ host, port })
    const finish = (connected: boolean) => {
      socket.destroy()
      resolve(connected)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

function nonLoopbackAddresses(): string[] {
  return [...new Set(Object.values(networkInterfaces()).flatMap(entries => entries ?? [])
    .filter(entry => !entry.internal)
    .map(entry => entry.address))]
}

async function assertUnreachableFromHost(addresses: readonly string[], ports: readonly number[]): Promise<void> {
  expect(addresses.length).toBeGreaterThan(0)
  for (const address of addresses) {
    for (const port of ports) expect(await canConnect(address, port)).toBe(false)
  }
}

async function assertUnreachableFromIndependentNamespace(addresses: readonly string[], ports: readonly number[]): Promise<void> {
  const endpoints = [
    ...addresses.flatMap(host => ports.map(port => ({ host, port }))),
    ...ports.map(port => ({ host: '127.0.0.1', port })),
    ...ports.map(port => ({ host: '::1', port })),
  ]
  const probe = [
    "const net = require('node:net')",
    `const endpoints = ${JSON.stringify(endpoints)}`,
    'const attempt = ({host, port}) => new Promise(resolve => {',
    '  const socket = net.connect({host, port})',
    '  const done = connected => { socket.destroy(); resolve(connected) }',
    '  socket.setTimeout(250, () => done(false))',
    '  socket.once("connect", () => done(true))',
    '  socket.once("error", () => done(false))',
    '})',
    '(async () => { for (const endpoint of endpoints) { if (await attempt(endpoint)) process.exit(1) } })().catch(() => process.exit(2))',
  ].join(';')
  await execFileAsync('unshare', [
    '--user',
    '--map-root-user',
    '--net',
    '--',
    'sh',
    '-c',
    'ip link set lo up; exec "$0" "$@"',
    process.execPath,
    '-e',
    probe,
  ])
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<string> {
  const started = Date.now()
  while (Date.now() - started <= timeoutMs) {
    try {
      return await readFile(path, 'utf8')
    } catch {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  throw new Error(`file was not written: ${path}`)
}

function requireNamespaceCapability() {
  const evidence = probeContainmentEvidence()
  requireContainmentPass(evidence)
}

const linuxNamespaceIt = process.platform === 'linux' ? it : it.skip

describe('CP-5 IC-5 preview containment', () => {
  linuxNamespaceIt('AS-30 keeps a contained wildcard preview reachable through its reported host-loopback port', async () => {
    requireNamespaceCapability()
    const directory = await workspace()
    const internalPort = await unusedPort()
    const containment = detectPreviewContainment()
    const host = await previewHost(directory, containment, {
      wildcard: { command: process.execPath, args: ['-e', listenerScript('0.0.0.0', internalPort, 'internal-wildcard-bind-succeeded')] },
    })

    const outcome = await host.start({ previewId: 'wildcard', recipe: 'wildcard', cwd: directory })

    expect(outcome.status).toBe('ready')
    if (outcome.status !== 'ready') throw new Error(`contained preview refused: ${outcome.reason}`)
    expect(await request('127.0.0.1', outcome.record.port)).toBe('internal-wildcard-bind-succeeded')
  }, 20_000)

  linuxNamespaceIt('AS-30 does not report the inherited bridge socket ready before the contained preview binds', async () => {
    requireNamespaceCapability()
    const directory = await workspace()
    const internalPort = await unusedPort()
    const bindDelayMs = 2_500
    const delayedScript = [
      "const net = require('node:net')",
      "const server = net.createServer(socket => socket.end('delayed-preview-ready'))",
      `setTimeout(() => server.listen(${internalPort}, '0.0.0.0'), ${bindDelayMs})`,
      'setInterval(() => {}, 1000)',
    ].join(';')
    const containment = detectPreviewContainment()
    const host = await previewHost(directory, containment, {
      delayed: { command: process.execPath, args: ['-e', delayedScript] },
    })
    let settled = false
    const startedAt = Date.now()
    const start = host.start({ previewId: 'delayed', recipe: 'delayed', cwd: directory }).then(outcome => {
      settled = true
      return outcome
    })

    await new Promise(resolve => setTimeout(resolve, 1_000))
    expect(settled).toBe(false)
    const outcome = await start
    expect(outcome.status).toBe('ready')
    if (outcome.status !== 'ready') throw new Error(`delayed contained preview refused: ${outcome.reason}`)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(bindDelayMs - 250)
    expect(await request('127.0.0.1', outcome.record.port)).toBe('delayed-preview-ready')
  }, 20_000)

  linuxNamespaceIt('AS-31 keeps successful wildcard binds unreachable from every non-loopback host address and an independent netns for their lifetime', async () => {
    requireNamespaceCapability()
    const directory = await workspace()
    const addresses = nonLoopbackAddresses()
    const containment = detectPreviewContainment()
    const ipv4Port = await unusedPort('0.0.0.0')
    const ipv6Addresses = addresses.filter(address => address.includes(':'))
    const ipv6Port = ipv6Addresses.length > 0 ? await unusedPort('::') : null
    const recipes: Record<string, PreviewRecipe> = {
      ipv4: { command: process.execPath, args: ['-e', listenerScript('0.0.0.0', ipv4Port, 'ipv4-wildcard-bind-succeeded')] },
    }
    if (ipv6Port !== null) recipes.ipv6 = { command: process.execPath, args: ['-e', listenerScript('::', ipv6Port, 'ipv6-wildcard-bind-succeeded')] }
    const host = await previewHost(directory, containment, recipes)
    const ipv4 = await host.start({ previewId: 'ipv4', recipe: 'ipv4', cwd: directory })
    const ipv6 = ipv6Port === null ? null : await host.start({ previewId: 'ipv6', recipe: 'ipv6', cwd: directory })
    expect(ipv4.status).toBe('ready')
    if (ipv4.status !== 'ready') throw new Error(`IPv4 preview refused: ${ipv4.reason}`)
    expect(ipv6?.status ?? 'not-applicable').toBe(ipv6Port === null ? 'not-applicable' : 'ready')
    const records = [ipv4, ...(ipv6?.status === 'ready' ? [ipv6] : [])]
    const reportedPorts = records.map(record => record.record.port)
    const internalPorts = [ipv4Port, ...(ipv6Port === null ? [] : [ipv6Port])]

    for (let observation = 0; observation < 3; observation += 1) {
      expect(await request('127.0.0.1', ipv4.record.port)).toBe('ipv4-wildcard-bind-succeeded')
      if (ipv6?.status === 'ready') expect(await request('127.0.0.1', ipv6.record.port)).toBe('ipv6-wildcard-bind-succeeded')
      await assertUnreachableFromHost(addresses, [...reportedPorts, ...internalPorts])
      await assertUnreachableFromIndependentNamespace(addresses, [...reportedPorts, ...internalPorts])
    }
  }, 30_000)

  linuxNamespaceIt('AS-31 refuses a contained preview with two TCP listener ports instead of forwarding one arbitrarily', async () => {
    requireNamespaceCapability()
    const directory = await workspace()
    const pidPath = join(directory, 'ambiguous.pid')
    const firstPort = await unusedPort()
    let secondPort = await unusedPort()
    while (secondPort === firstPort) secondPort = await unusedPort()
    const script = [
      "const fs = require('node:fs')",
      "const net = require('node:net')",
      `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid))`,
      `net.createServer().listen(${firstPort}, '0.0.0.0')`,
      `net.createServer().listen(${secondPort}, '0.0.0.0')`,
      'setInterval(() => {}, 1000)',
    ].join(';')
    const containment = detectPreviewContainment()
    const host = await previewHost(directory, containment, {
      ambiguous: { command: process.execPath, args: ['-e', script] },
    })

    const startedAt = Date.now()
    expect((await host.start({ previewId: 'ambiguous', recipe: 'ambiguous', cwd: directory })).status).toBe('refused')
    const previewPid = Number(await waitForFile(pidPath))
    let previewAlive = true
    const exitDeadline = Date.now() + 2_000
    while (previewAlive && Date.now() < exitDeadline) {
      try {
        process.kill(previewPid, 0)
        await new Promise(resolve => setTimeout(resolve, 20))
      } catch {
        previewAlive = false
      }
    }
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(previewAlive).toBe(false)
    expect(await canConnect('127.0.0.1', firstPort)).toBe(false)
    expect(await canConnect('127.0.0.1', secondPort)).toBe(false)
  }, 15_000)

  linuxNamespaceIt('AS-32 keeps a double-forked setsid descendant in the isolated network namespace', async () => {
    requireNamespaceCapability()
    const directory = await workspace()
    const pidPath = join(directory, 'escaped.pid')
    const internalPort = await unusedPort()
    const serverCode = [
      "const fs = require('node:fs')",
      "const net = require('node:net')",
      `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid))`,
      `net.createServer(socket => socket.end('double-fork-contained')).listen(${internalPort}, '0.0.0.0')`,
      'setInterval(() => {}, 1000)',
    ].join(';')
    const intermediateCode = [
      "const { spawn } = require('node:child_process')",
      `spawn(process.execPath, ['-e', ${JSON.stringify(serverCode)}], { detached: true, stdio: 'ignore' }).unref()`,
    ].join(';')
    const parentCode = [
      "const { spawn } = require('node:child_process')",
      `spawn(process.execPath, ['-e', ${JSON.stringify(intermediateCode)}], { detached: true, stdio: 'ignore' }).unref()`,
    ].join(';')
    const containment = detectPreviewContainment()
    const host = await previewHost(directory, containment, {
      daemon: { command: process.execPath, args: ['-e', parentCode] },
    })

    const outcome = await host.start({ previewId: 'daemon', recipe: 'daemon', cwd: directory })
    expect(outcome.status).toBe('ready')
    if (outcome.status !== 'ready') throw new Error(`daemon preview refused: ${outcome.reason}`)
    const daemonPid = Number(await waitForFile(pidPath))
    escapedPids.push(daemonPid)
    expect(networkNamespaceOf(daemonPid)).not.toBe(networkNamespaceOf('self'))
    expect(await request('127.0.0.1', outcome.record.port)).toBe('double-fork-contained')
    await assertUnreachableFromHost(nonLoopbackAddresses(), [outcome.record.port, internalPort])
    await assertUnreachableFromIndependentNamespace(nonLoopbackAddresses(), [outcome.record.port, internalPort])
  }, 25_000)

  linuxNamespaceIt('AS-33 states active prevention on a namespace-capable Linux host', () => {
    requireNamespaceCapability()
    expect(detectPreviewContainment().status).toEqual(expect.objectContaining({
      disposition: 'network-namespace',
      platform: 'linux',
      prevention: true,
      detail: expect.stringMatching(/active|network namespace/i),
    }))
  })

  it('AS-34 visibly degrades namespace denial to detect-and-stop and still terminates exposure', async () => {
    const containment = detectPreviewContainment({ forceDisposition: 'detect-and-stop', platform: 'linux' })
    expect(containment.status).toEqual(expect.objectContaining({
      disposition: 'detect-and-stop',
      platform: 'linux',
      prevention: false,
      detail: expect.stringMatching(/unavailable on this host/i),
    }))
    const directory = await workspace()
    const port = await unusedPort()
    const host = await previewHost(directory, containment, {
      exposed: { command: process.execPath, args: ['-e', listenerScript('0.0.0.0', port)] },
    })

    expect(await host.start({ previewId: 'exposed', recipe: 'exposed', cwd: directory })).toEqual({
      status: 'refused',
      reason: 'non-loopback-bind',
    })
    expect(await canConnect('127.0.0.1', port)).toBe(false)
    const missingHost = await previewHost(directory, containment, {
      missing: { command: join(directory, 'missing-preview-command'), args: [] },
    })
    expect(await missingHost.start({ previewId: 'missing', recipe: 'missing', cwd: directory })).toEqual({
      status: 'refused',
      reason: 'spawn-failed',
    })
  }, 15_000)

  it('AS-36 reports macOS containment as detect-and-stop while never claiming namespace prevention', async () => {
    const containment = detectPreviewContainment({ platform: 'darwin' })
    expect(containment.status).toEqual(expect.objectContaining({
      disposition: 'detect-and-stop',
      platform: 'darwin',
      prevention: false,
      detail: expect.stringMatching(/namespace prevention.*unavailable.*darwin|detect-and-stop/i),
    }))
    const directory = await workspace()
    const port = await unusedPort()
    const host = await previewHost(directory, containment, {
      exposed: { command: process.execPath, args: ['-e', listenerScript('0.0.0.0', port)] },
    })

    expect(await host.start({ previewId: 'mac-exposed', recipe: 'exposed', cwd: directory })).toEqual({
      status: 'refused',
      reason: 'non-loopback-bind',
    })
    expect(await canConnect('127.0.0.1', port)).toBe(false)
  }, 15_000)

  it('AS-37 keeps host-visible non-loopback detection active beneath claimed containment', async () => {
    const leakyContainment: PreviewContainment = {
      status: {
        disposition: 'network-namespace',
        platform: 'linux',
        prevention: true,
        detail: 'fault-injected active containment',
      },
      spawn: spec => spawn(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: spec.env,
        stdio: 'ignore',
        detached: true,
      }),
    }
    const directory = await workspace()
    const port = await unusedPort()
    const host = await previewHost(directory, leakyContainment, {
      leaked: { command: process.execPath, args: ['-e', listenerScript('0.0.0.0', port)] },
    })

    expect(await host.start({ previewId: 'leaked', recipe: 'leaked', cwd: directory })).toEqual({
      status: 'refused',
      reason: 'non-loopback-bind',
    })
    expect(await canConnect('127.0.0.1', port)).toBe(false)
  }, 15_000)
})

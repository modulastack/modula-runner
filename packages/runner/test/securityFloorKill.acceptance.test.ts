import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PreviewHost,
  RunnerClient,
  TerminalHost,
  activateKillSwitch,
  createGrants,
  createMemoryGrantStore,
  createSpawnSeam,
  type AuditLog,
  type AuditRecord,
  type CommandPolicy,
  type ConsentPolicy,
  type SpawnRequest,
  type VettedSpawn,
} from '../src/index.js'
import { openAuditLogFixture } from './appendOnlyAuditFixture.js'
import { StubControlPlane } from './stubControlPlane.js'

const execFileAsync = promisify(execFile)
const directories: string[] = []
const children: ChildProcess[] = []
const clients: RunnerClient[] = []
const controlPlanes: StubControlPlane[] = []

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'runner-kill-acceptance-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.stop()
  await Promise.all(controlPlanes.splice(0).map(controlPlane => controlPlane.stop().catch(() => undefined)))
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGKILL')
    await once(child, 'exit').catch(() => undefined)
  }))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function policy(recipes: CommandPolicy['recipe'] = () => null): CommandPolicy {
  return {
    allowsExecutable: executable => [process.execPath, 'git', 'tmux'].includes(executable),
    recipe: recipes,
    executables: [process.execPath, 'git', 'tmux'],
    keyId: 'kill-acceptance',
  }
}

function parseAudit(raw: string): AuditRecord[] {
  return raw
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as AuditRecord)
}

async function runVetted(vetted: VettedSpawn): Promise<{ outcome: { exitCode: 0; signal: null }; value: string }> {
  const { stdout } = await execFileAsync(vetted.command, [...vetted.args], { cwd: vetted.cwd })
  return { outcome: { exitCode: 0, signal: null }, value: stdout }
}

describe('CP-5 IC-3 kill switch and audit acceptance', () => {
  it('AS-15 severs a real runner connection and kills real visible terminal and preview children locally', async () => {
    const directory = await workspace()
    const auditPath = join(directory, 'audit.ndjson')
    const audit = openAuditLogFixture({ path: auditPath })
    const controlPlane = await new StubControlPlane().start()
    controlPlanes.push(controlPlane)
    const client = new RunnerClient({
      url: controlPlane.url,
      token: 'stub-token',
      runner: { name: 'kill-acceptance', version: '1.0.0', os: process.platform, arch: process.arch },
    })
    clients.push(client)
    const connected = once(client, 'connected')
    client.connect()
    await connected
    const grants = createGrants({ store: createMemoryGrantStore() })
    await grants.grant(directory)
    const previewScript = [
      "const net = require('node:net')",
      'const server = net.createServer()',
      "server.listen(0, '127.0.0.1')",
      'setInterval(() => {}, 1000)',
    ].join(';')
    const seam = createSpawnSeam({
      policy: policy(id => (id === 'app' ? { command: process.execPath, args: ['-e', previewScript] } : null)),
      audit,
      consent: grants,
    })
    const terminals = new TerminalHost(client, { seam, pollMs: 50 })
    const previews = new PreviewHost({ seam, consent: grants, readyTimeoutMs: 10_000 })
    await Promise.all([
      terminals.launch({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: directory }),
      terminals.launch({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: directory }),
    ])
    expect((await previews.start({ previewId: 'app', recipe: 'app', cwd: directory })).status).toBe('ready')
    expect(client.isConnected()).toBe(true)
    expect(terminals.sessions()).toHaveLength(2)
    expect(previews.list()).toHaveLength(1)

    try {
      const outcome = await activateKillSwitch({ audit, client, terminals, previews })
      expect(outcome.confirmed).toBe(true)
      expect(outcome.details.length).toBeGreaterThan(0)
      expect(client.isConnected()).toBe(false)
      expect(terminals.sessions()).toEqual([])
      expect(previews.list()).toEqual([])
    } finally {
      client.stop()
      await terminals.killAll()
      await previews.stopAll()
    }
  }, 20_000)

  it('AS-16 reports a real visible child that resists termination as unconfirmed', async () => {
    const directory = await workspace()
    const child = spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); process.send?.('ready'); setInterval(() => {}, 1000)"],
      { cwd: directory, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    )
    children.push(child)
    await once(child, 'message')
    const records: AuditRecord[] = []
    const audit: AuditLog = { append: async record => void records.push(record) }

    const outcome = await activateKillSwitch({
      audit,
      terminals: {
        killAll: async () => {
          child.kill('SIGTERM')
          await new Promise(resolve => setTimeout(resolve, 50))
          return child.exitCode === null && child.signalCode === null ? ['resistant-child'] : []
        },
      },
    })

    expect(outcome.confirmed).toBe(false)
    expect(outcome.details).toContain('resistant-child')
    expect(child.exitCode).toBeNull()
    expect(records).toEqual([expect.objectContaining({ kind: 'kill', confirmed: false, details: expect.stringContaining('resistant-child') })])
  })

  it('AS-16 reports a teardown subsystem failure as unconfirmed and audits it', async () => {
    const records: AuditRecord[] = []
    const audit: AuditLog = { append: async record => void records.push(record) }

    const outcome = await activateKillSwitch({
      audit,
      terminals: { killAll: async () => Promise.reject(new Error('tmux inspection failed')) },
    })

    expect(outcome.confirmed).toBe(false)
    expect(outcome.details).toContain('tmux inspection failed')
    expect(records).toEqual([
      expect.objectContaining({ kind: 'kill', confirmed: false, details: expect.stringContaining('tmux inspection failed') }),
    ])
  })

  it('AS-17 does not resolve the kill action until its real audit record is durably appended', async () => {
    const directory = await workspace()
    const path = join(directory, 'audit.ndjson')
    const realAudit = openAuditLogFixture({ path })
    let releaseAppend!: () => void
    let observeAppend!: () => void
    const appendReleased = new Promise<void>(resolve => {
      releaseAppend = resolve
    })
    const appendObserved = new Promise<void>(resolve => {
      observeAppend = resolve
    })
    const audit: AuditLog = {
      append: async record => {
        observeAppend()
        await appendReleased
        await realAudit.append(record)
      },
    }
    let settled = false
    const activation = activateKillSwitch({ audit, now: () => 1_700_000_000_000 }).then(
      outcome => {
        settled = true
        return { outcome }
      },
      error => {
        settled = true
        return { error }
      },
    )

    const reachedAppend = await Promise.race([
      appendObserved.then(() => true),
      activation.then(() => false),
    ])
    expect(reachedAppend).toBe(true)
    expect(settled).toBe(false)
    releaseAppend()
    const result = await activation
    expect(result).toHaveProperty('outcome')
    expect(parseAudit(await readFile(path, 'utf8'))).toEqual([
      expect.objectContaining({ kind: 'kill', confirmed: true, at: '2023-11-14T22:13:20.000Z' }),
    ])
  })

  it('AS-18 reconciles every accepted runner-owned spawn kind to admission and outcome records', async () => {
    const directory = await workspace()
    const path = join(directory, 'audit.ndjson')
    const grants = createGrants({ store: createMemoryGrantStore() })
    await grants.grant(directory)
    const seam = createSpawnSeam({
      policy: policy(id => (id === 'preview' ? { command: process.execPath, args: ['-e', 'process.stdout.write("preview")'] } : null)),
      audit: openAuditLogFixture({ path }),
      consent: grants,
      now: () => 1_700_000_000_000,
    })
    const requests: SpawnRequest[] = [
      { kind: 'pane', executable: process.execPath, args: ['-e', 'process.stdout.write("pane")'], cwd: directory, grantScoped: true },
      { kind: 'preview', recipeId: 'preview', cwd: directory, grantScoped: true },
      { kind: 'git', executable: 'git', args: ['--version'], cwd: directory, grantScoped: false },
      { kind: 'tmux', executable: 'tmux', args: ['-V'], cwd: directory, grantScoped: false },
      { kind: 'probe', executable: process.execPath, args: ['-e', 'process.stdout.write("probe")'], cwd: directory, grantScoped: false },
    ]

    for (const request of requests) {
      const result = await seam.run(request, runVetted)
      expect(result.status).toBe('ran')
    }

    const records = parseAudit(await readFile(path, 'utf8'))
    const admissions = records.filter(record => record.kind === 'spawn-admitted')
    const outcomes = records.filter(record => record.kind === 'spawn-outcome')
    expect(admissions).toHaveLength(requests.length)
    expect(outcomes).toHaveLength(requests.length)
    expect(new Set(outcomes.map(record => record.spawnId))).toEqual(new Set(admissions.map(record => record.spawnId)))
    for (const admission of admissions) {
      expect(admission.cwd).toBe(await realpath(directory))
      expect(Number.isNaN(Date.parse(admission.at))).toBe(false)
      expect(Boolean(admission.executable || admission.recipeId)).toBe(true)
    }
  })

  it('AS-19 durably audits every security refusal reason when it is surfaced', async () => {
    const directory = await workspace()
    const path = join(directory, 'audit.ndjson')
    const audit = openAuditLogFixture({ path })
    const emptyConsent = createGrants({ store: createMemoryGrantStore() })
    const denied = createSpawnSeam({ policy: null, audit })
    const ungranted = createSpawnSeam({ policy: policy(), audit, consent: emptyConsent })
    await denied.authorize({
      kind: 'pane',
      executable: 'remote-shell',
      cwd: directory,
      grantScoped: true,
      requestId: 'not-allowlisted',
    })
    await ungranted.authorize({
      kind: 'pane',
      executable: process.execPath,
      cwd: directory,
      grantScoped: true,
      requestId: 'path-not-granted',
    })

    let releaseConsent!: (cwd: string) => void
    let observeConsent!: () => void
    const consentReleased = new Promise<string>(resolve => {
      releaseConsent = resolve
    })
    const consentObserved = new Promise<void>(resolve => {
      observeConsent = resolve
    })
    let firstConsent = true
    const heldConsent: ConsentPolicy = {
      resolveGrantedCwd: async cwd => {
        if (!firstConsent) return realpath(cwd)
        firstConsent = false
        observeConsent()
        return consentReleased
      },
      isGrantedRealPath: async () => true,
    }
    const heldSeam = createSpawnSeam({
      policy: policy(id => (id === 'held' ? { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] } : null)),
      audit,
      consent: heldConsent,
    })
    const heldHost = new PreviewHost({ seam: heldSeam, consent: heldConsent, readyTimeoutMs: 1_000 })
    const heldStart = heldHost.start({ previewId: 'held', recipe: 'held', cwd: directory })
    await consentObserved
    const shutdown = heldHost.stopAll()
    const paused = await heldHost.start({ previewId: 'paused', recipe: 'held', cwd: directory })
    releaseConsent(await realpath(directory))
    await heldStart
    await shutdown
    expect(paused).toEqual({ status: 'refused', reason: 'runner-paused' })

    const grants = createGrants({ store: createMemoryGrantStore() })
    await grants.grant(directory)
    const exposedScript = [
      "const net = require('node:net')",
      'const server = net.createServer()',
      "server.listen(0, '0.0.0.0')",
      'setInterval(() => {}, 1000)',
    ].join(';')
    const exposedSeam = createSpawnSeam({
      policy: policy(id => (id === 'exposed' ? { command: process.execPath, args: ['-e', exposedScript] } : null)),
      audit,
      consent: grants,
    })
    const exposedHost = new PreviewHost({ seam: exposedSeam, consent: grants, readyTimeoutMs: 5_000 })
    expect(await exposedHost.start({ previewId: 'exposed', recipe: 'exposed', cwd: directory })).toEqual({
      status: 'refused',
      reason: 'non-loopback-bind',
    })
    await exposedHost.stopAll()

    const refusalRecords = parseAudit(await readFile(path, 'utf8')).filter(record => record.kind === 'refused')
    for (const reason of ['not-allowlisted', 'path-not-granted', 'runner-paused', 'non-loopback-bind'] as const) {
      expect(refusalRecords).toContainEqual(expect.objectContaining({ reason, at: expect.any(String) }))
    }
  }, 15_000)
})

import { appendFile, mkdtemp, open as openFile, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_FLOW,
  DEFAULT_REPLAY_LINES,
  PreviewHost,
  TerminalSession,
  createSpawnSeam,
  openAuditLog,
  type AuditLog,
  type AuditRecord,
  type CommandPolicy,
  type SpawnOutcome,
  type SpawnSeam,
} from '../src/index.js'
import { permissiveConsent } from './spawnSeamSupport.js'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'runner-audit-acceptance-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function killRecord(details: string): AuditRecord {
  return { kind: 'kill', confirmed: true, details, at: '2026-08-16T12:00:00.000Z' }
}

async function waitUntil(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function parseRecords(raw: string): AuditRecord[] {
  return raw
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as AuditRecord)
}

const allowedPolicy: CommandPolicy = {
  allowsExecutable: executable => executable === process.execPath,
  recipe: () => null,
  executables: [process.execPath],
  keyId: 'test-anchor',
}

describe('CP-5 append-only audit acceptance available at the IC-1 interface', () => {
  it('AS-20 preserves the existing byte prefix and appends complete records after concurrent external appends', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'audit.ndjson')
    const first = killRecord('first')
    const external = killRecord('external')
    const last = killRecord('last')
    const prefix = `${JSON.stringify(first)}\n`
    await writeFile(path, prefix, { mode: 0o600 })
    const audit = openAuditLog({ path })

    await appendFile(path, `${JSON.stringify(external)}\n`)
    await audit.append(last)

    const raw = await readFile(path, 'utf8')
    expect(raw.startsWith(prefix)).toBe(true)
    expect(parseRecords(raw)).toEqual([first, external, last])
  })

  it('AS-21 does not resolve an append until that record has passed its durability sync', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'audit.ndjson')
    const probe = await openFile(join(directory, 'probe'), 'w')
    type SyncTarget = { sync(): Promise<void> }
    const prototype = Object.getPrototypeOf(probe) as SyncTarget
    const originalSync = prototype.sync
    await probe.close()
    let releaseSync!: () => void
    let observeSync!: () => void
    const syncReleased = new Promise<void>(resolve => {
      releaseSync = resolve
    })
    const syncObserved = new Promise<void>(resolve => {
      observeSync = resolve
    })
    let syncCalls = 0
    prototype.sync = async function (this: SyncTarget): Promise<void> {
      syncCalls += 1
      observeSync()
      await syncReleased
      await originalSync.call(this)
    }

    try {
      const audit = openAuditLog({ path })
      let resolved = false
      const pending = audit.append(killRecord('durable')).then(() => {
        resolved = true
      })
      await syncObserved
      expect(resolved).toBe(false)
      expect(syncCalls).toBe(1)
      releaseSync()
      await pending
      expect(resolved).toBe(true)
      expect(parseRecords(await readFile(path, 'utf8'))).toEqual([killRecord('durable')])
    } finally {
      prototype.sync = originalSync
      releaseSync()
    }
  })

  it('AS-21 rejects a new-log append when the audit directory cannot be synced', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'audit.ndjson')
    const probe = await openFile(join(directory, 'probe-directory-sync'), 'w')
    type SyncTarget = { sync(): Promise<void> }
    const prototype = Object.getPrototypeOf(probe) as SyncTarget
    const originalSync = prototype.sync
    await probe.close()
    let syncCalls = 0
    prototype.sync = async function (this: SyncTarget): Promise<void> {
      syncCalls += 1
      if (syncCalls === 2) throw new Error('directory fsync failed')
      await originalSync.call(this)
    }

    try {
      const failures: unknown[] = []
      const audit = openAuditLog({ path, onFailure: (_record, error) => failures.push(error) })
      await expect(audit.append(killRecord('directory-durability'))).rejects.toThrow('directory fsync failed')
      expect(syncCalls).toBe(2)
      expect(failures).toHaveLength(1)
    } finally {
      prototype.sync = originalSync
    }
  })

  it('AS-21 re-syncs the audit directory when rotation changes the file inode', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'audit.ndjson')
    const rotated = join(directory, 'audit.ndjson.1')
    const probe = await openFile(join(directory, 'inode-sync-probe'), 'w')
    type SyncTarget = { sync(): Promise<void>; stat(): Promise<{ isDirectory(): boolean }> }
    const prototype = Object.getPrototypeOf(probe) as SyncTarget
    const originalSync = prototype.sync
    await probe.close()
    let directorySyncs = 0
    prototype.sync = async function (this: SyncTarget): Promise<void> {
      const target = await this.stat()
      if (target.isDirectory()) directorySyncs += 1
      await originalSync.call(this)
    }

    try {
      const audit = openAuditLog({ path })
      await audit.append(killRecord('before-rotation'))
      await rename(path, rotated)
      await audit.append(killRecord('after-rotation'))

      expect(directorySyncs).toBe(2)
      expect(parseRecords(await readFile(rotated, 'utf8'))).toEqual([killRecord('before-rotation')])
      expect(parseRecords(await readFile(path, 'utf8'))).toEqual([killRecord('after-rotation')])
    } finally {
      prototype.sync = originalSync
    }
  })

  it('AS-21 does not acknowledge a failed pane launch before its outcome record is durable', async () => {
    const directory = await temporaryDirectory()
    let releaseOutcome!: () => void
    let observeOutcome!: () => void
    const outcomeReleased = new Promise<void>(resolve => {
      releaseOutcome = resolve
    })
    const outcomeObserved = new Promise<void>(resolve => {
      observeOutcome = resolve
    })
    let paneOutcome: SpawnOutcome | undefined
    const seam: SpawnSeam = {
      check: () => true,
      recordRefusal: async () => undefined,
      authorize: async request => ({
        status: 'admitted',
        authorization: {
          vetted: {
            command: request.executable ?? '',
            args: request.args ?? [],
            cwd: request.cwd,
            spawnId: 'pane-spawn',
          },
          complete: async outcome => {
            paneOutcome = outcome
            observeOutcome()
            await outcomeReleased
          },
        },
      }),
      run: async () => ({ status: 'refused', reason: 'not-allowlisted' }),
    }
    let settled = false
    const launch = TerminalSession.launch(
      { command: process.execPath, args: ['-e', ''], cwd: directory },
      { flow: DEFAULT_FLOW, replayLines: DEFAULT_REPLAY_LINES, pollMs: 50 },
      { send: () => undefined, onExited: () => undefined },
      seam,
    ).then(
      () => {
        settled = true
        return 'resolved'
      },
      () => {
        settled = true
        return 'rejected'
      },
    )

    await outcomeObserved
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(settled).toBe(false)
    releaseOutcome()
    expect(await launch).toBe('rejected')
    expect(paneOutcome).toEqual({ spawnFailed: true })
  })

  it('AS-21 withholds failed pane-launch acknowledgment when its outcome append rejects', async () => {
    const directory = await temporaryDirectory()
    let observeOutcome!: () => void
    const outcomeObserved = new Promise<void>(resolve => {
      observeOutcome = resolve
    })
    const seam: SpawnSeam = {
      check: () => true,
      recordRefusal: async () => undefined,
      authorize: async request => ({
        status: 'admitted',
        authorization: {
          vetted: {
            command: request.executable ?? '',
            args: request.args ?? [],
            cwd: request.cwd,
            spawnId: 'pane-rejected-outcome',
          },
          complete: async () => {
            observeOutcome()
            throw new Error('audit target unavailable')
          },
        },
      }),
      run: async () => ({ status: 'refused', reason: 'not-allowlisted' }),
    }
    let settled = false
    void TerminalSession.launch(
      { command: process.execPath, args: ['-e', ''], cwd: directory },
      { flow: DEFAULT_FLOW, replayLines: DEFAULT_REPLAY_LINES, pollMs: 50 },
      { send: () => undefined, onExited: () => undefined },
      seam,
    ).then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )

    await outcomeObserved
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(settled).toBe(false)
  })

  it('AS-21 resumes a failed pane launch once its outcome audit recovers', async () => {
    const directory = await temporaryDirectory()
    let outcomeAttempts = 0
    const seam: SpawnSeam = {
      check: () => true,
      recordRefusal: async () => undefined,
      authorize: async request => ({
        status: 'admitted',
        authorization: {
          vetted: {
            command: request.executable ?? '',
            args: request.args ?? [],
            cwd: request.cwd,
            spawnId: 'failed-pane-recovery',
          },
          complete: async () => {
            outcomeAttempts += 1
            if (outcomeAttempts <= 7) throw new Error('temporary launch audit outage')
          },
        },
      }),
      run: async () => ({ status: 'refused', reason: 'not-allowlisted' }),
    }
    const launch = TerminalSession.launch(
      { command: process.execPath, args: ['-e', ''], cwd: directory },
      { flow: DEFAULT_FLOW, replayLines: DEFAULT_REPLAY_LINES, pollMs: 50 },
      { send: () => undefined, onExited: () => undefined },
      seam,
    ).then(() => 'resolved', () => 'rejected')

    await waitUntil(() => outcomeAttempts >= 5)
    await expect(Promise.race([
      launch,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('failed launch did not resume')), 4_000)),
    ])).resolves.toBe('rejected')
    expect(outcomeAttempts).toBe(8)
  }, 10_000)

  it('AS-21 withholds pane EXIT until the pane outcome record is durable', async () => {
    const directory = await temporaryDirectory()
    let releaseOutcome!: () => void
    let observeOutcome!: () => void
    let observeExit!: () => void
    const outcomeReleased = new Promise<void>(resolve => {
      releaseOutcome = resolve
    })
    const outcomeObserved = new Promise<void>(resolve => {
      observeOutcome = resolve
    })
    const exitObserved = new Promise<void>(resolve => {
      observeExit = resolve
    })
    let paneSpawnId: string | undefined
    const records: AuditRecord[] = []
    const audit: AuditLog = {
      append: async record => {
        records.push(record)
        if (record.kind === 'spawn-admitted' && record.executable === process.execPath) paneSpawnId = record.spawnId
        if (record.kind === 'spawn-outcome' && record.spawnId === paneSpawnId) {
          observeOutcome()
          await outcomeReleased
        }
      },
    }
    const seam = createSpawnSeam({
      policy: {
        allowsExecutable: executable => executable === process.execPath || executable === 'tmux',
        recipe: () => null,
        executables: [process.execPath, 'tmux'],
        keyId: 'pane-outcome',
      },
      audit,
      consent: permissiveConsent([directory]),
    })
    let exitSent = false
    const session = await TerminalSession.launch(
      { command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: directory },
      { flow: DEFAULT_FLOW, replayLines: DEFAULT_REPLAY_LINES, pollMs: 50 },
      {
        send: message => {
          if (message.type === 'EXIT') {
            exitSent = true
            observeExit()
          }
        },
        onExited: () => undefined,
      },
      seam,
    )

    await outcomeObserved
    const acknowledgedBeforeDurable = exitSent
    releaseOutcome()
    await exitObserved
    await session.dispose(false)

    expect(acknowledgedBeforeDurable).toBe(false)
    expect(records.some(record => record.kind === 'spawn-outcome' && record.spawnId === paneSpawnId)).toBe(true)
  })

  it('AS-21 withholds pane EXIT when the outcome append keeps rejecting', async () => {
    const directory = await temporaryDirectory()
    let paneSpawnId: string | undefined
    let outcomeAttempts = 0
    let observeOutcome!: () => void
    const outcomeObserved = new Promise<void>(resolve => {
      observeOutcome = resolve
    })
    const audit: AuditLog = {
      append: async record => {
        if (record.kind === 'spawn-admitted' && record.executable === process.execPath) paneSpawnId = record.spawnId
        if (record.kind === 'spawn-outcome' && record.spawnId === paneSpawnId) {
          outcomeAttempts += 1
          observeOutcome()
          throw new Error('audit target unavailable')
        }
      },
    }
    const seam = createSpawnSeam({
      policy: {
        allowsExecutable: executable => executable === process.execPath || executable === 'tmux',
        recipe: () => null,
        executables: [process.execPath, 'tmux'],
        keyId: 'pane-outcome-rejection',
      },
      audit,
      consent: permissiveConsent([directory]),
    })
    let exitSent = false
    const session = await TerminalSession.launch(
      { command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: directory },
      { flow: DEFAULT_FLOW, replayLines: DEFAULT_REPLAY_LINES, pollMs: 50 },
      {
        send: message => {
          if (message.type === 'EXIT') exitSent = true
        },
        onExited: () => undefined,
      },
      seam,
    )

    await outcomeObserved
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(outcomeAttempts).toBeGreaterThan(1)
    expect(exitSent).toBe(false)
    await session.dispose(false)
  })

  it('AS-21 eventually records and emits pane EXIT after an outage longer than one retry burst', async () => {
    const directory = await temporaryDirectory()
    let paneSpawnId: string | undefined
    let outcomeAttempts = 0
    const durableOutcomes: AuditRecord[] = []
    const audit: AuditLog = {
      append: async record => {
        if (record.kind === 'spawn-admitted' && record.executable === process.execPath) paneSpawnId = record.spawnId
        if (record.kind !== 'spawn-outcome' || record.spawnId !== paneSpawnId) return
        outcomeAttempts += 1
        if (outcomeAttempts <= 7) throw new Error('temporary pane audit outage')
        durableOutcomes.push(record)
      },
    }
    const seam = createSpawnSeam({
      policy: {
        allowsExecutable: executable => executable === process.execPath || executable === 'tmux',
        recipe: () => null,
        executables: [process.execPath, 'tmux'],
        keyId: 'pane-outcome-recovery',
      },
      audit,
      consent: permissiveConsent([directory]),
    })
    let exitCount = 0
    let observeExit!: () => void
    const exitObserved = new Promise<void>(resolve => {
      observeExit = resolve
    })
    const session = await TerminalSession.launch(
      { command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: directory },
      { flow: DEFAULT_FLOW, replayLines: DEFAULT_REPLAY_LINES, pollMs: 50 },
      {
        send: message => {
          if (message.type === 'EXIT') {
            exitCount += 1
            observeExit()
          }
        },
        onExited: () => undefined,
      },
      seam,
    )

    await Promise.race([
      exitObserved,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('pane EXIT was not re-driven')), 4_000)),
    ])
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(outcomeAttempts).toBe(8)
    expect(durableOutcomes).toHaveLength(1)
    expect(exitCount).toBe(1)
    await session.dispose(false)
  }, 15_000)

  it('AS-21 withholds preview exit notification until the preview outcome record is durable', async () => {
    const directory = await temporaryDirectory()
    let releaseOutcome!: () => void
    let observeOutcome!: () => void
    let observeExit!: () => void
    const outcomeReleased = new Promise<void>(resolve => {
      releaseOutcome = resolve
    })
    const outcomeObserved = new Promise<void>(resolve => {
      observeOutcome = resolve
    })
    const exitObserved = new Promise<void>(resolve => {
      observeExit = resolve
    })
    let previewSpawnId: string | undefined
    const audit: AuditLog = {
      append: async record => {
        if (record.kind === 'spawn-admitted' && record.recipeId === 'preview') previewSpawnId = record.spawnId
        if (record.kind === 'spawn-outcome' && record.spawnId === previewSpawnId) {
          observeOutcome()
          await outcomeReleased
        }
      },
    }
    const script = [
      "const net = require('node:net')",
      'const server = net.createServer()',
      "server.listen(0, '127.0.0.1', () => setTimeout(() => server.close(() => process.exit(0)), 6500))",
    ].join(';')
    const seam = createSpawnSeam({
      policy: {
        allowsExecutable: () => false,
        recipe: id => (id === 'preview' ? { command: process.execPath, args: ['-e', script] } : null),
        executables: [],
        keyId: 'preview-outcome',
      },
      audit,
      consent: permissiveConsent([directory]),
    })
    const host = new PreviewHost({ seam, consent: permissiveConsent([directory]), readyTimeoutMs: 10_000 })
    let exitSent = false
    host.on('exit', () => {
      exitSent = true
      observeExit()
    })

    expect((await host.start({ previewId: 'p', recipe: 'preview', cwd: directory })).status).toBe('ready')
    await outcomeObserved
    const acknowledgedBeforeDurable = exitSent
    releaseOutcome()
    await exitObserved
    await host.stopAll()

    expect(acknowledgedBeforeDurable).toBe(false)
  }, 15_000)

  it('AS-21 withholds preview exit when the outcome append keeps rejecting', async () => {
    const directory = await temporaryDirectory()
    let previewSpawnId: string | undefined
    let outcomeAttempts = 0
    let observeOutcome!: () => void
    const outcomeObserved = new Promise<void>(resolve => {
      observeOutcome = resolve
    })
    const audit: AuditLog = {
      append: async record => {
        if (record.kind === 'spawn-admitted' && record.recipeId === 'preview') previewSpawnId = record.spawnId
        if (record.kind === 'spawn-outcome' && record.spawnId === previewSpawnId) {
          outcomeAttempts += 1
          observeOutcome()
          throw new Error('audit target unavailable')
        }
      },
    }
    const script = [
      "const net = require('node:net')",
      'const server = net.createServer()',
      "server.listen(0, '127.0.0.1')",
      'setInterval(() => {}, 1000)',
    ].join(';')
    const seam = createSpawnSeam({
      policy: {
        allowsExecutable: () => false,
        recipe: id => (id === 'preview' ? { command: process.execPath, args: ['-e', script] } : null),
        executables: [],
        keyId: 'preview-outcome-rejection',
      },
      audit,
      consent: permissiveConsent([directory]),
    })
    const host = new PreviewHost({ seam, consent: permissiveConsent([directory]), readyTimeoutMs: 10_000 })
    let exitSent = false
    host.on('exit', () => {
      exitSent = true
    })

    expect((await host.start({ previewId: 'p-reject', recipe: 'preview', cwd: directory })).status).toBe('ready')
    await host.stop('p-reject')
    await outcomeObserved
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(outcomeAttempts).toBeGreaterThanOrEqual(5)
    expect(exitSent).toBe(false)
    await host.stopAll()
  }, 15_000)

  it('AS-21 eventually records and emits one preview exit after an outage longer than one retry burst', async () => {
    const directory = await temporaryDirectory()
    let previewSpawnId: string | undefined
    let outcomeAttempts = 0
    const durableOutcomes: AuditRecord[] = []
    const audit: AuditLog = {
      append: async record => {
        if (record.kind === 'spawn-admitted' && record.recipeId === 'preview-recovery') previewSpawnId = record.spawnId
        if (record.kind !== 'spawn-outcome' || record.spawnId !== previewSpawnId) return
        outcomeAttempts += 1
        if (outcomeAttempts <= 7) throw new Error('temporary audit outage')
        durableOutcomes.push(record)
      },
    }
    const script = [
      "const net = require('node:net')",
      'const server = net.createServer()',
      "server.listen(0, '127.0.0.1')",
      'setInterval(() => {}, 1000)',
    ].join(';')
    const seam = createSpawnSeam({
      policy: {
        allowsExecutable: () => false,
        recipe: id => (id === 'preview-recovery' ? { command: process.execPath, args: ['-e', script] } : null),
        executables: [],
        keyId: 'preview-outcome-recovery',
      },
      audit,
      consent: permissiveConsent([directory]),
    })
    const host = new PreviewHost({ seam, consent: permissiveConsent([directory]), readyTimeoutMs: 10_000 })
    let exitCount = 0
    let observeExit!: () => void
    const exitObserved = new Promise<void>(resolve => {
      observeExit = resolve
    })
    host.on('exit', () => {
      exitCount += 1
      observeExit()
    })

    expect((await host.start({ previewId: 'p-recovery', recipe: 'preview-recovery', cwd: directory })).status).toBe('ready')
    await host.stop('p-recovery')
    await Promise.race([
      exitObserved,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('preview exit was not re-driven')), 4_000)),
    ])
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(outcomeAttempts).toBe(8)
    expect(durableOutcomes).toHaveLength(1)
    expect(exitCount).toBe(1)
    await host.stopAll()
  }, 15_000)

  it('AS-21 keeps an old preview exit re-drive bound to its spawn when the id is reused', async () => {
    const directory = await temporaryDirectory()
    let oldSpawnId: string | undefined
    let newSpawnId: string | undefined
    let oldOutcomeAttempts = 0
    const durableOutcomes: AuditRecord[] = []
    const audit: AuditLog = {
      append: async record => {
        if (record.kind === 'spawn-admitted' && record.recipeId === 'old-preview') oldSpawnId = record.spawnId
        if (record.kind === 'spawn-admitted' && record.recipeId === 'new-preview') newSpawnId = record.spawnId
        if (record.kind !== 'spawn-outcome') return
        if (record.spawnId === oldSpawnId) {
          oldOutcomeAttempts += 1
          if (oldOutcomeAttempts <= 5) throw new Error('old preview audit outage')
        }
        durableOutcomes.push(record)
      },
    }
    const script = [
      "const net = require('node:net')",
      'const server = net.createServer()',
      "server.listen(0, '127.0.0.1')",
      'setInterval(() => {}, 1000)',
    ].join(';')
    const seam = createSpawnSeam({
      policy: {
        allowsExecutable: () => false,
        recipe: id => (id === 'old-preview' || id === 'new-preview' ? { command: process.execPath, args: ['-e', script] } : null),
        executables: [],
        keyId: 'preview-id-reuse',
      },
      audit,
      consent: permissiveConsent([directory]),
    })
    const host = new PreviewHost({ seam, consent: permissiveConsent([directory]), readyTimeoutMs: 10_000 })

    expect((await host.start({ previewId: 'reused', recipe: 'old-preview', cwd: directory })).status).toBe('ready')
    await host.stop('reused')
    await waitUntil(() => oldOutcomeAttempts >= 5)
    const newStart = host.start({ previewId: 'reused', recipe: 'new-preview', cwd: directory })
    await waitUntil(() => oldOutcomeAttempts === 6)
    expect((await newStart).status).toBe('ready')

    expect(durableOutcomes.filter(record => record.kind === 'spawn-outcome' && record.spawnId === oldSpawnId)).toHaveLength(1)
    expect(durableOutcomes.filter(record => record.kind === 'spawn-outcome' && record.spawnId === newSpawnId)).toHaveLength(0)
    expect(host.list().some(preview => preview.previewId === 'reused')).toBe(true)

    await host.stop('reused')
    await waitUntil(() => durableOutcomes.some(record => record.kind === 'spawn-outcome' && record.spawnId === newSpawnId))
    expect(durableOutcomes.filter(record => record.kind === 'spawn-outcome' && record.spawnId === newSpawnId)).toHaveLength(1)
    await host.stopAll()
  }, 20_000)

  it('AS-21 does not return a post-admission preview refusal before its outcome is durable', async () => {
    const directory = await temporaryDirectory()
    let releaseOutcome!: () => void
    let observeOutcome!: () => void
    const outcomeReleased = new Promise<void>(resolve => {
      releaseOutcome = resolve
    })
    const outcomeObserved = new Promise<void>(resolve => {
      observeOutcome = resolve
    })
    let previewSpawnId: string | undefined
    const audit: AuditLog = {
      append: async record => {
        if (record.kind === 'spawn-admitted' && record.recipeId === 'missing') previewSpawnId = record.spawnId
        if (record.kind === 'spawn-outcome' && record.spawnId === previewSpawnId) {
          observeOutcome()
          await outcomeReleased
        }
      },
    }
    const seam = createSpawnSeam({
      policy: {
        allowsExecutable: () => false,
        recipe: id => (id === 'missing' ? { command: join(directory, 'missing-preview-command'), args: [] } : null),
        executables: [],
        keyId: 'preview-refusal-outcome',
      },
      audit,
      consent: permissiveConsent([directory]),
    })
    const host = new PreviewHost({ seam, consent: permissiveConsent([directory]), readyTimeoutMs: 1_000 })
    let settled = false
    const start = host.start({ previewId: 'missing', recipe: 'missing', cwd: directory }).then(outcome => {
      settled = true
      return outcome
    })

    await outcomeObserved
    await new Promise(resolve => setTimeout(resolve, 50))
    const acknowledgedBeforeDurable = settled
    releaseOutcome()
    const outcome = await start
    await host.stopAll()

    expect(acknowledgedBeforeDurable).toBe(false)
    expect(outcome.status).toBe('refused')
  })

  it('AS-21 withholds a post-admission preview refusal when its outcome append keeps rejecting', async () => {
    const directory = await temporaryDirectory()
    let previewSpawnId: string | undefined
    let observeOutcome!: () => void
    const outcomeObserved = new Promise<void>(resolve => {
      observeOutcome = resolve
    })
    const audit: AuditLog = {
      append: async record => {
        if (record.kind === 'spawn-admitted' && record.recipeId === 'missing-reject') previewSpawnId = record.spawnId
        if (record.kind === 'spawn-outcome' && record.spawnId === previewSpawnId) {
          observeOutcome()
          throw new Error('audit target unavailable')
        }
      },
    }
    const seam = createSpawnSeam({
      policy: {
        allowsExecutable: () => false,
        recipe: id => (id === 'missing-reject' ? { command: join(directory, 'missing-preview-command'), args: [] } : null),
        executables: [],
        keyId: 'preview-refusal-rejection',
      },
      audit,
      consent: permissiveConsent([directory]),
    })
    const host = new PreviewHost({ seam, consent: permissiveConsent([directory]), readyTimeoutMs: 1_000 })
    let refusalAcknowledged = false
    void host.start({ previewId: 'missing-reject', recipe: 'missing-reject', cwd: directory }).then(
      outcome => {
        refusalAcknowledged = outcome.status === 'refused'
      },
      () => undefined,
    )

    await outcomeObserved
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(refusalAcknowledged).toBe(false)
    await host.stopAll()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(refusalAcknowledged).toBe(false)
  })

  it('AS-21 retries a transient run outcome append without changing the observed outcome', async () => {
    const directory = await temporaryDirectory()
    let firstOutcome = true
    const records: AuditRecord[] = []
    const audit: AuditLog = {
      append: async record => {
        if (record.kind === 'spawn-outcome' && firstOutcome) {
          firstOutcome = false
          throw new Error('transient audit failure')
        }
        records.push(record)
      },
    }
    const seam = createSpawnSeam({ policy: allowedPolicy, audit })

    await expect(seam.run(
      { kind: 'probe', executable: process.execPath, cwd: directory, grantScoped: false },
      async () => ({ outcome: { exitCode: 0, signal: null }, value: 'probe-complete' }),
    )).resolves.toEqual({ status: 'ran', value: 'probe-complete' })
    expect(records.filter(record => record.kind === 'spawn-outcome')).toEqual([
      expect.objectContaining({ outcome: { exitCode: 0, signal: null } }),
    ])
  })

  it('AS-22 refuses before execution when the admission audit append fails', async () => {
    const directory = await temporaryDirectory()
    const failingAudit: AuditLog = {
      append: async () => {
        throw new Error('simulated durable-write failure')
      },
    }
    const seam = createSpawnSeam({ policy: allowedPolicy, audit: failingAudit })
    let executionCallbacks = 0

    const result = await seam.run(
      {
        kind: 'probe',
        executable: process.execPath,
        args: ['-e', 'process.exit(0)'],
        cwd: directory,
        grantScoped: false,
      },
      async () => {
        executionCallbacks += 1
        return { outcome: { exitCode: 0, signal: null }, value: 'executed' }
      },
    )

    expect(result).toMatchObject({
      status: 'refused',
      reason: 'spawn-failed',
      local: expect.stringMatching(/audit|durab/i),
    })
    expect(executionCallbacks).toBe(0)
  })

  it('AS-23 serializes concurrent appends into independently complete records in call order', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'audit.ndjson')
    const audit = openAuditLog({ path })
    const records = Array.from({ length: 40 }, (_, index) => killRecord(`concurrent-${index}`))

    await Promise.all(records.map(record => audit.append(record)))

    expect(parseRecords(await readFile(path, 'utf8'))).toEqual(records)
  })
})

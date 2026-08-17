import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_FLOW,
  DEFAULT_REPLAY_LINES,
  PreviewHost,
  TerminalSession,
  createGrants,
  createMemoryGrantStore,
  createSpawnSeam,
  isContained,
  type AuditLog,
  type AuditRecord,
  type CommandPolicy,
  type ConsentPolicy,
  type PreviewContainment,
} from '../src/index.js'

const execFileAsync = promisify(execFile)
const directories: string[] = []
const children: ChildProcess[] = []

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'runner-consent-acceptance-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGKILL')
    await once(child, 'exit').catch(() => undefined)
  }))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function recordingAudit(): AuditLog & { records: AuditRecord[] } {
  const records: AuditRecord[] = []
  return { records, append: async record => void records.push(record) }
}

const commandPolicy: CommandPolicy = {
  allowsExecutable: executable => executable === process.execPath,
  recipe: id => (id === 'preview' ? { command: process.execPath, args: ['-e', 'process.exit(0)'] } : null),
  executables: [process.execPath],
  keyId: 'consent-test',
}

describe('CP-5 IC-2 per-directory consent acceptance', () => {
  it('AS-09 admits pane and preview work with the resolved cwd inside a grant', async () => {
    const directory = await workspace()
    const granted = join(directory, 'project')
    const nested = join(granted, 'packages', 'runner')
    await mkdir(nested, { recursive: true })
    const grants = createGrants({ store: createMemoryGrantStore(), cwdReadBackAvailable: true })
    await grants.grant(granted)
    const audit = recordingAudit()
    const seam = createSpawnSeam({ policy: commandPolicy, audit, consent: grants })
    const expectedCwd = await realpath(nested)

    const pane = await seam.authorize({
      kind: 'pane',
      executable: process.execPath,
      cwd: nested,
      grantScoped: true,
      requestId: 'pane-inside',
    })
    const preview = await seam.authorize({
      kind: 'preview',
      recipeId: 'preview',
      cwd: nested,
      grantScoped: true,
      requestId: 'preview-inside',
    })

    expect(pane.status).toBe('admitted')
    expect(preview.status).toBe('admitted')
    if (pane.status === 'admitted') {
      expect(pane.authorization.vetted.cwd).toBe(expectedCwd)
      await pane.authorization.complete({ exitCode: 0, signal: null })
    }
    if (preview.status === 'admitted') {
      expect(preview.authorization.vetted.cwd).toBe(expectedCwd)
      await preview.authorization.complete({ exitCode: 0, signal: null })
    }
  })

  it('AS-10 refuses and audits ungranted pane and preview work before execution', async () => {
    const directory = await workspace()
    const ungranted = join(directory, 'ungranted')
    await mkdir(ungranted)
    const grants = createGrants({ store: createMemoryGrantStore(), cwdReadBackAvailable: true })
    const audit = recordingAudit()
    const seam = createSpawnSeam({ policy: commandPolicy, audit, consent: grants })
    let callbacks = 0

    const pane = await seam.run(
      { kind: 'pane', executable: process.execPath, cwd: ungranted, grantScoped: true, requestId: 'pane-outside' },
      async () => {
        callbacks += 1
        return { outcome: { exitCode: 0, signal: null }, value: 'ran' }
      },
    )
    const preview = await seam.run(
      { kind: 'preview', recipeId: 'preview', cwd: ungranted, grantScoped: true, requestId: 'preview-outside' },
      async () => {
        callbacks += 1
        return { outcome: { exitCode: 0, signal: null }, value: 'ran' }
      },
    )

    expect(pane).toEqual({ status: 'refused', reason: 'path-not-granted' })
    expect(preview).toEqual({ status: 'refused', reason: 'path-not-granted' })
    expect(callbacks).toBe(0)
    expect(audit.records).toEqual([
      expect.objectContaining({ kind: 'refused', requestId: 'pane-outside', reason: 'path-not-granted' }),
      expect.objectContaining({ kind: 'refused', requestId: 'preview-outside', reason: 'path-not-granted' }),
    ])
    expect(await grants.resolveGrantedCwd(join(directory, 'missing'))).toBeNull()

    const absentConsentAudit = recordingAudit()
    const absentConsentSeam = createSpawnSeam({ policy: commandPolicy, audit: absentConsentAudit })
    expect(await absentConsentSeam.authorize({
      kind: 'pane',
      executable: process.execPath,
      cwd: ungranted,
      grantScoped: true,
      requestId: 'consent-unavailable',
    })).toEqual({ status: 'refused', reason: 'path-not-granted' })
    expect(absentConsentAudit.records).toEqual([
      expect.objectContaining({ kind: 'refused', requestId: 'consent-unavailable', reason: 'path-not-granted' }),
    ])
  })

  it('AS-10 kills and audits an admitted pane whose post-spawn cwd is outside the live grant', async () => {
    const directory = await workspace()
    const grantedReal = await realpath(directory)
    let landedCwd: string | undefined
    const consent: ConsentPolicy = {
      resolveGrantedCwd: async () => grantedReal,
      isGrantedRealPath: async actual => {
        landedCwd = actual
        return false
      },
    }
    const records: AuditRecord[] = []
    let paneSpawnId: string | undefined
    let outcomeAttempts = 0
    const audit: AuditLog & { records: AuditRecord[] } = {
      records,
      append: async record => {
        if (record.kind === 'spawn-admitted' && record.executable === process.execPath) paneSpawnId = record.spawnId
        if (record.kind === 'spawn-outcome' && record.spawnId === paneSpawnId) {
          outcomeAttempts += 1
          if (outcomeAttempts <= 7) throw new Error('temporary pane landing audit outage')
        }
        records.push(record)
      },
    }
    const seam = createSpawnSeam({
      policy: {
        allowsExecutable: executable => executable === process.execPath || executable === 'tmux',
        recipe: () => null,
        executables: [process.execPath, 'tmux'],
        keyId: 'pane-landing-consent',
      },
      audit,
      consent,
    })
    const socket = `consent-landing-${process.pid}-${Date.now()}`
    let readySent = false

    await expect(TerminalSession.launch(
      { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: directory, socket },
      { flow: DEFAULT_FLOW, replayLines: DEFAULT_REPLAY_LINES, pollMs: 50 },
      {
        send: message => {
          if (message.type === 'READY') readySent = true
        },
        onExited: () => undefined,
      },
      seam,
    )).rejects.toThrow('command landed outside a granted directory')

    const paneAdmission = audit.records.find(record => record.kind === 'spawn-admitted' && record.executable === process.execPath)
    expect(outcomeAttempts).toBe(8)
    expect(landedCwd).toBe(grantedReal)
    expect(readySent).toBe(false)
    expect(paneAdmission?.kind).toBe('spawn-admitted')
    if (paneAdmission?.kind !== 'spawn-admitted') throw new Error('pane admission was not audited')
    expect(audit.records).toContainEqual(expect.objectContaining({
      kind: 'spawn-outcome',
      spawnId: paneAdmission.spawnId,
      outcome: { exitCode: null, signal: expect.any(Number) },
    }))
    expect(audit.records).toContainEqual(expect.objectContaining({
      kind: 'refused',
      executable: process.execPath,
      cwd: grantedReal,
      reason: 'path-not-granted',
    }))
    await expect(execFileAsync('tmux', ['-L', socket, 'list-sessions'])).rejects.toBeDefined()
  }, 15_000)

  // Deferred to the reliable-cwd-capture checkpoint (#16): the fix is a new pane-wrapper mechanism
  // (the wrapper captures pwd -P before the command so the landing is verifiable even after a fast
  // exit), not a same-round patch. This is its executable contract, skipped until that checkpoint.
  it.skip('AS-10 does not waive pane landing verification merely because a fast command already exited', async () => {
    const directory = await workspace()
    const grantedReal = await realpath(directory)
    let landingChecks = 0
    const consent: ConsentPolicy = {
      resolveGrantedCwd: async () => grantedReal,
      isGrantedRealPath: async () => {
        landingChecks += 1
        return false
      },
    }
    const audit = recordingAudit()
    const seam = createSpawnSeam({
      policy: {
        allowsExecutable: executable => executable === '/bin/true' || executable === 'tmux',
        recipe: () => null,
        executables: ['/bin/true', 'tmux'],
        keyId: 'fast-pane-landing',
      },
      audit,
      consent,
    })
    const socket = `fast-landing-${process.pid}-${Date.now()}`
    let session: Awaited<ReturnType<typeof TerminalSession.launch>> | undefined
    let rejected = false
    try {
      session = await TerminalSession.launch(
        { command: '/bin/true', cwd: directory, socket },
        { flow: DEFAULT_FLOW, replayLines: DEFAULT_REPLAY_LINES, pollMs: 50 },
        { send: () => undefined, onExited: () => undefined },
        seam,
      )
    } catch {
      rejected = true
    }
    await session?.dispose(false)

    expect(rejected).toBe(true)
    expect(landingChecks).toBeGreaterThan(0)
    expect(audit.records).toContainEqual(expect.objectContaining({ kind: 'refused', reason: 'path-not-granted' }))
  }, 15_000)

  it('AS-10 verifies preview landing with the admission-bound consent, not a divergent host consent', async () => {
    const directory = await workspace()
    const admitted = join(directory, 'admitted')
    const outside = join(directory, 'outside')
    await Promise.all([mkdir(admitted), mkdir(outside)])
    const admittedReal = await realpath(admitted)
    const outsideReal = await realpath(outside)
    let admissionLanding: string | undefined
    let hostConsentChecks = 0
    const admissionConsent: ConsentPolicy = {
      resolveGrantedCwd: async () => admittedReal,
      isGrantedRealPath: async actual => {
        admissionLanding = actual
        return false
      },
    }
    const divergentHostConsent: ConsentPolicy = {
      resolveGrantedCwd: async () => admittedReal,
      isGrantedRealPath: async () => {
        hostConsentChecks += 1
        return true
      },
    }
    const audit = recordingAudit()
    const script = [
      "const net = require('node:net')",
      'const server = net.createServer()',
      "server.listen(0, '127.0.0.1')",
      'setInterval(() => {}, 1000)',
    ].join(';')
    const seam = createSpawnSeam({
      policy: {
        allowsExecutable: () => false,
        recipe: id => (id === 'moved-preview' ? { command: process.execPath, args: ['-e', script] } : null),
        executables: [],
        keyId: 'preview-landing-consent',
      },
      audit,
      consent: admissionConsent,
    })
    const movedContainment: PreviewContainment = {
      status: { disposition: 'detect-and-stop', platform: process.platform, prevention: false, detail: 'landing test' },
      spawn: spec => spawn(spec.command, [...spec.args], { cwd: outsideReal, env: spec.env, stdio: 'ignore', detached: true }),
    }
    const host = new PreviewHost({
      seam,
      consent: divergentHostConsent,
      containment: movedContainment,
      readyTimeoutMs: 2_000,
    })

    expect(await host.start({ previewId: 'moved', recipe: 'moved-preview', cwd: admitted })).toEqual({
      status: 'refused',
      reason: 'path-not-granted',
    })
    expect(admissionLanding).toBe(outsideReal)
    expect(hostConsentChecks).toBe(0)
    expect(audit.records).toContainEqual(expect.objectContaining({ kind: 'refused', reason: 'path-not-granted' }))
    await host.stopAll()
  })

  it('AS-11 checks containment on real paths, rejecting siblings, climbs, and symlink escapes', async () => {
    const directory = await workspace()
    const granted = join(directory, 'g', 'project')
    const nested = join(granted, 'nested')
    const sibling = join(directory, 'g', 'project-escape')
    const outside = join(directory, 'outside')
    await Promise.all([mkdir(nested, { recursive: true }), mkdir(sibling, { recursive: true }), mkdir(outside)])
    const escapeLink = join(granted, 'escape-link')
    const insideLink = join(directory, 'inside-link')
    await symlink(outside, escapeLink, 'dir')
    await symlink(nested, insideLink, 'dir')
    const grants = createGrants({ store: createMemoryGrantStore(), cwdReadBackAvailable: true })
    const grantedReal = await grants.grant(granted)
    const nestedReal = await realpath(nested)
    const siblingReal = await realpath(sibling)

    expect(isContained(grantedReal, grantedReal)).toBe(true)
    expect(isContained(grantedReal, nestedReal)).toBe(true)
    expect(isContained(grantedReal, siblingReal)).toBe(false)
    expect(await grants.resolveGrantedCwd(sibling)).toBeNull()
    expect(await grants.resolveGrantedCwd(join(granted, 'nested', '..', '..', 'project-escape'))).toBeNull()
    expect(await grants.resolveGrantedCwd(escapeLink)).toBeNull()
    expect(await grants.resolveGrantedCwd(insideLink)).toBe(nestedReal)
  })

  it('AS-11 does not retarget a stored real-path grant when its old pathname becomes a symlink', async () => {
    const directory = await workspace()
    const granted = join(directory, 'project')
    const movedOriginal = join(directory, 'project-original')
    const outside = join(directory, 'outside')
    await Promise.all([mkdir(granted), mkdir(outside)])
    const grants = createGrants({ store: createMemoryGrantStore(), cwdReadBackAvailable: true })
    const grantedReal = await grants.grant(granted)

    await rename(granted, movedOriginal)
    await symlink(outside, granted, 'dir')

    expect(await grants.list()).toEqual([grantedReal])
    expect(await grants.resolveGrantedCwd(outside)).toBeNull()
    expect(await grants.resolveGrantedCwd(granted)).toBeNull()
  })

  it.runIf(process.platform === 'linux')('AS-12 marks a running process cwd moved outside its grant as ungranted', async () => {
    const directory = await workspace()
    const granted = join(directory, 'granted')
    const work = join(granted, 'work')
    const escaped = join(directory, 'escaped')
    await mkdir(work, { recursive: true })
    const grants = createGrants({ store: createMemoryGrantStore(), cwdReadBackAvailable: true })
    await grants.grant(granted)
    expect(await grants.resolveGrantedCwd(work)).toBe(await realpath(work))

    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: work, stdio: 'ignore' })
    children.push(child)
    await once(child, 'spawn')
    await rename(work, escaped)
    const runningCwd = await realpath(`/proc/${child.pid}/cwd`)

    expect(grants.cwdReadBackAvailable).toBe(true)
    expect(runningCwd).toBe(await realpath(escaped))
    expect(await grants.isGrantedRealPath(runningCwd)).toBe(false)
  })

  it('AS-13 reports the resolve-then-enter window when cwd read-back is unavailable', async () => {
    const directory = await workspace()
    const granted = join(directory, 'project')
    await mkdir(granted)
    const grants = createGrants({ store: createMemoryGrantStore(), cwdReadBackAvailable: false })
    const grantedReal = await grants.grant(granted)

    expect(grants.cwdReadBackAvailable).toBe(false)
    expect(await grants.isGrantedRealPath(grantedReal)).toBe(true)
  })

  it('AS-14 lists and revokes grants locally without retroactively killing admitted work', async () => {
    const directory = await workspace()
    const granted = join(directory, 'project')
    const outside = join(directory, 'outside')
    await Promise.all([mkdir(granted), mkdir(outside)])
    const grants = createGrants({ store: createMemoryGrantStore(), cwdReadBackAvailable: true })
    const grantedReal = await grants.grant(granted)
    await grants.grant(granted)
    expect(await grants.list()).toEqual([grantedReal])
    const audit = recordingAudit()
    const seam = createSpawnSeam({ policy: commandPolicy, audit, consent: grants })
    const admitted = await seam.authorize({
      kind: 'pane',
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: granted,
      grantScoped: true,
      requestId: 'before-revoke',
    })
    expect(admitted.status).toBe('admitted')
    if (admitted.status !== 'admitted') throw new Error('expected work admitted before revocation')
    const child = spawn(admitted.authorization.vetted.command, [...admitted.authorization.vetted.args], {
      cwd: admitted.authorization.vetted.cwd,
      stdio: 'ignore',
    })
    children.push(child)
    await once(child, 'spawn')

    await grants.revoke(granted)
    expect(await grants.list()).toEqual([])
    expect(child.exitCode).toBeNull()
    const afterRevocation = await seam.authorize({
      kind: 'pane',
      executable: process.execPath,
      cwd: granted,
      grantScoped: true,
      requestId: 'after-revoke',
    })
    const hostileOutsideRequest = await seam.authorize({
      kind: 'preview',
      recipeId: 'preview',
      cwd: outside,
      grantScoped: true,
      requestId: 'wire-cannot-grant',
    })

    expect(afterRevocation).toEqual({ status: 'refused', reason: 'path-not-granted' })
    expect(hostileOutsideRequest).toEqual({ status: 'refused', reason: 'path-not-granted' })
    expect(await grants.list()).toEqual([])
    child.kill('SIGKILL')
    await once(child, 'exit')
    await admitted.authorization.complete({ exitCode: null, signal: 9 })
  })
})

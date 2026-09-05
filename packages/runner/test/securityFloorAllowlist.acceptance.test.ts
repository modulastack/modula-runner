import { generateKeyPairSync } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, mkdtemp, open as openFile, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_ALLOWLIST_EXECUTABLES,
  DEFAULT_FLOW,
  DEFAULT_REPLAY_LINES,
  TerminalSession,
  allowlistKeyId,
  createSpawnSeam,
  loadTrustedAllowlist,
  signAllowlist,
  type Allowlist,
  type AllowlistRejection,
  type AllowlistSigningKey,
  type AuditRecord,
  type CommandPolicy,
  type SignedAllowlist,
  type SpawnKind,
  type TrustAnchor,
  type VettedSpawn,
} from '../src/index.js'
import { openAuditLogFixture } from './appendOnlyAuditFixture.js'
import { permissiveConsent } from './spawnSeamSupport.js'

// The seam resolves a caller-named path inside one synchronous tick, so no real filesystem race
// fits between two resolutions of it. This wrapper never fabricates a result — it observes the
// platform's own realpathSync and, for a path a case stages, performs the relink an attacker with
// write access to that symlink would, immediately after the first resolution. Nothing is staged
// by default, so every other case in this file resolves paths exactly as it did before.
const pathResolutions = vi.hoisted(() => ({
  resolved: [] as string[],
  relinkAfterFirstResolution: null as { path: string; target: string } | null,
}))

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const realpathSync = ((target: string, ...rest: unknown[]) => {
    const resolved = (actual.realpathSync as (...args: unknown[]) => string)(target, ...rest)
    pathResolutions.resolved.push(String(target))
    const staged = pathResolutions.relinkAfterFirstResolution
    if (staged && target === staged.path) {
      pathResolutions.relinkAfterFirstResolution = null
      actual.unlinkSync(staged.path)
      actual.symlinkSync(staged.target, staged.path)
    }
    return resolved
  }) as typeof actual.realpathSync
  const patched = { ...actual, realpathSync }
  return { ...patched, default: patched }
})

afterEach(() => {
  pathResolutions.resolved.length = 0
  pathResolutions.relinkAfterFirstResolution = null
})

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'runner-security-floor-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function signingIdentity(_label: string): { anchor: TrustAnchor; key: AllowlistSigningKey } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const keyId = allowlistKeyId(publicKey)
  return {
    anchor: { keyId, publicKey },
    key: { keyId, privateKey },
  }
}

function allowlist(executables: readonly string[] = DEFAULT_ALLOWLIST_EXECUTABLES): Allowlist {
  return {
    executables,
    recipes: {
      docs: { command: process.execPath, args: ['-e', 'process.stdout.write("signed-preview")'] },
    },
  }
}

async function writeEnvelope(path: string, envelope: SignedAllowlist): Promise<void> {
  await writeFile(path, JSON.stringify(envelope), { mode: 0o600 })
}

async function loadPolicy(path: string, anchors: readonly TrustAnchor[]): Promise<CommandPolicy> {
  const result = await loadTrustedAllowlist({ path, trustAnchors: anchors })
  expect(result.status).toBe('trusted')
  if (result.status !== 'trusted') throw new Error(`expected trusted allowlist, received ${result.reason}`)
  return result.policy
}

async function auditRecords(path: string): Promise<AuditRecord[]> {
  const raw = await readFile(path, 'utf8')
  return raw
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as AuditRecord)
}

async function executeVetted(vetted: VettedSpawn): Promise<{ outcome: { exitCode: 0; signal: null }; value: string }> {
  const { stdout } = await execFileAsync(vetted.command, [...vetted.args], { cwd: vetted.cwd })
  return { outcome: { exitCode: 0, signal: null }, value: stdout }
}

describe('CP-5 IC-1 security-floor acceptance', () => {
  it('AS-01 honors an allowlist signed by the locally trusted Ed25519 key', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'allowlist.json')
    const identity = signingIdentity('operator-root')
    await writeEnvelope(path, signAllowlist(allowlist(), identity.key))

    const policy = await loadPolicy(path, [identity.anchor])

    expect(policy.keyId).toBe(identity.anchor.keyId)
    expect(policy.executables).toEqual(DEFAULT_ALLOWLIST_EXECUTABLES)
    expect(policy.recipe('docs')).toEqual({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("signed-preview")'],
    })
    for (const inheritedName of ['toString', 'constructor', '__proto__']) {
      expect(() => policy.recipe(inheritedName)).not.toThrow()
      expect(policy.recipe(inheritedName)).toBeNull()
    }
  })

  it('AS-02 rejects missing, unsigned, malformed, foreign-signed, bad-signature, and tampered policy files', async () => {
    const directory = await temporaryDirectory()
    const trusted = signingIdentity('trusted')
    const foreign = signingIdentity('foreign')
    const document = allowlist()
    const trustedEnvelope = signAllowlist(document, trusted.key)
    const cases: Array<{ name: string; raw?: string; reason: AllowlistRejection }> = [
      { name: 'missing', reason: 'missing' },
      {
        name: 'unsigned',
        raw: JSON.stringify({ allowlist: document, keyId: trusted.key.keyId }),
        reason: 'malformed',
      },
      { name: 'malformed', raw: '{', reason: 'malformed' },
      {
        name: 'foreign-signed',
        raw: JSON.stringify(signAllowlist(document, foreign.key)),
        reason: 'unknown-key',
      },
      {
        name: 'bad-signature',
        raw: JSON.stringify({ ...signAllowlist(document, foreign.key), keyId: trusted.key.keyId }),
        reason: 'bad-signature',
      },
      {
        name: 'tampered',
        raw: JSON.stringify({
          ...trustedEnvelope,
          allowlist: { ...trustedEnvelope.allowlist, executables: [...trustedEnvelope.allowlist.executables, 'remote-shell'] },
        }),
        reason: 'bad-signature',
      },
    ]

    for (const fixture of cases) {
      const path = join(directory, `${fixture.name}.json`)
      if (fixture.raw !== undefined) await writeFile(path, fixture.raw)
      await expect(loadTrustedAllowlist({ path, trustAnchors: [trusted.anchor] })).resolves.toEqual({
        status: 'untrusted',
        reason: fixture.reason,
      })
    }
  })

  it('AS-02 refuses a FIFO immediately and bounds a file that grows after its stat', async () => {
    const directory = await temporaryDirectory()
    const fifoPath = join(directory, 'allowlist.fifo')
    await execFileAsync('mkfifo', [fifoPath])
    await expect(Promise.race([
      loadTrustedAllowlist({ path: fifoPath, trustAnchors: [] }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('FIFO allowlist read stalled')), 1_000)),
    ])).resolves.toEqual({ status: 'untrusted', reason: 'missing' })

    const growingPath = join(directory, 'growing-allowlist.json')
    await writeFile(growingPath, '{}')
    const probe = await openFile(join(directory, 'stat-probe'), 'w')
    type StatTarget = { stat(options?: unknown): Promise<unknown> }
    const prototype = Object.getPrototypeOf(probe) as StatTarget
    const originalStat = prototype.stat
    await probe.close()
    let enlarged = false
    prototype.stat = async function (this: StatTarget, options?: unknown): Promise<unknown> {
      const result = await originalStat.call(this, options)
      if (!enlarged) {
        enlarged = true
        await appendFile(growingPath, Buffer.alloc(64 * 1024 + 1, 0x61))
      }
      return result
    }
    try {
      await expect(loadTrustedAllowlist({ path: growingPath, trustAnchors: [] })).resolves.toEqual({
        status: 'untrusted',
        reason: 'missing',
      })
    } finally {
      prototype.stat = originalStat
    }
  })

  it('AS-03 honors locally re-signed additions and removals without a wire round trip', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'allowlist.json')
    const identity = signingIdentity('local-editor')
    const original = allowlist()
    await writeEnvelope(path, signAllowlist(original, identity.key))
    expect((await loadPolicy(path, [identity.anchor])).allowsExecutable('local-tool')).toBe(false)

    const added = { ...original, executables: [...original.executables, 'local-tool'] }
    await writeEnvelope(path, signAllowlist(added, identity.key))
    expect((await loadPolicy(path, [identity.anchor])).allowsExecutable('local-tool')).toBe(true)

    await writeEnvelope(path, signAllowlist(original, identity.key))
    expect((await loadPolicy(path, [identity.anchor])).allowsExecutable('local-tool')).toBe(false)
  })

  it('AS-04 keeps a loaded policy and trust identity unchanged under hostile and replayed requests', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'allowlist.json')
    const auditPath = join(directory, 'audit.ndjson')
    const identity = signingIdentity('local-only')
    await writeEnvelope(path, signAllowlist(allowlist(), identity.key))
    const policy = await loadPolicy(path, [identity.anchor])
    const seam = createSpawnSeam({ policy, audit: openAuditLogFixture({ path: auditPath }) })
    const requests = [
      { kind: 'preview' as const, recipeId: 'remote-recipe', cwd: directory, grantScoped: true, requestId: 'wire-1' },
      { kind: 'preview' as const, recipeId: 'remote-recipe', cwd: directory, grantScoped: true, requestId: 'wire-1' },
      { kind: 'pane' as const, executable: 'remote-shell', cwd: directory, grantScoped: true, requestId: 'wire-2' },
    ]

    for (const request of requests) {
      const result = await seam.authorize(request)
      expect(result).toMatchObject({ status: 'refused', reason: 'not-allowlisted' })
    }
    try {
      ;(policy.executables as string[]).push('remote-shell')
    } catch {
      // Runtime freezing is acceptable; effective policy immutability is the assertion below.
    }
    expect(policy.keyId).toBe(identity.anchor.keyId)
    expect(policy.executables).not.toContain('remote-shell')
    expect(policy.allowsExecutable('remote-shell')).toBe(false)
    expect(policy.recipe('remote-recipe')).toBeNull()
  })

  it('AS-05 exposes exactly the contracted default executable set', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'allowlist.json')
    const identity = signingIdentity('default-policy')
    const defaultDocument: Allowlist = { executables: DEFAULT_ALLOWLIST_EXECUTABLES, recipes: {} }
    await writeEnvelope(path, signAllowlist(defaultDocument, identity.key))

    const policy = await loadPolicy(path, [identity.anchor])

    expect([...DEFAULT_ALLOWLIST_EXECUTABLES]).toEqual(['claude', 'codex', 'pi', 'goose', 'git', 'gh', 'tmux'])
    expect(policy.executables).toEqual(['claude', 'codex', 'pi', 'goose', 'git', 'gh', 'tmux'])
    for (const executable of DEFAULT_ALLOWLIST_EXECUTABLES) expect(policy.allowsExecutable(executable)).toBe(true)
    for (const executable of ['bash', 'sh', 'node', 'python', 'ruby', 'remote-shell']) {
      expect(policy.allowsExecutable(executable)).toBe(false)
    }
  })

  it('AS-06 gates pane, preview, git, tmux, and probe spawns before their real execution callbacks', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'allowlist.json')
    const auditPath = join(directory, 'audit.ndjson')
    const identity = signingIdentity('spawn-policy')
    const document: Allowlist = {
      executables: [process.execPath],
      recipes: {
        preview: { command: process.execPath, args: ['-e', 'process.stdout.write("signed-preview")'] },
      },
    }
    await writeEnvelope(path, signAllowlist(document, identity.key))
    const policy = await loadPolicy(path, [identity.anchor])
    const seam = createSpawnSeam({ policy, audit: openAuditLogFixture({ path: auditPath }), now: () => 1_700_000_000_000, consent: permissiveConsent([directory]) })
    const directKinds: Exclude<SpawnKind, 'preview'>[] = ['pane', 'git', 'tmux', 'probe']

    for (const kind of directKinds) {
      const result = await seam.run(
        {
          kind,
          executable: process.execPath,
          args: ['-e', `process.stdout.write(${JSON.stringify(kind)})`],
          cwd: directory,
          grantScoped: kind === 'pane',
        },
        executeVetted,
      )
      expect(result).toEqual({ status: 'ran', value: kind })
    }

    const preview = await seam.run(
      {
        kind: 'preview',
        recipeId: 'preview',
        args: ['remote-argument-must-be-ignored'],
        cwd: directory,
        grantScoped: true,
      },
      executeVetted,
    )
    expect(preview).toEqual({ status: 'ran', value: 'signed-preview' })

    let forbiddenCallbacks = 0
    for (const kind of directKinds) {
      const result = await seam.run(
        { kind, executable: 'remote-shell', cwd: directory, grantScoped: kind === 'pane' },
        async vetted => {
          forbiddenCallbacks += 1
          return executeVetted(vetted)
        },
      )
      expect(result).toMatchObject({ status: 'refused', reason: 'not-allowlisted' })
    }
    const unknownPreview = await seam.run(
      { kind: 'preview', recipeId: 'remote-recipe', cwd: directory, grantScoped: true },
      async vetted => {
        forbiddenCallbacks += 1
        return executeVetted(vetted)
      },
    )
    expect(unknownPreview).toMatchObject({ status: 'refused', reason: 'not-allowlisted' })
    expect(forbiddenCallbacks).toBe(0)
  })

  it('AS-06 denies the pane logical command even when tmux itself is allowlisted', async () => {
    const directory = await temporaryDirectory()
    const auditPath = join(directory, 'audit.ndjson')
    const sentinel = join(directory, 'pane-command-ran')
    const audit = openAuditLogFixture({ path: auditPath })
    const seam = createSpawnSeam({
      policy: {
        allowsExecutable: executable => executable === 'tmux',
        recipe: () => null,
        executables: ['tmux'],
        keyId: 'tmux-only',
      },
      audit,
    })
    let session: TerminalSession | undefined
    let launchError: unknown

    try {
      session = await TerminalSession.launch(
        {
          command: process.execPath,
          args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')`],
          cwd: directory,
        },
        { flow: DEFAULT_FLOW, replayLines: DEFAULT_REPLAY_LINES, pollMs: 50 },
        { send: () => undefined, onExited: () => undefined },
        seam,
      )
    } catch (error) {
      launchError = error
    } finally {
      if (session) await session.dispose(true)
    }

    expect(launchError).toBeInstanceOf(Error)
    expect(existsSync(sentinel)).toBe(false)
    expect(await auditRecords(auditPath)).toEqual([
      expect.objectContaining({ kind: 'refused', executable: process.execPath, reason: 'not-allowlisted' }),
    ])
  })

  it('AS-07 refuses and durably audits unknown pane executables and preview recipes without admission', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'allowlist.json')
    const auditPath = join(directory, 'audit.ndjson')
    const identity = signingIdentity('refusal-policy')
    await writeEnvelope(path, signAllowlist(allowlist(), identity.key))
    const policy = await loadPolicy(path, [identity.anchor])
    const seam = createSpawnSeam({ policy, audit: openAuditLogFixture({ path: auditPath }), now: () => 1_700_000_000_000 })

    const pane = await seam.authorize({
      kind: 'pane',
      executable: 'remote-shell',
      cwd: directory,
      grantScoped: true,
      requestId: 'pane-request',
    })
    const preview = await seam.authorize({
      kind: 'preview',
      recipeId: 'remote-recipe',
      cwd: directory,
      grantScoped: true,
      requestId: 'preview-request',
    })

    expect(pane).toMatchObject({ status: 'refused', reason: 'not-allowlisted' })
    expect(preview).toMatchObject({ status: 'refused', reason: 'not-allowlisted' })
    expect(await auditRecords(auditPath)).toEqual([
      expect.objectContaining({
        kind: 'refused',
        requestId: 'pane-request',
        executable: 'remote-shell',
        recipeId: null,
        reason: 'not-allowlisted',
      }),
      expect.objectContaining({
        kind: 'refused',
        requestId: 'preview-request',
        executable: null,
        recipeId: 'remote-recipe',
        reason: 'not-allowlisted',
      }),
    ])
  })

  it('AS-06 leaves an allowlisted bare command to PATH rather than a same-named file in the working directory', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'allowlist.json')
    const auditPath = join(directory, 'audit.ndjson')
    const identity = signingIdentity('bare-command-policy')
    await writeEnvelope(path, signAllowlist(allowlist(['decoy-tool']), identity.key))
    await writeFile(join(directory, 'decoy-tool'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const policy = await loadPolicy(path, [identity.anchor])
    const seam = createSpawnSeam({ policy, audit: openAuditLogFixture({ path: auditPath }), now: () => 1_700_000_000_000 })

    const previousCwd = process.cwd()
    let admitted: VettedSpawn | undefined
    try {
      process.chdir(directory)
      const result = await seam.authorize({ kind: 'probe', executable: 'decoy-tool', cwd: directory, grantScoped: false })
      if (result.status === 'admitted') admitted = result.authorization.vetted
    } finally {
      // chdir is process-wide, so it is restored before any assertion can abort the case, and this
      // case must never be copied into a concurrent describe.
      process.chdir(previousCwd)
    }

    expect(admitted?.command).toBe('decoy-tool')
    expect(await auditRecords(auditPath)).toEqual([
      expect.objectContaining({ kind: 'spawn-admitted', spawnKind: 'probe', executable: 'decoy-tool' }),
    ])
  })

  it('AS-06 admits the executable the signed document names, not another path that resolves to the same file', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'allowlist.json')
    const auditPath = join(directory, 'audit.ndjson')
    const identity = signingIdentity('alias-policy')
    const wrapper = join(directory, 'wrapper')
    await symlink(process.execPath, wrapper)
    await writeEnvelope(path, signAllowlist(allowlist([wrapper]), identity.key))
    const policy = await loadPolicy(path, [identity.anchor])
    const seam = createSpawnSeam({ policy, audit: openAuditLogFixture({ path: auditPath }), now: () => 1_700_000_000_000 })

    const listed = await seam.authorize({ kind: 'probe', executable: wrapper, cwd: directory, grantScoped: false })
    const aliased = await seam.authorize({ kind: 'probe', executable: process.execPath, cwd: directory, grantScoped: false })

    expect(listed).toMatchObject({ status: 'admitted' })
    expect(aliased).toMatchObject({ status: 'refused', reason: 'not-allowlisted' })
  })

  it('AS-06 spawns and audits the target its admission approved when the symlink moves under it', async () => {
    const root = await realpath(await temporaryDirectory())
    const path = join(root, 'allowlist.json')
    const auditPath = join(root, 'audit.ndjson')
    const identity = signingIdentity('relinked-alias-policy')
    const approved = join(root, 'approved-tool')
    const substituted = join(root, 'substituted-tool')
    const named = join(root, 'named-tool')
    await writeFile(approved, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await writeFile(substituted, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await symlink(approved, named)
    await writeEnvelope(path, signAllowlist(allowlist([approved]), identity.key))
    const policy = await loadPolicy(path, [identity.anchor])
    const seam = createSpawnSeam({ policy, audit: openAuditLogFixture({ path: auditPath }), now: () => 1_700_000_000_000 })
    pathResolutions.relinkAfterFirstResolution = { path: named, target: substituted }

    const result = await seam.authorize({ kind: 'probe', executable: named, cwd: root, grantScoped: false })

    expect(result).toMatchObject({ status: 'admitted' })
    expect(result.status === 'admitted' ? result.authorization.vetted.command : null).toBe(approved)
    expect(pathResolutions.resolved.filter(entry => entry === named)).toEqual([named])
    expect(await auditRecords(auditPath)).toEqual([
      expect.objectContaining({ kind: 'spawn-admitted', spawnKind: 'probe', executable: approved }),
    ])
  })

  it('AS-06 resolves an admitted absolute executable exactly once and a bare one not at all', async () => {
    const root = await realpath(await temporaryDirectory())
    const path = join(root, 'allowlist.json')
    const auditPath = join(root, 'audit.ndjson')
    const identity = signingIdentity('resolution-count-policy')
    const approved = join(root, 'approved-tool')
    const named = join(root, 'named-tool')
    await writeFile(approved, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await symlink(approved, named)
    await writeEnvelope(path, signAllowlist(allowlist([named, 'tmux']), identity.key))
    const policy = await loadPolicy(path, [identity.anchor])
    const seam = createSpawnSeam({ policy, audit: openAuditLogFixture({ path: auditPath }), now: () => 1_700_000_000_000 })

    const result = await seam.authorize({ kind: 'probe', executable: named, cwd: root, grantScoped: false })

    expect(result).toMatchObject({ status: 'admitted' })
    expect(pathResolutions.resolved.filter(entry => entry === named)).toEqual([named])

    // The accepted cost of resolving before the membership test: a listed absolute name resolves
    // once per check where it used to resolve none. Short-circuiting that away is how the seam
    // regains two resolutions of one name, so the count is asserted rather than left free.
    pathResolutions.resolved.length = 0
    expect(seam.check(named)).toBe(true)
    expect(pathResolutions.resolved).toEqual([named])

    pathResolutions.resolved.length = 0
    expect(seam.check('tmux')).toBe(true)
    expect(pathResolutions.resolved).toEqual([])
  })
})

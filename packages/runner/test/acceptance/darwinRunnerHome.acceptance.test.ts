import { fork, spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { AuditRecordInputV2, RunnerCliIo, RunnerHomeStorage } from '../../src/index.js'

const describeOnDarwin = process.platform === 'darwin' ? describe : describe.skip
const roots: string[] = []
const storages: RunnerHomeStorage[] = []
const clock = { now: () => Date.parse('2026-09-01T00:00:00Z'), sleep: async () => undefined }

afterEach(async () => {
  await Promise.all(storages.splice(0).map(storage => storage.close?.()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryHome(prefix = 'runner-home-darwin-') {
  const parent = await mkdtemp(path.join(tmpdir(), prefix))
  roots.push(parent)
  return { parent, root: path.join(parent, 'home') }
}

async function runner() {
  return await import('../../src/index.js')
}

async function storage(root: string): Promise<RunnerHomeStorage> {
  const { createFileRunnerHomeStorage } = await runner()
  const value = createFileRunnerHomeStorage({ defaultRoot: root })
  storages.push(value)
  return value
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value)
}

async function policySnapshot() {
  const { allowlistKeyId, signAllowlist } = await runner()
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const keyId = allowlistKeyId(publicPem)
  return {
    revision: 1,
    allowlist: signAllowlist(
      { executables: ['git'], recipes: {} },
      { keyId, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
    ),
    trustAnchors: [{ keyId, publicKey: publicPem }],
  }
}

async function seedTrustedPolicy(root: string) {
  const snapshot = await policySnapshot()
  await writeFile(path.join(root, 'policy.trust.json'), `${canonicalJson({
    schemaVersion: 1,
    revision: snapshot.revision,
    anchors: snapshot.trustAnchors,
    allowlist: snapshot.allowlist,
  })}\n`, { mode: 0o600 })
}

function auditRecord(index: number): AuditRecordInputV2 {
  return {
    schemaVersion: 2,
    eventId: `darwin-event-${index}`,
    at: `2026-09-01T00:00:0${index}.000Z`,
    kind: 'capability-refresh-admitted',
    refreshId: `refresh-${index}`,
    runtimeIds: [`runtime-${index}`],
    runtimeIntentions: 1,
    endpointIntentions: 1,
  }
}

function invocation(args: string[], home: string) {
  const stdout: string[] = []
  const stderr: string[] = []
  const io: RunnerCliIo = {
    inputIsTTY: false,
    readHidden: async () => { throw new Error('hidden input was not expected') },
    writeStdout: text => stdout.push(text),
    writeStderr: text => stderr.push(text),
  }
  return { value: { args, cwd: home, environment: { runnerHome: home }, io }, stdout, stderr }
}

async function forkLeaseHolder(root: string) {
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'darwinRunnerHomeLeaseChild.mjs')
  const child = fork(fixture, [root], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const message = await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lease child did not report acquisition')), 5_000)
    child.once('message', value => {
      clearTimeout(timer)
      resolve(value)
    })
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`lease child exited before acquisition: code=${code ?? 'null'} signal=${signal ?? 'null'}`))
    })
  })
  expect(message).toEqual({ acquired: 'acquired' })
  return child
}

describeOnDarwin('Darwin arm64 runner-home acceptance', () => {
  it('creates, inspects, reads, replaces, and rejects stale compare-and-set writes', async () => {
    expect(process.arch).toBe('arm64')
    const { root } = await temporaryHome()
    const home = await storage(root)
    const inspected = await home.inspect({})
    expect(inspected).toMatchObject({ rootKind: 'directory', rootOwner: 'current-user', rootMode: 0o700 })
    expect(inspected.entries.every(entry => entry.kind === 'missing')).toBe(true)

    const initial = Buffer.from('{"revision":1}\n')
    const written = await home.replace('configuration', null, initial)
    expect(written).toMatchObject({ status: 'written', sha256: createHash('sha256').update(initial).digest('hex') })
    if (written.status !== 'written') throw new Error('configuration write did not succeed')
    await expect(home.read('configuration')).resolves.toMatchObject({ status: 'found', bytes: initial, sha256: written.sha256 })
    await expect(home.replace('configuration', null, Buffer.from('stale\n'))).resolves.toEqual({
      status: 'conflict',
      currentSha256: written.sha256,
    })
  })

  it('fails closed when the bound root or ancestor is replaced and never writes into the replacement', async () => {
    const { parent, root } = await temporaryHome()
    const home = await storage(root)
    await home.inspect({})
    await rm(root, { recursive: true, force: true })
    await mkdir(root, { mode: 0o700 })
    await expect(home.replace('projects', null, Buffer.from('unsafe'))).resolves.toEqual({ status: 'storage-unavailable' })
    await expect(lstat(path.join(root, 'projects.json'))).rejects.toMatchObject({ code: 'ENOENT' })

    const ancestorHome = await storage(path.join(parent, 'ancestor', 'home'))
    await ancestorHome.inspect({})
    await rm(path.join(parent, 'ancestor'), { recursive: true, force: true })
    await mkdir(path.join(parent, 'ancestor', 'home'), { recursive: true, mode: 0o700 })
    await expect(ancestorHome.replace('projects', null, Buffer.from('unsafe'))).resolves.toEqual({ status: 'storage-unavailable' })
    await expect(lstat(path.join(parent, 'ancestor', 'home', 'projects.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed for symlink, hardlink, FIFO, wrong-owner, and permissive-mode records', async () => {
    const { parent, root } = await temporaryHome()
    const home = await storage(root)
    await home.inspect({})
    await home.replace('configuration', null, Buffer.from('private'))
    await chmod(path.join(root, 'configuration.json'), 0o644)
    await expect(home.read('configuration')).resolves.toEqual({ status: 'storage-unavailable' })

    await chmod(path.join(root, 'configuration.json'), 0o600)
    await link(path.join(root, 'configuration.json'), path.join(parent, 'configuration-hardlink'))
    await expect(home.read('configuration')).resolves.toEqual({ status: 'storage-unavailable' })

    await symlink(path.join(parent, 'outside'), path.join(root, 'grants.json'))
    await expect(home.read('grants')).resolves.toEqual({ status: 'storage-unavailable' })

    const fifo = path.join(root, 'projects.json')
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0)
    const inspected = await home.inspect({})
    expect(inspected.entries.find(entry => entry.record === 'projects')).toMatchObject({ kind: 'other' })
    await expect(home.read('projects')).resolves.toEqual({ status: 'storage-unavailable' })

    const { createFileRunnerHomeStorage } = await runner()
    const wrongOwner = createFileRunnerHomeStorage({ defaultRoot: root, currentUserId: (process.getuid?.() ?? 0) + 1 })
    storages.push(wrongOwner)
    await expect(wrongOwner.inspect({})).resolves.toMatchObject({ rootOwner: 'other', entries: [] })
    await expect(wrongOwner.read('configuration')).resolves.toEqual({ status: 'storage-unavailable' })
  })

  it('cleans valid interrupted temporary files and fails closed on malformed or excessive temporary state', async () => {
    const { root } = await temporaryHome()
    const home = await storage(root)
    await home.inspect({})
    const valid = path.join(root, `receipts.json.tmp-${'a'.repeat(32)}`)
    await writeFile(valid, 'partial', { mode: 0o600 })
    await expect(home.replace('projects', null, Buffer.from('written'))).resolves.toMatchObject({ status: 'written' })
    await expect(lstat(valid)).rejects.toMatchObject({ code: 'ENOENT' })

    const malformed = path.join(root, 'receipts.json.tmp-not-hex')
    await writeFile(malformed, 'unknown', { mode: 0o600 })
    await expect(home.replace('configuration', null, Buffer.from('blocked'))).resolves.toEqual({ status: 'storage-unavailable' })
    await expect(readFile(malformed, 'utf8')).resolves.toBe('unknown')

    await rm(malformed)
    const excessive = Array.from({ length: 129 }, (_, index) => path.join(root, `projects.json.tmp-${index.toString(16).padStart(32, '0')}`))
    await Promise.all(excessive.map(file => writeFile(file, '', { mode: 0o600 })))
    await expect(home.replace('configuration', null, Buffer.from('blocked'))).resolves.toEqual({ status: 'storage-unavailable' })
    await expect(lstat(excessive[0]!)).resolves.toMatchObject({ size: 0 })

    await Promise.all(excessive.map(file => rm(file)))
    const oversized = path.join(root, `receipts.json.tmp-${'b'.repeat(32)}`)
    await writeFile(oversized, '', { mode: 0o600 })
    await truncate(oversized, 26 * 1024 * 1024)
    await expect(home.replace('configuration', null, Buffer.from('blocked'))).resolves.toEqual({ status: 'storage-unavailable' })
  })

  it('enforces cross-process foreground lease contention', async () => {
    const { root } = await temporaryHome()
    const first = await storage(root)
    await first.inspect({})
    const child = await forkLeaseHolder(root)
    try {
      await expect(first.acquire!()).resolves.toBe('busy')
    } finally {
      child.kill('SIGTERM')
      await new Promise(resolve => child.once('exit', resolve))
    }
  })

  it('releases the kernel lease after SIGKILL sudden death for a later process', async () => {
    const { root } = await temporaryHome()
    const child = await forkLeaseHolder(root)
    child.kill('SIGKILL')
    await new Promise(resolve => child.once('exit', resolve))

    const next = await storage(root)
    await next.inspect({})
    await expect(next.acquire!()).resolves.toBe('acquired')
    await next.release!()
  })

  it('recovers audit state, appends, durably replaces segments, and preserves archive custody', async () => {
    const { root, parent } = await temporaryHome('runner-home-darwin-audit-')
    const { archiveRunnerAudit, openRunnerAuditLifecycle } = await runner()
    const opened = await openRunnerAuditLifecycle({ runnerHome: root })
    expect(opened.status).toBe('ready')
    if (opened.status !== 'ready') throw new Error('audit lifecycle did not open')
    await opened.audit.append(auditRecord(1))
    await opened.audit.close()

    const recovered = await openRunnerAuditLifecycle({ runnerHome: root })
    expect(recovered.status).toBe('ready')
    if (recovered.status !== 'ready') throw new Error('audit lifecycle did not recover')
    await recovered.audit.append(auditRecord(2))
    await recovered.audit.close()

    const destination = path.join(parent, 'archive')
    await mkdir(destination, { mode: 0o700 })
    await expect(archiveRunnerAudit({ runnerHome: root, destination })).resolves.toMatchObject({ status: 'archived' })
    const archived = await readdir(destination)
    expect(archived.some(name => name.endsWith('.jsonl'))).toBe(true)
    expect(archived.some(name => name.includes(root))).toBe(false)
  })

  it('installs with a verified Darwin arm64 native binary and no runtime compiler fallback', async () => {
    const rootManifest = JSON.parse(await readFile('package.json', 'utf8')) as { os?: string[]; cpu?: string[] }
    const packageManifest = JSON.parse(await readFile('packages/runner/package.json', 'utf8')) as { os?: string[]; cpu?: string[]; dependencies?: Record<string, string> }
    expect(rootManifest.os).toContain('darwin')
    expect(rootManifest.cpu).toContain('arm64')
    expect(packageManifest.os).toContain('darwin')
    expect(packageManifest.cpu).toContain('arm64')
    expect(packageManifest.dependencies).toHaveProperty('@modulastack/darwin-file-lock')

    const lockPackage = JSON.parse(await readFile('packages/darwin-file-lock/package.json', 'utf8')) as Record<string, unknown>
    expect(lockPackage).not.toHaveProperty('scripts')
    expect(lockPackage).not.toHaveProperty('dependencies')
    const loader = await readFile('packages/darwin-file-lock/index.js', 'utf8')
    expect(loader).not.toMatch(/node-gyp|prebuild|build\/Release|process\.env|clang|make|xcodebuild/)
    await expect(lstat('packages/darwin-file-lock/binaries/fs-ext-darwin-arm64-node-22.0.0.node'))
      .resolves.toMatchObject({ nlink: 1 })
  })

  it('keeps Darwin unsupported until the full Darwin acceptance lane is available', async () => {
    const packageManifest = JSON.parse(await readFile('packages/runner/package.json', 'utf8')) as { os?: string[]; dependencies?: Record<string, string> }
    const declaresDarwin = packageManifest.os?.includes('darwin') ?? false
    const hasNativeLock = Boolean(packageManifest.dependencies?.['@modulastack/darwin-file-lock'])
    expect(declaresDarwin).toBe(hasNativeLock)
  })

  it('does not accept /dev/fd descriptor-path emulation on Darwin', async () => {
    const { root } = await temporaryHome()
    const home = await storage(root)
    await home.inspect({})
    await expect(home.acquire!()).resolves.toBe('acquired')
    await expect(home.descriptorRoot?.()).resolves.toBeNull()
    await home.release!()
  })

  it('exercises Darwin support through the installed runner application interface', async () => {
    const { root } = await temporaryHome()
    await mkdir(root, { mode: 0o700 })
    await seedTrustedPolicy(root)
    const { createInstalledRunnerApplication } = await runner()
    const app = createInstalledRunnerApplication({ version: '0.1.0', defaultHomeRoot: root })
    const status = invocation(['status', '--json'], root)
    await expect(app.execute(status.value)).resolves.toBe(0)
    expect(JSON.parse(status.stdout.join(''))).toMatchObject({ status: 'ready' })
    await app.execute(invocation(['audit', 'archive', '--output', path.join(path.dirname(root), 'archive')], root).value)
  })
})

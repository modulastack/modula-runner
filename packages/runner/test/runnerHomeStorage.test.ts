import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFileRunnerHomeStorage } from '../src/index.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryHome() {
  const parent = await mkdtemp(path.join(tmpdir(), 'runner-home-storage-'))
  roots.push(parent)
  return { parent, root: path.join(parent, 'home') }
}

describe('file runner-home storage', () => {
  it('creates a private home and performs durable SHA-256 compare-and-set replacement', async () => {
    const { root } = await temporaryHome()
    const storage = createFileRunnerHomeStorage({ defaultRoot: root })
    const inspection = await storage.inspect({})
    expect(inspection).toMatchObject({ rootKind: 'directory', rootOwner: 'current-user', rootMode: 0o700 })
    expect(inspection.entries.every(entry => entry.kind === 'missing')).toBe(true)

    const bytes = Buffer.from('{"revision":1}')
    const written = await storage.replace('configuration', null, bytes)
    expect(written).toMatchObject({ status: 'written' })
    if (written.status !== 'written') throw new Error('configuration was not written')
    const info = await lstat(path.join(root, 'configuration.json'))
    expect(info.mode & 0o777).toBe(0o600)
    expect(info.nlink).toBe(1)
    await expect(storage.read('configuration')).resolves.toMatchObject({ status: 'found', sha256: written.sha256 })
    await expect(storage.replace('configuration', null, Buffer.from('other'))).resolves.toEqual({
      status: 'conflict',
      currentSha256: written.sha256,
    })
  })

  it('keeps one selected root bound and rejects a different override before touching it', async () => {
    const { parent, root } = await temporaryHome()
    const other = path.join(parent, 'other-home')
    const storage = createFileRunnerHomeStorage({ defaultRoot: root })
    await expect(storage.inspect({})).resolves.toMatchObject({ rootKind: 'directory' })
    await expect(storage.inspect({ override: root })).resolves.toMatchObject({ rootKind: 'directory' })
    await expect(storage.inspect({ override: other })).rejects.toThrow('cannot reselect a bound runner home')
    await expect(lstat(other)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes competing compare-and-set writers so exactly one wins', async () => {
    const { root } = await temporaryHome()
    const storage = createFileRunnerHomeStorage({ defaultRoot: root })
    await storage.inspect({})
    const first = await storage.replace('projects', null, Buffer.from('initial'))
    if (first.status !== 'written') throw new Error('initial project record was not written')
    const outcomes = await Promise.all([
      storage.replace('projects', first.sha256, Buffer.from('one')),
      storage.replace('projects', first.sha256, Buffer.from('two')),
    ])
    expect(outcomes.map(outcome => outcome.status).sort()).toEqual(['conflict', 'written'])
    const held = await storage.read('projects')
    expect(held.status).toBe('found')
    if (held.status === 'found') expect(['one', 'two']).toContain(Buffer.from(held.bytes).toString('utf8'))
  })

  it('serializes compare-and-set across storage instances bound to one root', async () => {
    const { root } = await temporaryHome()
    const first = createFileRunnerHomeStorage({ defaultRoot: root })
    const second = createFileRunnerHomeStorage({ defaultRoot: root })
    await first.inspect({})
    await second.inspect({})
    const initial = await first.replace('projects', null, Buffer.from('initial'))
    if (initial.status !== 'written') throw new Error('initial project record was not written')
    const outcomes = await Promise.all([
      first.replace('projects', initial.sha256, Buffer.from('one')),
      second.replace('projects', initial.sha256, Buffer.from('two')),
    ])
    expect(outcomes.map(outcome => outcome.status).sort()).toEqual(['conflict', 'written'])
    expect(['one', 'two']).toContain(await readFile(path.join(root, 'projects.json'), 'utf8'))
  })

  it('retires a secure mutation lock owned by an absent process', async () => {
    const { root } = await temporaryHome()
    const storage = createFileRunnerHomeStorage({ defaultRoot: root })
    await storage.inspect({})
    await writeFile(path.join(root, '.records.lock'), '{"pid":2147483647}\n', { mode: 0o600 })
    await expect(storage.replace('projects', null, Buffer.from('recovered'))).resolves.toMatchObject({ status: 'written' })
    await expect(lstat(path.join(root, '.records.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes concurrent stale-lock reapers before a new owner writes', async () => {
    const { root } = await temporaryHome()
    const first = createFileRunnerHomeStorage({ defaultRoot: root })
    const second = createFileRunnerHomeStorage({ defaultRoot: root })
    await first.inspect({})
    await second.inspect({})
    await writeFile(path.join(root, '.records.lock'), '{"pid":2147483647}\n', { mode: 0o600 })
    const outcomes = await Promise.all([
      first.replace('projects', null, Buffer.from('one')),
      second.replace('projects', null, Buffer.from('two')),
    ])
    expect(outcomes.map(outcome => outcome.status).sort()).toEqual(['conflict', 'written'])
    expect(['one', 'two']).toContain(await readFile(path.join(root, 'projects.json'), 'utf8'))
  })

  it('returns bounded reads without retaining the record-limit allocation', async () => {
    const { root } = await temporaryHome()
    const storage = createFileRunnerHomeStorage({ defaultRoot: root })
    await storage.inspect({})
    await expect(storage.replace('receipts', null, Buffer.from('x'))).resolves.toMatchObject({ status: 'written' })
    const held = await storage.read('receipts')
    expect(held.status).toBe('found')
    if (held.status === 'found') {
      expect(held.bytes.byteLength).toBe(1)
      expect(held.bytes.buffer.byteLength).toBeLessThanOrEqual(8 * 1024)
    }
  })

  it('fails closed on permissive, linked, and symlinked records', async () => {
    const { parent, root } = await temporaryHome()
    const storage = createFileRunnerHomeStorage({ defaultRoot: root })
    await storage.inspect({})
    await storage.replace('configuration', null, Buffer.from('private'))
    const configuration = path.join(root, 'configuration.json')
    await chmod(configuration, 0o644)
    await expect(storage.read('configuration')).resolves.toEqual({ status: 'storage-unavailable' })

    await chmod(configuration, 0o600)
    await link(configuration, path.join(parent, 'hard-link'))
    await expect(storage.read('configuration')).resolves.toEqual({ status: 'storage-unavailable' })

    const target = path.join(parent, 'outside')
    await writeFile(target, 'outside', { mode: 0o600 })
    await symlink(target, path.join(root, 'grants.json'))
    const inspection = await storage.inspect({})
    expect(inspection.entries.find(entry => entry.record === 'grants')?.kind).toBe('symlink')
    await expect(storage.read('grants')).resolves.toEqual({ status: 'storage-unavailable' })
  })

  it('reports an insecure or symlinked root without opening records through it', async () => {
    const { parent, root } = await temporaryHome()
    await mkdir(root, { mode: 0o755 })
    const insecure = createFileRunnerHomeStorage({ defaultRoot: root })
    await expect(insecure.inspect({})).resolves.toMatchObject({ rootKind: 'directory', rootMode: 0o755, entries: [] })
    await expect(insecure.read('configuration')).resolves.toEqual({ status: 'storage-unavailable' })

    const target = path.join(parent, 'target-home')
    await mkdir(target, { mode: 0o700 })
    await writeFile(path.join(target, 'configuration.json'), 'outside', { mode: 0o600 })
    const alias = path.join(parent, 'alias-home')
    await symlink(target, alias)
    const linked = createFileRunnerHomeStorage({ defaultRoot: alias })
    await expect(linked.inspect({})).resolves.toMatchObject({ rootKind: 'symlink', entries: [] })
    await expect(linked.read('configuration')).resolves.toEqual({ status: 'storage-unavailable' })
  })

  it('keeps the inspected directory descriptor open so a deleted inode cannot be rebound', async () => {
    const { root } = await temporaryHome()
    const storage = createFileRunnerHomeStorage({ defaultRoot: root })
    await storage.inspect({})
    const initial = await lstat(root)
    await rm(root, { recursive: true })
    for (let attempt = 0; attempt < 32; attempt += 1) {
      await mkdir(root, { mode: 0o700 })
      const replacement = await lstat(root)
      expect(`${replacement.dev}:${replacement.ino}`).not.toBe(`${initial.dev}:${initial.ino}`)
      await rm(root, { recursive: true })
    }
    await mkdir(root, { mode: 0o700 })
    await expect(storage.read('configuration')).resolves.toEqual({ status: 'storage-unavailable' })
    await expect(storage.replace('configuration', null, Buffer.from('unsafe'))).resolves.toEqual({ status: 'storage-unavailable' })
  })

  it('holds one foreground lease per home and releases it for the next runner', async () => {
    const { root } = await temporaryHome()
    const first = createFileRunnerHomeStorage({ defaultRoot: root })
    const second = createFileRunnerHomeStorage({ defaultRoot: root })
    await first.inspect({})
    await second.inspect({})
    const outcomes = await Promise.all([first.acquire!(), second.acquire!()])
    expect([...outcomes].sort()).toEqual(['acquired', 'busy'])
    const winner = outcomes[0] === 'acquired' ? first : second
    const contender = winner === first ? second : first
    await expect(winner.acquire!()).resolves.toBe('busy')
    await contender.release!()
    await winner.release!()
    await expect(contender.acquire!()).resolves.toBe('acquired')
    await contender.release!()
  })

  it('reclaims a well-formed lock whose owning process no longer exists', async () => {
    const { root } = await temporaryHome()
    const storage = createFileRunnerHomeStorage({ defaultRoot: root })
    await storage.inspect({})
    await writeFile(path.join(root, 'runner.lock'), '{"pid":2147483647,"identity":"linux:stale:1"}\n', { mode: 0o600 })
    await expect(storage.acquire!()).resolves.toBe('acquired')
    await storage.release!()
    await expect(lstat(path.join(root, 'runner.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reclaims a live reused PID when its process-start identity differs', async () => {
    const { root } = await temporaryHome()
    const storage = createFileRunnerHomeStorage({ defaultRoot: root })
    await storage.inspect({})
    await writeFile(path.join(root, 'runner.lock'), `${JSON.stringify({ pid: process.pid, identity: 'stale-process-instance' })}\n`, { mode: 0o600 })
    await expect(storage.acquire!()).resolves.toBe('acquired')
    await storage.release!()
  })
})

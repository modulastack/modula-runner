import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { archiveRunnerAudit, openRunnerAuditLifecycle, type AuditRecordInputV2 } from '../src/index.js'

const roots: string[] = []

async function root() {
  const value = await mkdtemp(path.join(tmpdir(), 'runner-audit-migration-'))
  roots.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(value => rm(value, { recursive: true, force: true })))
})

const legacyRecords = [
  { kind: 'kill', confirmed: true, details: 'operator stop', at: '2026-08-22T00:00:00.000Z' },
  {
    kind: 'spawn-admitted',
    spawnId: 'spawn-1',
    executable: 'git',
    recipeId: null,
    cwd: '/repo',
    at: '2026-08-22T00:00:01.000Z',
  },
]

function legacyBytes() {
  return Buffer.from(`${legacyRecords.map(record => JSON.stringify(record)).join('\n')}\n`)
}

function v2Record(): AuditRecordInputV2 {
  return {
    schemaVersion: 2,
    eventId: 'event-3',
    at: '2026-08-22T00:00:02.000Z',
    kind: 'kill',
    confirmed: true,
    targetCount: 1,
    targetsSha256: 'a'.repeat(64),
  }
}

async function writeLegacy(targetRoot: string, name = 'audit.jsonl') {
  await writeFile(path.join(targetRoot, name), legacyBytes(), { mode: 0o600 })
}

describe('legacy audit migration', () => {
  it('copies legacy JSONL exactly into a schema-v1 sealed prefix and continues at the next sequence', async () => {
    const targetRoot = await root()
    await writeLegacy(targetRoot)

    const opened = await openRunnerAuditLifecycle({ runnerHome: targetRoot })
    if (opened.status !== 'ready') throw new Error('legacy audit did not migrate')
    await opened.audit.append(v2Record())
    await opened.audit.close()

    const audit = path.join(targetRoot, 'audit.jsonl')
    expect((await lstat(audit)).isDirectory()).toBe(true)
    await expect(lstat(path.join(targetRoot, 'audit.jsonl.legacy'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(path.join(audit, 'segment-00000000000000000001.jsonl'))).toEqual(legacyBytes())
    const manifest = JSON.parse(await readFile(path.join(audit, 'segment-00000000000000000001.manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({ recordSchemaVersion: 1, records: 2, firstRecordSequence: '1', lastRecordSequence: '2' })
    const next = await readFile(path.join(audit, 'segment-00000000000000000002.open'), 'utf8')
    expect(JSON.parse(next).sequence).toBe('3')
    expect(JSON.parse(await readFile(path.join(audit, 'migration.json'), 'utf8'))).toMatchObject({ legacyRecords: 2 })
  })

  it('fails closed without replacing a malformed or incomplete legacy source', async () => {
    for (const bytes of [Buffer.from('{"kind":"kill"}\n'), Buffer.from(`${JSON.stringify(legacyRecords[0])}\nnot-json`)]) {
      const targetRoot = await root()
      await writeFile(path.join(targetRoot, 'audit.jsonl'), bytes, { mode: 0o600 })
      await expect(openRunnerAuditLifecycle({ runnerHome: targetRoot })).resolves.toEqual({ status: 'storage-unavailable' })
      expect((await lstat(path.join(targetRoot, 'audit.jsonl'))).isFile()).toBe(true)
    }
  })

  it('rebuilds an interrupted staging directory while the legacy source remains authoritative', async () => {
    const targetRoot = await root()
    await writeLegacy(targetRoot)
    const staging = path.join(targetRoot, 'audit.jsonl.migrating')
    await mkdir(staging, { mode: 0o700 })
    await writeFile(path.join(staging, 'partial'), 'incomplete', { mode: 0o600 })

    const opened = await openRunnerAuditLifecycle({ runnerHome: targetRoot })
    expect(opened.status).toBe('ready')
    if (opened.status === 'ready') await opened.audit.close()
  })

  it('resumes the rename boundary from a verified staged directory and legacy backup', async () => {
    const completedRoot = await root()
    await writeLegacy(completedRoot)
    const completed = await openRunnerAuditLifecycle({ runnerHome: completedRoot })
    if (completed.status !== 'ready') throw new Error('fixture migration failed')
    await completed.audit.close()

    const interruptedRoot = await root()
    await writeLegacy(interruptedRoot, 'audit.jsonl.legacy')
    await cp(path.join(completedRoot, 'audit.jsonl'), path.join(interruptedRoot, 'audit.jsonl.migrating'), { recursive: true })
    const resumed = await openRunnerAuditLifecycle({ runnerHome: interruptedRoot })
    expect(resumed.status).toBe('ready')
    if (resumed.status === 'ready') await resumed.audit.close()
    expect((await lstat(path.join(interruptedRoot, 'audit.jsonl'))).isDirectory()).toBe(true)
    await expect(lstat(path.join(interruptedRoot, 'audit.jsonl.legacy'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('archives a migrated legacy prefix through the same acknowledgement path', async () => {
    const targetRoot = await root()
    const destination = await root()
    await writeLegacy(targetRoot)
    const opened = await openRunnerAuditLifecycle({ runnerHome: targetRoot })
    if (opened.status !== 'ready') throw new Error('legacy audit did not migrate')
    await opened.audit.close()

    await expect(archiveRunnerAudit({ runnerHome: targetRoot, destination })).resolves.toMatchObject({ status: 'archived', segments: 1 })
    const names = await readdir(path.join(targetRoot, 'audit.jsonl'))
    expect(names).toEqual(expect.arrayContaining([
      'segment-00000000000000000001.ack.json',
      'segment-00000000000000000001.tombstone.json',
      'migration.json',
    ]))
  })
})

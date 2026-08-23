import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_AUDIT_SEGMENT_BYTES,
  archiveRunnerAudit,
  openRunnerAuditLifecycle,
  type AuditRecordInputV2,
} from '../src/index.js'
import { encodeAuditRecord } from '../src/auditRecordCodec.js'

const roots: string[] = []

async function directory(prefix: string) {
  const value = await mkdtemp(path.join(tmpdir(), prefix))
  roots.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function auditDirectory(root: string) {
  return path.join(root, 'audit.jsonl')
}

function sourcePath(root: string, sequence: number, extension: string) {
  return path.join(auditDirectory(root), `segment-${String(sequence).padStart(20, '0')}.${extension}`)
}

function largeAdmission(index: number): AuditRecordInputV2 {
  return {
    schemaVersion: 2,
    eventId: `event-${index}`,
    at: '2026-08-22T00:00:00.000Z',
    kind: 'capability-refresh-admitted',
    refreshId: `refresh-${index}`,
    runtimeIds: Array.from({ length: 32 }, (_, runtime) => `runtime-${runtime}-${'x'.repeat(96)}`).sort(),
    runtimeIntentions: 64,
    endpointIntentions: 8,
  }
}

async function sealOne(root: string) {
  const initial = await openRunnerAuditLifecycle({ runnerHome: root })
  if (initial.status !== 'ready') throw new Error('audit lifecycle did not open')
  await initial.audit.close()

  const chunks: Buffer[] = []
  let bytes = 0
  let index = 1
  for (;;) {
    const encoded = encodeAuditRecord(largeAdmission(index), String(index))
    if (bytes + encoded.byteLength > MAX_AUDIT_SEGMENT_BYTES) break
    chunks.push(encoded)
    bytes += encoded.byteLength
    index += 1
  }
  const seeded = Buffer.concat(chunks)
  await writeFile(sourcePath(root, 1, 'open'), seeded, { mode: 0o600 })
  await writeFile(sourcePath(root, 1, 'commit.json'), `${JSON.stringify({
    schemaVersion: 1,
    segmentSequence: '1',
    bytes: seeded.byteLength,
    records: chunks.length,
    lastRecordSequence: String(chunks.length),
    sha256: createHash('sha256').update(seeded).digest('hex'),
  })}\n`)
  const recovered = await openRunnerAuditLifecycle({ runnerHome: root })
  if (recovered.status !== 'ready') throw new Error('audit lifecycle did not recover')
  await recovered.audit.append(largeAdmission(index))
  await recovered.audit.close()
  return { records: chunks.length, nextRecord: index + 1 }
}

describe('offline audit archive', () => {
  it('copies, acknowledges, tombstones, and reclaims an exact sealed segment', async () => {
    const root = await directory('runner-audit-source-')
    const destination = await directory('runner-audit-destination-')
    const seeded = await sealOne(root)

    const result = await archiveRunnerAudit({ runnerHome: root, destination, now: () => Date.parse('2026-08-22T00:10:00Z') })

    expect(result).toMatchObject({ status: 'archived', segments: 1 })
    const sourceNames = await readdir(auditDirectory(root))
    expect(sourceNames).toEqual(expect.arrayContaining([
      'segment-00000000000000000001.manifest.json',
      'segment-00000000000000000001.ack.json',
      'segment-00000000000000000001.tombstone.json',
      'segment-00000000000000000002.open',
    ]))
    expect(sourceNames).not.toContain('segment-00000000000000000001.jsonl')
    expect(await readdir(destination)).toHaveLength(2)
    const acknowledgement = await readFile(sourcePath(root, 1, 'ack.json'), 'utf8')
    expect(acknowledgement).not.toContain(destination)

    const reopened = await openRunnerAuditLifecycle({ runnerHome: root })
    if (reopened.status !== 'ready') throw new Error('audit lifecycle did not reopen after archive')
    await reopened.audit.append(largeAdmission(seeded.nextRecord))
    await reopened.audit.close()
  }, 30_000)

  it('is idempotent when destination bytes landed before source acknowledgement', async () => {
    const root = await directory('runner-audit-source-')
    const destination = await directory('runner-audit-destination-')
    await sealOne(root)
    const manifest = JSON.parse(await readFile(sourcePath(root, 1, 'manifest.json'), 'utf8'))
    const prefix = `segment-00000000000000000001-${manifest.sha256}`
    await copyFile(sourcePath(root, 1, 'jsonl'), path.join(destination, `${prefix}.jsonl`))
    await copyFile(sourcePath(root, 1, 'manifest.json'), path.join(destination, `${prefix}.manifest.json`))

    await expect(archiveRunnerAudit({ runnerHome: root, destination })).resolves.toMatchObject({ status: 'archived', segments: 1 })
    await expect(archiveRunnerAudit({ runnerHome: root, destination })).resolves.toEqual({ status: 'nothing-to-archive' })
    expect(await readdir(destination)).toHaveLength(2)
  }, 30_000)

  it('fails closed on a conflicting archive artifact without acknowledging or reclaiming', async () => {
    const root = await directory('runner-audit-source-')
    const destination = await directory('runner-audit-destination-')
    await sealOne(root)
    const manifest = JSON.parse(await readFile(sourcePath(root, 1, 'manifest.json'), 'utf8'))
    const conflict = path.join(destination, `segment-00000000000000000001-${manifest.sha256}.jsonl`)
    await writeFile(conflict, 'conflict', { mode: 0o600 })

    await expect(archiveRunnerAudit({ runnerHome: root, destination })).resolves.toEqual({ status: 'storage-unavailable' })
    expect(await stat(sourcePath(root, 1, 'jsonl'))).toBeDefined()
    expect((await readdir(auditDirectory(root))).some(name => name.endsWith('.ack.json'))).toBe(false)
  }, 30_000)

  it('rejects overlapping, insecure, and concurrently leased destinations', async () => {
    const root = await directory('runner-audit-source-')
    const destination = await directory('runner-audit-destination-')
    await expect(archiveRunnerAudit({ runnerHome: root, destination: root })).resolves.toEqual({ status: 'storage-unavailable' })
    await chmod(destination, 0o755)
    await expect(archiveRunnerAudit({ runnerHome: root, destination })).resolves.toEqual({ status: 'storage-unavailable' })
    await chmod(destination, 0o700)

    const active = await openRunnerAuditLifecycle({ runnerHome: root })
    if (active.status !== 'ready') throw new Error('audit lifecycle did not open')
    await expect(archiveRunnerAudit({ runnerHome: root, destination })).resolves.toEqual({ status: 'storage-unavailable' })
    await active.audit.close()
  })
})

import { createHash } from 'node:crypto'
import { appendFile, chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_AUDIT_SEGMENT_BYTES,
  openRunnerAuditLifecycle,
  type AuditRecordInputV2,
} from '../src/index.js'
import { decodeAuditRecord, encodeAuditRecord } from '../src/auditRecordCodec.js'

const roots: string[] = []

async function runnerHome() {
  const root = await mkdtemp(path.join(tmpdir(), 'runner-audit-lifecycle-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function spawnAdmission(index: number): AuditRecordInputV2 {
  return {
    schemaVersion: 2,
    eventId: `event-${index}`,
    at: '2026-08-22T00:00:00.000Z',
    kind: 'spawn-admitted',
    spawnId: `spawn-${index}`,
    spawnKind: 'pane',
    subjectId: null,
    requestId: null,
  }
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

function auditDirectory(root: string) {
  return path.join(root, 'audit.jsonl')
}

function openSegment(root: string, sequence = 1) {
  return path.join(auditDirectory(root), `segment-${String(sequence).padStart(20, '0')}.open`)
}

function openCommit(root: string, sequence = 1) {
  return path.join(auditDirectory(root), `segment-${String(sequence).padStart(20, '0')}.commit.json`)
}

describe('file audit lifecycle', () => {
  it('persists lifecycle-owned record sequences across reopen', async () => {
    const root = await runnerHome()
    const first = await openRunnerAuditLifecycle({ runnerHome: root })
    if (first.status !== 'ready') throw new Error('audit lifecycle did not open')
    await first.audit.append(spawnAdmission(1))
    await expect(first.audit.snapshot()).resolves.toMatchObject({ state: 'ready', residentSegments: 1, openSequence: '1' })
    await first.audit.close()

    const second = await openRunnerAuditLifecycle({ runnerHome: root })
    if (second.status !== 'ready') throw new Error('audit lifecycle did not reopen')
    await second.audit.append(spawnAdmission(2))
    await second.audit.close()

    const lines = (await readFile(openSegment(root), 'utf8')).trim().split('\n')
    expect(lines.map(line => decodeAuditRecord(Buffer.from(line))?.sequence)).toEqual(['1', '2'])
    expect((await stat(auditDirectory(root))).mode & 0o777).toBe(0o700)
    expect((await stat(openSegment(root))).mode & 0o777).toBe(0o600)
  })

  it('serializes concurrent appends without duplicate or reordered sequences', async () => {
    const root = await runnerHome()
    const opened = await openRunnerAuditLifecycle({ runnerHome: root })
    if (opened.status !== 'ready') throw new Error('audit lifecycle did not open')
    await Promise.all(Array.from({ length: 20 }, (_, index) => opened.audit.append(spawnAdmission(index + 1))))
    await opened.audit.close()

    const lines = (await readFile(openSegment(root), 'utf8')).trim().split('\n')
    expect(lines.map(line => decodeAuditRecord(Buffer.from(line))?.sequence)).toEqual(Array.from({ length: 20 }, (_, index) => String(index + 1)))
  })

  it('repairs only an incomplete unacknowledged final line', async () => {
    const root = await runnerHome()
    const first = await openRunnerAuditLifecycle({ runnerHome: root })
    if (first.status !== 'ready') throw new Error('audit lifecycle did not open')
    await first.audit.append(spawnAdmission(1))
    await first.audit.close()
    const pending = encodeAuditRecord(spawnAdmission(2), '2')
    const commit = JSON.parse(await readFile(openCommit(root), 'utf8'))
    await writeFile(openCommit(root), `${JSON.stringify({ ...commit, pendingRecordBase64: pending.toString('base64') })}\n`)
    await appendFile(openSegment(root), pending.subarray(0, Math.floor(pending.byteLength / 2)))

    const recovered = await openRunnerAuditLifecycle({ runnerHome: root })
    if (recovered.status !== 'ready') throw new Error('audit lifecycle did not recover')
    await recovered.audit.append(spawnAdmission(2))
    await recovered.audit.close()

    const raw = await readFile(openSegment(root), 'utf8')
    expect(raw).not.toContain('partial')
    expect(raw.trim().split('\n')).toHaveLength(2)
  })

  it('rotates a near-full valid segment and commits its digest manifest', async () => {
    const root = await runnerHome()
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
    await writeFile(openSegment(root), seeded, { mode: 0o600 })
    await writeFile(openCommit(root), `${JSON.stringify({
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

    const names = await readdir(auditDirectory(root))
    expect(names).toEqual(expect.arrayContaining([
      'segment-00000000000000000001.jsonl',
      'segment-00000000000000000001.manifest.json',
      'segment-00000000000000000002.open',
    ]))
    const sealed = await readFile(path.join(auditDirectory(root), 'segment-00000000000000000001.jsonl'))
    const manifest = JSON.parse(await readFile(path.join(auditDirectory(root), 'segment-00000000000000000001.manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({
      sequence: '1',
      state: 'sealed',
      bytes: sealed.byteLength,
      records: chunks.length,
      sha256: createHash('sha256').update(sealed).digest('hex'),
      firstRecordSequence: '1',
      lastRecordSequence: String(chunks.length),
    })
  }, 30_000)

  it('fails closed for an insecure audit directory and while another owner holds the home lease', async () => {
    const root = await runnerHome()
    await mkdir(auditDirectory(root), { mode: 0o700 })
    await chmod(auditDirectory(root), 0o755)
    await expect(openRunnerAuditLifecycle({ runnerHome: root })).resolves.toEqual({ status: 'storage-unavailable' })
    await chmod(auditDirectory(root), 0o700)

    const first = await openRunnerAuditLifecycle({ runnerHome: root })
    if (first.status !== 'ready') throw new Error('audit lifecycle did not open')
    await expect(openRunnerAuditLifecycle({ runnerHome: root })).resolves.toEqual({ status: 'storage-unavailable' })
    await first.audit.close()
  })
})

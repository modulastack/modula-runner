import { fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { archiveRunnerAudit, openRunnerAuditLifecycle, type AuditRecordInputV2 } from '../src/index.js'
import { openRunnerAuditLifecycleCore } from '../src/fileAuditLifecycleCore.js'
import { migrateLegacyAudit } from '../src/fileAuditMigration.js'
import { MAX_AUDIT_SEGMENT_BYTES } from '../src/auditLifecycle.js'
import { encodeAuditRecord } from '../src/auditRecordCodec.js'

const describeOnDarwin = process.platform === 'darwin' ? describe : describe.skip
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function auditRecord(index: number): AuditRecordInputV2 {
  return {
    schemaVersion: 2,
    eventId: `darwin-audit-${index}`,
    at: `2026-09-01T00:00:${String(index).padStart(2, '0')}.000Z`,
    kind: 'spawn-admitted',
    spawnId: `darwin-spawn-${index}`,
    spawnKind: 'pane',
    subjectId: null,
    requestId: null,
  }
}

function largeAuditRecord(index: number): AuditRecordInputV2 {
  return {
    schemaVersion: 2,
    eventId: `darwin-large-${index}`,
    at: '2026-09-01T00:00:00.000Z',
    kind: 'capability-refresh-admitted',
    refreshId: `refresh-${index}`,
    runtimeIds: Array.from({ length: 32 }, (_, runtime) => `runtime-${runtime}-${'x'.repeat(96)}`).sort(),
    runtimeIntentions: 64,
    endpointIntentions: 8,
  }
}

function auditPath(root: string, entry: string): string {
  return path.join(root, 'audit.jsonl', entry)
}

async function openReady(root: string) {
  const opened = await openRunnerAuditLifecycle({ runnerHome: root })
  if (opened.status !== 'ready') throw new Error('audit lifecycle did not open')
  return opened.audit
}

async function forkAuditHolder(root: string) {
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'darwinAuditLifecycleChild.mjs')
  const child = fork(fixture, [root], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('audit child did not report readiness')), 5_000)
    child.once('message', () => {
      clearTimeout(timer)
      resolve()
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`audit child exited early: code=${code ?? 'null'} signal=${signal ?? 'null'}`))
    })
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
  return child
}

describeOnDarwin('Darwin descriptor-backed audit lifecycle', () => {
  it('recovers a non-empty current segment and archives it without path-derived custody', async () => {
    const parent = await tempRoot('darwin-audit-descriptor-')
    const root = path.join(parent, 'home')
    const destination = path.join(parent, 'archive')
    await mkdir(destination, { mode: 0o700 })

    const first = await openReady(root)
    await first.append(auditRecord(1))
    await first.close()

    const recovered = await openReady(root)
    await recovered.append(auditRecord(2))
    await recovered.close()

    await expect(archiveRunnerAudit({
      runnerHome: root,
      destination,
      now: () => Date.parse('2026-09-01T00:10:00Z'),
    })).resolves.toMatchObject({ status: 'archived', segments: 1 })
    expect(await readdir(destination)).toHaveLength(2)
    await expect(stat(auditPath(root, 'segment-00000000000000000001.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await stat(auditPath(root, 'segment-00000000000000000001.ack.json'))).toBeDefined()
    expect(await stat(auditPath(root, 'segment-00000000000000000002.open'))).toBeDefined()
  })

  it('rotates large records and validates the sealed manifest on Darwin', async () => {
    const root = await tempRoot('darwin-audit-rotation-')
    const audit = await openReady(root)
    let bytes = 0
    let index = 1
    for (;;) {
      const encoded = encodeAuditRecord(largeAuditRecord(index), String(index))
      if (bytes + encoded.byteLength > MAX_AUDIT_SEGMENT_BYTES) break
      await audit.append(largeAuditRecord(index))
      bytes += encoded.byteLength
      index += 1
    }
    await audit.append(largeAuditRecord(index))
    await audit.close()

    const sealed = await readFile(auditPath(root, 'segment-00000000000000000001.jsonl'))
    const manifest = JSON.parse(await readFile(auditPath(root, 'segment-00000000000000000001.manifest.json'), 'utf8')) as Record<string, unknown>
    expect(manifest).toMatchObject({
      sequence: '1',
      state: 'sealed',
      bytes: sealed.byteLength,
      sha256: createHash('sha256').update(sealed).digest('hex'),
    })
    expect(await stat(auditPath(root, 'segment-00000000000000000002.open'))).toBeDefined()
  }, 30_000)

  it('migrates a legacy audit file and archives the migrated sealed prefix', async () => {
    const parent = await tempRoot('darwin-audit-migration-')
    const root = path.join(parent, 'home')
    const destination = path.join(parent, 'archive')
    await mkdir(root, { mode: 0o700 })
    await mkdir(destination, { mode: 0o700 })
    await writeFile(path.join(root, 'audit.jsonl'), `${JSON.stringify({ kind: 'kill', confirmed: true, details: 'operator', at: '2026-09-01T00:00:00.000Z' })}\n`, { mode: 0o600 })

    const audit = await openReady(root)
    await audit.append(auditRecord(2))
    await audit.close()

    await expect(archiveRunnerAudit({ runnerHome: root, destination })).resolves.toMatchObject({ status: 'archived', segments: 1 })
    expect(await stat(auditPath(root, 'migration.json'))).toBeDefined()
    expect(await stat(auditPath(root, 'segment-00000000000000000001.tombstone.json'))).toBeDefined()
  })

  it('fails closed when the audit root is replaced after lease binding', async () => {
    const parent = await tempRoot('darwin-audit-replacement-')
    const root = path.join(parent, 'home')
    const opened = await openRunnerAuditLifecycleCore({ runnerHome: root }, async (boundRoot, uid, rootHandle, adapter) => {
      await rm(root, { recursive: true, force: true })
      await mkdir(root, { mode: 0o700 })
      await migrateLegacyAudit(boundRoot, uid, rootHandle, adapter)
    })
    expect(opened).toEqual({ status: 'storage-unavailable' })
    await expect(stat(path.join(root, 'audit.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('releases the audit root lease after SIGKILL sudden death', async () => {
    const root = await tempRoot('darwin-audit-sigkill-')
    const child = await forkAuditHolder(root)
    child.kill('SIGKILL')
    await new Promise(resolve => child.once('exit', resolve))

    const audit = await openReady(root)
    await audit.append(auditRecord(2))
    await audit.close()
    const lines = (await readFile(auditPath(root, 'segment-00000000000000000001.open'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
  })
})

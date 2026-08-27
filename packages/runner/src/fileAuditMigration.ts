import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises'
import path from 'node:path'
import {
  MAX_AUDIT_METADATA_BYTES,
  MAX_AUDIT_SEGMENT_BYTES,
  MAX_AUDIT_SEGMENT_RECORDS,
  MAX_RESIDENT_AUDIT_SEGMENTS,
  type AuditSegmentManifest,
} from './auditLifecycle.js'
import {
  AUDIT_DIRECTORY,
  DIRECTORY_MODE,
  FILE_MODE,
  LEGACY_BACKUP,
  MIGRATING_DIRECTORY,
  MIGRATION_MARKER,
  classifyEntries,
  createOpenSegment,
  identityOf,
  missingOnly,
  openExistingSegment,
  readAll,
  readMigrationMarker,
  recoverSealed,
  secureDirectory,
  secureRecord,
  segmentName,
  sha256,
  sha256Value,
  splitRecordLines,
  syncDirectory,
  validLegacyAuditRecord,
  writeAll,
  writeManifest,
  type MigrationMarker,
  type RecoveryPath,
} from './fileAuditLifecycleCore.js'

function metadataBytesFor(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`)
}

export async function migrateLegacyAudit(root: string, uid: number | undefined): Promise<void> {
  const auditPath = path.join(root, AUDIT_DIRECTORY)
  const legacyPath = path.join(root, LEGACY_BACKUP)
  const migratingPath = path.join(root, MIGRATING_DIRECTORY)
  const audit = await lstat(auditPath, { bigint: true }).catch(error => missingOnly(error))
  const legacy = await lstat(legacyPath, { bigint: true }).catch(error => missingOnly(error))
  const migrating = await lstat(migratingPath, { bigint: true }).catch(error => missingOnly(error))
  if (audit?.isDirectory()) {
    if (!secureDirectory(audit, uid)) throw new Error('insecure migrated audit directory')
    if (legacy) await finishLegacyCleanup(root, auditPath, legacyPath, uid)
    if (migrating) await removeMigrationDirectory(root, migratingPath, migrating, uid)
    return
  }
  if (audit) {
    if (!secureRecord(audit, uid) || legacy) throw new Error('ambiguous legacy audit source')
    const source = await readLegacyAudit(auditPath, uid)
    if (migrating) await removeMigrationDirectory(root, migratingPath, migrating, uid)
    await buildMigrationDirectory(root, migratingPath, source, uid)
    await rename(auditPath, legacyPath)
    await syncParentDirectory(root)
    await rename(migratingPath, auditPath)
    await syncParentDirectory(root)
    await finishLegacyCleanup(root, auditPath, legacyPath, uid)
    return
  }
  if (legacy) {
    if (!migrating?.isDirectory() || !secureDirectory(migrating, uid)) throw new Error('incomplete legacy audit migration')
    await verifyMigrationDirectory(migratingPath, legacyPath, uid)
    await rename(migratingPath, auditPath)
    await syncParentDirectory(root)
    await finishLegacyCleanup(root, auditPath, legacyPath, uid)
    return
  }
  if (migrating) throw new Error('orphaned legacy audit migration')
}

async function buildMigrationDirectory(
  root: string,
  migratingPath: string,
  source: { bytes: Buffer; records: Buffer[] },
  uid: number | undefined,
): Promise<void> {
  await mkdir(migratingPath, { mode: DIRECTORY_MODE })
  await syncParentDirectory(root)
  const directory = await open(migratingPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const info = await directory.stat({ bigint: true })
  if (!secureDirectory(info, uid)) {
    await directory.close()
    throw new Error('insecure migration directory')
  }
  const recovered: RecoveryPath = { directory, directoryIdentity: identityOf(info), directoryPath: migratingPath, uid }
  try {
    const chunks = legacyChunks(source.records)
    if (chunks.length >= MAX_RESIDENT_AUDIT_SEGMENTS) throw new Error('legacy audit exceeds resident migration capacity')
    let previousManifestSha256: string | null = null
    let firstRecord = 1
    for (let index = 0; index < chunks.length; index += 1) {
      const sequence = index + 1
      const bytes = Buffer.concat(chunks[index]!)
      await writeMigrationSegment(recovered, sequence, bytes)
      const lastRecord = firstRecord + chunks[index]!.length - 1
      const manifest: AuditSegmentManifest = {
        schemaVersion: 1,
        sequence: String(sequence),
        state: 'sealed',
        recordSchemaVersion: 1,
        bytes: bytes.byteLength,
        records: chunks[index]!.length,
        sha256: sha256(bytes),
        firstRecordSequence: String(firstRecord),
        lastRecordSequence: String(lastRecord),
        previousManifestSha256,
      }
      const manifestBytes = await writeManifest(recovered, manifest)
      previousManifestSha256 = sha256(manifestBytes)
      firstRecord = lastRecord + 1
    }
    const current = await createOpenSegment(recovered, chunks.length + 1)
    await current.handle.close()
    const marker: MigrationMarker = {
      schemaVersion: 1,
      legacySha256: sha256(source.bytes),
      legacyBytes: source.bytes.byteLength,
      legacyRecords: source.records.length,
      lastManifestSha256: previousManifestSha256,
    }
    await writeMigrationMarker(recovered, marker)
  } finally {
    await directory.close()
  }
}

function legacyChunks(records: readonly Buffer[]): Buffer[][] {
  const chunks: Buffer[][] = []
  let current: Buffer[] = []
  let bytes = 0
  for (const record of records) {
    if (current.length >= MAX_AUDIT_SEGMENT_RECORDS || bytes + record.byteLength + 1 > MAX_AUDIT_SEGMENT_BYTES) {
      chunks.push(current)
      current = []
      bytes = 0
    }
    current.push(Buffer.concat([record, Buffer.from('\n')]))
    bytes += record.byteLength + 1
  }
  if (current.length) chunks.push(current)
  return chunks
}

async function writeMigrationSegment(recovered: RecoveryPath, sequence: number, bytes: Buffer): Promise<void> {
  const target = path.join(recovered.directoryPath, segmentName(sequence, 'jsonl'))
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE)
  try {
    await writeAll(handle, bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncDirectory(recovered)
}

async function readLegacyAudit(target: string, uid: number | undefined): Promise<{ bytes: Buffer; records: Buffer[] }> {
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat({ bigint: true })
    const maximum = (MAX_RESIDENT_AUDIT_SEGMENTS - 1) * MAX_AUDIT_SEGMENT_BYTES
    if (!secureRecord(info, uid) || info.size > BigInt(maximum)) throw new Error('invalid legacy audit file')
    const bytes = await readAll(handle, Number(info.size))
    const records = splitRecordLines(bytes)
    for (const record of records) {
      if (record.byteLength > 64 * 1024 || !validLegacyAuditRecord(record)) throw new Error('invalid legacy audit record')
    }
    return { bytes, records }
  } finally {
    await handle.close()
  }
}

async function verifyMigrationDirectory(migratingPath: string, legacyPath: string, uid: number | undefined): Promise<void> {
  await verifyMigrationState(migratingPath, await readLegacyAudit(legacyPath, uid), uid)
}

async function finishLegacyCleanup(root: string, auditPath: string, legacyPath: string, uid: number | undefined): Promise<void> {
  await verifyMigrationState(auditPath, await readLegacyAudit(legacyPath, uid), uid)
  await unlink(legacyPath)
  await syncParentDirectory(root)
}

async function verifyMigrationState(
  directoryPath: string,
  source: { bytes: Buffer; records: Buffer[] },
  uid: number | undefined,
): Promise<void> {
  const directory = await open(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const info = await directory.stat({ bigint: true })
    if (!secureDirectory(info, uid)) throw new Error('insecure migration directory')
    const recovered: RecoveryPath = { directory, directoryIdentity: identityOf(info), directoryPath, uid }
    const marker = await readMigrationMarker(recovered)
    if (!migrationMatches(marker.value, source)) throw new Error('legacy migration marker mismatch')
    const grouped = classifyEntries(await readdir(directoryPath))
    if (grouped.acknowledgements.length || grouped.tombstones.length
      || grouped.segments.some(sequence => !grouped.manifests.includes(sequence))
      || grouped.commits.some(sequence => !grouped.opens.includes(sequence))) {
      throw new Error('migration staging contains non-migration state')
    }
    const sealed = await recoverSealed(recovered, grouped)
    if (sealed.legacyRecords !== source.records.length
      || sealed.legacyLastManifestSha256 !== marker.value.lastManifestSha256
      || grouped.opens.length !== 1 || grouped.opens[0] !== sealed.lastSequence + 1) {
      throw new Error('migration staging chain mismatch')
    }
    const current = await openExistingSegment(recovered, grouped.opens[0], grouped.commits.includes(grouped.opens[0]))
    try {
      if (current.records !== 0 || current.byteCount !== 0) throw new Error('migration staging open segment is not empty')
    } finally {
      await current.handle.close()
    }
  } finally {
    await directory.close()
  }
}

async function removeMigrationDirectory(root: string, target: string, info: BigIntStats, uid: number | undefined): Promise<void> {
  if (!secureDirectory(info, uid)) throw new Error('insecure migration directory')
  await rm(target, { recursive: true })
  await syncParentDirectory(root)
}

async function writeMigrationMarker(recovered: RecoveryPath, marker: MigrationMarker): Promise<void> {
  const bytes = metadataBytesFor(marker)
  const target = path.join(recovered.directoryPath, MIGRATION_MARKER)
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE)
  try {
    await writeAll(handle, bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncDirectory(recovered)
}

function migrationMatches(marker: MigrationMarker, source: { bytes: Buffer; records: readonly Buffer[] }): boolean {
  return marker.legacySha256 === sha256(source.bytes)
    && marker.legacyBytes === source.bytes.byteLength
    && marker.legacyRecords === source.records.length
}

async function syncParentDirectory(root: string): Promise<void> {
  const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

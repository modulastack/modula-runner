import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
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
  closeHandle,
  identityOf,
  missingOnly,
  openAuditEntry,
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
  syncHandle,
  validLegacyAuditRecord,
  writeAll,
  writeManifest,
  type MigrationMarker,
  type RecoveryPath,
} from './fileAuditLifecycleCore.js'
import { descriptorRootAdapter, type DescriptorChildHandle, type DescriptorRootAdapter, type DescriptorRootEntryStat } from './descriptorRootAdapter.js'

function metadataBytesFor(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`)
}

export async function migrateLegacyAudit(
  root: string,
  uid: number | undefined,
  rootHandle?: FileHandle,
  providedAdapter?: DescriptorRootAdapter,
): Promise<void> {
  const adapter = providedAdapter ?? descriptorRootAdapter()
  const rootDirectory = rootHandle ?? await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
  const audit = await adapter.statEntry(rootDirectory, AUDIT_DIRECTORY)
  const legacy = await adapter.statEntry(rootDirectory, LEGACY_BACKUP)
  const migrating = await adapter.statEntry(rootDirectory, MIGRATING_DIRECTORY)
  if (audit?.isDirectory()) {
    if (!secureDirectory(audit, uid)) throw new Error('insecure migrated audit directory')
    if (legacy) await finishLegacyCleanup(rootDirectory, adapter, AUDIT_DIRECTORY, LEGACY_BACKUP, uid)
    if (migrating) await removeMigrationDirectory(rootDirectory, adapter, MIGRATING_DIRECTORY, migrating, uid)
    return
  }
  if (audit) {
    if (!secureRecord(audit, uid) || legacy) throw new Error('ambiguous legacy audit source')
    const source = await readLegacyAudit(rootDirectory, adapter, AUDIT_DIRECTORY, uid)
    if (migrating) await removeMigrationDirectory(rootDirectory, adapter, MIGRATING_DIRECTORY, migrating, uid)
    await buildMigrationDirectory(rootDirectory, adapter, root, MIGRATING_DIRECTORY, source, uid)
    await adapter.rename(rootDirectory, AUDIT_DIRECTORY, LEGACY_BACKUP)
    await syncParentDirectory(rootDirectory)
    await adapter.rename(rootDirectory, MIGRATING_DIRECTORY, AUDIT_DIRECTORY)
    await syncParentDirectory(rootDirectory)
    await finishLegacyCleanup(rootDirectory, adapter, AUDIT_DIRECTORY, LEGACY_BACKUP, uid)
    return
  }
  if (legacy) {
    if (!migrating?.isDirectory() || !secureDirectory(migrating, uid)) throw new Error('incomplete legacy audit migration')
    await verifyMigrationDirectory(rootDirectory, adapter, MIGRATING_DIRECTORY, LEGACY_BACKUP, uid)
    await adapter.rename(rootDirectory, MIGRATING_DIRECTORY, AUDIT_DIRECTORY)
    await syncParentDirectory(rootDirectory)
    await finishLegacyCleanup(rootDirectory, adapter, AUDIT_DIRECTORY, LEGACY_BACKUP, uid)
    return
  }
  if (migrating) throw new Error('orphaned legacy audit migration')
  } finally {
    if (!rootHandle) await rootDirectory.close().catch(() => undefined)
  }
}

async function buildMigrationDirectory(
  root: FileHandle,
  adapter: DescriptorRootAdapter,
  rootPath: string,
  migratingEntry: string,
  source: { bytes: Buffer; records: Buffer[] },
  uid: number | undefined,
): Promise<void> {
  await adapter.mkdir(root, migratingEntry, DIRECTORY_MODE)
  await syncParentDirectory(root)
  const directory = await adapter.openEntry(root, migratingEntry, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  if (!directory) throw new Error('missing migration directory')
  const info = await adapter.stat(directory)
  if (!secureDirectory(info, uid)) {
    await closeHandle({ adapter }, directory)
    throw new Error('insecure migration directory')
  }
  const recovered: RecoveryPath = { root, adapter, directory, directoryIdentity: identityOf(info), directoryPath: path.join(rootPath, migratingEntry), directoryEntry: migratingEntry, uid }
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
    await closeHandle(recovered, current.handle)
    const marker: MigrationMarker = {
      schemaVersion: 1,
      legacySha256: sha256(source.bytes),
      legacyBytes: source.bytes.byteLength,
      legacyRecords: source.records.length,
      lastManifestSha256: previousManifestSha256,
    }
    await writeMigrationMarker(recovered, marker)
  } finally {
    await closeHandle({ adapter }, directory)
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
  const handle = await openAuditEntry(recovered, segmentName(sequence, 'jsonl'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE)
  if (!handle) throw new Error('migration segment already exists')
  try {
    await writeAll(recovered, handle, bytes)
    await syncHandle(recovered, handle)
  } finally {
    await closeHandle(recovered, handle)
  }
  await syncDirectory(recovered)
}

async function readLegacyAudit(root: FileHandle, adapter: DescriptorRootAdapter, target: string, uid: number | undefined): Promise<{ bytes: Buffer; records: Buffer[] }> {
  const handle = await adapter.openEntry(root, target, constants.O_RDONLY | constants.O_NOFOLLOW)
  if (!handle) throw new Error('missing legacy audit file')
  try {
    const info = await adapter.stat(handle)
    const maximum = (MAX_RESIDENT_AUDIT_SEGMENTS - 1) * MAX_AUDIT_SEGMENT_BYTES
    if (!secureRecord(info, uid) || info.size > maximum) throw new Error('invalid legacy audit file')
    const bytes = await readAll({ adapter }, handle, Number(info.size))
    const records = splitRecordLines(bytes)
    for (const record of records) {
      if (record.byteLength > 64 * 1024 || !validLegacyAuditRecord(record)) throw new Error('invalid legacy audit record')
    }
    return { bytes, records }
  } finally {
    await closeHandle({ adapter }, handle)
  }
}

async function verifyMigrationDirectory(root: FileHandle, adapter: DescriptorRootAdapter, migratingEntry: string, legacyEntry: string, uid: number | undefined): Promise<void> {
  await verifyMigrationState(root, adapter, migratingEntry, await readLegacyAudit(root, adapter, legacyEntry, uid), uid)
}

async function finishLegacyCleanup(root: FileHandle, adapter: DescriptorRootAdapter, auditEntry: string, legacyEntry: string, uid: number | undefined): Promise<void> {
  await verifyMigrationState(root, adapter, auditEntry, await readLegacyAudit(root, adapter, legacyEntry, uid), uid)
  await adapter.unlink(root, legacyEntry)
  await syncParentDirectory(root)
}

async function verifyMigrationState(
  root: FileHandle,
  adapter: DescriptorRootAdapter,
  directoryEntry: string,
  source: { bytes: Buffer; records: Buffer[] },
  uid: number | undefined,
): Promise<void> {
  const directory = await adapter.openEntry(root, directoryEntry, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  if (!directory) throw new Error('missing migration directory')
  try {
    const info = await adapter.stat(directory)
    if (!secureDirectory(info, uid)) throw new Error('insecure migration directory')
    const recovered: RecoveryPath = { root, adapter, directory, directoryIdentity: identityOf(info), directoryPath: directoryEntry, directoryEntry, uid }
    const marker = await readMigrationMarker(recovered)
    if (!migrationMatches(marker.value, source)) throw new Error('legacy migration marker mismatch')
    const grouped = classifyEntries(await adapter.readdir(directory))
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
      await closeHandle(recovered, current.handle)
    }
  } finally {
    await closeHandle({ adapter }, directory)
  }
}

async function removeMigrationDirectory(root: FileHandle, adapter: DescriptorRootAdapter, target: string, info: BigIntStats | DescriptorRootEntryStat, uid: number | undefined): Promise<void> {
  if (!secureDirectory(info, uid)) throw new Error('insecure migration directory')
  await removeDirectoryTree(root, adapter, target, uid)
  await syncParentDirectory(root)
}

async function writeMigrationMarker(recovered: RecoveryPath, marker: MigrationMarker): Promise<void> {
  const bytes = metadataBytesFor(marker)
  const handle = await openAuditEntry(recovered, MIGRATION_MARKER, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE)
  if (!handle) throw new Error('migration marker already exists')
  try {
    await writeAll(recovered, handle, bytes)
    await syncHandle(recovered, handle)
  } finally {
    await closeHandle(recovered, handle)
  }
  await syncDirectory(recovered)
}

function migrationMatches(marker: MigrationMarker, source: { bytes: Buffer; records: readonly Buffer[] }): boolean {
  return marker.legacySha256 === sha256(source.bytes)
    && marker.legacyBytes === source.bytes.byteLength
    && marker.legacyRecords === source.records.length
}

async function removeDirectoryTree(parent: FileHandle | DescriptorChildHandle, adapter: DescriptorRootAdapter, entry: string, uid: number | undefined): Promise<void> {
  const directory = await adapter.openEntry(parent, entry, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  if (!directory) throw new Error('missing migration directory')
  try {
    for (const child of await adapter.readdir(directory)) {
      const info = await adapter.statEntry(directory, child)
      if (!info) throw new Error('migration entry disappeared')
      if (info.isDirectory()) {
        if (!secureDirectory(info, uid)) throw new Error('insecure migration directory')
        await removeDirectoryTree(directory, adapter, child, uid)
      } else {
        if (!secureRecord(info, uid)) throw new Error('insecure migration entry')
        await adapter.unlink(directory, child)
      }
    }
  } finally {
    await closeHandle({ adapter }, directory)
  }
  await adapter.rmdir(parent, entry)
}

async function syncParentDirectory(root: FileHandle): Promise<void> {
  await root.sync()
}

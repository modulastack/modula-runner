import { constants } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { lstat, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import {
  MAX_AUDIT_METADATA_BYTES,
  type AuditArchiveAcknowledgement,
  type AuditReclamationTombstone,
  type AuditSegmentManifest,
  type RunnerAuditArchiveOptions,
  type RunnerAuditArchiveResult,
} from './auditLifecycle.js'
import {
  FILE_MODE,
  SEQUENCE_WIDTH,
  identityOf,
  missingOnly,
  readAll,
  recoverLifecycle,
  secureDirectory,
  secureRecord,
  segmentName,
  sha256,
  syncDirectory,
  writeAll,
  type AuditMigrationHook,
  type DirectoryIdentity,
  type RecoveredLifecycle,
  type RecoveryPath,
  type SealedSegment,
} from './fileAuditLifecycleCore.js'
import { createFileRunnerHomeStorage } from './runnerHomeStorage.js'
import type { RunnerHomeStorage } from './runnerHome.js'

type ArchiveDestination = {
  path: string
  directory: FileHandle
  identity: DirectoryIdentity
  uid: number | undefined
}

export async function archiveRunnerAuditFile(
  options: RunnerAuditArchiveOptions,
  migrate: AuditMigrationHook,
): Promise<RunnerAuditArchiveResult> {
  const root = path.resolve(options.runnerHome)
  const storage = createFileRunnerHomeStorage({
    defaultRoot: root,
    ...(options.currentUserId === undefined ? {} : { currentUserId: options.currentUserId }),
  })
  let recovered: RecoveredLifecycle | undefined
  let destination: ArchiveDestination | undefined
  try {
    await storage.inspect({ override: root })
    destination = await openArchiveDestination(root, options.destination, options.currentUserId ?? process.getuid?.())
    if (await storage.acquire?.() !== 'acquired') return await unavailableArchive(storage, destination)
    const leasedRoot = await storage.descriptorRoot?.()
    if (!leasedRoot || await sameDirectoryIdentity(leasedRoot, destination)) return await unavailableArchive(storage, destination)
    const uid = options.currentUserId ?? process.getuid?.()
    await migrate(leasedRoot, uid)
    recovered = await recoverLifecycle(leasedRoot, uid)
    if (await sameHandleIdentity(recovered.directory, destination.directory)) {
      return await unavailableArchive(storage, destination, recovered)
    }
    const result = await archiveSealed(recovered, destination, options.now ?? Date.now)
    await closeArchiveResources(storage, recovered, destination)
    return result
  } catch {
    return await unavailableArchive(storage, destination, recovered)
  }
}

async function archiveSealed(
  recovered: RecoveredLifecycle,
  destination: ArchiveDestination,
  now: () => number,
): Promise<RunnerAuditArchiveResult> {
  if (recovered.sealed.length === 0) return { status: 'nothing-to-archive' }
  const at = new Date(now())
  if (!Number.isFinite(at.getTime())) throw new Error('invalid archive clock')
  let metadataBytes = recovered.metadataBytes
  let archivedBytes = 0
  const acknowledgementDigests: string[] = []
  for (const segment of recovered.sealed) {
    const source = await readResidentSegment(recovered, segment.manifest)
    const artifactSha256 = await copyArchiveArtifact(destination, segment, source)
    let acknowledgement = segment.acknowledgement
    if (acknowledgement && acknowledgement.value.artifactSha256 !== artifactSha256) {
      throw new Error('archive acknowledgement no longer matches destination artifacts')
    }
    if (!acknowledgement) {
      const value: AuditArchiveAcknowledgement = {
        schemaVersion: 1,
        segmentSequence: segment.manifest.sequence,
        segmentSha256: segment.manifest.sha256,
        manifestSha256: sha256(segment.manifestBytes),
        bytes: segment.manifest.bytes,
        records: segment.manifest.records,
        exportId: sha256(Buffer.concat([Buffer.from('runner-audit-export-v1\0'), segment.manifestBytes])),
        artifactSha256,
        acknowledgedAt: at.toISOString(),
      }
      const bytes = metadataBytesFor(value)
      if (metadataBytes + bytes.byteLength > MAX_AUDIT_METADATA_BYTES) throw new Error('audit metadata capacity exhausted')
      await writeLifecycleMetadata(recovered, Number(segment.manifest.sequence), 'ack.json', bytes)
      acknowledgement = { value, bytes }
      metadataBytes += bytes.byteLength
    }
    const tombstone: AuditReclamationTombstone = {
      schemaVersion: 1,
      segmentSequence: segment.manifest.sequence,
      segmentSha256: segment.manifest.sha256,
      acknowledgementSha256: sha256(acknowledgement.bytes),
      reclaimedAt: at.toISOString(),
    }
    const tombstoneBytes = metadataBytesFor(tombstone)
    if (metadataBytes + tombstoneBytes.byteLength > MAX_AUDIT_METADATA_BYTES) throw new Error('audit metadata capacity exhausted')
    await writeLifecycleMetadata(recovered, Number(segment.manifest.sequence), 'tombstone.json', tombstoneBytes)
    metadataBytes += tombstoneBytes.byteLength
    await unlink(path.join(recovered.directoryPath, segmentName(Number(segment.manifest.sequence), 'jsonl')))
    await syncDirectory(recovered)
    archivedBytes += segment.manifest.bytes
    acknowledgementDigests.push(sha256(acknowledgement.bytes))
  }
  return { status: 'archived', segments: recovered.sealed.length, bytes: archivedBytes, acknowledgementDigests }
}

async function readResidentSegment(recovered: RecoveryPath, manifest: AuditSegmentManifest): Promise<Buffer> {
  const sequence = Number(manifest.sequence)
  const target = path.join(recovered.directoryPath, segmentName(sequence, 'jsonl'))
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat({ bigint: true })
    if (!secureRecord(info, recovered.uid) || Number(info.size) !== manifest.bytes) throw new Error('resident audit segment changed')
    const bytes = await readAll(handle, Number(info.size))
    if (sha256(bytes) !== manifest.sha256) throw new Error('resident audit segment digest changed')
    return bytes
  } finally {
    await handle.close()
  }
}

async function copyArchiveArtifact(
  destination: ArchiveDestination,
  segment: SealedSegment,
  source: Buffer,
): Promise<string> {
  const prefix = `segment-${String(segment.manifest.sequence).padStart(SEQUENCE_WIDTH, '0')}-${segment.manifest.sha256}`
  await copyArchiveFile(destination, `${prefix}.jsonl`, source)
  await copyArchiveFile(destination, `${prefix}.manifest.json`, segment.manifestBytes)
  return sha256(Buffer.concat([Buffer.from('runner-audit-artifact-v1\0'), source, segment.manifestBytes]))
}

async function copyArchiveFile(destination: ArchiveDestination, name: string, bytes: Buffer): Promise<void> {
  await assertArchiveDestination(destination)
  const target = path.join(destination.path, name)
  const existing = await lstat(target).catch(error => missingOnly(error))
  if (existing !== null) return await verifyArchiveFile(destination, target, bytes)
  const temporary = path.join(destination.path, `.tmp-${randomBytes(16).toString('hex')}`)
  let handle: FileHandle | undefined
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE)
    await writeAll(handle, bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, target)
    await destination.directory.sync()
    await verifyArchiveFile(destination, target, bytes)
  } catch (error) {
    // A failed copy has no acknowledgement; its private temporary cannot authorize reclamation.
    await handle?.close().catch(() => undefined)
    // The final artifact name is the only destination commit marker.
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

async function verifyArchiveFile(
  destination: ArchiveDestination,
  target: string,
  expected: Buffer,
): Promise<void> {
  await assertArchiveDestination(destination)
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat({ bigint: true })
    if (!secureRecord(info, destination.uid) || Number(info.size) !== expected.byteLength
      || !(await readAll(handle, expected.byteLength)).equals(expected)) throw new Error('archive artifact conflicts')
  } finally {
    await handle.close()
  }
  await assertArchiveDestination(destination)
}

async function openArchiveDestination(
  runnerHome: string,
  selected: string,
  uid: number | undefined,
): Promise<ArchiveDestination> {
  const [canonicalHome, destinationPath] = await Promise.all([realpath(runnerHome), realpath(path.resolve(selected))])
  if (containsPath(canonicalHome, destinationPath) || containsPath(destinationPath, canonicalHome)) {
    throw new Error('archive destination overlaps runner home')
  }
  const info = await lstat(destinationPath, { bigint: true })
  if (!secureDirectory(info, uid)) throw new Error('insecure archive destination')
  const directory = await open(destinationPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const held = await directory.stat({ bigint: true })
  if (!secureDirectory(held, uid) || held.dev !== info.dev || held.ino !== info.ino) {
    await directory.close()
    throw new Error('archive destination identity changed')
  }
  return { path: destinationPath, directory, identity: identityOf(held), uid }
}

async function sameDirectoryIdentity(root: string, destination: ArchiveDestination): Promise<boolean> {
  const info = await lstat(root, { bigint: true })
  return info.dev === destination.identity.device && info.ino === destination.identity.inode
}

async function sameHandleIdentity(first: FileHandle, second: FileHandle): Promise<boolean> {
  const [firstInfo, secondInfo] = await Promise.all([
    first.stat({ bigint: true }),
    second.stat({ bigint: true }),
  ])
  return firstInfo.dev === secondInfo.dev && firstInfo.ino === secondInfo.ino
}

async function assertArchiveDestination(destination: ArchiveDestination): Promise<void> {
  const [held, current] = await Promise.all([
    destination.directory.stat({ bigint: true }),
    lstat(destination.path, { bigint: true }),
  ])
  if (!secureDirectory(held, destination.uid) || !secureDirectory(current, destination.uid)
    || held.dev !== destination.identity.device || held.ino !== destination.identity.inode
    || current.dev !== destination.identity.device || current.ino !== destination.identity.inode) {
    throw new Error('archive destination identity changed')
  }
}

function containsPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function closeArchiveResources(
  storage: RunnerHomeStorage,
  recovered: RecoveredLifecycle,
  destination: ArchiveDestination,
): Promise<void> {
  await recovered.current.handle.sync()
  await recovered.current.handle.close()
  await recovered.directory.close()
  await destination.directory.close()
  await storage.release?.()
  await storage.close?.()
}

async function unavailableArchive(
  storage: RunnerHomeStorage,
  destination?: ArchiveDestination,
  recovered?: RecoveredLifecycle,
): Promise<RunnerAuditArchiveResult> {
  // The result is already fail-closed; cleanup errors cannot authorize reclamation.
  await recovered?.current.handle.close().catch(() => undefined)
  // The source directory descriptor carries no state after the operation is unavailable.
  await recovered?.directory.close().catch(() => undefined)
  // Destination cleanup cannot change whether an acknowledgement was durably written.
  await destination?.directory.close().catch(() => undefined)
  // A failed archive operation must release its exclusive lease for operator retry.
  await storage.release?.().catch(() => undefined)
  // Closing an already-unavailable adapter cannot make the archive successful.
  await storage.close?.().catch(() => undefined)
  return { status: 'storage-unavailable' }
}

function metadataBytesFor(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`)
}

async function writeLifecycleMetadata(
  recovered: RecoveryPath,
  sequence: number,
  extension: 'ack.json' | 'tombstone.json',
  bytes: Buffer,
): Promise<void> {
  const finalPath = path.join(recovered.directoryPath, segmentName(sequence, extension))
  const temporary = `${finalPath.replace(/\.json$/, '')}.tmp-${randomBytes(16).toString('hex')}`
  let handle: FileHandle | undefined
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE)
    await writeAll(handle, bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, finalPath)
    await syncDirectory(recovered)
  } catch (error) {
    // Only the final metadata name is authoritative.
    await handle?.close().catch(() => undefined)
    // An interrupted private temp is removed or ignored by recovery.
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

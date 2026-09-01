import { constants } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
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
  createOpenSegment,
  encodeOpenCommit,
  identityOf,
  manifestFor,
  missingOnly,
  openCommit,
  readAll,
  recoverLifecycle,
  secureDirectory,
  secureRecord,
  segmentName,
  sha256,
  syncDirectory,
  writeAll,
  closeHandle,
  openAuditEntry,
  syncHandle,
  writeManifest,
  type AuditMigrationHook,
  type DirectoryIdentity,
  type RecoveredLifecycle,
  type RecoveryPath,
  type SealedSegment,
} from './fileAuditLifecycleCore.js'
import { createFileRunnerHomeStorage } from './runnerHomeStorage.js'
import type { RunnerHomeStorage } from './runnerHome.js'
import { descriptorRootAdapter, sameIdentity, type DescriptorChildHandle, type DescriptorRootAdapter } from './descriptorRootAdapter.js'

type ArchiveDestination = {
  path: string
  adapter: DescriptorRootAdapter
  directory: DescriptorChildHandle
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
  let rootHandle: FileHandle | undefined
  try {
    await storage.inspect({ override: root })
    if (await storage.acquire?.() !== 'acquired') return await unavailableArchive(storage, destination)
    const uid = options.currentUserId ?? process.getuid?.()
    const adapter = descriptorRootAdapter()
    destination = await openArchiveDestination(root, options.destination, uid, adapter)
    rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    if (!secureDirectory(await rootHandle.stat({ bigint: true }), uid)) return await unavailableArchive(storage, destination)
    if (await sameHandleIdentity(rootHandle, adapter, destination.directory, destination.adapter)) return await unavailableArchive(storage, destination)
    await migrate(root, uid, rootHandle, adapter)
    recovered = await recoverLifecycle(root, uid, rootHandle, adapter)
    if (await sameHandleIdentity(recovered.directory, recovered.adapter, destination.directory, destination.adapter)) {
      return await unavailableArchive(storage, destination, recovered)
    }
    const result = await archiveSealed(recovered, destination, options.now ?? Date.now)
    await closeArchiveResources(storage, recovered, destination)
    rootHandle = undefined
    return result
  } catch {
    return await unavailableArchive(storage, destination, recovered)
  } finally {
    // Archive failure is already mapped to unavailable; a close failure cannot add custody proof.
    await rootHandle?.close().catch(() => undefined)
  }
}

async function archiveSealed(
  recovered: RecoveredLifecycle,
  destination: ArchiveDestination,
  now: () => number,
): Promise<RunnerAuditArchiveResult> {
  if (recovered.sealed.length === 0 && recovered.current.sequence === 1) await sealCurrentForArchive(recovered)
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
    await recovered.adapter.unlink(recovered.directory, segmentName(Number(segment.manifest.sequence), 'jsonl'))
    await syncDirectory(recovered)
    archivedBytes += segment.manifest.bytes
    acknowledgementDigests.push(sha256(acknowledgement.bytes))
  }
  return { status: 'archived', segments: recovered.sealed.length, bytes: archivedBytes, acknowledgementDigests }
}

async function sealCurrentForArchive(recovered: RecoveredLifecycle): Promise<void> {
  if (recovered.current.records === 0) return
  const sequence = recovered.current.sequence
  await syncHandle(recovered, recovered.current.handle)
  await closeHandle(recovered, recovered.current.handle)
  await recovered.adapter.rename(recovered.directory, segmentName(sequence, 'open'), segmentName(sequence, 'jsonl'))
  await syncDirectory(recovered)
  const manifest = manifestFor(sequence, {
    byteCount: recovered.current.byteCount,
    records: recovered.current.records,
    firstRecordSequence: recovered.current.firstRecordSequence,
    lastRecordSequence: recovered.current.lastRecordSequence,
    sha256: recovered.current.hash.copy().digest('hex'),
  }, recovered.previousManifestSha256)
  const manifestBytes = await writeManifest(recovered, manifest)
  const emptyCommitBytes = encodeOpenCommit(openCommit(sequence + 1, 0, 0, null, sha256(Buffer.alloc(0))))
  const nextMetadataBytes = recovered.metadataBytes + manifestBytes.byteLength + emptyCommitBytes.byteLength - recovered.current.commitBytes
  if (nextMetadataBytes > MAX_AUDIT_METADATA_BYTES) throw new Error('audit metadata capacity exhausted')
  const next = await createOpenSegment(recovered, sequence + 1)
  await recovered.adapter.unlink(recovered.directory, segmentName(sequence, 'commit.json'))
  await syncDirectory(recovered)
  recovered.previousManifestSha256 = sha256(manifestBytes)
  recovered.sealed.push({ manifest, manifestBytes })
  recovered.current = next
  recovered.metadataBytes = nextMetadataBytes
}

async function readResidentSegment(recovered: RecoveryPath, manifest: AuditSegmentManifest): Promise<Buffer> {
  const sequence = Number(manifest.sequence)
  const handle = await openAuditEntry(recovered, segmentName(sequence, 'jsonl'), constants.O_RDONLY | constants.O_NOFOLLOW)
  if (!handle) throw new Error('resident audit segment missing')
  try {
    const info = await recovered.adapter.stat(handle)
    if (!secureRecord(info, recovered.uid) || Number(info.size) !== manifest.bytes) throw new Error('resident audit segment changed')
    const bytes = await readAll(recovered, handle, Number(info.size))
    if (sha256(bytes) !== manifest.sha256) throw new Error('resident audit segment digest changed')
    return bytes
  } finally {
    await closeHandle(recovered, handle)
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
  const existing = await destination.adapter.statEntry(destination.directory, name)
  if (existing !== null) return await verifyArchiveFile(destination, name, bytes)
  const temporary = `.tmp-${randomBytes(16).toString('hex')}`
  let handle: DescriptorChildHandle | null = null
  try {
    handle = await destination.adapter.openEntry(destination.directory, temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE)
    if (!handle) throw new Error('archive temporary already exists')
    await writeAll(destinationRecovery(destination), handle, bytes)
    await syncHandle(destinationRecovery(destination), handle)
    await closeHandle(destinationRecovery(destination), handle)
    handle = null
    await destination.adapter.rename(destination.directory, temporary, name)
    await destination.adapter.sync(destination.directory)
    await verifyArchiveFile(destination, name, bytes)
  } catch (error) {
    // A failed copy has no acknowledgement; its private temporary cannot authorize reclamation.
    await closeHandle(destinationRecovery(destination), handle)
    // The final artifact name is the only destination commit marker.
    await destination.adapter.unlink(destination.directory, temporary).catch(() => undefined)
    throw error
  }
}

async function verifyArchiveFile(
  destination: ArchiveDestination,
  target: string,
  expected: Buffer,
): Promise<void> {
  await assertArchiveDestination(destination)
  const handle = await destination.adapter.openEntry(destination.directory, target, constants.O_RDONLY | constants.O_NOFOLLOW)
  if (!handle) throw new Error('archive artifact missing')
  try {
    const info = await destination.adapter.stat(handle)
    if (!secureRecord(info, destination.uid) || Number(info.size) !== expected.byteLength
      || !(await readAll(destinationRecovery(destination), handle, expected.byteLength)).equals(expected)) throw new Error('archive artifact conflicts')
  } finally {
    await closeHandle(destinationRecovery(destination), handle)
  }
  await assertArchiveDestination(destination)
}

async function openArchiveDestination(
  runnerHome: string,
  selected: string,
  uid: number | undefined,
  adapter: DescriptorRootAdapter,
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
  return { path: destinationPath, adapter, directory, identity: identityOf(held), uid }
}

async function sameHandleIdentity(
  first: DescriptorChildHandle | FileHandle,
  firstAdapter: DescriptorRootAdapter,
  second: DescriptorChildHandle | FileHandle,
  secondAdapter: DescriptorRootAdapter,
): Promise<boolean> {
  const [firstInfo, secondInfo] = await Promise.all([firstAdapter.stat(first), secondAdapter.stat(second)])
  return sameIdentity(firstInfo, identityOf(secondInfo))
}

async function assertArchiveDestination(destination: ArchiveDestination): Promise<void> {
  const [held, current] = await Promise.all([
    destination.adapter.stat(destination.directory),
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
  await syncHandle(recovered, recovered.current.handle)
  await closeHandle(recovered, recovered.current.handle)
  await closeHandle(recovered, recovered.directory)
  await recovered.root.close()
  await closeHandle(destinationRecovery(destination), destination.directory)
  await storage.release?.()
  await storage.close?.()
}

async function unavailableArchive(
  storage: RunnerHomeStorage,
  destination?: ArchiveDestination,
  recovered?: RecoveredLifecycle,
): Promise<RunnerAuditArchiveResult> {
  // The result is already fail-closed; cleanup errors cannot authorize reclamation.
  await closeHandle(recovered, recovered?.current.handle)
  // The source directory descriptor carries no state after the operation is unavailable.
  await closeHandle(recovered, recovered?.directory)
  await recovered?.root.close().catch(() => undefined)
  // Destination cleanup cannot change whether an acknowledgement was durably written.
  await closeHandle(destination ? destinationRecovery(destination) : undefined, destination?.directory)
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
  const finalName = segmentName(sequence, extension)
  const temporary = `${finalName.replace(/\.json$/, '')}.tmp-${randomBytes(16).toString('hex')}`
  let handle: DescriptorChildHandle | null = null
  try {
    handle = await openAuditEntry(recovered, temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE)
    if (!handle) throw new Error('audit temporary already exists')
    await writeAll(recovered, handle, bytes)
    await syncHandle(recovered, handle)
    await closeHandle(recovered, handle)
    handle = null
    await recovered.adapter.rename(recovered.directory, temporary, finalName)
    await syncDirectory(recovered)
  } catch (error) {
    // Only the final metadata name is authoritative.
    await closeHandle(recovered, handle)
    // An interrupted private temp is removed or ignored by recovery.
    await recovered.adapter.unlink(recovered.directory, temporary).catch(() => undefined)
    throw error
  }
}

function destinationRecovery(destination: ArchiveDestination): Pick<RecoveredLifecycle, 'adapter'> {
  return { adapter: destination.adapter }
}

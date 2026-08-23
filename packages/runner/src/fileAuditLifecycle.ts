import { constants, type BigIntStats, type Stats } from 'node:fs'
import { createHash, randomBytes, type Hash } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import path from 'node:path'
import {
  AUDIT_SEGMENT_SCHEMA_VERSION,
  MAX_AUDIT_METADATA_BYTES,
  MAX_AUDIT_RECORD_BYTES,
  MAX_AUDIT_SEGMENT_BYTES,
  MAX_AUDIT_SEGMENT_RECORDS,
  MAX_RESIDENT_AUDIT_SEGMENTS,
  type AuditArchiveAcknowledgement,
  type AuditLifecycleSnapshot,
  type AuditRecordInputV2,
  type AuditReclamationTombstone,
  type AuditSegmentManifest,
  type RunnerAuditArchiveOptions,
  type RunnerAuditArchiveResult,
  type RunnerAuditLifecycle,
  type RunnerAuditLifecycleOpen,
  type RunnerAuditLifecycleOptions,
} from './auditLifecycle.js'
import { decodeAuditRecord, encodeAuditRecord } from './auditRecordCodec.js'
import { createFileRunnerHomeStorage } from './runnerHomeStorage.js'
import type { RunnerHomeStorage } from './runnerHome.js'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const AUDIT_DIRECTORY = 'audit.jsonl'
const SEQUENCE_WIDTH = 20
const SEGMENT_PATTERN = /^segment-([0-9]{20})\.(open|jsonl|manifest\.json|commit\.json|ack\.json|tombstone\.json)$/
const TEMP_METADATA_PATTERN = /^segment-([0-9]{20})\.(manifest|commit|ack|tombstone)\.tmp-[0-9a-f]{32}$/

type DirectoryIdentity = { device: bigint; inode: bigint }
type ArchiveDestination = {
  path: string
  directory: FileHandle
  identity: DirectoryIdentity
  uid: number | undefined
}
type SegmentSummary = {
  byteCount: number
  records: number
  firstRecordSequence: string | null
  lastRecordSequence: string | null
  sha256: string
}
type SegmentScan = SegmentSummary & { bytes: Buffer }
type SealedSegment = {
  manifest: AuditSegmentManifest
  manifestBytes: Buffer
  acknowledgement?: { value: AuditArchiveAcknowledgement; bytes: Buffer }
}
type OpenSegment = Omit<SegmentSummary, 'sha256'> & {
  sequence: number
  handle: FileHandle
  identity: DirectoryIdentity
  hash: Hash
  commitBytes: number
}

type OpenCommit = {
  schemaVersion: typeof AUDIT_SEGMENT_SCHEMA_VERSION
  segmentSequence: string
  bytes: number
  records: number
  lastRecordSequence: string | null
  sha256: string
  pendingRecordBase64?: string
}

type RecoveredSealed = {
  resident: SealedSegment[]
  metadataBytes: number
  lastSequence: number
  lastRecordSequence: string | null
  previousManifestSha256: string | null
}

type RecoveredLifecycle = {
  directory: FileHandle
  directoryIdentity: DirectoryIdentity
  directoryPath: string
  uid: number | undefined
  sealed: SealedSegment[]
  current: OpenSegment
  nextRecordSequence: number
  metadataBytes: number
  previousManifestSha256: string | null
}

export async function openRunnerAuditLifecycle(options: RunnerAuditLifecycleOptions): Promise<RunnerAuditLifecycleOpen> {
  const storage = createFileRunnerHomeStorage({
    defaultRoot: path.resolve(options.runnerHome),
    ...(options.currentUserId === undefined ? {} : { currentUserId: options.currentUserId }),
  })
  try {
    await storage.inspect({ override: options.runnerHome })
    if (await storage.acquire?.() !== 'acquired') return await unavailable(storage)
    const recovered = await recoverLifecycle(path.resolve(options.runnerHome), options.currentUserId ?? process.getuid?.())
    return { status: 'ready', audit: new FileRunnerAuditLifecycle(storage, recovered) }
  } catch {
    return await unavailable(storage)
  }
}

export async function openBoundRunnerAuditLifecycle(
  options: RunnerAuditLifecycleOptions,
): Promise<RunnerAuditLifecycleOpen> {
  try {
    const recovered = await recoverLifecycle(path.resolve(options.runnerHome), options.currentUserId ?? process.getuid?.())
    return { status: 'ready', audit: new FileRunnerAuditLifecycle(null, recovered) }
  } catch {
    return { status: 'storage-unavailable' }
  }
}

export async function archiveRunnerAudit(options: RunnerAuditArchiveOptions): Promise<RunnerAuditArchiveResult> {
  const root = path.resolve(options.runnerHome)
  const storage = createFileRunnerHomeStorage({
    defaultRoot: root,
    ...(options.currentUserId === undefined ? {} : { currentUserId: options.currentUserId }),
  })
  let recovered: RecoveredLifecycle | undefined
  let destination: ArchiveDestination | undefined
  try {
    destination = await openArchiveDestination(root, options.destination, options.currentUserId ?? process.getuid?.())
    await storage.inspect({ override: root })
    if (await storage.acquire?.() !== 'acquired') return await unavailableArchive(storage, destination)
    recovered = await recoverLifecycle(root, options.currentUserId ?? process.getuid?.())
    const result = await archiveSealed(recovered, destination, options.now ?? Date.now)
    await closeArchiveResources(storage, recovered, destination)
    return result
  } catch {
    return await unavailableArchive(storage, destination, recovered)
  }
}

class FileRunnerAuditLifecycle implements RunnerAuditLifecycle {
  private queue: Promise<unknown> = Promise.resolve()
  private faulted = false
  private closed = false
  private readonly sealed: SealedSegment[]
  private current: OpenSegment
  private nextRecordSequence: number
  private metadataBytes: number
  private previousManifestSha256: string | null

  constructor(
    private readonly storage: RunnerHomeStorage | null,
    private readonly recovered: RecoveredLifecycle,
  ) {
    this.sealed = [...recovered.sealed]
    this.current = recovered.current
    this.nextRecordSequence = recovered.nextRecordSequence
    this.metadataBytes = recovered.metadataBytes
    this.previousManifestSha256 = recovered.previousManifestSha256
  }

  append(record: AuditRecordInputV2): Promise<void> {
    const operation = this.queue.then(() => this.appendOne(record))
    // The caller receives the append failure; the ordering queue remains usable for close/snapshot.
    this.queue = operation.catch(() => undefined)
    return operation
  }

  snapshot(): Promise<AuditLifecycleSnapshot> {
    return this.queue.then(() => ({
      state: this.faulted || this.closed ? 'storage-unavailable' as const : 'ready' as const,
      residentSegments: this.sealed.length + 1,
      residentBytes: this.sealed.reduce((total, segment) => total + segment.manifest.bytes, this.current.byteCount),
      metadataBytes: this.metadataBytes,
      openSequence: this.closed ? null : String(this.current.sequence),
    }))
  }

  close(): Promise<void> {
    const operation = this.queue.then(() => this.closeOwned(), () => this.closeOwned())
    // Close reports its own failure while the internal queue only retains ordering.
    this.queue = operation.catch(() => undefined)
    return operation
  }

  private async appendOne(record: AuditRecordInputV2): Promise<void> {
    if (this.closed || this.faulted || !Number.isSafeInteger(this.nextRecordSequence)) throw new Error('audit lifecycle unavailable')
    try {
      const bytes = encodeAuditRecord(record, String(this.nextRecordSequence))
      if (this.mustRotate(bytes.byteLength)) await this.rotate()
      await assertDirectoryBound(this.recovered.directory, this.recovered.directoryIdentity, this.recovered.directoryPath, this.recovered.uid)
      const pendingCommit = openCommit(
        this.current.sequence,
        this.current.byteCount,
        this.current.records,
        this.current.lastRecordSequence,
        this.current.hash.copy().digest('hex'),
        bytes.toString('base64'),
      )
      const pendingBytes = encodeOpenCommit(pendingCommit)
      if (this.metadataBytes - this.current.commitBytes + pendingBytes.byteLength > MAX_AUDIT_METADATA_BYTES) {
        throw new Error('audit metadata capacity exhausted')
      }
      await writeOpenCommit(this.recovered, pendingCommit, pendingBytes)
      this.metadataBytes += pendingBytes.byteLength - this.current.commitBytes
      this.current.commitBytes = pendingBytes.byteLength
      await writeAll(this.current.handle, bytes)
      await this.current.handle.sync()
      await assertSegmentBound(this.current, this.recovered.directoryPath, this.recovered.uid)
      await assertDirectoryBound(this.recovered.directory, this.recovered.directoryIdentity, this.recovered.directoryPath, this.recovered.uid)
      const nextHash = this.current.hash.copy().update(bytes)
      const commit = openCommit(
        this.current.sequence,
        this.current.byteCount + bytes.byteLength,
        this.current.records + 1,
        String(this.nextRecordSequence),
        nextHash.copy().digest('hex'),
      )
      const commitBytes = encodeOpenCommit(commit)
      if (this.metadataBytes - this.current.commitBytes + commitBytes.byteLength > MAX_AUDIT_METADATA_BYTES) {
        throw new Error('audit metadata capacity exhausted')
      }
      await writeOpenCommit(this.recovered, commit, commitBytes)
      this.metadataBytes += commitBytes.byteLength - this.current.commitBytes
      this.current.commitBytes = commitBytes.byteLength
      this.current.hash = nextHash
      this.current.byteCount = commit.bytes
      this.current.records = commit.records
      this.current.firstRecordSequence ??= String(this.nextRecordSequence)
      this.current.lastRecordSequence = commit.lastRecordSequence
      this.nextRecordSequence += 1
    } catch (error) {
      this.faulted = true
      throw error
    }
  }

  private mustRotate(nextBytes: number): boolean {
    return this.current.records >= MAX_AUDIT_SEGMENT_RECORDS
      || this.current.byteCount + nextBytes > MAX_AUDIT_SEGMENT_BYTES
  }

  private async rotate(): Promise<void> {
    if (this.current.records === 0) throw new Error('an empty audit segment cannot rotate')
    if (this.sealed.length + 1 >= MAX_RESIDENT_AUDIT_SEGMENTS) throw new Error('audit lifecycle requires operator archive')
    const sequence = this.current.sequence
    const sealedPath = path.join(this.recovered.directoryPath, segmentName(sequence, 'jsonl'))
    await this.current.handle.sync()
    await assertSegmentBound(this.current, this.recovered.directoryPath, this.recovered.uid)
    await this.current.handle.close()
    await rename(path.join(this.recovered.directoryPath, segmentName(sequence, 'open')), sealedPath)
    await syncDirectory(this.recovered)
    const manifest = manifestFor(sequence, {
      byteCount: this.current.byteCount,
      records: this.current.records,
      firstRecordSequence: this.current.firstRecordSequence,
      lastRecordSequence: this.current.lastRecordSequence,
      sha256: this.current.hash.digest('hex'),
    }, this.previousManifestSha256)
    const manifestBytes = await writeManifest(this.recovered, manifest)
    const emptyCommitBytes = encodeOpenCommit(openCommit(sequence + 1, 0, 0, null, sha256(Buffer.alloc(0))))
    const nextMetadata = this.metadataBytes + manifestBytes.byteLength + emptyCommitBytes.byteLength
      - this.current.commitBytes
    if (nextMetadata > MAX_AUDIT_METADATA_BYTES) throw new Error('audit metadata capacity exhausted')
    await unlink(path.join(this.recovered.directoryPath, segmentName(sequence, 'commit.json')))
    await syncDirectory(this.recovered)
    this.previousManifestSha256 = sha256(manifestBytes)
    this.sealed.push({ manifest, manifestBytes })
    this.current = await createOpenSegment(this.recovered, sequence + 1)
    this.metadataBytes = nextMetadata
  }

  private async closeOwned(): Promise<void> {
    if (this.closed) return
    this.closed = true
    let failure: unknown
    try {
      await this.current.handle.sync()
      await this.current.handle.close()
      await this.recovered.directory.close()
    } catch (error) {
      failure = error
    }
    if (this.storage) {
      try {
        await this.storage.release?.()
        await this.storage.close?.()
      } catch (error) {
        failure ??= error
      }
    }
    if (failure) throw failure
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
    let acknowledgement = segment.acknowledgement
    if (!acknowledgement) {
      const source = await readResidentSegment(recovered, segment.manifest)
      const artifactSha256 = await copyArchiveArtifact(destination, segment, source)
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
  if (existing !== null) {
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat({ bigint: true })
      if (!secureRecord(info, destination.uid) || Number(info.size) !== bytes.byteLength
        || !(await readAll(handle, bytes.byteLength)).equals(bytes)) throw new Error('archive artifact conflicts')
    } finally {
      await handle.close()
    }
    return
  }
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
    await assertArchiveDestination(destination)
  } catch (error) {
    // A failed copy has no acknowledgement; its private temporary cannot authorize reclamation.
    await handle?.close().catch(() => undefined)
    // The final artifact name is the only destination commit marker.
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

async function openArchiveDestination(
  runnerHome: string,
  selected: string,
  uid: number | undefined,
): Promise<ArchiveDestination> {
  const destinationPath = path.resolve(selected)
  if (containsPath(runnerHome, destinationPath) || containsPath(destinationPath, runnerHome)) {
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

async function recoverLifecycle(root: string, uid: number | undefined): Promise<RecoveredLifecycle> {
  const directoryPath = path.join(root, AUDIT_DIRECTORY)
  await ensureAuditDirectory(directoryPath, uid)
  const directory = await open(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const directoryInfo = await directory.stat({ bigint: true })
  if (!secureDirectory(directoryInfo, uid)) throw new Error('insecure audit directory')
  const recovered = { directory, directoryIdentity: identityOf(directoryInfo), directoryPath, uid }
  try {
    await removeInterruptedTemps(recovered)
    const entries = await readdir(directoryPath)
    const grouped = classifyEntries(entries)
    if (grouped.commits.some(sequence => !grouped.segments.includes(sequence) && !grouped.opens.includes(sequence))) {
      throw new Error('audit commit has no segment')
    }
    const recoveredSealed = await recoverSealed(recovered, grouped)
    if (recoveredSealed.metadataBytes > MAX_AUDIT_METADATA_BYTES
      || recoveredSealed.resident.length >= MAX_RESIDENT_AUDIT_SEGMENTS) {
      throw new Error('audit metadata capacity exhausted')
    }
    const expectedOpen = recoveredSealed.lastSequence + 1
    if (grouped.opens.length > 1 || (grouped.opens[0] !== undefined && grouped.opens[0] !== expectedOpen)) {
      throw new Error('ambiguous audit open segment')
    }
    const current = grouped.opens.length === 0
      ? await createOpenSegment(recovered, expectedOpen)
      : await openExistingSegment(recovered, expectedOpen, grouped.commits.includes(expectedOpen))
    const previousManifestSha256 = recoveredSealed.previousManifestSha256
    const previousRecord = recoveredSealed.lastRecordSequence ?? undefined
    if (previousRecord && current.firstRecordSequence && Number(current.firstRecordSequence) !== Number(previousRecord) + 1) {
      throw new Error('audit record sequence gap')
    }
    const lastRecord = current.lastRecordSequence ?? previousRecord
    return {
      ...recovered,
      sealed: recoveredSealed.resident,
      current,
      nextRecordSequence: lastRecord ? Number(lastRecord) + 1 : 1,
      metadataBytes: recoveredSealed.metadataBytes + current.commitBytes,
      previousManifestSha256,
    }
  } catch (error) {
    // Recovery's original integrity failure is the actionable error; cleanup cannot replace it.
    await directory.close().catch(() => undefined)
    throw error
  }
}

async function ensureAuditDirectory(directoryPath: string, uid: number | undefined): Promise<void> {
  const held = await lstat(directoryPath).catch(error => missingOnly(error))
  if (held === null) {
    await mkdir(directoryPath, { mode: DIRECTORY_MODE })
    const parent = await open(path.dirname(directoryPath), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      await parent.sync()
    } finally {
      await parent.close()
    }
  }
  const info = await lstat(directoryPath)
  if (!secureDirectory(info, uid)) throw new Error('insecure audit directory')
}

function classifyEntries(entries: readonly string[]) {
  const segments: number[] = []
  const manifests: number[] = []
  const commits: number[] = []
  const acknowledgements: number[] = []
  const tombstones: number[] = []
  const opens: number[] = []
  for (const entry of entries) {
    if (TEMP_METADATA_PATTERN.test(entry)) continue
    const matched = SEGMENT_PATTERN.exec(entry)
    if (!matched) throw new Error('unknown audit lifecycle entry')
    const sequence = parseSegmentSequence(matched[1]!)
    if (matched[2] === 'open') opens.push(sequence)
    else if (matched[2] === 'jsonl') segments.push(sequence)
    else if (matched[2] === 'manifest.json') manifests.push(sequence)
    else if (matched[2] === 'commit.json') commits.push(sequence)
    else if (matched[2] === 'ack.json') acknowledgements.push(sequence)
    else tombstones.push(sequence)
  }
  return {
    segments: segments.sort(numeric),
    manifests: manifests.sort(numeric),
    commits: commits.sort(numeric),
    acknowledgements: acknowledgements.sort(numeric),
    tombstones: tombstones.sort(numeric),
    opens: opens.sort(numeric),
  }
}

async function recoverSealed(
  recovered: RecoveryPath,
  grouped: ReturnType<typeof classifyEntries>,
): Promise<RecoveredSealed> {
  const maxSequence = Math.max(0, ...grouped.segments, ...grouped.manifests)
  if (grouped.manifests.some((sequence, index) => sequence !== index + 1)) throw new Error('audit manifest sequence gap')
  if (grouped.acknowledgements.some(sequence => !grouped.manifests.includes(sequence))) throw new Error('audit acknowledgement has no manifest')
  if (grouped.tombstones.some(sequence => !grouped.acknowledgements.includes(sequence))) throw new Error('audit tombstone has no acknowledgement')
  const resident: SealedSegment[] = []
  let metadataBytes = 0
  let previousManifestSha256: string | null = null
  let previousRecord = 0
  for (let sequence = 1; sequence <= maxSequence; sequence += 1) {
    let scan = grouped.segments.includes(sequence) ? await scanSegment(recovered, sequence, 'jsonl') : null
    if (scan && (scan.records === 0 || !scan.firstRecordSequence || !scan.lastRecordSequence)) throw new Error('empty sealed audit segment')
    let manifest: AuditSegmentManifest
    let manifestBytes: Buffer
    if (grouped.manifests.includes(sequence)) {
      ;({ manifest, bytes: manifestBytes } = await readManifest(recovered, sequence))
    } else {
      if (!scan || sequence !== maxSequence) throw new Error('interrupted nonterminal audit seal')
      manifest = manifestFor(sequence, scan, previousManifestSha256)
      manifestBytes = await writeManifest(recovered, manifest)
    }
    if (!manifestChainMatches(manifest, sequence, previousRecord, previousManifestSha256)) throw new Error('audit manifest chain mismatch')
    if (scan && !manifestMatches(manifest, sequence, scan, previousManifestSha256)) throw new Error('audit manifest mismatch')
    const acknowledgement = grouped.acknowledgements.includes(sequence)
      ? await readAcknowledgement(recovered, sequence, manifest, manifestBytes)
      : undefined
    const tombstone = grouped.tombstones.includes(sequence)
      ? await readTombstone(recovered, sequence, manifest, acknowledgement!)
      : undefined
    if (!scan && !tombstone) throw new Error('audit manifest has no resident or reclaimed segment')
    if (grouped.commits.includes(sequence)) {
      if (!scan) throw new Error('audit commit has no resident segment')
      const { commit } = await readOpenCommit(recovered, sequence)
      if (!commitMatches(commit, sequence, scan)) throw new Error('audit open commit mismatch')
      await unlink(path.join(recovered.directoryPath, segmentName(sequence, 'commit.json')))
      await syncDirectory(recovered)
    }
    if (scan && tombstone) {
      await unlink(path.join(recovered.directoryPath, segmentName(sequence, 'jsonl')))
      await syncDirectory(recovered)
      scan = null
    }
    if (scan) resident.push({ manifest, manifestBytes, ...(acknowledgement ? { acknowledgement } : {}) })
    metadataBytes += manifestBytes.byteLength + (acknowledgement?.bytes.byteLength ?? 0) + (tombstone?.bytes.byteLength ?? 0)
    previousManifestSha256 = sha256(manifestBytes)
    previousRecord = Number(manifest.lastRecordSequence)
  }
  return {
    resident,
    metadataBytes,
    lastSequence: maxSequence,
    lastRecordSequence: maxSequence === 0 ? null : String(previousRecord),
    previousManifestSha256,
  }
}

async function createOpenSegment(recovered: RecoveryPath, sequence: number): Promise<OpenSegment> {
  const target = path.join(recovered.directoryPath, segmentName(sequence, 'open'))
  const handle = await open(target, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE)
  try {
    const info = await handle.stat({ bigint: true })
    if (!secureRecord(info, recovered.uid)) throw new Error('insecure audit segment')
    await handle.sync()
    await syncDirectory(recovered)
    const commit = openCommit(sequence, 0, 0, null, sha256(Buffer.alloc(0)))
    const commitBytes = encodeOpenCommit(commit)
    await writeOpenCommit(recovered, commit, commitBytes)
    return {
      sequence,
      handle,
      identity: identityOf(info),
      byteCount: 0,
      records: 0,
      firstRecordSequence: null,
      lastRecordSequence: null,
      hash: createHash('sha256'),
      commitBytes: commitBytes.byteLength,
    }
  } catch (error) {
    // Segment creation already failed closed; a close error cannot make it available.
    await handle.close().catch(() => undefined)
    throw error
  }
}

async function openExistingSegment(
  recovered: RecoveryPath,
  sequence: number,
  hasCommit: boolean,
): Promise<OpenSegment> {
  const target = path.join(recovered.directoryPath, segmentName(sequence, 'open'))
  const handle = await open(target, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat({ bigint: true })
    if (!secureRecord(info, recovered.uid) || info.size > BigInt(MAX_AUDIT_SEGMENT_BYTES)) throw new Error('insecure audit segment')
    const raw = await readAll(handle, Number(info.size))
    const held = hasCommit
      ? await readOpenCommit(recovered, sequence)
      : { commit: openCommit(sequence, 0, 0, null, sha256(Buffer.alloc(0))), bytes: Buffer.alloc(0) }
    if (!hasCommit && raw.byteLength !== 0) throw new Error('audit open segment has no commit marker')
    if (raw.byteLength < held.commit.bytes) throw new Error('audit open segment lost committed bytes')
    const committed = raw.subarray(0, held.commit.bytes)
    const scan = scanAuditBytes(committed)
    if (!commitMatches(held.commit, sequence, scan)) throw new Error('audit open commit mismatch')
    const tail = raw.subarray(held.commit.bytes)
    const pending = pendingRecord(held.commit, scan.lastRecordSequence)
    if (tail.byteLength > 0 && (!pending || tail.byteLength > pending.byteLength || !pending.subarray(0, tail.byteLength).equals(tail))) {
      throw new Error('audit open segment has an unproved tail')
    }
    if (tail.byteLength > 0) {
      await handle.truncate(held.commit.bytes)
      await handle.sync()
    }
    const finalCommit = openCommit(sequence, scan.byteCount, scan.records, scan.lastRecordSequence, scan.sha256)
    const commitBytes = encodeOpenCommit(finalCommit)
    if (!hasCommit || held.commit.pendingRecordBase64 !== undefined) {
      await writeOpenCommit(recovered, finalCommit, commitBytes)
    }
    return {
      sequence,
      handle,
      identity: identityOf(info),
      byteCount: scan.byteCount,
      records: scan.records,
      firstRecordSequence: scan.firstRecordSequence,
      lastRecordSequence: scan.lastRecordSequence,
      hash: createHash('sha256').update(committed),
      commitBytes: commitBytes.byteLength,
    }
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function scanSegment(
  recovered: RecoveryPath,
  sequence: number,
  extension: 'jsonl',
): Promise<SegmentScan> {
  const target = path.join(recovered.directoryPath, segmentName(sequence, extension))
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat({ bigint: true })
    if (!secureRecord(info, recovered.uid) || info.size > BigInt(MAX_AUDIT_SEGMENT_BYTES)) throw new Error('invalid audit segment')
    return scanAuditBytes(await readAll(handle, Number(info.size)))
  } finally {
    await handle.close()
  }
}

function scanAuditBytes(bytes: Buffer): SegmentScan {
  const records = splitRecordLines(bytes)
  if (records.length > MAX_AUDIT_SEGMENT_RECORDS) throw new Error('audit segment record limit exceeded')
  const sequences: number[] = []
  for (const record of records) {
    const decoded = decodeAuditRecord(record)
    if (!decoded || !Buffer.from(JSON.stringify(decoded)).equals(record)) throw new Error('invalid audit record')
    sequences.push(Number(decoded.sequence))
  }
  if (sequences.some((value, index) => index > 0 && value !== sequences[index - 1]! + 1)) throw new Error('audit record sequence gap')
  return {
    bytes,
    byteCount: bytes.byteLength,
    records: records.length,
    firstRecordSequence: sequences.length ? String(sequences[0]) : null,
    lastRecordSequence: sequences.length ? String(sequences.at(-1)) : null,
    sha256: sha256(bytes),
  }
}

function manifestFor(
  sequence: number,
  scan: SegmentSummary,
  previousManifestSha256: string | null,
): AuditSegmentManifest {
  if (!scan.firstRecordSequence || !scan.lastRecordSequence) throw new Error('empty audit segment cannot be sealed')
  return {
    schemaVersion: AUDIT_SEGMENT_SCHEMA_VERSION,
    sequence: String(sequence),
    state: 'sealed',
    recordSchemaVersion: 2,
    bytes: scan.byteCount,
    records: scan.records,
    sha256: scan.sha256,
    firstRecordSequence: scan.firstRecordSequence,
    lastRecordSequence: scan.lastRecordSequence,
    previousManifestSha256,
  }
}

function openCommit(
  sequence: number,
  bytes: number,
  records: number,
  lastRecordSequence: string | null,
  digest: string,
  pendingRecordBase64?: string,
): OpenCommit {
  return {
    schemaVersion: AUDIT_SEGMENT_SCHEMA_VERSION,
    segmentSequence: String(sequence),
    bytes,
    records,
    lastRecordSequence,
    sha256: digest,
    ...(pendingRecordBase64 === undefined ? {} : { pendingRecordBase64 }),
  }
}

function encodeOpenCommit(commit: OpenCommit): Buffer {
  return Buffer.from(`${JSON.stringify(commit)}\n`)
}

async function writeOpenCommit(
  recovered: RecoveryPath,
  commit: OpenCommit,
  bytes = encodeOpenCommit(commit),
): Promise<void> {
  const finalPath = path.join(recovered.directoryPath, segmentName(Number(commit.segmentSequence), 'commit.json'))
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
    // The commit update failed closed; its temporary name is never authoritative.
    await handle?.close().catch(() => undefined)
    // An unremovable temp is ignored during recovery because only commit.json is authoritative.
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

async function readOpenCommit(recovered: RecoveryPath, sequence: number): Promise<{ commit: OpenCommit; bytes: Buffer }> {
  const target = path.join(recovered.directoryPath, segmentName(sequence, 'commit.json'))
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat({ bigint: true })
    if (!secureRecord(info, recovered.uid) || info.size > BigInt(MAX_AUDIT_METADATA_BYTES)) throw new Error('invalid audit commit')
    const bytes = await readAll(handle, Number(info.size))
    const commit = JSON.parse(bytes.toString('utf8')) as OpenCommit
    if (!Buffer.from(`${JSON.stringify(commit)}\n`).equals(bytes)) throw new Error('noncanonical audit commit')
    return { commit, bytes }
  } finally {
    await handle.close()
  }
}

function pendingRecord(commit: OpenCommit, lastRecordSequence: string | null): Buffer | null {
  const encoded = commit.pendingRecordBase64
  if (encoded === undefined) return null
  if (encoded.length > Math.ceil(MAX_AUDIT_RECORD_BYTES / 3) * 4) throw new Error('audit pending record exceeds its bound')
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.toString('base64') !== encoded || bytes.byteLength === 0 || bytes.at(-1) !== 0x0a) {
    throw new Error('invalid audit pending record')
  }
  const decoded = decodeAuditRecord(bytes.subarray(0, -1))
  const expected = lastRecordSequence === null ? 1 : Number(lastRecordSequence) + 1
  if (!decoded || Number(decoded.sequence) !== expected || !Buffer.from(`${JSON.stringify(decoded)}\n`).equals(bytes)) {
    throw new Error('audit pending record does not follow the committed sequence')
  }
  return bytes
}

function commitMatches(commit: OpenCommit, sequence: number, scan: SegmentSummary): boolean {
  return commit.schemaVersion === AUDIT_SEGMENT_SCHEMA_VERSION
    && commit.segmentSequence === String(sequence)
    && commit.bytes === scan.byteCount
    && commit.records === scan.records
    && commit.lastRecordSequence === scan.lastRecordSequence
    && commit.sha256 === scan.sha256
}

async function writeManifest(recovered: RecoveryPath, manifest: AuditSegmentManifest): Promise<Buffer> {
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`)
  const finalPath = path.join(recovered.directoryPath, segmentName(Number(manifest.sequence), 'manifest.json'))
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
    return bytes
  } catch (error) {
    // The manifest write/rename failure is primary; best-effort private-temp cleanup changes no state.
    await handle?.close().catch(() => undefined)
    // An unremovable temp is inert because only the final manifest name commits a seal.
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

async function readManifest(recovered: RecoveryPath, sequence: number): Promise<{ manifest: AuditSegmentManifest; bytes: Buffer }> {
  const target = path.join(recovered.directoryPath, segmentName(sequence, 'manifest.json'))
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat({ bigint: true })
    if (!secureRecord(info, recovered.uid) || info.size > BigInt(MAX_AUDIT_METADATA_BYTES)) throw new Error('invalid audit manifest')
    const bytes = await readAll(handle, Number(info.size))
    const manifest = JSON.parse(bytes.toString('utf8')) as AuditSegmentManifest
    return { manifest, bytes }
  } finally {
    await handle.close()
  }
}

function manifestChainMatches(
  manifest: AuditSegmentManifest,
  sequence: number,
  previousRecord: number,
  previousManifestSha256: string | null,
): boolean {
  const first = Number(manifest.firstRecordSequence)
  const last = Number(manifest.lastRecordSequence)
  return manifest.schemaVersion === AUDIT_SEGMENT_SCHEMA_VERSION
    && manifest.sequence === String(sequence)
    && manifest.state === 'sealed'
    && manifest.recordSchemaVersion === 2
    && Number.isSafeInteger(manifest.bytes) && manifest.bytes > 0 && manifest.bytes <= MAX_AUDIT_SEGMENT_BYTES
    && Number.isSafeInteger(manifest.records) && manifest.records > 0 && manifest.records <= MAX_AUDIT_SEGMENT_RECORDS
    && sha256Value(manifest.sha256)
    && Number.isSafeInteger(first) && first === previousRecord + 1
    && Number.isSafeInteger(last) && last - first + 1 === manifest.records
    && manifest.previousManifestSha256 === previousManifestSha256
}

function manifestMatches(
  manifest: AuditSegmentManifest,
  sequence: number,
  scan: SegmentScan,
  previousManifestSha256: string | null,
): boolean {
  return manifest.schemaVersion === AUDIT_SEGMENT_SCHEMA_VERSION
    && manifest.sequence === String(sequence)
    && manifest.state === 'sealed'
    && manifest.recordSchemaVersion === 2
    && manifest.bytes === scan.byteCount
    && manifest.records === scan.records
    && manifest.sha256 === scan.sha256
    && manifest.firstRecordSequence === scan.firstRecordSequence
    && manifest.lastRecordSequence === scan.lastRecordSequence
    && manifest.previousManifestSha256 === previousManifestSha256
}

async function readAcknowledgement(
  recovered: RecoveryPath,
  sequence: number,
  manifest: AuditSegmentManifest,
  manifestBytes: Buffer,
): Promise<{ value: AuditArchiveAcknowledgement; bytes: Buffer }> {
  const { value, bytes } = await readMetadata(recovered, sequence, 'ack.json')
  const acknowledgement = value as AuditArchiveAcknowledgement
  if (acknowledgement.schemaVersion !== 1
    || acknowledgement.segmentSequence !== String(sequence)
    || acknowledgement.segmentSha256 !== manifest.sha256
    || acknowledgement.manifestSha256 !== sha256(manifestBytes)
    || acknowledgement.bytes !== manifest.bytes
    || acknowledgement.records !== manifest.records
    || !sha256Value(acknowledgement.exportId)
    || !sha256Value(acknowledgement.artifactSha256)
    || !validTimestamp(acknowledgement.acknowledgedAt)) {
    throw new Error('invalid audit archive acknowledgement')
  }
  return { value: acknowledgement, bytes }
}

async function readTombstone(
  recovered: RecoveryPath,
  sequence: number,
  manifest: AuditSegmentManifest,
  acknowledgement: { value: AuditArchiveAcknowledgement; bytes: Buffer },
): Promise<{ value: AuditReclamationTombstone; bytes: Buffer }> {
  const { value, bytes } = await readMetadata(recovered, sequence, 'tombstone.json')
  const tombstone = value as AuditReclamationTombstone
  if (tombstone.schemaVersion !== 1
    || tombstone.segmentSequence !== String(sequence)
    || tombstone.segmentSha256 !== manifest.sha256
    || tombstone.acknowledgementSha256 !== sha256(acknowledgement.bytes)
    || !validTimestamp(tombstone.reclaimedAt)) {
    throw new Error('invalid audit reclamation tombstone')
  }
  return { value: tombstone, bytes }
}

async function readMetadata(
  recovered: RecoveryPath,
  sequence: number,
  extension: 'ack.json' | 'tombstone.json',
): Promise<{ value: unknown; bytes: Buffer }> {
  const target = path.join(recovered.directoryPath, segmentName(sequence, extension))
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat({ bigint: true })
    if (!secureRecord(info, recovered.uid) || info.size > BigInt(MAX_AUDIT_METADATA_BYTES)) throw new Error('invalid audit metadata')
    const bytes = await readAll(handle, Number(info.size))
    const value = JSON.parse(bytes.toString('utf8')) as unknown
    if (!Buffer.from(`${JSON.stringify(value)}\n`).equals(bytes)) throw new Error('noncanonical audit metadata')
    return { value, bytes }
  } finally {
    await handle.close()
  }
}

async function removeInterruptedTemps(recovered: RecoveryPath): Promise<void> {
  const entries = await readdir(recovered.directoryPath)
  let removed = false
  for (const entry of entries) {
    if (!TEMP_METADATA_PATTERN.test(entry)) continue
    const target = path.join(recovered.directoryPath, entry)
    const info = await lstat(target)
    if (!secureRecord(info, recovered.uid)) throw new Error('insecure audit temporary')
    await unlink(target)
    removed = true
  }
  if (removed) await syncDirectory(recovered)
}

type RecoveryPath = {
  directory: FileHandle
  directoryIdentity: DirectoryIdentity
  directoryPath: string
  uid: number | undefined
}

async function syncDirectory(recovered: RecoveryPath): Promise<void> {
  await recovered.directory.sync()
  await assertDirectoryBound(recovered.directory, recovered.directoryIdentity, recovered.directoryPath, recovered.uid)
}

async function assertSegmentBound(
  segment: OpenSegment,
  directoryPath: string,
  uid: number | undefined,
): Promise<void> {
  const target = path.join(directoryPath, segmentName(segment.sequence, 'open'))
  const [held, current] = await Promise.all([segment.handle.stat({ bigint: true }), lstat(target, { bigint: true })])
  if (!secureRecord(held, uid) || !secureRecord(current, uid)) throw new Error('audit segment custody changed')
  if (held.dev !== segment.identity.device || held.ino !== segment.identity.inode
    || current.dev !== segment.identity.device || current.ino !== segment.identity.inode) {
    throw new Error('audit segment identity changed')
  }
}

async function assertDirectoryBound(
  handle: FileHandle,
  identity: DirectoryIdentity,
  target: string,
  uid: number | undefined,
): Promise<void> {
  const [held, current] = await Promise.all([handle.stat({ bigint: true }), lstat(target, { bigint: true })])
  if (!secureDirectory(held, uid) || !secureDirectory(current, uid)) throw new Error('audit directory custody changed')
  if (held.dev !== identity.device || held.ino !== identity.inode || current.dev !== identity.device || current.ino !== identity.inode) {
    throw new Error('audit directory identity changed')
  }
}

function splitRecordLines(bytes: Buffer): Buffer[] {
  const records: Buffer[] = []
  let start = 0
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0x0a) continue
    records.push(bytes.subarray(start, index))
    start = index + 1
  }
  if (start !== bytes.byteLength) throw new Error('incomplete audit record tail')
  return records
}

async function readAll(handle: FileHandle, size: number): Promise<Buffer> {
  const bytes = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    const { bytesRead } = await handle.read(bytes, offset, size - offset, offset)
    if (bytesRead === 0) throw new Error('audit file ended before its reported size')
    offset += bytesRead
  }
  return bytes
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset)
    if (bytesWritten === 0) throw new Error('audit write made no progress')
    offset += bytesWritten
  }
}

function segmentName(
  sequence: number,
  extension: 'open' | 'jsonl' | 'manifest.json' | 'commit.json' | 'ack.json' | 'tombstone.json',
): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('invalid audit segment sequence')
  return `segment-${String(sequence).padStart(SEQUENCE_WIDTH, '0')}.${extension}`
}

function parseSegmentSequence(value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('invalid audit segment sequence')
  return parsed
}

function secureDirectory(info: Stats | BigIntStats, uid: number | undefined): boolean {
  return info.isDirectory() && (uid === undefined || Number(info.uid) === uid) && (Number(info.mode) & 0o777) === DIRECTORY_MODE
}

function secureRecord(info: Stats | BigIntStats, uid: number | undefined): boolean {
  return info.isFile() && (uid === undefined || Number(info.uid) === uid) && (Number(info.mode) & 0o777) === FILE_MODE && Number(info.nlink) === 1
}

function identityOf(info: BigIntStats): DirectoryIdentity {
  return { device: info.dev, inode: info.ino }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sha256Value(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function numeric(left: number, right: number): number {
  return left - right
}

function missingOnly(error: unknown): null {
  if (isCode(error, 'ENOENT')) return null
  throw error
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}

async function unavailable(storage: RunnerHomeStorage): Promise<RunnerAuditLifecycleOpen> {
  // The public result is already fail-closed; cleanup failures cannot make it more unavailable.
  await storage.release?.().catch(() => undefined)
  // Closing the already-unavailable storage cannot alter the fail-closed result.
  await storage.close?.().catch(() => undefined)
  return { status: 'storage-unavailable' }
}

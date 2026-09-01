import { constants, type BigIntStats, type Stats } from 'node:fs'
import {
  SESSION_LAUNCH_PROTOCOL_VERSION,
  isRefusalReason,
  isSafeIdentifier,
  parseSessionLaunchServerMessage,
} from '@modulastack/runner-protocol'
import { createHash, randomBytes, type Hash } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
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
  type RunnerAuditLifecycle,
  type RunnerAuditLifecycleOpen,
  type RunnerAuditLifecycleOptions,
} from './auditLifecycle.js'
import { decodeAuditRecord, encodeAuditRecord } from './auditRecordCodec.js'
import { createFileRunnerHomeStorage } from './runnerHomeStorage.js'
import type { RunnerHomeStorage } from './runnerHome.js'
import { linuxDescriptorRootPath, withLinuxRootLease } from './linuxRootLease.js'
import {
  descriptorRootAdapter,
  identityOf as descriptorIdentityOf,
  sameIdentity,
  type DescriptorChildHandle,
  type DescriptorRootAdapter,
  type DescriptorRootEntryStat,
} from './descriptorRootAdapter.js'

export const DIRECTORY_MODE = 0o700
export const FILE_MODE = 0o600
export const AUDIT_DIRECTORY = 'audit.jsonl'
export const LEGACY_BACKUP = 'audit.jsonl.legacy'
export const MIGRATING_DIRECTORY = 'audit.jsonl.migrating'
export const MIGRATION_MARKER = 'migration.json'
export const SEQUENCE_WIDTH = 20
const SEGMENT_PATTERN = /^segment-([0-9]{20})\.(open|jsonl|manifest\.json|commit\.json|ack\.json|tombstone\.json)$/
const TEMP_METADATA_PATTERN = /^segment-([0-9]{20})\.(manifest|commit|ack|tombstone)\.tmp-[0-9a-f]{32}$/

export type DirectoryIdentity = { device: bigint; inode: bigint }
type SegmentSummary = {
  byteCount: number
  records: number
  firstRecordSequence: string | null
  lastRecordSequence: string | null
  sha256: string
}
type SegmentScan = SegmentSummary & { bytes: Buffer }
export type SealedSegment = {
  manifest: AuditSegmentManifest
  manifestBytes: Buffer
  acknowledgement?: { value: AuditArchiveAcknowledgement; bytes: Buffer }
}
export type OpenSegment = Omit<SegmentSummary, 'sha256'> & {
  sequence: number
  handle: DescriptorChildHandle
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

export type MigrationMarker = {
  schemaVersion: 1
  legacySha256: string
  legacyBytes: number
  legacyRecords: number
  lastManifestSha256: string | null
}

type RecoveredSealed = {
  resident: SealedSegment[]
  metadataBytes: number
  lastSequence: number
  lastRecordSequence: string | null
  previousManifestSha256: string | null
  legacyRecords: number
  legacyLastManifestSha256: string | null
}

export type RecoveredLifecycle = {
  leaseRoot?: FileHandle
  root: FileHandle
  adapter: DescriptorRootAdapter
  directory: DescriptorChildHandle
  directoryIdentity: DirectoryIdentity
  directoryPath: string
  directoryEntry: string
  uid: number | undefined
  sealed: SealedSegment[]
  current: OpenSegment
  nextRecordSequence: number
  metadataBytes: number
  previousManifestSha256: string | null
}

export type AuditMigrationHook = (
  root: string,
  uid: number | undefined,
  rootHandle?: FileHandle,
  adapter?: DescriptorRootAdapter,
) => Promise<void>

async function recoverWithRootLease(
  root: string,
  uid: number | undefined,
  migrate: AuditMigrationHook,
): Promise<RecoveredLifecycle | null> {
  let leaseRoot: FileHandle | undefined
  let candidate: RecoveredLifecycle | undefined
  try {
    leaseRoot = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    if (!secureDirectory(await leaseRoot.stat({ bigint: true }), uid)) {
      await leaseRoot.close()
      leaseRoot = undefined
      return null
    }
    const rootHandle = leaseRoot
    const recovered = await withLinuxRootLease(
      rootHandle,
      null,
      async () => {
        const adapter = descriptorRootAdapter()
        const boundRoot = process.platform === 'darwin' ? root : linuxDescriptorRootPath(rootHandle)
        await migrate(boundRoot, uid, rootHandle, adapter)
        const value = await recoverLifecycle(boundRoot, uid, rootHandle, adapter)
        candidate = { ...value, leaseRoot: rootHandle }
        return candidate
      },
      () => false,
      async () => {
        // Unlock failure rejects recovery; closing only guarantees the kernel lease is released.
        await rootHandle.close().catch(() => undefined)
      },
    )
    if (recovered) return recovered
  } catch {
    // Cleanup below owns every handle created by a failed open/recovery attempt.
  }
  // Recovery is already unavailable; cleanup failures cannot produce a usable lifecycle.
  await closeHandle(candidate, candidate?.current.handle)
  // The audit directory handle has no owner after recovery failure.
  await closeHandle(candidate, candidate?.directory)
  // The root handle must release any lease even though recovery failed.
  await leaseRoot?.close().catch(() => undefined)
  return null
}

export async function openRunnerAuditLifecycleCore(
  options: RunnerAuditLifecycleOptions,
  migrate: AuditMigrationHook,
): Promise<RunnerAuditLifecycleOpen> {
  const storage = createFileRunnerHomeStorage({
    defaultRoot: path.resolve(options.runnerHome),
    ...(options.currentUserId === undefined ? {} : { currentUserId: options.currentUserId }),
  })
  try {
    await storage.inspect({ override: options.runnerHome })
    if (await storage.acquire?.() !== 'acquired') return await unavailable(storage)
    const root = path.resolve(options.runnerHome)
    const uid = options.currentUserId ?? process.getuid?.()
    const recovered = await recoverWithRootLease(root, uid, migrate)
    return recovered
      ? { status: 'ready', audit: new FileRunnerAuditLifecycle(storage, recovered) }
      : await unavailable(storage)
  } catch {
    return await unavailable(storage)
  }
}

export async function openBoundRunnerAuditLifecycleCore(
  options: RunnerAuditLifecycleOptions,
  migrate: AuditMigrationHook,
): Promise<RunnerAuditLifecycleOpen> {
  try {
    const root = path.resolve(options.runnerHome)
    const uid = options.currentUserId ?? process.getuid?.()
    const recovered = await recoverWithRootLease(root, uid, migrate)
    return recovered
      ? { status: 'ready', audit: new FileRunnerAuditLifecycle(null, recovered) }
      : { status: 'storage-unavailable' }
  } catch {
    return { status: 'storage-unavailable' }
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
    const operation = this.queue.then(() => this.appendLeased(record))
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

  private async appendLeased(record: AuditRecordInputV2): Promise<void> {
    const root = this.recovered.leaseRoot
    if (!root) throw new Error('audit lifecycle has no runner-home lease root')
    const committed = await withLinuxRootLease(
      root,
      false,
      async () => {
        await this.appendOne(record)
        return true
      },
      value => value,
      async () => {
        this.faulted = true
        // Closing the lease root releases unknown lock state; close failure cannot restore it.
        await root.close().catch(() => undefined)
      },
    )
    if (!committed) throw new Error('audit lifecycle lease unavailable')
  }

  private async appendOne(record: AuditRecordInputV2): Promise<void> {
    if (this.closed || this.faulted || !Number.isSafeInteger(this.nextRecordSequence)) throw new Error('audit lifecycle unavailable')
    try {
      const bytes = encodeAuditRecord(record, String(this.nextRecordSequence))
      if (this.mustRotate(bytes.byteLength)) await this.rotate()
      await assertDirectoryBound(this.recovered)
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
      await writeAll(this.recovered, this.current.handle, bytes)
      await syncHandle(this.recovered, this.current.handle)
      await assertSegmentBound(this.recovered, this.current)
      await assertDirectoryBound(this.recovered)
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
    await syncHandle(this.recovered, this.current.handle)
    await assertSegmentBound(this.recovered, this.current)
    await closeHandle(this.recovered, this.current.handle)
    await this.recovered.adapter.rename(this.recovered.directory, segmentName(sequence, 'open'), segmentName(sequence, 'jsonl'))
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
    await this.recovered.adapter.unlink(this.recovered.directory, segmentName(sequence, 'commit.json'))
    await syncDirectory(this.recovered)
    this.previousManifestSha256 = sha256(manifestBytes)
    this.sealed.push({ manifest, manifestBytes })
    this.current = await createOpenSegment(this.recovered, sequence + 1)
    this.metadataBytes = nextMetadata
  }

  private async closeOwned(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const operations = [
      async () => await syncHandle(this.recovered, this.current.handle),
      async () => await closeHandle(this.recovered, this.current.handle),
      async () => await closeHandle(this.recovered, this.recovered.directory),
      async () => await this.recovered.leaseRoot?.close(),
      async () => await this.storage?.release?.(),
      async () => await this.storage?.close?.(),
    ]
    const failure = await attemptAll(operations)
    if (failure) throw failure
  }
}

async function attemptAll(operations: readonly (() => Promise<unknown>)[]): Promise<unknown> {
  let failure: unknown
  for (const operation of operations) {
    try {
      await operation()
    } catch (error) {
      failure ??= error
    }
  }
  return failure
}

export async function readMigrationMarker(
  recovered: RecoveryPath,
): Promise<{ value: MigrationMarker; bytes: Buffer }> {
  const handle = await openAuditEntry(recovered, MIGRATION_MARKER, constants.O_RDONLY | constants.O_NOFOLLOW)
  if (!handle) throw new Error('missing migration marker')
  try {
    const info = await recovered.adapter.stat(handle)
    if (!secureRecord(info, recovered.uid) || info.size > MAX_AUDIT_METADATA_BYTES) throw new Error('invalid migration marker')
    const bytes = await readAll(recovered, handle, Number(info.size))
    const value = JSON.parse(bytes.toString('utf8')) as MigrationMarker
    if (!Buffer.from(`${JSON.stringify(value)}\n`).equals(bytes)
      || value.schemaVersion !== 1 || !sha256Value(value.legacySha256)
      || !Number.isSafeInteger(value.legacyBytes) || value.legacyBytes < 0
      || !Number.isSafeInteger(value.legacyRecords) || value.legacyRecords < 0
      || (value.lastManifestSha256 !== null && !sha256Value(value.lastManifestSha256))) {
      throw new Error('invalid migration marker')
    }
    return { value, bytes }
  } finally {
    await closeHandle(recovered, handle)
  }
}

export async function recoverLifecycle(
  rootPath: string,
  uid: number | undefined,
  rootHandle?: FileHandle,
  providedAdapter?: DescriptorRootAdapter,
): Promise<RecoveredLifecycle> {
  const directoryPath = path.join(rootPath, AUDIT_DIRECTORY)
  const adapter = providedAdapter ?? descriptorRootAdapter()
  const rootDirectory = rootHandle ?? await open(rootPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  await ensureAuditDirectory(rootPath, directoryPath, uid, rootDirectory, adapter)
  const directory = await adapter.openEntry(rootDirectory, AUDIT_DIRECTORY, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  if (!directory) throw new Error('missing audit directory')
  try {
    const directoryInfo = await adapter.stat(directory)
    if (!secureDirectory(directoryInfo, uid)) throw new Error('insecure audit directory')
    const recovered = { root: rootDirectory, adapter, directory, directoryIdentity: identityOf(directoryInfo), directoryPath, directoryEntry: AUDIT_DIRECTORY, uid }
    await removeInterruptedTemps(recovered)
    const entries = await adapter.readdir(directory)
    const migration = entries.includes(MIGRATION_MARKER) ? await readMigrationMarker(recovered) : undefined
    const grouped = classifyEntries(entries)
    if (grouped.commits.some(sequence => !grouped.segments.includes(sequence) && !grouped.opens.includes(sequence))) {
      throw new Error('audit commit has no segment')
    }
    const recoveredSealed = await recoverSealed(recovered, grouped)
    if (migration && (migration.value.legacyRecords !== recoveredSealed.legacyRecords
      || migration.value.lastManifestSha256 !== recoveredSealed.legacyLastManifestSha256)) {
      throw new Error('legacy audit migration chain changed')
    }
    const recoveredMetadataBytes = recoveredSealed.metadataBytes + (migration?.bytes.byteLength ?? 0)
    if (recoveredMetadataBytes > MAX_AUDIT_METADATA_BYTES
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
      metadataBytes: recoveredMetadataBytes + current.commitBytes,
      previousManifestSha256,
    }
  } catch (error) {
    // Recovery's original integrity failure is the actionable error; cleanup cannot replace it.
    await adapter.close(directory).catch(() => undefined)
    if (!rootHandle) await rootDirectory.close().catch(() => undefined)
    throw error
  }
}

async function ensureAuditDirectory(
  root: string,
  directoryPath: string,
  uid: number | undefined,
  rootHandle?: FileHandle,
  adapter = descriptorRootAdapter(),
): Promise<void> {
  const held = rootHandle ? await adapter.statEntry(rootHandle, AUDIT_DIRECTORY) : await lstat(directoryPath).catch(error => missingOnly(error))
  if (held === null) {
    if (rootHandle) await adapter.mkdir(rootHandle, AUDIT_DIRECTORY, DIRECTORY_MODE)
    else await mkdir(directoryPath, { mode: DIRECTORY_MODE })
    if (rootHandle) {
      await rootHandle.sync()
    } else {
      const parent = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try {
        await parent.sync()
      } finally {
        await parent.close()
      }
    }
  }
  const info = rootHandle ? await adapter.statEntry(rootHandle, AUDIT_DIRECTORY) : await lstat(directoryPath)
  if (!info) throw new Error('missing audit directory')
  if (!secureDirectory(info, uid)) throw new Error('insecure audit directory')
}

export function classifyEntries(entries: readonly string[]) {
  const segments: number[] = []
  const manifests: number[] = []
  const commits: number[] = []
  const acknowledgements: number[] = []
  const tombstones: number[] = []
  const opens: number[] = []
  for (const entry of entries) {
    if (entry === MIGRATION_MARKER || TEMP_METADATA_PATTERN.test(entry)) continue
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

export async function recoverSealed(
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
  let legacyRecords = 0
  let legacyLastManifestSha256: string | null = null
  let sawSchemaV2 = false
  for (let sequence = 1; sequence <= maxSequence; sequence += 1) {
    let manifest: AuditSegmentManifest
    let manifestBytes: Buffer
    let scan: SegmentScan | null
    if (grouped.manifests.includes(sequence)) {
      ;({ manifest, bytes: manifestBytes } = await readManifest(recovered, sequence))
      scan = grouped.segments.includes(sequence)
        ? manifest.recordSchemaVersion === 1
          ? await scanLegacySegment(recovered, sequence, Number(manifest.firstRecordSequence), Number(manifest.lastRecordSequence))
          : await scanSegment(recovered, sequence, 'jsonl')
        : null
    } else {
      scan = grouped.segments.includes(sequence) ? await scanSegment(recovered, sequence, 'jsonl') : null
      if (!scan || sequence !== maxSequence) throw new Error('interrupted nonterminal audit seal')
      manifest = manifestFor(sequence, scan, previousManifestSha256)
      manifestBytes = await writeManifest(recovered, manifest)
    }
    if (scan && (scan.records === 0 || !scan.firstRecordSequence || !scan.lastRecordSequence)) throw new Error('empty sealed audit segment')
    if (!manifestChainMatches(manifest, sequence, previousRecord, previousManifestSha256)) throw new Error('audit manifest chain mismatch')
    if (manifest.recordSchemaVersion === 1 && sawSchemaV2) throw new Error('legacy audit segment follows schema v2')
    if (manifest.recordSchemaVersion === 2) sawSchemaV2 = true
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
      await recovered.adapter.unlink(recovered.directory, segmentName(sequence, 'commit.json'))
      await syncDirectory(recovered)
    }
    if (scan && tombstone) {
      await recovered.adapter.unlink(recovered.directory, segmentName(sequence, 'jsonl'))
      await syncDirectory(recovered)
      scan = null
    }
    if (scan) resident.push({ manifest, manifestBytes, ...(acknowledgement ? { acknowledgement } : {}) })
    metadataBytes += manifestBytes.byteLength + (acknowledgement?.bytes.byteLength ?? 0) + (tombstone?.bytes.byteLength ?? 0)
    previousManifestSha256 = sha256(manifestBytes)
    previousRecord = Number(manifest.lastRecordSequence)
    if (manifest.recordSchemaVersion === 1) {
      legacyRecords += manifest.records
      legacyLastManifestSha256 = previousManifestSha256
    }
  }
  return {
    resident,
    metadataBytes,
    lastSequence: maxSequence,
    lastRecordSequence: maxSequence === 0 ? null : String(previousRecord),
    previousManifestSha256,
    legacyRecords,
    legacyLastManifestSha256,
  }
}

export async function createOpenSegment(recovered: RecoveryPath, sequence: number): Promise<OpenSegment> {
  const handle = await openAuditEntry(recovered, segmentName(sequence, 'open'), constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE)
  if (!handle) throw new Error('audit segment already exists')
  try {
    const info = await recovered.adapter.stat(handle)
    if (!secureRecord(info, recovered.uid)) throw new Error('insecure audit segment')
    await syncHandle(recovered, handle)
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
    await closeHandle(recovered, handle)
    throw error
  }
}

export async function openExistingSegment(
  recovered: RecoveryPath,
  sequence: number,
  hasCommit: boolean,
): Promise<OpenSegment> {
  const handle = await openAuditEntry(recovered, segmentName(sequence, 'open'), constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW)
  if (!handle) throw new Error('missing audit open segment')
  try {
    const info = await recovered.adapter.stat(handle)
    if (!secureRecord(info, recovered.uid) || info.size > MAX_AUDIT_SEGMENT_BYTES) throw new Error('insecure audit segment')
    const raw = await readAll(recovered, handle, Number(info.size))
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
      await recovered.adapter.truncate(handle, held.commit.bytes)
      await syncHandle(recovered, handle)
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
    await closeHandle(recovered, handle)
    throw error
  }
}

async function scanSegment(
  recovered: RecoveryPath,
  sequence: number,
  extension: 'jsonl',
): Promise<SegmentScan> {
  const handle = await openAuditEntry(recovered, segmentName(sequence, extension), constants.O_RDONLY | constants.O_NOFOLLOW)
  if (!handle) throw new Error('missing audit segment')
  try {
    const info = await recovered.adapter.stat(handle)
    if (!secureRecord(info, recovered.uid) || info.size > MAX_AUDIT_SEGMENT_BYTES) throw new Error('invalid audit segment')
    return scanAuditBytes(await readAll(recovered, handle, Number(info.size)))
  } finally {
    await closeHandle(recovered, handle)
  }
}

async function scanLegacySegment(
  recovered: RecoveryPath,
  sequence: number,
  firstRecordSequence: number,
  lastRecordSequence: number,
): Promise<SegmentScan> {
  const handle = await openAuditEntry(recovered, segmentName(sequence, 'jsonl'), constants.O_RDONLY | constants.O_NOFOLLOW)
  if (!handle) throw new Error('missing legacy audit segment')
  try {
    const info = await recovered.adapter.stat(handle)
    if (!secureRecord(info, recovered.uid) || info.size > MAX_AUDIT_SEGMENT_BYTES) throw new Error('invalid legacy audit segment')
    const bytes = await readAll(recovered, handle, Number(info.size))
    const records = splitRecordLines(bytes)
    if (records.length === 0 || records.length > MAX_AUDIT_SEGMENT_RECORDS
      || lastRecordSequence - firstRecordSequence + 1 !== records.length) throw new Error('invalid legacy audit record count')
    for (const record of records) {
      if (record.byteLength > 64 * 1024 || !validLegacyAuditRecord(record)) throw new Error('invalid legacy audit record')
    }
    return {
      bytes,
      byteCount: bytes.byteLength,
      records: records.length,
      firstRecordSequence: String(firstRecordSequence),
      lastRecordSequence: String(lastRecordSequence),
      sha256: sha256(bytes),
    }
  } finally {
    await closeHandle(recovered, handle)
  }
}

export function validLegacyAuditRecord(bytes: Buffer): boolean {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
    if (!isRecord(value) || Buffer.from(JSON.stringify(value)).compare(bytes) !== 0 || !validTimestamp(value.at)) return false
    if (value.kind === 'spawn-admitted') {
      return exactKeys(value, ['kind', 'spawnId', 'spawnKind', 'requestId', 'executable', 'recipeId', 'cwd', 'at'], ['spawnKind', 'requestId'])
        && isSafeIdentifier(value.spawnId) && nullableText(value.executable) && nullableText(value.recipeId)
        && typeof value.cwd === 'string'
    }
    if (value.kind === 'spawn-outcome') {
      return exactKeys(value, ['kind', 'spawnId', 'outcome', 'at']) && isSafeIdentifier(value.spawnId) && validLegacyOutcome(value.outcome)
    }
    if (value.kind === 'refused') {
      return exactKeys(value, ['kind', 'requestId', 'spawnKind', 'executable', 'recipeId', 'cwd', 'reason', 'at'], ['spawnKind'])
        && nullableIdentifier(value.requestId) && nullableText(value.executable) && nullableText(value.recipeId)
        && nullableText(value.cwd) && isRefusalReason(value.reason)
    }
    if (value.kind === 'kill') {
      return exactKeys(value, ['kind', 'confirmed', 'details', 'at'])
        && typeof value.confirmed === 'boolean' && typeof value.details === 'string'
    }
    if (value.kind === 'session-connection-refusal') {
      return exactKeys(value, ['kind', 'connectionId', 'channelId', 'requestId', 'reason', 'selectedProtocolVersion', 'phase', 'at'])
        && isSafeIdentifier(value.connectionId) && isSafeIdentifier(value.channelId) && nullableIdentifier(value.requestId)
    }
    if (value.kind === 'session-launch') {
      return exactKeys(value, ['kind', 'key', 'state', 'at', 'sessionId', 'result'], ['sessionId', 'result'])
        && isRecord(value.key) && isSafeIdentifier(value.key.bindingId) && isSafeIdentifier(value.key.requestId)
        && (value.sessionId === undefined || isSafeIdentifier(value.sessionId))
        && (value.result === undefined || parseSessionLaunchServerMessage(value.result, SESSION_LAUNCH_PROTOCOL_VERSION) !== null)
    }
    return false
  } catch {
    return false
  }
}

function validLegacyOutcome(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.spawnFailed === true) return Object.keys(value).length === 1
  return (nonnegativeInteger(value.exitCode) && value.signal === null)
    || (nonnegativeInteger(value.signal) && value.exitCode === null)
}

function nullableIdentifier(value: unknown): boolean {
  return value === null || isSafeIdentifier(value)
}

function nullableText(value: unknown): boolean {
  return value === null || typeof value === 'string'
}

function nonnegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value)
  return keys.every(key => allowed.includes(key))
    && allowed.every(key => optional.includes(key) || keys.includes(key))
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

export function manifestFor(
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

export function openCommit(
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

export function encodeOpenCommit(commit: OpenCommit): Buffer {
  return Buffer.from(`${JSON.stringify(commit)}\n`)
}

async function writeOpenCommit(
  recovered: RecoveryPath,
  commit: OpenCommit,
  bytes = encodeOpenCommit(commit),
): Promise<void> {
  const finalName = segmentName(Number(commit.segmentSequence), 'commit.json')
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
    // The commit update failed closed; its temporary name is never authoritative.
    await closeHandle(recovered, handle)
    // An unremovable temp is ignored during recovery because only commit.json is authoritative.
    await recovered.adapter.unlink(recovered.directory, temporary).catch(() => undefined)
    throw error
  }
}

async function readOpenCommit(recovered: RecoveryPath, sequence: number): Promise<{ commit: OpenCommit; bytes: Buffer }> {
  const handle = await openAuditEntry(recovered, segmentName(sequence, 'commit.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
  if (!handle) throw new Error('missing audit commit')
  try {
    const info = await recovered.adapter.stat(handle)
    if (!secureRecord(info, recovered.uid) || info.size > MAX_AUDIT_METADATA_BYTES) throw new Error('invalid audit commit')
    const bytes = await readAll(recovered, handle, Number(info.size))
    const commit = JSON.parse(bytes.toString('utf8')) as OpenCommit
    if (!Buffer.from(`${JSON.stringify(commit)}\n`).equals(bytes)) throw new Error('noncanonical audit commit')
    return { commit, bytes }
  } finally {
    await closeHandle(recovered, handle)
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

export async function writeManifest(recovered: RecoveryPath, manifest: AuditSegmentManifest): Promise<Buffer> {
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`)
  const finalName = segmentName(Number(manifest.sequence), 'manifest.json')
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
    return bytes
  } catch (error) {
    // The manifest write/rename failure is primary; best-effort private-temp cleanup changes no state.
    await closeHandle(recovered, handle)
    // An unremovable temp is inert because only the final manifest name commits a seal.
    await recovered.adapter.unlink(recovered.directory, temporary).catch(() => undefined)
    throw error
  }
}

async function readManifest(recovered: RecoveryPath, sequence: number): Promise<{ manifest: AuditSegmentManifest; bytes: Buffer }> {
  const handle = await openAuditEntry(recovered, segmentName(sequence, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
  if (!handle) throw new Error('missing audit manifest')
  try {
    const info = await recovered.adapter.stat(handle)
    if (!secureRecord(info, recovered.uid) || info.size > MAX_AUDIT_METADATA_BYTES) throw new Error('invalid audit manifest')
    const bytes = await readAll(recovered, handle, Number(info.size))
    const manifest = JSON.parse(bytes.toString('utf8')) as AuditSegmentManifest
    return { manifest, bytes }
  } finally {
    await closeHandle(recovered, handle)
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
    && (manifest.recordSchemaVersion === 1 || manifest.recordSchemaVersion === 2)
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
  const handle = await openAuditEntry(recovered, segmentName(sequence, extension), constants.O_RDONLY | constants.O_NOFOLLOW)
  if (!handle) throw new Error('missing audit metadata')
  try {
    const info = await recovered.adapter.stat(handle)
    if (!secureRecord(info, recovered.uid) || info.size > MAX_AUDIT_METADATA_BYTES) throw new Error('invalid audit metadata')
    const bytes = await readAll(recovered, handle, Number(info.size))
    const value = JSON.parse(bytes.toString('utf8')) as unknown
    if (!Buffer.from(`${JSON.stringify(value)}\n`).equals(bytes)) throw new Error('noncanonical audit metadata')
    return { value, bytes }
  } finally {
    await closeHandle(recovered, handle)
  }
}

async function removeInterruptedTemps(recovered: RecoveryPath): Promise<void> {
  const entries = await recovered.adapter.readdir(recovered.directory)
  let removed = false
  for (const entry of entries) {
    if (!TEMP_METADATA_PATTERN.test(entry)) continue
    const info = await recovered.adapter.statEntry(recovered.directory, entry)
    if (!info) throw new Error('missing audit temporary')
    if (!secureRecord(info, recovered.uid)) throw new Error('insecure audit temporary')
    await recovered.adapter.unlink(recovered.directory, entry)
    removed = true
  }
  if (removed) await syncDirectory(recovered)
}

export type RecoveryPath = {
  root: FileHandle
  adapter: DescriptorRootAdapter
  directory: DescriptorChildHandle
  directoryIdentity: DirectoryIdentity
  directoryPath: string
  directoryEntry: string
  uid: number | undefined
}

export async function syncDirectory(recovered: RecoveryPath): Promise<void> {
  await syncHandle(recovered, recovered.directory)
  await assertDirectoryBound(recovered)
}

async function assertSegmentBound(
  recovered: RecoveryPath,
  segment: OpenSegment,
): Promise<void> {
  const [held, current] = await Promise.all([
    recovered.adapter.stat(segment.handle),
    recovered.adapter.statEntry(recovered.directory, segmentName(segment.sequence, 'open')),
  ])
  if (!current || !secureRecord(held, recovered.uid) || !secureRecord(current, recovered.uid)) throw new Error('audit segment custody changed')
  if (!sameIdentity(held, segment.identity) || !sameIdentity(current, segment.identity)) {
    throw new Error('audit segment identity changed')
  }
}

async function assertDirectoryBound(recovered: RecoveryPath): Promise<void> {
  const [held, current] = await Promise.all([
    recovered.adapter.stat(recovered.directory),
    recovered.adapter.statEntry(recovered.root, recovered.directoryEntry),
  ])
  if (!current || !secureDirectory(held, recovered.uid) || !secureDirectory(current, recovered.uid)) throw new Error('audit directory custody changed')
  if (!sameIdentity(held, recovered.directoryIdentity) || !sameIdentity(current, recovered.directoryIdentity)) {
    throw new Error('audit directory identity changed')
  }
}

export function splitRecordLines(bytes: Buffer): Buffer[] {
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

export async function readAll(recovered: Pick<RecoveryPath, 'adapter'>, handle: DescriptorChildHandle, size: number): Promise<Buffer> {
  const bytes = await recovered.adapter.read(handle, size)
  if (bytes.byteLength !== size) throw new Error('audit file ended before its reported size')
  return bytes
}

export async function writeAll(recovered: Pick<RecoveryPath, 'adapter'>, handle: DescriptorChildHandle, bytes: Uint8Array): Promise<void> {
  await recovered.adapter.writeAll(handle, bytes)
}

export function segmentName(
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

export async function openAuditEntry(
  recovered: RecoveryPath,
  entry: string,
  flags: number,
  mode?: number,
): Promise<DescriptorChildHandle | null> {
  return await recovered.adapter.openEntry(recovered.directory, entry, flags, mode)
}

export async function syncHandle(recovered: Pick<RecoveryPath, 'adapter'> | undefined, handle: DescriptorChildHandle | FileHandle | null | undefined): Promise<void> {
  if (!recovered || !handle) return
  await recovered.adapter.sync(handle)
}

export async function closeHandle(recovered: Pick<RecoveryPath, 'adapter'> | undefined, handle: DescriptorChildHandle | null | undefined): Promise<void> {
  if (!recovered || !handle) return
  await recovered.adapter.close(handle).catch(() => undefined)
}

export function secureDirectory(info: Stats | BigIntStats | DescriptorRootEntryStat, uid: number | undefined): boolean {
  return info.isDirectory() && (uid === undefined || Number(info.uid) === uid) && (Number(info.mode) & 0o777) === DIRECTORY_MODE
}

export function secureRecord(info: Stats | BigIntStats | DescriptorRootEntryStat, uid: number | undefined): boolean {
  return info.isFile() && (uid === undefined || Number(info.uid) === uid) && (Number(info.mode) & 0o777) === FILE_MODE && Number(info.nlink) === 1
}

export function identityOf(info: BigIntStats | DescriptorRootEntryStat): DirectoryIdentity {
  return descriptorIdentityOf(info)
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function sha256Value(value: unknown): value is string {
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

export function missingOnly(error: unknown): null {
  if (isCode(error, 'ENOENT')) return null
  throw error
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

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
  AuditLifecycleNotImplementedError,
  type AuditLifecycleSnapshot,
  type AuditRecordInputV2,
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
const SEGMENT_PATTERN = /^segment-([0-9]{20})\.(open|jsonl|manifest\.json|commit\.json)$/
const TEMP_METADATA_PATTERN = /^segment-([0-9]{20})\.(manifest|commit)\.tmp-[0-9a-f]{32}$/

type DirectoryIdentity = { device: bigint; inode: bigint }
type SegmentSummary = {
  byteCount: number
  records: number
  firstRecordSequence: string | null
  lastRecordSequence: string | null
  sha256: string
}
type SegmentScan = SegmentSummary & { bytes: Buffer }
type SealedSegment = { manifest: AuditSegmentManifest; manifestBytes: Buffer }
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

export async function archiveRunnerAudit(_options: RunnerAuditArchiveOptions): Promise<RunnerAuditArchiveResult> {
  throw new AuditLifecycleNotImplementedError()
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
    private readonly storage: RunnerHomeStorage,
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
    try {
      await this.storage.release?.()
      await this.storage.close?.()
    } catch (error) {
      failure ??= error
    }
    if (failure) throw failure
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
    const sealed = await recoverSealed(recovered, grouped.segments, grouped.manifests, grouped.commits)
    const sealedMetadataBytes = sealed.reduce((total, segment) => total + segment.manifestBytes.byteLength, 0)
    if (sealedMetadataBytes > MAX_AUDIT_METADATA_BYTES || sealed.length >= MAX_RESIDENT_AUDIT_SEGMENTS) throw new Error('audit metadata capacity exhausted')
    const expectedOpen = sealed.length + 1
    if (grouped.opens.length > 1 || (grouped.opens[0] !== undefined && grouped.opens[0] !== expectedOpen)) {
      throw new Error('ambiguous audit open segment')
    }
    const current = grouped.opens.length === 0
      ? await createOpenSegment(recovered, expectedOpen)
      : await openExistingSegment(recovered, expectedOpen, grouped.commits.includes(expectedOpen))
    const previousManifestSha256 = sealed.length ? sha256(sealed.at(-1)!.manifestBytes) : null
    const previousRecord = sealed.at(-1)?.manifest.lastRecordSequence
    if (previousRecord && current.firstRecordSequence && Number(current.firstRecordSequence) !== Number(previousRecord) + 1) {
      throw new Error('audit record sequence gap')
    }
    const lastRecord = current.lastRecordSequence ?? previousRecord
    return {
      ...recovered,
      sealed,
      current,
      nextRecordSequence: lastRecord ? Number(lastRecord) + 1 : 1,
      metadataBytes: sealedMetadataBytes + current.commitBytes,
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
  const opens: number[] = []
  for (const entry of entries) {
    if (TEMP_METADATA_PATTERN.test(entry)) continue
    const matched = SEGMENT_PATTERN.exec(entry)
    if (!matched) throw new Error('unknown audit lifecycle entry')
    const sequence = parseSegmentSequence(matched[1]!)
    if (matched[2] === 'open') opens.push(sequence)
    else if (matched[2] === 'jsonl') segments.push(sequence)
    else if (matched[2] === 'manifest.json') manifests.push(sequence)
    else commits.push(sequence)
  }
  return {
    segments: segments.sort(numeric),
    manifests: manifests.sort(numeric),
    commits: commits.sort(numeric),
    opens: opens.sort(numeric),
  }
}

async function recoverSealed(
  recovered: RecoveryPath,
  segments: readonly number[],
  manifests: readonly number[],
  commits: readonly number[],
): Promise<SealedSegment[]> {
  if (segments.some((sequence, index) => sequence !== index + 1)) throw new Error('audit segment sequence gap')
  if (manifests.some(sequence => !segments.includes(sequence))) throw new Error('audit manifest has no segment')
  const sealed: SealedSegment[] = []
  let previousManifestSha256: string | null = null
  let previousRecord = 0
  for (const sequence of segments) {
    const scan = await scanSegment(recovered, sequence, 'jsonl')
    if (scan.records === 0 || !scan.firstRecordSequence || !scan.lastRecordSequence) throw new Error('empty sealed audit segment')
    if (commits.includes(sequence)) {
      const { commit } = await readOpenCommit(recovered, sequence)
      if (!commitMatches(commit, sequence, scan)) throw new Error('audit open commit mismatch')
    }
    if (Number(scan.firstRecordSequence) !== previousRecord + 1) throw new Error('audit record sequence gap')
    let manifest: AuditSegmentManifest
    let manifestBytes: Buffer
    if (manifests.includes(sequence)) {
      ;({ manifest, bytes: manifestBytes } = await readManifest(recovered, sequence))
      if (!manifestMatches(manifest, sequence, scan, previousManifestSha256)) throw new Error('audit manifest mismatch')
    } else {
      if (sequence !== segments.at(-1)) throw new Error('interrupted nonterminal audit seal')
      manifest = manifestFor(sequence, scan, previousManifestSha256)
      manifestBytes = await writeManifest(recovered, manifest)
    }
    if (commits.includes(sequence)) {
      await unlink(path.join(recovered.directoryPath, segmentName(sequence, 'commit.json')))
      await syncDirectory(recovered)
    }
    sealed.push({ manifest, manifestBytes })
    previousManifestSha256 = sha256(manifestBytes)
    previousRecord = Number(scan.lastRecordSequence)
  }
  return sealed
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

function segmentName(sequence: number, extension: 'open' | 'jsonl' | 'manifest.json' | 'commit.json'): string {
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

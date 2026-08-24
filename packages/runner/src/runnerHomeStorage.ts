import { createHash, randomBytes } from 'node:crypto'
import { constants, type BigIntStats, type Stats } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, unlink, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import {
  RUNNER_HOME_RECORDS,
  type RunnerHomeCustodyInspection,
  type RunnerHomeEntryInspection,
  type RunnerHomeInspection,
  type RunnerHomeRecord,
  type RunnerHomeSelection,
  type RunnerHomeStateRecord,
  type RunnerHomeStorage,
  type RunnerHomeStorageRead,
  type RunnerHomeStorageWrite,
} from './runnerHome.js'
import {
  acquireLinuxRootLifetime,
  linuxDescriptorRootPath,
  releaseLinuxRootLifetime,
  withLinuxRootLease,
} from './linuxRootLease.js'

const DIRECTORY_MODE = 0o700
const RECORD_MODE = 0o600
const DEFAULT_RECORD_LIMIT = 2 * 1024 * 1024
const MAX_INTERRUPTED_TEMPS = 128
const MAX_INTERRUPTED_TEMP_BYTES = 128 * 1024 * 1024
const LEGACY_COORDINATION_ENTRIES = new Set(['.records.lock', '.records.reap'])
const RECORD_LIMITS: Readonly<Record<RunnerHomeStateRecord, number>> = {
  pairing: DEFAULT_RECORD_LIMIT,
  keys: 8 * 1024 * 1024,
  grants: DEFAULT_RECORD_LIMIT,
  configuration: DEFAULT_RECORD_LIMIT,
  policy: DEFAULT_RECORD_LIMIT,
  projects: DEFAULT_RECORD_LIMIT,
  receipts: 25 * 1024 * 1024,
}
const RECORD_FILES: Readonly<Record<RunnerHomeRecord, string>> = {
  pairing: 'pairing.bin',
  keys: 'keys.bin',
  grants: 'grants.json',
  configuration: 'configuration.json',
  policy: 'policy.json',
  projects: 'projects.json',
  receipts: 'receipts.json',
  audit: 'audit.jsonl',
}

type RootIdentity = { device: bigint; inode: bigint }

export type FileRunnerHomeStorageOptions = {
  defaultRoot: string
  currentUserId?: number
}

export function createFileRunnerHomeStorage(options: FileRunnerHomeStorageOptions): RunnerHomeStorage {
  return new FileRunnerHomeStorage(options)
}

export function fileRunnerHomeRecordPath(root: string, record: RunnerHomeRecord): string {
  return path.join(root, RECORD_FILES[record])
}

export function fileRunnerHomeSealingKeyPath(root: string): string {
  return path.join(root, 'sealing.key')
}

class FileRunnerHomeStorage implements RunnerHomeStorage {
  private queue: Promise<unknown> = Promise.resolve()
  private root: string | null = null
  private rootHandle: FileHandle | null = null
  private rootIdentity: RootIdentity | null = null
  private foregroundLease = false
  private poisoned = false
  private closed = false
  private readonly uid: number | undefined

  constructor(private readonly options: FileRunnerHomeStorageOptions) {
    descriptorRootDirectory()
    this.uid = options.currentUserId ?? process.getuid?.()
  }

  inspect(selection: RunnerHomeSelection): Promise<RunnerHomeInspection> {
    return this.serialize(async () => await this.inspectSelected(selection))
  }

  acquire(): Promise<'acquired' | 'busy' | 'storage-unavailable'> {
    return this.serialize(async () => await this.acquireLock())
  }

  release(): Promise<void> {
    return this.serialize(async () => await this.releaseLock())
  }

  close(): Promise<void> {
    return this.serialize(async () => {
      if (this.closed) return
      this.closed = true
      await this.releaseLock()
      await this.rootHandle?.close()
      this.rootHandle = null
      this.rootIdentity = null
      this.root = null
    })
  }

  descriptorRoot(): Promise<string | null> {
    return this.serialize(async () => {
      if (!this.foregroundLease || !(await this.rootStillBound())) return null
      return this.rootHandle ? linuxDescriptorRootPath(this.rootHandle) : null
    })
  }

  read(record: RunnerHomeStateRecord): Promise<RunnerHomeStorageRead> {
    return this.serialize(async () => await this.readRecord(record))
  }

  replace(record: RunnerHomeStateRecord, expectedSha256: string | null, bytes: Uint8Array): Promise<RunnerHomeStorageWrite> {
    return this.serialize(async () => {
      if (bytes.byteLength > RECORD_LIMITS[record]) return { status: 'storage-unavailable' }
      const root = await this.boundRoot()
      if (!root) return { status: 'storage-unavailable' }
      return await withLinuxRootLease(
        root,
        { status: 'storage-unavailable' },
        async () => {
          if (!(await cleanupInterruptedTemps(root, this.uid))) return { status: 'storage-unavailable' }
          const current = await this.readRecordAt(root, record)
          if (current.status === 'storage-unavailable') return current
          const currentSha256 = current.status === 'found' ? current.sha256 : null
          if (currentSha256 !== expectedSha256) return { status: 'conflict', currentSha256 }
          return await this.replaceRecord(root, record, bytes)
        },
        result => result.status === 'written',
        async () => await this.poison(),
      )
    })
  }

  private async inspectSelected(selection: RunnerHomeSelection): Promise<RunnerHomeInspection> {
    if (this.closed || this.poisoned) throw new Error('runner-home storage is closed')
    const root = path.resolve(selection.override ?? this.options.defaultRoot)
    if (this.root !== null && root !== this.root) throw new Error('cannot reselect a bound runner home')
    const initial = await lstat(root).catch(error => missingOnly(error))
    const created = initial === null
    if (created) await createDurableDirectory(root)
    if (this.root === null) {
      this.root = root
      this.rootHandle = await openSecureRoot(root, this.uid)
      this.rootIdentity = this.rootHandle ? identityOf(await this.rootHandle.stat({ bigint: true })) : null
    }
    if (created) await this.rootHandle?.sync()
    let bound = this.rootHandle && await this.rootStillBound() ? this.rootHandle : null
    const inspectedRoot = bound
    let entries = inspectedRoot
      ? await Promise.all(RUNNER_HOME_RECORDS.map(async record => await inspectEntry(inspectedRoot, record, this.uid)))
      : []
    if (bound && !(await this.rootStillBound())) {
      bound = null
      entries = []
    }
    const info = bound ? await bound.stat() : await lstat(root)
    const sealingKey = bound
      ? await inspectCustody(rootEntryPath(bound, 'sealing.key'), this.uid)
      : undefined
    return {
      rootKind: rootKindOf(info),
      rootOwner: ownerOf(info, this.uid),
      rootMode: permissionsOf(info),
      entries,
      ...(sealingKey ? { sealingKey } : {}),
    }
  }

  private async acquireLock(): Promise<'acquired' | 'busy' | 'storage-unavailable'> {
    if (this.foregroundLease) return 'busy'
    const root = await this.boundRoot()
    if (!root) return 'storage-unavailable'
    const result = await acquireLinuxRootLifetime(root)
    if (result === 'acquired') this.foregroundLease = true
    return result === 'contended' ? 'busy' : result
  }

  private async releaseLock(): Promise<void> {
    if (!this.foregroundLease) return
    const root = this.rootHandle
    this.foregroundLease = false
    if (!root || !(await releaseLinuxRootLifetime(root))) {
      await this.poison()
      throw new Error('runner-home foreground lease could not be released')
    }
  }

  private async readRecord(record: RunnerHomeStateRecord): Promise<RunnerHomeStorageRead> {
    const root = await this.boundRoot()
    if (!root) return { status: 'storage-unavailable' }
    return await this.readRecordAt(root, record)
  }

  private async readRecordAt(root: FileHandle, record: RunnerHomeStateRecord): Promise<RunnerHomeStorageRead> {
    try {
      const handle = await openRecord(rootEntryPath(root, RECORD_FILES[record]))
      const result = handle ? await readSecure(handle, this.uid, RECORD_LIMITS[record]) : { status: 'missing' as const }
      return (await this.rootStillBound()) ? result : { status: 'storage-unavailable' }
    } catch {
      return { status: 'storage-unavailable' }
    }
  }

  private async replaceRecord(root: FileHandle, record: RunnerHomeStateRecord, bytes: Uint8Array): Promise<RunnerHomeStorageWrite> {
    const target = rootEntryPath(root, RECORD_FILES[record])
    const temporary = `${target}.tmp-${randomBytes(16).toString('hex')}`
    try {
      await writeTemporary(temporary, bytes, this.uid)
      await rename(temporary, target)
      await root.sync()
      if (!(await this.rootStillBound())) return { status: 'storage-unavailable' }
      return { status: 'written', sha256: sha256(bytes) }
    } catch {
      // The operation already fails closed; an unremovable private temp must not replace that result.
      await unlink(temporary).catch(() => undefined)
      return { status: 'storage-unavailable' }
    }
  }

  private async poison(): Promise<void> {
    this.poisoned = true
    const root = this.rootHandle
    this.rootHandle = null
    this.rootIdentity = null
    this.foregroundLease = false
    // Poisoning rejects all future work; close errors cannot restore storage authority.
    // Root closure releases any unknown kernel lease; its error cannot unpoison the instance.
    await root?.close().catch(() => undefined)
  }

  private async boundRoot(): Promise<FileHandle | null> {
    if (this.closed || this.poisoned || !this.rootHandle || !this.rootIdentity) return null
    try {
      const info = await this.rootHandle.stat({ bigint: true })
      const homeMatches = secureDirectory(info, this.uid) && sameIdentity(info, this.rootIdentity) && await this.rootStillBound()
      return homeMatches ? this.rootHandle : null
    } catch {
      return null
    }
  }

  private async rootStillBound(): Promise<boolean> {
    if (!this.root || !this.rootIdentity) return false
    // Any lookup failure means identity cannot be proven and therefore fails the operation closed.
    const info = await lstat(this.root, { bigint: true }).catch(() => null)
    return info !== null && secureDirectory(info, this.uid) && sameIdentity(info, this.rootIdentity)
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    // A caller receives its failure; the ordering queue must remain available for later recovery.
    this.queue = result.catch(() => undefined)
    return result
  }
}

async function createDurableDirectory(root: string): Promise<void> {
  const missing: string[] = []
  let current = root
  for (;;) {
    const info = await lstat(current).catch(error => missingOnly(error))
    if (info !== null) break
    missing.push(current)
    const parent = path.dirname(current)
    if (parent === current) throw new Error('runner-home root has no existing ancestor')
    current = parent
  }
  await mkdir(root, { mode: DIRECTORY_MODE, recursive: true })
  for (const directory of missing.reverse()) await syncDirectory(path.dirname(directory))
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function openSecureRoot(root: string, uid: number | undefined): Promise<FileHandle | null> {
  let handle: FileHandle | undefined
  try {
    handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    if (secureDirectory(await handle.stat({ bigint: true }), uid)) return handle
  } catch {
    // Cleanup below keeps every non-success path descriptor-neutral.
  }
  // The root is already rejected; close failure cannot restore or weaken that decision.
  await handle?.close().catch(() => undefined)
  return null
}

function descriptorRootDirectory(): string {
  if (process.platform === 'linux') return '/proc/self/fd'
  throw new Error(`file runner-home storage requires Linux descriptor-relative paths; found ${process.platform}`)
}

function rootEntryPath(root: FileHandle, entry: string): string {
  return path.join(descriptorRootDirectory(), String(root.fd), entry)
}

type InterruptedTemp = { name: string; identity: RootIdentity; size: number }

async function cleanupInterruptedTemps(root: FileHandle, uid: number | undefined): Promise<boolean> {
  try {
    const names = await readdir(rootEntryPath(root, '.'))
    if (names.some(name => LEGACY_COORDINATION_ENTRIES.has(name))) return false
    const records = Object.entries(RECORD_FILES).filter(([record]) => record !== 'audit')
    const candidates: InterruptedTemp[] = []
    let totalBytes = 0
    for (const name of names) {
      const matched = records.find(([, file]) => name.startsWith(`${file}.tmp-`))
      if (!matched) continue
      const [record, file] = matched
      if (!new RegExp(`^${escapeRegExp(file)}\\.tmp-[0-9a-f]{32}$`).test(name)) return false
      const info = await lstat(rootEntryPath(root, name), { bigint: true })
      if (!secureRecord(info, uid) || Number(info.size) > RECORD_LIMITS[record as RunnerHomeStateRecord]) return false
      totalBytes += Number(info.size)
      candidates.push({ name, identity: identityOf(info), size: Number(info.size) })
    }
    if (candidates.length > MAX_INTERRUPTED_TEMPS || totalBytes > MAX_INTERRUPTED_TEMP_BYTES) return false
    for (const candidate of candidates) {
      const target = rootEntryPath(root, candidate.name)
      let handle: FileHandle | undefined
      try {
        handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const [held, visible] = await Promise.all([handle.stat({ bigint: true }), lstat(target, { bigint: true })])
        if (!secureRecord(held, uid) || !sameIdentity(held, candidate.identity) || !sameIdentity(visible, candidate.identity)) return false
      } finally {
        await handle?.close()
      }
      await unlink(target)
    }
    if (candidates.length > 0) await root.sync()
    return true
  } catch {
    return false
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function inspectEntry(root: FileHandle, record: RunnerHomeRecord, uid: number | undefined): Promise<RunnerHomeEntryInspection> {
  const info = await lstat(rootEntryPath(root, RECORD_FILES[record])).catch(error => missingOnly(error))
  if (info === null) return { record, kind: 'missing', owner: 'current-user', mode: 0, links: 0 }
  return { record, kind: entryKindOf(info), owner: ownerOf(info, uid), mode: permissionsOf(info), links: info.nlink }
}

async function inspectCustody(target: string, uid: number | undefined): Promise<RunnerHomeCustodyInspection> {
  const info = await lstat(target).catch(error => missingOnly(error))
  if (info === null) return { kind: 'missing', owner: 'current-user', mode: 0, links: 0 }
  return { kind: entryKindOf(info), owner: ownerOf(info, uid), mode: permissionsOf(info), links: info.nlink }
}

async function openRecord(target: string): Promise<FileHandle | null> {
  try {
    return await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (isCode(error, 'ENOENT')) return null
    throw error
  }
}

async function readSecure(handle: FileHandle, uid: number | undefined, limit: number): Promise<RunnerHomeStorageRead> {
  try {
    const info = await handle.stat()
    if (!secureRecord(info, uid) || info.size > limit) return { status: 'storage-unavailable' }
    const bytes = await readBounded(handle, limit, info.size)
    return bytes ? { status: 'found', bytes, sha256: sha256(bytes) } : { status: 'storage-unavailable' }
  } finally {
    // The bounded read result is already determined; closing cannot make its bytes less read.
    await handle.close().catch(() => undefined)
  }
}

async function readBounded(handle: FileHandle, limit: number, expectedSize: number): Promise<Uint8Array | null> {
  const buffer = Buffer.alloc(Math.min(expectedSize + 1, limit + 1))
  let offset = 0
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  return offset > limit || offset > expectedSize ? null : Buffer.from(buffer.subarray(0, offset))
}

async function writeTemporary(target: string, bytes: Uint8Array, uid: number | undefined): Promise<void> {
  let handle: FileHandle | undefined
  try {
    handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, RECORD_MODE)
    if (!secureRecord(await handle.stat(), uid)) throw new Error('temporary runner-home record is insecure')
    await writeAll(handle, bytes)
    await handle.sync()
  } finally {
    await handle?.close()
  }
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset)
    if (bytesWritten === 0) throw new Error('runner-home write made no progress')
    offset += bytesWritten
  }
}

function secureDirectory(info: Stats | BigIntStats, uid: number | undefined): boolean {
  return info.isDirectory() && ownerOf(info, uid) === 'current-user' && permissionsOf(info) === DIRECTORY_MODE
}

function secureRecord(info: Stats | BigIntStats, uid: number | undefined): boolean {
  return info.isFile() && ownerOf(info, uid) === 'current-user' && permissionsOf(info) === RECORD_MODE && Number(info.nlink) === 1
}

function identityOf(info: Stats | BigIntStats): RootIdentity {
  return { device: BigInt(info.dev), inode: BigInt(info.ino) }
}

function sameIdentity(info: BigIntStats, expected: RootIdentity): boolean {
  return info.dev === expected.device && info.ino === expected.inode
}

function ownerOf(info: Stats | BigIntStats, uid: number | undefined): 'current-user' | 'other' {
  return uid === undefined || Number(info.uid) === uid ? 'current-user' : 'other'
}

function permissionsOf(info: Stats | BigIntStats): number {
  return Number(info.mode) & 0o777
}

function rootKindOf(info: Stats): RunnerHomeInspection['rootKind'] {
  if (info.isSymbolicLink()) return 'symlink'
  return info.isDirectory() ? 'directory' : 'other'
}

function entryKindOf(info: Stats): RunnerHomeEntryInspection['kind'] {
  if (info.isSymbolicLink()) return 'symlink'
  if (info.isDirectory()) return 'directory'
  return info.isFile() ? 'regular' : 'other'
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function missingOnly(error: unknown): null {
  if (isCode(error, 'ENOENT')) return null
  throw error
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}

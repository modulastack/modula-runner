import { createHash, randomBytes } from 'node:crypto'
import { constants, type BigIntStats, type Stats } from 'node:fs'
import { lstat, mkdir, open, type FileHandle } from 'node:fs/promises'
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
import {
  descriptorRootAdapter,
  identityOf,
  sameIdentity,
  type DescriptorChildHandle,
  type DescriptorRootAdapter,
  type DescriptorRootEntryStat,
  type DescriptorRootIdentity,
} from './descriptorRootAdapter.js'

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
  trust: 256 * 1024,
  projects: DEFAULT_RECORD_LIMIT,
  receipts: 25 * 1024 * 1024,
}
const RECORD_FILES: Readonly<Record<RunnerHomeRecord, string>> = {
  pairing: 'pairing.bin',
  keys: 'keys.bin',
  grants: 'grants.json',
  configuration: 'configuration.json',
  policy: 'policy.json',
  trust: 'policy.trust.json',
  projects: 'projects.json',
  receipts: 'receipts.json',
  audit: 'audit.jsonl',
}

export type FileRunnerHomeStorageOptions = {
  defaultRoot: string
  currentUserId?: number
}

// The file storage answers one question the shared interface does not: whether a descriptor some
// caller opened by path is the inode this lease covers. Only a caller that shares this home needs
// it, so it stays off `RunnerHomeStorage` and its doubles.
export type LeasedRunnerHomeStorage = RunnerHomeStorage & {
  leasesDescriptor(handle: FileHandle): Promise<boolean>
}

export function createFileRunnerHomeStorage(options: FileRunnerHomeStorageOptions): LeasedRunnerHomeStorage {
  return new FileRunnerHomeStorage(options)
}

export function fileRunnerHomeRecordPath(root: string, record: RunnerHomeRecord): string {
  return path.join(root, RECORD_FILES[record])
}

export function fileRunnerHomeSealingKeyPath(root: string): string {
  return path.join(root, 'sealing.key')
}

class FileRunnerHomeStorage implements RunnerHomeStorage {
  private readonly rootAdapter: DescriptorRootAdapter
  private queue: Promise<unknown> = Promise.resolve()
  private root: string | null = null
  private rootHandle: FileHandle | null = null
  private rootIdentity: DescriptorRootIdentity | null = null
  private foregroundLease = false
  private poisoned = false
  private closed = false
  private readonly uid: number | undefined

  constructor(private readonly options: FileRunnerHomeStorageOptions) {
    this.rootAdapter = descriptorRootAdapter()
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
      if (!this.rootHandle || process.platform === 'darwin') return null
      return linuxDescriptorRootPath(this.rootHandle)
    })
  }

  leasesDescriptor(handle: FileHandle): Promise<boolean> {
    return this.serialize(async () => {
      const identity = this.rootIdentity
      if (!this.foregroundLease || !identity || !(await this.boundRoot())) return false
      // A descriptor that cannot be stat'ed cannot be shown to be the leased inode, and an
      // unprovable match is a refused one — the caller must not touch the home on it.
      const info = await handle.stat({ bigint: true }).catch(() => null)
      return info !== null && sameIdentity(info, identity)
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
          if (!(await cleanupInterruptedTemps(root, this.uid, this.rootAdapter))) return { status: 'storage-unavailable' }
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
      ? await Promise.all(RUNNER_HOME_RECORDS.map(async record => await inspectEntry(inspectedRoot, record, this.uid, this.rootAdapter)))
      : []
    if (bound && !(await this.rootStillBound())) {
      bound = null
      entries = []
    }
    const info = bound ? await bound.stat() : await lstat(root)
    const sealingKey = bound
      ? await inspectCustody(bound, 'sealing.key', this.uid, this.rootAdapter)
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
      const handle = await openRecord(root, RECORD_FILES[record], this.rootAdapter)
      const result = handle ? await readSecure(handle, this.uid, RECORD_LIMITS[record], this.rootAdapter) : { status: 'missing' as const }
      return (await this.rootStillBound()) ? result : { status: 'storage-unavailable' }
    } catch {
      return { status: 'storage-unavailable' }
    }
  }

  private async replaceRecord(root: FileHandle, record: RunnerHomeStateRecord, bytes: Uint8Array): Promise<RunnerHomeStorageWrite> {
    const target = RECORD_FILES[record]
    const temporary = `${target}.tmp-${randomBytes(16).toString('hex')}`
    try {
      await writeTemporary(root, temporary, bytes, this.uid, this.rootAdapter)
      await this.rootAdapter.rename(root, temporary, target)
      await this.rootAdapter.sync(root)
      if (!(await this.rootStillBound())) return { status: 'storage-unavailable' }
      return { status: 'written', sha256: sha256(bytes) }
    } catch {
      // The operation already fails closed; an unremovable private temp must not replace that result.
      await this.rootAdapter.unlink(root, temporary).catch(() => undefined)
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

type InterruptedTemp = { name: string; identity: DescriptorRootIdentity; size: number }

async function cleanupInterruptedTemps(root: FileHandle, uid: number | undefined, adapter: DescriptorRootAdapter): Promise<boolean> {
  try {
    const names = await adapter.readdir(root)
    if (names.some(name => LEGACY_COORDINATION_ENTRIES.has(name))) return false
    const records = Object.entries(RECORD_FILES).filter(([record]) => record !== 'audit')
    const candidates: InterruptedTemp[] = []
    let totalBytes = 0
    for (const name of names) {
      const matched = records.find(([, file]) => name.startsWith(`${file}.tmp-`))
      if (!matched) continue
      const [record, file] = matched
      if (!new RegExp(`^${escapeRegExp(file)}\\.tmp-[0-9a-f]{32}$`).test(name)) return false
      const info = await adapter.statEntry(root, name)
      if (!info) return false
      if (!secureRecord(info, uid) || Number(info.size) > RECORD_LIMITS[record as RunnerHomeStateRecord]) return false
      totalBytes += Number(info.size)
      candidates.push({ name, identity: identityOf(info), size: Number(info.size) })
    }
    if (candidates.length > MAX_INTERRUPTED_TEMPS || totalBytes > MAX_INTERRUPTED_TEMP_BYTES) return false
    for (const candidate of candidates) {
      let handle: DescriptorChildHandle | null = null
      try {
        handle = await adapter.openEntry(root, candidate.name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        if (!handle) return false
        const [held, visible] = await Promise.all([adapter.stat(handle), adapter.statEntry(root, candidate.name)])
        if (!visible) return false
        if (!secureRecord(held, uid) || !sameIdentity(held, candidate.identity) || !sameIdentity(visible, candidate.identity)) return false
      } finally {
        // Candidate validation has its verdict; close failure must not turn cleanup into acceptance.
        if (handle) await adapter.close(handle).catch(() => undefined)
      }
      await adapter.unlink(root, candidate.name)
    }
    if (candidates.length > 0) await adapter.sync(root)
    return true
  } catch {
    return false
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function inspectEntry(root: FileHandle, record: RunnerHomeRecord, uid: number | undefined, adapter: DescriptorRootAdapter): Promise<RunnerHomeEntryInspection> {
  const info = await adapter.statEntry(root, RECORD_FILES[record])
  if (info === null) return { record, kind: 'missing', owner: 'current-user', mode: 0, links: 0 }
  return { record, kind: entryKindOf(info), owner: ownerOf(info, uid), mode: permissionsOf(info), links: info.nlink }
}

async function inspectCustody(root: FileHandle, entry: string, uid: number | undefined, adapter: DescriptorRootAdapter): Promise<RunnerHomeCustodyInspection> {
  const info = await adapter.statEntry(root, entry)
  if (info === null) return { kind: 'missing', owner: 'current-user', mode: 0, links: 0 }
  return { kind: entryKindOf(info), owner: ownerOf(info, uid), mode: permissionsOf(info), links: info.nlink }
}

async function openRecord(root: FileHandle, target: string, adapter: DescriptorRootAdapter): Promise<DescriptorChildHandle | null> {
  try {
    return await adapter.openEntry(root, target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (isCode(error, 'ENOENT')) return null
    throw error
  }
}

async function readSecure(handle: DescriptorChildHandle, uid: number | undefined, limit: number, adapter: DescriptorRootAdapter): Promise<RunnerHomeStorageRead> {
  try {
    const info = await adapter.stat(handle)
    if (!secureRecord(info, uid) || info.size > limit) return { status: 'storage-unavailable' }
    const bytes = await readBounded(handle, limit, info.size, adapter)
    return bytes ? { status: 'found', bytes, sha256: sha256(bytes) } : { status: 'storage-unavailable' }
  } finally {
    // The bounded read result is already determined; closing cannot make its bytes less read.
    await adapter.close(handle).catch(() => undefined)
  }
}

async function readBounded(handle: DescriptorChildHandle, limit: number, expectedSize: number, adapter: DescriptorRootAdapter): Promise<Uint8Array | null> {
  const bytes = await adapter.read(handle, Math.min(expectedSize + 1, limit + 1))
  return bytes.byteLength > limit || bytes.byteLength > expectedSize ? null : bytes
}

async function writeTemporary(root: FileHandle, target: string, bytes: Uint8Array, uid: number | undefined, adapter: DescriptorRootAdapter): Promise<void> {
  let handle: DescriptorChildHandle | null = null
  try {
    handle = await adapter.openEntry(root, target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, RECORD_MODE)
    if (!handle) throw new Error('temporary runner-home record already exists')
    if (!secureRecord(await adapter.stat(handle), uid)) throw new Error('temporary runner-home record is insecure')
    await adapter.writeAll(handle, bytes)
    await adapter.sync(handle)
  } finally {
    // The write path reports sync/open errors directly; close is best-effort descriptor cleanup.
    if (handle) await adapter.close(handle).catch(() => undefined)
  }
}

function secureDirectory(info: Stats | BigIntStats | DescriptorRootEntryStat, uid: number | undefined): boolean {
  return info.isDirectory() && ownerOf(info, uid) === 'current-user' && permissionsOf(info) === DIRECTORY_MODE
}

function secureRecord(info: Stats | BigIntStats | DescriptorRootEntryStat, uid: number | undefined): boolean {
  return info.isFile() && ownerOf(info, uid) === 'current-user' && permissionsOf(info) === RECORD_MODE && Number(info.nlink) === 1
}

function ownerOf(info: Stats | BigIntStats | DescriptorRootEntryStat, uid: number | undefined): 'current-user' | 'other' {
  return uid === undefined || Number(info.uid) === uid ? 'current-user' : 'other'
}

function permissionsOf(info: Stats | BigIntStats | DescriptorRootEntryStat): number {
  return Number(info.mode) & 0o777
}

function rootKindOf(info: Stats | BigIntStats | DescriptorRootEntryStat): RunnerHomeInspection['rootKind'] {
  if (info.isSymbolicLink()) return 'symlink'
  return info.isDirectory() ? 'directory' : 'other'
}

function entryKindOf(info: Stats | BigIntStats | DescriptorRootEntryStat): RunnerHomeEntryInspection['kind'] {
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

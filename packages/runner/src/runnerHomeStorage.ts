import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants, type BigIntStats, type Stats } from 'node:fs'
import { lstat, mkdir, open, readFile, rename, unlink, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  RUNNER_HOME_RECORDS,
  type RunnerHomeCustodyInspection,
  type RunnerHomeEntryInspection,
  type RunnerHomeInspection,
  type RunnerHomeRecord,
  type RunnerHomeSelection,
  type RunnerHomeStorage,
  type RunnerHomeStorageRead,
  type RunnerHomeStorageWrite,
} from './runnerHome.js'

const DIRECTORY_MODE = 0o700
const RECORD_MODE = 0o600
const LOCK_FILE = 'runner.lock'
const LOCK_BYTES = 1_024
const DEFAULT_RECORD_LIMIT = 2 * 1024 * 1024
const MUTATION_LOCK_FILE = '.records.lock'
const MUTATION_REAPER_FILE = '.records.reap'
const MUTATION_LOCK_ATTEMPTS = 1_000
const MUTATION_LOCK_BYTES = 1_024
const MUTATION_LOCK_INITIALIZATION_MS = 1_000
const RECORD_LIMITS: Readonly<Record<RunnerHomeRecord, number>> = {
  pairing: DEFAULT_RECORD_LIMIT,
  keys: 8 * 1024 * 1024,
  grants: DEFAULT_RECORD_LIMIT,
  configuration: DEFAULT_RECORD_LIMIT,
  policy: DEFAULT_RECORD_LIMIT,
  projects: DEFAULT_RECORD_LIMIT,
  receipts: 25 * 1024 * 1024,
  audit: 64 * 1024,
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

const mutationQueues = new Map<string, Promise<void>>()

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
  private lockHandle: FileHandle | null = null
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
      await this.releaseLock()
      await this.rootHandle?.close()
      this.rootHandle = null
      this.rootIdentity = null
      this.root = null
    })
  }

  read(record: RunnerHomeRecord): Promise<RunnerHomeStorageRead> {
    return this.serialize(async () => await this.readRecord(record))
  }

  replace(record: RunnerHomeRecord, expectedSha256: string | null, bytes: Uint8Array): Promise<RunnerHomeStorageWrite> {
    return this.serialize(async () => {
      if (record === 'audit' || bytes.byteLength > RECORD_LIMITS[record]) return { status: 'storage-unavailable' }
      const root = await this.boundRoot()
      if (!root) return { status: 'storage-unavailable' }
      return await this.withMutationLock(root, { status: 'storage-unavailable' }, async () => {
        const current = await this.readRecordAt(root, record)
        if (current.status === 'storage-unavailable') return current
        const currentSha256 = current.status === 'found' ? current.sha256 : null
        if (currentSha256 !== expectedSha256) return { status: 'conflict', currentSha256 }
        return await this.replaceRecord(root, record, bytes)
      })
    })
  }

  append(record: 'audit', bytes: Uint8Array): Promise<'appended' | 'storage-unavailable'> {
    return this.serialize(async () => await this.appendAudit(record, bytes))
  }

  private async inspectSelected(selection: RunnerHomeSelection): Promise<RunnerHomeInspection> {
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
    if (this.lockHandle) return (await this.lockStillBound()) ? 'busy' : 'storage-unavailable'
    const root = await this.boundRoot()
    if (!root) return 'storage-unavailable'
    const target = path.join(this.root!, LOCK_FILE)
    const identity = await processIdentity(process.pid)
    if (identity.status !== 'identified') return 'storage-unavailable'
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const created = await createLock(target, this.uid)
      if (created.status === 'created') {
        try {
          await writeAll(created.handle, Buffer.from(`${JSON.stringify({ pid: process.pid, identity: identity.value })}\n`))
          await created.handle.sync()
          await root.sync()
          this.lockHandle = created.handle
          return (await this.lockStillBound()) ? 'acquired' : 'storage-unavailable'
        } catch {
          const owned = await lockPathMatches(created.handle, target, this.uid)
          // The failed acquisition is already unavailable; closing must not hide that result.
          await created.handle.close().catch(() => undefined)
          if (owned) {
            // A private incomplete lock is safe to remove; cleanup failure leaves startup closed.
            await unlink(target).catch(() => undefined)
          }
          return 'storage-unavailable'
        }
      }
      if (created.status === 'storage-unavailable') return 'storage-unavailable'
      const owner = await readLockOwner(target, this.uid)
      if (owner === null) {
        await delay(5)
        continue
      }
      const current = await processIdentity(owner.pid)
      if (current.status === 'indeterminate') return 'storage-unavailable'
      if (current.status === 'identified' && current.value === owner.identity) return 'busy'
      if (!(await retireStaleLock(target, root))) return 'storage-unavailable'
    }
    return 'storage-unavailable'
  }

  private async releaseLock(): Promise<void> {
    const handle = this.lockHandle
    if (!handle) return
    if (!(await lockPathMatches(handle, path.join(this.root!, LOCK_FILE), this.uid))) {
      await handle.close()
      this.lockHandle = null
      throw new Error('runner-home lock identity changed')
    }
    await unlink(path.join(this.root!, LOCK_FILE))
    await this.rootHandle?.sync()
    await handle.close()
    this.lockHandle = null
  }

  private async lockStillBound(): Promise<boolean> {
    return this.lockHandle !== null
      && await lockPathMatches(this.lockHandle, path.join(this.root!, LOCK_FILE), this.uid)
  }

  private async readRecord(record: RunnerHomeRecord): Promise<RunnerHomeStorageRead> {
    const root = await this.boundRoot()
    if (!root) return { status: 'storage-unavailable' }
    return await this.readRecordAt(root, record)
  }

  private async readRecordAt(root: FileHandle, record: RunnerHomeRecord): Promise<RunnerHomeStorageRead> {
    try {
      const handle = await openRecord(rootEntryPath(root, RECORD_FILES[record]))
      const result = handle ? await readSecure(handle, this.uid, RECORD_LIMITS[record]) : { status: 'missing' as const }
      return (await this.rootStillBound()) ? result : { status: 'storage-unavailable' }
    } catch {
      return { status: 'storage-unavailable' }
    }
  }

  private async replaceRecord(root: FileHandle, record: RunnerHomeRecord, bytes: Uint8Array): Promise<RunnerHomeStorageWrite> {
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

  private async appendAudit(_record: 'audit', bytes: Uint8Array): Promise<'appended' | 'storage-unavailable'> {
    if (bytes.byteLength === 0 || bytes.byteLength > RECORD_LIMITS.audit) return 'storage-unavailable'
    const root = await this.boundRoot()
    if (!root) return 'storage-unavailable'
    return await this.withMutationLock(root, 'storage-unavailable', async () => {
      const current = await this.readRecordAt(root, 'audit')
      if (current.status === 'storage-unavailable') return 'storage-unavailable'
      const existing = current.status === 'found' ? Buffer.from(current.bytes) : Buffer.alloc(0)
      const updated = Buffer.concat([existing, Buffer.from(bytes)])
      if (updated.byteLength > RECORD_LIMITS.audit) return 'storage-unavailable'
      const stored = await this.replaceRecord(root, 'audit', updated)
      return stored.status === 'written' ? 'appended' : 'storage-unavailable'
    })
  }

  private async withMutationLock<T>(root: FileHandle, unavailable: T, operation: () => Promise<T>): Promise<T> {
    // An unidentified root cannot share a trustworthy process-local queue key and stays unavailable.
    const info = await root.stat({ bigint: true }).catch(() => null)
    if (!info) return unavailable
    return await serializeMutation(`${info.dev}:${info.ino}`, async () => {
      const lock = await acquireMutationLock(root, this.uid)
      if (!lock) return unavailable
      try {
        const result = (await this.rootStillBound()) ? await operation() : unavailable
        return (await releaseMutationLock(root, lock, this.uid)) ? result : unavailable
      } catch {
        await releaseMutationLock(root, lock, this.uid)
        return unavailable
      }
    })
  }

  private async boundRoot(): Promise<FileHandle | null> {
    if (!this.rootHandle || !this.rootIdentity) return null
    try {
      const info = await this.rootHandle.stat({ bigint: true })
      const homeMatches = secureDirectory(info, this.uid) && sameIdentity(info, this.rootIdentity) && await this.rootStillBound()
      if (!homeMatches || (this.lockHandle && !(await this.lockStillBound()))) return null
      return this.rootHandle
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

async function serializeMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(key) ?? Promise.resolve()
  const running = previous.then(operation, operation)
  // This promise only advances the per-root queue; the caller still receives `running` failures.
  const settled = running.then(() => undefined, () => undefined)
  mutationQueues.set(key, settled)
  try {
    return await running
  } finally {
    if (mutationQueues.get(key) === settled) mutationQueues.delete(key)
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

type LockCreation =
  | { status: 'created'; handle: FileHandle }
  | { status: 'exists' }
  | { status: 'storage-unavailable' }

async function createLock(target: string, uid: number | undefined): Promise<LockCreation> {
  try {
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, RECORD_MODE)
    if (secureRecord(await handle.stat(), uid)) return { status: 'created', handle }
    await handle.close()
    await unlink(target)
    return { status: 'storage-unavailable' }
  } catch (error) {
    return isCode(error, 'EEXIST') ? { status: 'exists' } : { status: 'storage-unavailable' }
  }
}

type LockOwner = { pid: number; identity: string }
type ProcessIdentity =
  | { status: 'identified'; value: string }
  | { status: 'absent' }
  | { status: 'indeterminate' }

async function readLockOwner(target: string, uid: number | undefined): Promise<LockOwner | null> {
  try {
    const handle = await openRecord(target)
    if (!handle) return null
    const held = await readSecure(handle, uid, LOCK_BYTES)
    if (held.status !== 'found') return null
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(held.bytes)) as { pid?: unknown; identity?: unknown }
    if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0) return null
    if (typeof value.identity !== 'string' || value.identity.length === 0 || value.identity.length > 512 || /[\u0000-\u001f\u007f]/.test(value.identity)) return null
    return { pid: value.pid, identity: value.identity }
  } catch {
    return null
  }
}

async function processIdentity(pid: number): Promise<ProcessIdentity> {
  if (process.platform === 'linux') return await linuxProcessIdentity(pid)
  if (process.platform === 'darwin') return await darwinProcessIdentity(pid)
  return processAlive(pid) ? { status: 'indeterminate' } : { status: 'absent' }
}

async function linuxProcessIdentity(pid: number): Promise<ProcessIdentity> {
  try {
    const [bootId, stat] = await Promise.all([
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      readFile(`/proc/${pid}/stat`, 'utf8'),
    ])
    const closingParenthesis = stat.lastIndexOf(')')
    const fields = closingParenthesis < 0 ? [] : stat.slice(closingParenthesis + 1).trim().split(/\s+/)
    const startTicks = fields[19]
    const boot = bootId.trim()
    if (!/^[0-9a-f-]{36}$/.test(boot) || !startTicks || !/^\d+$/.test(startTicks)) return { status: 'indeterminate' }
    return { status: 'identified', value: `linux:${boot}:${startTicks}` }
  } catch {
    return processAlive(pid) ? { status: 'indeterminate' } : { status: 'absent' }
  }
}

function darwinProcessIdentity(pid: number): Promise<ProcessIdentity> {
  return new Promise(resolve => {
    execFile(
      '/bin/ps',
      ['-p', String(pid), '-o', 'pid=', '-o', 'lstart='],
      { encoding: 'utf8', timeout: 1_000, maxBuffer: 4_096, env: { LC_ALL: 'C', LANG: 'C', PATH: '/usr/bin:/bin' } },
      (error, stdout) => {
        if (error) {
          resolve(processAlive(pid) ? { status: 'indeterminate' } : { status: 'absent' })
          return
        }
        const matched = stdout.match(/^\s*(\d+)\s+(.+?)\s*$/)
        resolve(matched?.[1] === String(pid) && matched[2]
          ? { status: 'identified', value: `darwin:${matched[2]}` }
          : { status: 'indeterminate' })
      },
    )
  })
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !isCode(error, 'ESRCH')
  }
}

async function retireStaleLock(target: string, root: FileHandle): Promise<boolean> {
  const retired = `${target}.stale-${randomBytes(16).toString('hex')}`
  try {
    await rename(target, retired)
    await unlink(retired)
    await root.sync()
    return true
  } catch (error) {
    return isCode(error, 'ENOENT')
  }
}

async function lockPathMatches(handle: FileHandle, target: string, uid: number | undefined): Promise<boolean> {
  try {
    const held = await handle.stat({ bigint: true })
    const current = await lstat(target, { bigint: true })
    return secureRecord(held, uid) && secureRecord(current, uid) && sameIdentity(current, identityOf(held))
  } catch {
    return false
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

async function acquireMutationLock(root: FileHandle, uid: number | undefined): Promise<FileHandle | null> {
  const target = rootEntryPath(root, MUTATION_LOCK_FILE)
  for (let attempt = 0; attempt < MUTATION_LOCK_ATTEMPTS; attempt += 1) {
    let handle: FileHandle | undefined
    try {
      const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK
      handle = await open(target, flags, RECORD_MODE)
      if (!secureRecord(await handle.stat(), uid)) {
        await rejectMutationLock(handle, target)
        return null
      }
      await writeAll(handle, Buffer.from(`${JSON.stringify({ pid: process.pid })}\n`))
      await handle.sync()
      await root.sync()
      if (!(await ownedEntryMatches(handle, target, uid))) {
        // Lost publication means this handle owns no lock path; close cannot make it usable.
        await handle.close().catch(() => undefined)
        return null
      }
      return handle
    } catch (error) {
      if (handle) await releaseOwnedEntry(root, handle, MUTATION_LOCK_FILE, uid)
      if (!isCode(error, 'EEXIST')) return null
      const retired = await retireStaleMutationLock(root, target, uid)
      if (retired === 'unavailable') return null
      if (retired === 'active') await delay(2)
    }
  }
  return null
}

async function rejectMutationLock(handle: FileHandle, target: string): Promise<void> {
  // The lock is already rejected; cleanup errors keep acquisition unavailable.
  await handle.close().catch(() => undefined)
  // Only the just-created private lock is targeted, and failure leaves the root closed.
  await unlink(target).catch(() => undefined)
}

type MutationLockState = 'retired' | 'active' | 'unavailable'

async function retireStaleMutationLock(
  root: FileHandle,
  target: string,
  uid: number | undefined,
): Promise<MutationLockState> {
  const reaper = await acquireReaper(root, uid)
  if (!reaper) return 'active'
  let handle: FileHandle | undefined
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const held = await handle.stat({ bigint: true })
    if (!secureRecord(held, uid)) return 'unavailable'
    const bytes = await readBounded(handle, MUTATION_LOCK_BYTES, Number(held.size))
    const pid = bytes && mutationLockPid(bytes)
    if (pid && processIsAlive(pid)) return 'active'
    if (!pid && Date.now() - Number(held.mtimeMs) <= MUTATION_LOCK_INITIALIZATION_MS) return 'active'
    const visible = await lstat(target, { bigint: true })
    if (!secureRecord(visible, uid) || !sameIdentity(visible, identityOf(held))) return 'unavailable'
    await unlink(target)
    return 'retired'
  } catch (error) {
    return isCode(error, 'ENOENT') ? 'retired' : 'unavailable'
  } finally {
    // The reaper serializes stale retirement; target inspection never owns the active lock.
    await handle?.close().catch(() => undefined)
    await releaseOwnedEntry(root, reaper, MUTATION_REAPER_FILE, uid)
  }
}

async function acquireReaper(root: FileHandle, uid: number | undefined): Promise<FileHandle | null> {
  const target = rootEntryPath(root, MUTATION_REAPER_FILE)
  let handle: FileHandle | undefined
  try {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK
    handle = await open(target, flags, RECORD_MODE)
    if (secureRecord(await handle.stat(), uid)) {
      await writeAll(handle, Buffer.from(`${JSON.stringify({ pid: process.pid })}\n`))
      await handle.sync()
      await root.sync()
      if (!(await ownedEntryMatches(handle, target, uid))) {
        // A replaced reaper owns no retirement authority; close cannot reclaim that path.
        await handle.close().catch(() => undefined)
        return null
      }
      return handle
    }
    await rejectMutationLock(handle, target)
    return null
  } catch {
    if (handle) await releaseOwnedEntry(root, handle, MUTATION_REAPER_FILE, uid)
    return null
  }
}

function mutationLockPid(bytes: Uint8Array): number | null {
  try {
    const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown
    if (typeof value !== 'object' || value === null || !('pid' in value)) return null
    const pid = value.pid
    return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !isCode(error, 'ESRCH')
  }
}

async function releaseMutationLock(root: FileHandle, lock: FileHandle, uid: number | undefined): Promise<boolean> {
  return await releaseOwnedEntry(root, lock, MUTATION_LOCK_FILE, uid)
}

async function ownedEntryMatches(handle: FileHandle, target: string, uid: number | undefined): Promise<boolean> {
  try {
    const [held, visible] = await Promise.all([handle.stat({ bigint: true }), lstat(target, { bigint: true })])
    return secureRecord(held, uid) && secureRecord(visible, uid) && sameIdentity(visible, identityOf(held))
  } catch {
    return false
  }
}

async function releaseOwnedEntry(
  root: FileHandle,
  lock: FileHandle,
  entry: string,
  uid: number | undefined,
): Promise<boolean> {
  const target = rootEntryPath(root, entry)
  try {
    if (!(await ownedEntryMatches(lock, target, uid))) {
      // Identity mismatch is already unavailable; close cannot authorize cleanup.
      await lock.close().catch(() => undefined)
      return false
    }
    await unlink(target)
    // The lock is already absent; sync failure cannot undo mutual exclusion just completed.
    await root.sync().catch(() => undefined)
    // The unlinked lock no longer coordinates writers, so descriptor close is best-effort.
    await lock.close().catch(() => undefined)
    return true
  } catch {
    // Failed identity/unlink cleanup remains unavailable; closing only prevents a descriptor leak.
    await lock.close().catch(() => undefined)
    return false
  }
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

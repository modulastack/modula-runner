import { performance } from 'node:perf_hooks'
import { statfs, type FileHandle } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { loadDarwinRunnerHomeNative } from './darwinRunnerHomeNative.js'

const ACQUIRE_TIMEOUT_MS = 2_000
const RETRY_DELAY_MS = 2
const LOCAL_FILESYSTEMS = new Set([
  0xEF53n,
  0x58465342n,
  0x9123683En,
  0x2FC12FC1n,
  0x794C7630n,
])

const queues = new Map<string, Promise<void>>()
const pending = new Map<string, number>()
const lifetimeLeases = new Map<string, number>()
const transientLeases = new Map<string, { fd: number; poison: () => Promise<void> }>()

export type LinuxRootLifetimeResult = 'acquired' | 'contended' | 'storage-unavailable'

export function linuxDescriptorRootPath(root: FileHandle): string {
  return `/proc/self/fd/${root.fd}/.`
}

export async function acquireLinuxRootLifetime(root: FileHandle): Promise<LinuxRootLifetimeResult> {
  const key = await admittedRootKey(root)
  if (!key) return 'storage-unavailable'
  return await serialize(key, async () => {
    if (lifetimeLeases.has(key)) return 'contended'
    const transient = transientLeases.get(key)
    if (transient?.fd === root.fd) {
      transientLeases.delete(key)
      lifetimeLeases.set(key, root.fd)
      return 'acquired'
    }
    if (transient) {
      transientLeases.delete(key)
      try {
        await release(transient.fd)
      } catch {
        await transient.poison()
        return 'storage-unavailable'
      }
    }
    const result = await acquire(root.fd)
    if (result !== 'acquired') return result === 'contended' ? 'contended' : 'storage-unavailable'
    lifetimeLeases.set(key, root.fd)
    return 'acquired'
  })
}

export async function releaseLinuxRootLifetime(root: FileHandle): Promise<boolean> {
  const key = await rootKey(root)
  if (!key) return false
  return await serialize(key, async () => {
    if (lifetimeLeases.get(key) !== root.fd) return false
    lifetimeLeases.delete(key)
    try {
      await release(root.fd)
      return true
    } catch {
      return false
    }
  })
}

export async function withLinuxRootLease<T>(
  root: FileHandle,
  unavailable: T,
  operation: () => Promise<T>,
  isDurablyCommitted: (result: T) => boolean,
  poison: () => Promise<void>,
): Promise<T> {
  const key = await admittedRootKey(root)
  if (!key) return unavailable
  return await serialize(key, async () => {
    if (lifetimeLeases.has(key)) return await runOperation(operation, unavailable)
    let lease = transientLeases.get(key)
    if (!lease) {
      if (await acquire(root.fd) !== 'acquired') return unavailable
      lease = { fd: root.fd, poison }
      transientLeases.set(key, lease)
    }
    const result = await runOperation(operation, unavailable)
    if ((pending.get(key) ?? 0) > 1) return result
    transientLeases.delete(key)
    try {
      await release(lease.fd)
      return result
    } catch {
      await lease.poison()
      return isDurablyCommitted(result) ? result : unavailable
    }
  })
}

async function runOperation<T>(operation: () => Promise<T>, unavailable: T): Promise<T> {
  try {
    return await operation()
  } catch {
    return unavailable
  }
}

async function acquire(fd: number): Promise<'acquired' | 'contended' | 'unavailable'> {
  const deadline = performance.now() + ACQUIRE_TIMEOUT_MS
  let contended = false
  for (;;) {
    try {
      const result = await tryExclusive(fd)
      if (result === 'acquired') return 'acquired'
      contended = true
    } catch {
      return 'unavailable'
    }
    if (performance.now() >= deadline) return contended ? 'contended' : 'unavailable'
    await delay(RETRY_DELAY_MS)
  }
}

async function release(fd: number): Promise<void> {
  await unlock(fd)
}

async function linuxFileLock(): Promise<typeof import('@modulastack/linux-file-lock')> {
  return await import('@modulastack/linux-file-lock')
}

async function tryExclusive(fd: number): Promise<'acquired' | 'contended'> {
  if (process.platform === 'darwin') return loadDarwinRunnerHomeNative().tryExclusive(fd)
  return await (await linuxFileLock()).tryExclusive(fd)
}

async function unlock(fd: number): Promise<void> {
  if (process.platform === 'darwin') return loadDarwinRunnerHomeNative().unlock(fd)
  await (await linuxFileLock()).unlock(fd)
}

async function admittedRootKey(root: FileHandle): Promise<string | null> {
  const key = await rootKey(root)
  if (!key) return null
  try {
    if (process.platform === 'darwin') return loadDarwinRunnerHomeNative().isLocalFileSystem(root.fd) ? key : null
    const info = await statfs(linuxDescriptorRootPath(root), { bigint: true })
    return LOCAL_FILESYSTEMS.has(info.type) ? key : null
  } catch {
    return null
  }
}

async function rootKey(root: FileHandle): Promise<string | null> {
  // An unidentified root has no trustworthy queue key or filesystem lease boundary.
  const info = await root.stat({ bigint: true }).catch(() => null)
  return info ? `${info.dev}:${info.ino}` : null
}

async function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
  pending.set(key, (pending.get(key) ?? 0) + 1)
  const previous = queues.get(key) ?? Promise.resolve()
  const running = previous.then(operation, operation)
  // The settled promise advances only the queue; callers still observe `running` failures.
  const settled = running.then(() => undefined, () => undefined)
  queues.set(key, settled)
  try {
    return await running
  } finally {
    const remaining = (pending.get(key) ?? 1) - 1
    if (remaining === 0) pending.delete(key)
    else pending.set(key, remaining)
    if (queues.get(key) === settled) queues.delete(key)
  }
}

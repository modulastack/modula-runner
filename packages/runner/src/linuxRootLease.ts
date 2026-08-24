import { tryExclusive, unlock } from '@modulastack/linux-file-lock'
import { performance } from 'node:perf_hooks'
import { statfs, type FileHandle } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

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
        await unlock(transient.fd)
      } catch {
        await transient.poison()
        return 'storage-unavailable'
      }
    }
    if (!(await acquire(root.fd))) return 'storage-unavailable'
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
      await unlock(root.fd)
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
      if (!(await acquire(root.fd))) return unavailable
      lease = { fd: root.fd, poison }
      transientLeases.set(key, lease)
    }
    const result = await runOperation(operation, unavailable)
    if ((pending.get(key) ?? 0) > 1) return result
    transientLeases.delete(key)
    try {
      await unlock(lease.fd)
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

async function acquire(fd: number): Promise<boolean> {
  const deadline = performance.now() + ACQUIRE_TIMEOUT_MS
  for (;;) {
    try {
      if (await tryExclusive(fd) === 'acquired') return true
    } catch {
      return false
    }
    if (performance.now() >= deadline) return false
    await delay(RETRY_DELAY_MS)
  }
}

async function admittedRootKey(root: FileHandle): Promise<string | null> {
  const key = await rootKey(root)
  if (!key) return null
  try {
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

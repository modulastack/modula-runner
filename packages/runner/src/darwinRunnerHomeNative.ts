import { createRequire } from 'node:module'

type NativeStat = {
  dev: bigint
  ino: bigint
  mode: number
  uid: number
  nlink: number
  size: bigint
  type: 'file' | 'directory' | 'symlink' | 'other'
}

type DarwinRunnerHomeNative = {
  fstat(fd: number): NativeStat
  fstatat(rootFd: number, name: string): NativeStat | null
  openat(rootFd: number, name: string, flags: number, mode?: number): number | null
  read(fd: number, limit: number): Buffer
  writeAll(fd: number, bytes: Buffer): void
  truncate(fd: number, length: number): void
  close(fd: number): void
  fsync(fd: number): void
  renameat(fromFd: number, fromName: string, toFd: number, toName: string): void
  unlinkat(rootFd: number, name: string): void
  mkdirat(rootFd: number, name: string, mode: number): void
  rmdir(rootFd: number, name: string): void
  readdir(rootFd: number): string[]
  isLocalFileSystem(rootFd: number): boolean
  tryExclusive(fd: number): 'acquired' | 'contended'
  unlock(fd: number): void
  fdFlags(fd: number): number
  errnoSymbols(): { EBADF: 'EBADF'; EINVAL: 'EINVAL'; EIO: 'EIO'; ENOENT: 'ENOENT' }
}

// The addon is verified on the load that executes it and then held. A contended lease polls this
// every 2ms, and the module is require-cached after the first load, so re-reading and re-hashing
// the file spends the work on bytes that are no longer the ones running. The platform guard stays
// outside the cache so a wrong-platform call still throws.
let binding: DarwinRunnerHomeNative | null = null

export function loadDarwinRunnerHomeNative(): DarwinRunnerHomeNative {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.versions.node.split('.')[0] !== '22') {
    throw new Error(`Darwin runner-home native storage requires Node 22 on darwin arm64; found ${process.platform} ${process.arch} ${process.versions.node}`)
  }
  binding ??= (createRequire(import.meta.url)('@modulastack/darwin-file-lock') as { loadBinding(): DarwinRunnerHomeNative }).loadBinding()
  return binding
}

export type { NativeStat, DarwinRunnerHomeNative }

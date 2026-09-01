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

export function loadDarwinRunnerHomeNative(): DarwinRunnerHomeNative {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.versions.node.split('.')[0] !== '22') {
    throw new Error(`Darwin runner-home native storage requires Node 22 on darwin arm64; found ${process.platform} ${process.arch} ${process.versions.node}`)
  }
  const loader = createRequire(import.meta.url)('@modulastack/darwin-file-lock') as { loadBinding(): DarwinRunnerHomeNative }
  return loader.loadBinding()
}

export type { NativeStat, DarwinRunnerHomeNative }

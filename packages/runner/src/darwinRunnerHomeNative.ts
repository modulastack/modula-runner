import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
  close(fd: number): void
  fsync(fd: number): void
  renameat(fromFd: number, fromName: string, toFd: number, toName: string): void
  unlinkat(rootFd: number, name: string): void
  readdir(rootFd: number): string[]
  isLocalFileSystem(rootFd: number): boolean
  tryExclusive(fd: number): 'acquired' | 'contended'
  unlock(fd: number): void
}

const binary = {
  file: 'darwin-runner-home-arm64-node-22.0.0.node',
  sha256: 'f4390997eda1e586a225c12420b521b4ba170723c4033d61ade8d083a1742dfc',
}

export function loadDarwinRunnerHomeNative(): DarwinRunnerHomeNative {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.versions.node.split('.')[0] !== '22') {
    throw new Error(`Darwin runner-home native storage requires Node 22 on darwin arm64; found ${process.platform} ${process.arch} ${process.versions.node}`)
  }
  const source = fileURLToPath(import.meta.url)
  const url = path.resolve(path.dirname(source), '..', 'native', binary.file)
  const digest = createHash('sha256').update(readFileSync(url)).digest('hex')
  if (digest !== binary.sha256) throw new Error('Darwin runner-home native binary integrity check failed')
  return createRequire(import.meta.url)(url) as DarwinRunnerHomeNative
}

export type { NativeStat, DarwinRunnerHomeNative }

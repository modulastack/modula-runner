import { type BigIntStats, type Stats } from 'node:fs'
import { lstat, open, readdir, rename, statfs, unlink, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { loadDarwinRunnerHomeNative, type NativeStat } from './darwinRunnerHomeNative.js'

export type DescriptorRootIdentity = { device: bigint; inode: bigint }

export type DescriptorRootEntryStat = {
  dev: bigint
  ino: bigint
  mode: number
  uid: number
  nlink: number
  size: number
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export type DescriptorChildHandle = FileHandle | { platform: 'darwin'; fd: number }

export interface DescriptorRootAdapter {
  rootEntryPath(root: FileHandle, entry: string): string
  inspectPath(target: string): Promise<DescriptorRootEntryStat | null>
  stat(handle: DescriptorChildHandle | FileHandle): Promise<DescriptorRootEntryStat>
  statEntry(root: FileHandle, entry: string): Promise<DescriptorRootEntryStat | null>
  openEntry(root: FileHandle, entry: string, flags: number, mode?: number): Promise<DescriptorChildHandle | null>
  read(handle: DescriptorChildHandle, limit: number): Promise<Buffer>
  writeAll(handle: DescriptorChildHandle, bytes: Uint8Array): Promise<void>
  sync(handle: DescriptorChildHandle | FileHandle): Promise<void>
  close(handle: DescriptorChildHandle): Promise<void>
  rename(root: FileHandle, from: string, to: string): Promise<void>
  unlink(root: FileHandle, entry: string): Promise<void>
  readdir(root: FileHandle): Promise<string[]>
  isLocalFileSystem(root: FileHandle): Promise<boolean>
}

const LOCAL_LINUX_FILESYSTEMS = new Set([
  0xEF53n,
  0x58465342n,
  0x9123683En,
  0x2FC12FC1n,
  0x794C7630n,
])

export function descriptorRootAdapter(): DescriptorRootAdapter {
  return process.platform === 'darwin' ? darwinDescriptorRootAdapter() : linuxDescriptorRootAdapter()
}

function linuxDescriptorRootAdapter(): DescriptorRootAdapter {
  const rootEntryPath = (root: FileHandle, entry: string) => path.join('/proc/self/fd', String(root.fd), entry)
  return {
    rootEntryPath,
    inspectPath: async target => statsToEntryStat(await lstat(target, { bigint: true }).catch(error => missingOnly(error))),
    stat: async handle => statsToEntryStat(await (handle as FileHandle).stat({ bigint: true }))!,
    statEntry: async (root, entry) => statsToEntryStat(await lstat(rootEntryPath(root, entry), { bigint: true }).catch(error => missingOnly(error))),
    openEntry: async (root, entry, flags, mode) => await open(rootEntryPath(root, entry), flags, mode).catch(error => missingOnly(error)),
    read: async (handle, limit) => await readFileHandle(handle as FileHandle, limit),
    writeAll: async (handle, bytes) => await writeAllFileHandle(handle as FileHandle, bytes),
    sync: async handle => await (handle as FileHandle).sync(),
    close: async handle => await (handle as FileHandle).close(),
    rename: async (root, from, to) => await rename(rootEntryPath(root, from), rootEntryPath(root, to)),
    unlink: async (root, entry) => await unlink(rootEntryPath(root, entry)),
    readdir: async root => await readdir(rootEntryPath(root, '.')),
    isLocalFileSystem: async root => {
      const info = await statfs(rootEntryPath(root, '.'), { bigint: true })
      return LOCAL_LINUX_FILESYSTEMS.has(info.type)
    },
  }
}

function darwinDescriptorRootAdapter(): DescriptorRootAdapter {
  const native = loadDarwinRunnerHomeNative()
  return {
    rootEntryPath: () => {
      throw new Error('Darwin runner-home storage does not expose descriptor paths')
    },
    inspectPath: async target => statsToEntryStat(await lstat(target, { bigint: true }).catch(error => missingOnly(error))),
    stat: async handle => {
      if ('platform' in handle) return nativeStatToEntryStat(native.fstat(handle.fd))!
      return statsToEntryStat(await handle.stat({ bigint: true }))!
    },
    statEntry: async (root, entry) => nativeStatToEntryStat(native.fstatat(root.fd, entry)),
    openEntry: async (root, entry, flags, mode) => {
      const fd = native.openat(root.fd, entry, flags, mode)
      return fd === null ? null : { platform: 'darwin', fd }
    },
    read: async (handle, limit) => native.read(darwinHandle(handle).fd, limit),
    writeAll: async (handle, bytes) => native.writeAll(darwinHandle(handle).fd, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)),
    sync: async handle => {
      if ('platform' in handle) native.fsync(handle.fd)
      else await handle.sync()
    },
    close: async handle => native.close(darwinHandle(handle).fd),
    rename: async (root, from, to) => native.renameat(root.fd, from, root.fd, to),
    unlink: async (root, entry) => native.unlinkat(root.fd, entry),
    readdir: async root => native.readdir(root.fd),
    isLocalFileSystem: async root => native.isLocalFileSystem(root.fd),
  }
}

function darwinHandle(handle: DescriptorChildHandle): { platform: 'darwin'; fd: number } {
  if (!('platform' in handle) || handle.platform !== 'darwin') throw new Error('expected Darwin child descriptor')
  return handle
}

async function readFileHandle(handle: FileHandle, limit: number): Promise<Buffer> {
  const buffer = Buffer.alloc(limit)
  let offset = 0
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  return Buffer.from(buffer.subarray(0, offset))
}

async function writeAllFileHandle(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset)
    if (bytesWritten === 0) throw new Error('runner-home write made no progress')
    offset += bytesWritten
  }
}

function nativeStatToEntryStat(info: NativeStat | null): DescriptorRootEntryStat | null {
  if (!info) return null
  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    uid: info.uid,
    nlink: info.nlink,
    size: Number(info.size),
    isFile: () => info.type === 'file',
    isDirectory: () => info.type === 'directory',
    isSymbolicLink: () => info.type === 'symlink',
  }
}

function statsToEntryStat(info: BigIntStats | null): DescriptorRootEntryStat | null {
  if (!info) return null
  return {
    dev: BigInt(info.dev),
    ino: BigInt(info.ino),
    mode: Number(info.mode),
    uid: Number(info.uid),
    nlink: Number(info.nlink),
    size: Number(info.size),
    isFile: () => info.isFile(),
    isDirectory: () => info.isDirectory(),
    isSymbolicLink: () => info.isSymbolicLink(),
  }
}

export function identityOf(info: Stats | BigIntStats | DescriptorRootEntryStat): DescriptorRootIdentity {
  return { device: BigInt(info.dev), inode: BigInt(info.ino) }
}

export function sameIdentity(info: BigIntStats | DescriptorRootEntryStat, expected: DescriptorRootIdentity): boolean {
  return BigInt(info.dev) === expected.device && BigInt(info.ino) === expected.inode
}

function missingOnly<T>(error: unknown): T | null {
  if (isCode(error, 'ENOENT')) return null
  throw error
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}

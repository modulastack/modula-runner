import { createPrivateKey, createPublicKey } from 'node:crypto'
import { constants, type BigIntStats, type Stats } from 'node:fs'
import { link, lstat, open, readdir, realpath, unlink, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import {
  MAX_ALLOWLIST_BYTES,
  allowlistKeyId,
  generateAllowlistSigningKey,
  type AllowlistSigningKey,
  type GeneratedAllowlistSigningKey,
} from './allowlist.js'

const PRIVATE_KEY_MODE = 0o600
const MAX_PRIVATE_KEY_BYTES = 16 * 1024

export async function createAllowlistSigningKeyFile(target: string): Promise<GeneratedAllowlistSigningKey> {
  const keyPath = await validatedKeyPath(target)
  const generated = generateAllowlistSigningKey()
  const temporary = `${keyPath}.tmp-${process.pid}-${generated.signingKey.keyId.slice(0, 16)}`
  let handle: FileHandle | undefined
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, PRIVATE_KEY_MODE)
    await handle.chmod(PRIVATE_KEY_MODE)
    const info = await handle.stat()
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== PRIVATE_KEY_MODE || info.nlink !== 1) {
      throw new Error('generated allowlist signing key custody is invalid')
    }
    await writeAll(handle, Buffer.from(generated.signingKey.privateKey))
    await handle.sync()
    await handle.close()
    handle = undefined
    await link(temporary, keyPath)
    await unlink(temporary)
    await syncDirectory(path.dirname(keyPath))
    return generated
  } catch (error) {
    if (isCode(error, 'EEXIST')) throw new Error('allowlist signing key path already exists')
    throw error
  } finally {
    // A failed no-overwrite publish leaves only a private temporary owned by this operation.
    await handle?.close().catch(() => undefined)
    // The target is never removed here; only the uniquely named unpublished temporary is cleanup-safe.
    await unlink(temporary).catch(() => undefined)
  }
}

export async function readAllowlistSigningKeyFile(target: string): Promise<GeneratedAllowlistSigningKey> {
  const keyPath = await validatedKeyPath(target)
  let handle: FileHandle | undefined
  try {
    handle = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let info = await handle.stat()
    if (info.nlink === 2) info = await recoverInterruptedKeyPublication(keyPath, handle, info)
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== PRIVATE_KEY_MODE || info.nlink !== 1) {
      throw new Error('allowlist signing key custody is invalid')
    }
    if (info.size > MAX_PRIVATE_KEY_BYTES) throw new Error('allowlist signing key is too large')
    const privateKey = (await readBounded(handle, MAX_PRIVATE_KEY_BYTES, 'allowlist signing key')).toString('utf8')
    const privateObject = createPrivateKey({ key: privateKey, format: 'pem' })
    if (privateObject.asymmetricKeyType !== 'ed25519') throw new Error('allowlist signing key must use Ed25519')
    const publicKey = createPublicKey(privateObject).export({ type: 'spki', format: 'pem' }).toString()
    const keyId = allowlistKeyId(publicKey)
    return { signingKey: { keyId, privateKey }, trustAnchor: { keyId, publicKey } }
  } finally {
    await handle?.close()
  }
}

export async function readAllowlistDocumentFile(target: string): Promise<string> {
  if (typeof target !== 'string' || target.length === 0 || target.length > 4_096 || /[\u0000-\u001f\u007f]/.test(target)) {
    throw new Error('allowlist document path is invalid')
  }
  let handle: FileHandle | undefined
  try {
    handle = await open(path.resolve(target), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = await handle.stat({ bigint: true })
    if (!secureAllowlistDocument(before)) throw new Error('allowlist document custody is invalid')
    if (before.size > BigInt(MAX_ALLOWLIST_BYTES)) throw new Error('allowlist document is too large')
    const document = await readBounded(handle, MAX_ALLOWLIST_BYTES, 'allowlist document')
    const after = await handle.stat({ bigint: true })
    if (!sameDocument(before, after) || !secureAllowlistDocument(after)) {
      throw new Error('allowlist document custody changed while reading')
    }
    return document.toString('utf8')
  } finally {
    await handle?.close()
  }
}

export function signingKeyOutsideHome(target: string, homeRoot: string): boolean {
  const keyPath = path.resolve(target)
  const root = path.resolve(homeRoot)
  const relative = path.relative(root, keyPath)
  return relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative))
}

async function recoverInterruptedKeyPublication(
  keyPath: string,
  handle: FileHandle,
  targetInfo: Stats,
) {
  const directory = path.dirname(keyPath)
  const basename = path.basename(keyPath)
  const candidates = (await readdir(directory)).filter(entry => (
    entry.startsWith(`${basename}.tmp-`) && /\.tmp-\d+-[0-9a-f]{16}$/.test(entry)
  ))
  const matching = []
  for (const entry of candidates) {
    const info = await lstat(path.join(directory, entry))
    if (info.isFile() && info.dev === targetInfo.dev && info.ino === targetInfo.ino) matching.push(entry)
  }
  if (matching.length !== 1) return targetInfo
  await unlink(path.join(directory, matching[0]!))
  await syncDirectory(directory)
  return await handle.stat()
}

async function validatedKeyPath(target: string): Promise<string> {
  if (typeof target !== 'string' || target.length === 0 || target.length > 4_096 || /[\u0000-\u001f\u007f]/.test(target)) {
    throw new Error('allowlist signing key path is invalid')
  }
  const keyPath = path.resolve(target)
  const parent = path.dirname(keyPath)
  const [resolvedParent, info] = await Promise.all([realpath(parent), lstat(parent)])
  if (resolvedParent !== parent || !info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) {
    throw new Error('allowlist signing key directory custody is invalid')
  }
  return keyPath
}

async function readBounded(handle: FileHandle, limit: number, label: string): Promise<Buffer> {
  const buffer = Buffer.alloc(limit + 1)
  let offset = 0
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  if (offset > limit) throw new Error(`${label} grew past its size limit`)
  return buffer.subarray(0, offset)
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset)
    if (bytesWritten === 0) throw new Error('allowlist signing key write made no progress')
    offset += bytesWritten
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function secureAllowlistDocument(info: BigIntStats): boolean {
  return info.isFile()
    && info.uid === BigInt(process.getuid?.() ?? -1)
    && (info.mode & 0o022n) === 0n
    && info.nlink === 1n
}

function sameDocument(
  before: BigIntStats,
  after: BigIntStats,
): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}

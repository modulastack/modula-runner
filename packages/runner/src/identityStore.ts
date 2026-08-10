import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, link, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import type { PairingStore, RunnerBinding } from './pairing.js'

// Key custody, stated so "encrypted" is a testable promise rather than a word:
//
// A 32-byte random key lives in its own file, mode 0600, generated on first write and
// never leaving the machine. Records are AES-256-GCM with a fresh nonce per write, so a
// tampered record fails closed instead of decrypting into something.
//
// What this does NOT protect against: a local attacker running as the same user reads the
// key and the binding alike. This defends against casual disclosure — a world-readable
// config, a backup, a copied directory — and against silent tampering. Claiming more
// would be false, and a security posture nobody can rely on is worse than a modest one
// everybody understands.

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16
const FILE_MODE = 0o600
const RECORD_VERSION = 1

export type EncryptedStoreOptions = {
  path: string
  keyPath: string
}

type SealedRecord = {
  v: number
  nonce: string
  tag: string
  body: string
}

export function createEncryptedPairingStore(options: EncryptedStoreOptions): PairingStore {
  const bindingPath = path.resolve(String(options.path))
  const keyPath = path.resolve(String(options.keyPath))
  // Pointed at one file, the first save writes ciphertext over the key that was just
  // created and reports success, and nothing can be read back afterwards. Refusing the
  // configuration is the only outcome that does not destroy the binding it was given.
  //
  // Comparing spellings is not enough: a symlink, or a case-insensitive filesystem, gives
  // one file two names that differ as strings. The paths are compared as written for the
  // obvious case, and by file identity once both exist.
  if (bindingPath === keyPath) throw new Error('the pairing binding and its key must be different files')
  // Mutations run one at a time. Revocation reads the binding and writes it back, and an
  // interleaved save would be overwritten by the stale record that read began with.
  // Serializing within the process is the whole fix for the supported case: two runner
  // processes sharing one store is outside this contract, the same way two runners sharing
  // a checkout is (see docs/runner-seam.md).
  let queue: Promise<unknown> = Promise.resolve()
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation)
    // The queue only sequences; a failed operation reports to its own caller.
    queue = result.catch(() => {})
    return result
  }
  return {
    // Checked inside each operation rather than fired off at construction: a detached
    // promise that rejects takes the process down instead of failing the call that cared.
    load: () => serialize(async () => {
      await assertDistinctFiles(bindingPath, keyPath)
      return await loadBinding(bindingPath, keyPath)
    }),
    save: (binding, expectedToken) => serialize(async () => {
      if (expectedToken !== undefined) {
        const current = await loadBinding(bindingPath, keyPath)
        // A missing record is not a match. Treating absence as agreement let a late
        // settlement recreate a binding that had been deliberately removed.
        if (!current || current.token !== expectedToken) return
        // Nor is a revoked one. A settlement that lost the queue to endBinding would
        // otherwise write its pre-revocation copy back and erase the revocation, after
        // which clients retry a token the account deliberately retired.
        if (current.revokedAt !== undefined) return
      }
      await saveBinding(bindingPath, keyPath, binding)
    }),
    markRevoked: (revokedAt, expectedToken) => serialize(async () => {
      const current = await loadBinding(bindingPath, keyPath)
      if (!current || current.revokedAt) return
      if (expectedToken !== undefined && current.token !== expectedToken) return
      await saveBinding(bindingPath, keyPath, { ...current, revokedAt })
    }),
  }
}

// Deferred rather than blocking construction: the files usually do not exist yet, so this
// answers as soon as they do and fails the operation that would corrupt them.
async function assertDistinctFiles(bindingPath: string, keyPath: string) {
  // A file that does not exist yet cannot alias another; absence is the answer here.
  const [binding, key] = await Promise.all([stat(bindingPath).catch(() => null), stat(keyPath).catch(() => null)])
  if (!binding || !key) return
  if (binding.ino === key.ino && binding.dev === key.dev) {
    throw new Error('the pairing binding and its key resolve to the same file')
  }
}

export function createMemoryPairingStore(): PairingStore {
  let binding: RunnerBinding | null = null
  return {
    load: async () => (binding ? { ...binding } : null),
    save: async (next, expectedToken) => {
      if (expectedToken !== undefined && (!binding || binding.token !== expectedToken)) return
      // Same rule as the encrypted store: a revocation is not undone by a late write.
      if (expectedToken !== undefined && binding?.revokedAt !== undefined) return
      binding = { ...next }
    },
    markRevoked: async (revokedAt, expectedToken) => {
      if (!binding || binding.revokedAt) return
      if (expectedToken !== undefined && binding.token !== expectedToken) return
      binding = { ...binding, revokedAt }
    },
  }
}

async function loadBinding(bindingPath: string, keyPath: string): Promise<RunnerBinding | null> {
  const raw = await readIfPresent(bindingPath)
  if (raw === null) return null
  // Parsed before the key is opened. Only readCustodiedKey closes the descriptor, so a
  // malformed record throwing between the open and the read leaked one per attempt.
  const record = parseRecord(raw)
  const handle = await openIfPresent(keyPath)
  if (!handle) throw new Error(`pairing key file is missing: ${keyPath}`)
  return decodeBinding(unseal(record, await readCustodiedKey(handle, keyPath)))
}


async function saveBinding(bindingPath: string, keyPath: string, binding: RunnerBinding) {
  await assertDistinctFiles(bindingPath, keyPath)
  const key = await loadOrCreateKey(keyPath)
  // Re-checked after the key exists: two differently-spelled paths that did not exist a
  // moment ago can resolve to one file once the key file is created.
  await assertDistinctFiles(bindingPath, keyPath)
  const record = seal(Buffer.from(JSON.stringify(binding), 'utf8'), key)
  await writeAtomically(bindingPath, Buffer.from(JSON.stringify(record), 'utf8'))
}

function seal(plaintext: Buffer, key: Buffer): SealedRecord {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, nonce)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { v: RECORD_VERSION, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') }
}

// Authentication failure is the tamper signal, so it surfaces as its own error rather
// than as a parse failure further down.
function unseal(record: SealedRecord, key: Buffer): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(record.nonce, 'base64'))
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'))
  try {
    return Buffer.concat([decipher.update(Buffer.from(record.body, 'base64')), decipher.final()])
  } catch {
    throw new Error('the stored binding failed authentication: it was tampered with, or the key does not match')
  }
}

function parseRecord(raw: Buffer): SealedRecord {
  const parsed = safeJson(raw.toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null) throw new Error('the stored binding is not a sealed record')
  const record = parsed as Record<string, unknown>
  if (record.v !== RECORD_VERSION) throw new Error(`unsupported binding record version: ${String(record.v)}`)
  const { nonce, tag, body } = record
  if (!isBase64(nonce, NONCE_BYTES) || !isBase64(tag, TAG_BYTES) || typeof body !== 'string') {
    throw new Error('the stored binding is not a sealed record')
  }
  return { v: RECORD_VERSION, nonce, tag, body }
}

function decodeBinding(plaintext: Buffer): RunnerBinding {
  const parsed = safeJson(plaintext.toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null) throw new Error('the stored binding is not an object')
  const binding = parsed as Record<string, unknown>
  const fields = [binding.runnerId, binding.controlPlaneUrl, binding.token, binding.pairedAt]
  if (!fields.every(field => typeof field === 'string' && field.length > 0)) throw new Error('the stored binding is incomplete')
  for (const marker of ['revokedAt', 'pendingSince'] as const) {
    const value = binding[marker]
    if (value === undefined) continue
    // Rejected at the edge as well: a marker that is present but empty is a lifecycle
    // state nothing downstream can read correctly.
    if (typeof value !== 'string' || value.length === 0) throw new Error('the stored binding is incomplete')
  }
  return binding as unknown as RunnerBinding
}

// Exclusive creation, so two runners starting together cannot each mint a key and leave
// one of them holding a binding it can no longer open.
//
// Custody is checked on the descriptor that is actually read, not on the path. Stat-then-
// open leaves a window in which another local user with write access to the directory can
// replace what the path names — supplying a key they know, under which this runner would
// then encrypt its credential. O_NOFOLLOW refuses a symlink outright, and fstat asks about
// the file that was opened rather than about the name.
async function loadOrCreateKey(keyPath: string) {
  await mkdir(path.dirname(keyPath), { recursive: true })
  const existing = await openIfPresent(keyPath)
  if (existing) return await readCustodiedKey(existing, keyPath)
  try {
    // The key becomes visible at its real name only once it is whole. Writing in place
    // publishes the path first and fills it second, so a crash in between leaves an empty
    // or truncated key sitting where a real one belongs — and every later load trusts it,
    // which bricks pairing until somebody deletes the file by hand.
    //
    // link() is the atomic no-overwrite publish: it fails rather than replacing an
    // existing key, which is what makes two runners racing safe.
    const temporary = `${keyPath}.${randomBytes(6).toString('hex')}.tmp`
    try {
      const created = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, FILE_MODE)
      try {
        await created.writeFile(randomBytes(KEY_BYTES))
        await created.sync()
      } finally {
        await created.close()
      }
      await link(temporary, keyPath)
      await syncDirectory(path.dirname(keyPath))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally {
      // The temporary is either already published or already gone; either is fine.
      await unlink(temporary).catch(() => {})
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const handle = await openIfPresent(keyPath)
  if (!handle) throw new Error(`could not create the pairing key file: ${keyPath}`)
  return await readCustodiedKey(handle, keyPath)
}

async function openIfPresent(keyPath: string) {
  try {
    return await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    if (code === 'ELOOP') throw new Error(`pairing key path is a symbolic link: ${keyPath}`)
    throw error
  }
}

async function readCustodiedKey(handle: FileHandle, keyPath: string) {
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`pairing key path is not a regular file: ${keyPath}`)
    if (info.uid !== process.getuid?.()) throw new Error(`pairing key file is not owned by this user: ${keyPath}`)
    if ((info.mode & 0o077) !== 0) {
      throw new Error(`pairing key file is readable by other users (mode ${(info.mode & 0o777).toString(8)}): ${keyPath}`)
    }
    return assertKey(await handle.readFile(), keyPath)
  } finally {
    await handle.close()
  }
}

function assertKey(key: Buffer, keyPath: string) {
  if (key.length !== KEY_BYTES) throw new Error(`pairing key file must hold ${KEY_BYTES} bytes: ${keyPath}`)
  return key
}

// Rename is atomic within a directory, so a crash mid-write leaves the previous binding
// intact rather than a truncated record nothing can open.
async function writeAtomically(target: string, contents: Buffer) {
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, FILE_MODE)
    try {
      await handle.writeFile(contents)
      // On the platter before the rename, and the directory entry after it. Redemption
      // spends a single-use code, so a power loss between activation and the data landing
      // destroys the only credential and no retry can recover it.
      await handle.sync()
    } finally {
      await handle.close()
    }
    await chmod(temporary, FILE_MODE)
    await rename(temporary, target)
    await syncDirectory(path.dirname(target))
  } catch (error) {
    // Cleaning up after a failed write; the error itself is rethrown to the caller.
    await unlink(temporary).catch(() => {})
    throw error
  }
  // No chmod after the rename: the mode is already correct on the temporary, and a failure
  // here would report that the binding was not saved when it demonstrably was — which
  // sends the operator to pair again over a credential that is on disk and valid.
}

async function syncDirectory(directory: string) {
  const handle = await open(directory, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function readIfPresent(target: string) {
  try {
    await stat(target)
    return await readFile(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function isBase64(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && Buffer.from(value, 'base64').length === bytes
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('the stored binding is not valid JSON')
  }
}

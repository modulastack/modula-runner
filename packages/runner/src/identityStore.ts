import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, link, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
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
//
// One implementation serves every record kind. A second encrypted store would be a second
// set of these decisions to get right, and the one that drifts is the one nobody is
// looking at — so the pairing binding and the API key store are two record files sharing
// one key file, one mutation queue, and one set of custody checks.

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16
const FILE_MODE = 0o600
const RECORD_VERSION = 1
const KEY_FILE = 'key file'

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

// Named rather than numbered because the names are what the operator reads when two of
// them collide, and a collision is the failure this vocabulary exists to describe.
export type SealedRecordKind = 'pairing binding' | 'API key store'

export type SealedRecordFile = {
  // Mutations run one at a time, across every record under one key file. Revocation reads
  // a record and writes it back, and an interleaved save would be overwritten by the stale
  // copy that read began with. The queue is shared rather than per-record because the key
  // file is shared: two queues would let two record kinds each create it, and one of them
  // would end up holding a record it can no longer open.
  //
  // Serializing within the process is the whole fix for the supported case: two runner
  // processes sharing one store is outside this contract, the same way two runners sharing
  // a checkout is (see docs/runner-seam.md).
  serialize<T>(operation: () => Promise<T>): Promise<T>
  read(): Promise<unknown | null>
  write(value: unknown): Promise<void>
}

type Custody = {
  keyPath: string
  queue: Promise<unknown>
}

// A path some store in this process has claimed, and what it was claimed as.
type PathClaim =
  | { role: 'key' }
  | { role: 'record'; kind: SealedRecordKind; keyPath: string }

// Module-level, which is the only process-wide state in this file and is a decision rather
// than a convenience. Stores are opened by separate factory calls, and what they must share
// cannot travel through either signature.
//
// Two things are shared, for two different reasons. Mutations queue per key file, because
// that is the resource a race corrupts: two writes that each mint the key would leave one of
// them holding a record it can no longer open. Path claims are process-wide, because a
// per-key-file registry cannot see the collisions that matter most — two stores configured
// with *different* key files never met, so the same record path under two keys had each
// write re-encrypt the other's record under a key it cannot read, and a record path equal to
// another store's key path put ciphertext on the key file and made that store permanently
// unreadable. Neither is detectable from inside one custody.
//
// What bounds both: paths come from local configuration, never from a name on the wire, and
// a runner holds two or three. A process that opens many — a test suite — accumulates one
// small entry per path.
const custodies = new Map<string, Custody>()
const claims = new Map<string, PathClaim>()

export function openSealedRecord(kind: SealedRecordKind, options: EncryptedStoreOptions): SealedRecordFile {
  const recordPath = path.resolve(String(options.path))
  const keyPath = path.resolve(String(options.keyPath))
  // Pointed at one file, the first save writes ciphertext over the key that was just
  // created and reports success, and nothing can be read back afterwards. Refusing the
  // configuration is the only outcome that does not destroy the record it was given.
  //
  // Comparing spellings is not enough: a symlink, or a case-insensitive filesystem, gives
  // one file two names that differ as strings. The paths are compared as written for the
  // obvious case, and by file identity once they exist.
  if (recordPath === keyPath) throw new Error(`the ${kind} and its key must be different files`)
  claim(kind, recordPath, keyPath)
  const custody = custodyFor(keyPath)
  return {
    serialize: operation => serialize(custody, operation),
    // Checked inside each operation rather than fired off at construction: a detached
    // promise that rejects takes the process down instead of failing the call that cared.
    read: async () => {
      await assertDistinctFiles()
      return await readSealed(custody, recordPath)
    },
    write: value => writeSealed(custody, recordPath, value),
  }
}

// Both paths are checked before either is recorded, so a configuration that is refused
// leaves nothing half-claimed for the next opener to trip over.
function claim(kind: SealedRecordKind, recordPath: string, keyPath: string) {
  const onRecord = claims.get(recordPath)
  if (onRecord?.role === 'key') throw new Error(`the ${kind} and a ${KEY_FILE} must be different files`)
  if (onRecord?.role === 'record' && onRecord.kind !== kind) throw new Error(`the ${kind} and the ${onRecord.kind} must be different files`)
  // The same record under a second key file: each write re-encrypts it under a key the other
  // store cannot read, so whichever wrote last becomes the only one that can open it.
  if (onRecord?.role === 'record' && onRecord.keyPath !== keyPath) throw new Error(`the ${kind} is already open under a different ${KEY_FILE}`)
  const onKey = claims.get(keyPath)
  if (onKey?.role === 'record') throw new Error(`a ${KEY_FILE} and the ${onKey.kind} must be different files`)
  claims.set(recordPath, { role: 'record', kind, keyPath })
  claims.set(keyPath, { role: 'key' })
}

function custodyFor(keyPath: string): Custody {
  const existing = custodies.get(keyPath)
  if (existing) return existing
  const custody: Custody = { keyPath, queue: Promise.resolve() }
  custodies.set(keyPath, custody)
  return custody
}

function serialize<T>(custody: Custody, operation: () => Promise<T>): Promise<T> {
  const result = custody.queue.then(operation, operation)
  // The queue only sequences; a failed operation reports to its own caller.
  custody.queue = result.catch(() => {})
  return result
}

// Spelling is settled when a path is claimed; this is the other half, and it is deferred
// rather than done at construction because the files usually do not exist yet. A symlink, a
// hard link or a case-insensitive filesystem gives one file two names that no comparison of
// strings can catch, so identity is asked of the filesystem as soon as there is a file to
// ask about — across every claim in the process, since the collisions that corrupt most are
// the ones between stores that were configured separately.
//
// Grouped by identity rather than compared pairwise: one pass, and the number of claims is
// the only thing it grows with.
async function assertDistinctFiles() {
  const targets = [...claims.entries()]
  // A file that does not exist yet cannot alias another; absence is the answer here.
  const identities = await Promise.all(targets.map(([target]) => stat(target).catch(() => null)))
  const byIdentity = new Map<string, PathClaim>()
  for (const [index, entry] of targets.entries()) {
    const info = identities[index]
    const claimed = entry[1]
    if (!info) continue
    const identity = `${info.dev}:${info.ino}`
    const previous = byIdentity.get(identity)
    if (previous && !oneStore(previous, claimed)) throw new Error(`${labelOf(previous)} and ${labelOf(claimed)} resolve to the same file`)
    byIdentity.set(identity, claimed)
  }
}

// The one case where two names for a single file is not a collision: the same store opened
// twice under two spellings, which is what a second handle to it looks like. A key against a
// record, two record kinds, or one record kind under two key files are each the corruption
// this check exists to find.
function oneStore(one: PathClaim, other: PathClaim) {
  if (one.role === 'key' || other.role === 'key') return one.role === other.role
  return one.kind === other.kind && one.keyPath === other.keyPath
}

function labelOf(claimed: PathClaim) {
  return claimed.role === 'key' ? `the ${KEY_FILE}` : `the ${claimed.kind}`
}

async function readSealed(custody: Custody, recordPath: string): Promise<unknown | null> {
  const raw = await readIfPresent(recordPath)
  if (raw === null) return null
  // Parsed before the key is opened. Only readCustodiedKey closes the descriptor, so a
  // malformed record throwing between the open and the read leaked one per attempt.
  const record = parseRecord(raw)
  const handle = await openIfPresent(custody.keyPath)
  if (!handle) throw new Error(`the key file is missing: ${custody.keyPath}`)
  return safeJson(unseal(record, await readCustodiedKey(handle, custody.keyPath)).toString('utf8'))
}

async function writeSealed(custody: Custody, recordPath: string, value: unknown) {
  await assertDistinctFiles()
  const key = await loadOrCreateKey(custody.keyPath)
  // Re-checked after the key exists: two differently-spelled paths that did not exist a
  // moment ago can resolve to one file once the key file is created.
  await assertDistinctFiles()
  const record = seal(Buffer.from(JSON.stringify(value), 'utf8'), key)
  await writeAtomically(recordPath, Buffer.from(JSON.stringify(record), 'utf8'))
}

export function createEncryptedPairingStore(options: EncryptedStoreOptions): PairingStore {
  const file = openSealedRecord('pairing binding', options)
  const current = async () => {
    const stored = await file.read()
    return stored === null ? null : decodeBinding(stored)
  }
  return {
    load: () => file.serialize(current),
    save: (binding, expectedToken) => file.serialize(async () => {
      if (expectedToken !== undefined) {
        const stored = await current()
        // A missing record is not a match. Treating absence as agreement let a late
        // settlement recreate a binding that had been deliberately removed.
        if (!stored || stored.token !== expectedToken) return
        // Nor is a revoked one. A settlement that lost the queue to endBinding would
        // otherwise write its pre-revocation copy back and erase the revocation, after
        // which clients retry a token the account deliberately retired.
        if (stored.revokedAt !== undefined) return
      }
      await file.write(binding)
    }),
    markRevoked: (revokedAt, expectedToken) => file.serialize(async () => {
      const stored = await current()
      if (!stored || stored.revokedAt) return
      if (expectedToken !== undefined && stored.token !== expectedToken) return
      await file.write({ ...stored, revokedAt })
    }),
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
    throw new Error('the stored record failed authentication: it was tampered with, or the key does not match')
  }
}

function parseRecord(raw: Buffer): SealedRecord {
  const parsed = safeJson(raw.toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null) throw new Error('the stored record is not a sealed record')
  const record = parsed as Record<string, unknown>
  if (record.v !== RECORD_VERSION) throw new Error(`unsupported record version: ${String(record.v)}`)
  const { nonce, tag, body } = record
  if (!isBase64(nonce, NONCE_BYTES) || !isBase64(tag, TAG_BYTES) || typeof body !== 'string') {
    throw new Error('the stored record is not a sealed record')
  }
  return { v: RECORD_VERSION, nonce, tag, body }
}

function decodeBinding(parsed: unknown): RunnerBinding {
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
// one of them holding a record it can no longer open.
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
  if (!handle) throw new Error(`could not create the key file: ${keyPath}`)
  return await readCustodiedKey(handle, keyPath)
}

async function openIfPresent(keyPath: string) {
  try {
    return await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    if (code === 'ELOOP') throw new Error(`key path is a symbolic link: ${keyPath}`)
    throw error
  }
}

async function readCustodiedKey(handle: FileHandle, keyPath: string) {
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`key path is not a regular file: ${keyPath}`)
    if (info.uid !== process.getuid?.()) throw new Error(`key file is not owned by this user: ${keyPath}`)
    if ((info.mode & 0o077) !== 0) {
      throw new Error(`key file is readable by other users (mode ${(info.mode & 0o777).toString(8)}): ${keyPath}`)
    }
    return assertKey(await handle.readFile(), keyPath)
  } finally {
    await handle.close()
  }
}

function assertKey(key: Buffer, keyPath: string) {
  if (key.length !== KEY_BYTES) throw new Error(`key file must hold ${KEY_BYTES} bytes: ${keyPath}`)
  return key
}

// Rename is atomic within a directory, so a crash mid-write leaves the previous record
// intact rather than a truncated one nothing can open.
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
  // here would report that the record was not saved when it demonstrably was — which
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
    throw new Error('the stored record is not valid JSON')
  }
}

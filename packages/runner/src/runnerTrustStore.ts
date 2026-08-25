import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { isSafeIdentifier } from '@modulastack/runner-protocol'
import {
  allowlistKeyId,
  decodeSignedAllowlist,
  trustSignedAllowlist,
  type AllowlistSigningKey,
  type SignedAllowlist,
  type TrustAnchor,
} from './allowlist.js'
import type {
  RunnerHomeFailure,
  RunnerHomeStorage,
  RunnerPolicyReplace,
  RunnerPolicySnapshot,
  RunnerPolicyStore,
  RunnerTrustAuthorization,
  RunnerTrustReplace,
} from './runnerHome.js'

const TRUST_SCHEMA_VERSION = 1
const MAX_TRUST_ANCHORS = 16
const MAX_TRUST_RECORD_BYTES = 256 * 1024
const TOMBSTONE = { schemaVersion: 2, migratedTo: 'policy.trust.json' } as const
const PENDING_TOMBSTONE_SCHEMA_VERSION = 3

type StoredTrustPolicy = {
  schemaVersion: typeof TRUST_SCHEMA_VERSION
  revision: number
  anchors: readonly TrustAnchor[]
  allowlist: SignedAllowlist
}

type HeldTrustPolicy = { value: RunnerPolicySnapshot; sha256: string }

export class RunnerTrustError extends Error {
  constructor(readonly failure: RunnerHomeFailure) {
    super(failure)
    this.name = 'RunnerTrustError'
  }
}

export function createRunnerTrustStore(storage: RunnerHomeStorage): RunnerPolicyStore {
  return {
    snapshot: async () => (await readTrust(storage)).value,
    replace: async (expectedRevision, candidate) => await replaceAllowlist(storage, expectedRevision, candidate),
    rotateTrust: async (expectedRevision, anchors, authorization) => (
      await rotateTrust(storage, expectedRevision, anchors, authorization)
    ),
  }
}

export async function initializeRunnerTrust(
  storage: RunnerHomeStorage,
  candidate: RunnerPolicySnapshot,
): Promise<'initialized' | 'exact-existing' | 'conflict'> {
  const requested = validateTrustPolicy({ ...candidate, revision: 1 })
  const held = await storage.read('trust')
  if (held.status === 'found') {
    const existing = decodeTrust(held.bytes)
    await ensurePolicyTombstone(storage)
    return sameRunnerPolicy(existing, requested) ? 'exact-existing' : 'conflict'
  }
  if (held.status === 'storage-unavailable') unavailable()
  const legacy = await storage.read('policy')
  if (legacy.status === 'storage-unavailable') unavailable()
  const initial = legacy.status === 'found'
    ? await stageLegacyMigration(storage, legacy, requested)
    : requested
  if (!initial) return 'conflict'
  const stored = await storage.replace('trust', null, encodeTrust(initial))
  if (stored.status === 'storage-unavailable') unavailable()
  if (stored.status === 'conflict') {
    const winner = await readTrust(storage)
    await ensurePolicyTombstone(storage)
    return sameRunnerPolicy(winner.value, initial) ? 'exact-existing' : 'conflict'
  }
  await ensurePolicyTombstone(storage)
  return 'initialized'
}

export async function openRunnerTrust(storage: RunnerHomeStorage): Promise<RunnerPolicyStore> {
  const store = createRunnerTrustStore(storage)
  const held = await storage.read('trust')
  if (held.status === 'storage-unavailable') unavailable()
  if (held.status === 'missing') {
    const legacy = await storage.read('policy')
    if (legacy.status === 'storage-unavailable') unavailable()
    throw new RunnerTrustError(legacy.status === 'found' ? 'policy-trust-migration-required' : 'policy-missing')
  }
  decodeTrust(held.bytes)
  await ensurePolicyTombstone(storage)
  return store
}

export function createTrustRotationAuthorization(
  current: RunnerPolicySnapshot,
  nextAnchors: readonly TrustAnchor[],
  key: AllowlistSigningKey,
): RunnerTrustAuthorization {
  const normalized = validateAnchors(nextAnchors)
  const privateKey = createPrivateKey({ key: key.privateKey, format: 'pem' })
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('trust signing keys must use Ed25519')
  const derivedKeyId = allowlistKeyId(createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString())
  if (derivedKeyId !== key.keyId) throw new Error('trust signing key id does not match its public key')
  const signature = sign(null, rotationMessage(current, normalized), privateKey).toString('base64')
  return { keyId: derivedKeyId, signature }
}

export function decodeTrustAnchors(raw: string): readonly TrustAnchor[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  try {
    return validateAnchors(parsed)
  } catch {
    return null
  }
}

async function replaceAllowlist(
  storage: RunnerHomeStorage,
  expectedRevision: number,
  candidate: Omit<RunnerPolicySnapshot, 'revision'>,
): Promise<RunnerPolicyReplace> {
  const current = await readTrust(storage)
  if (current.value.revision !== expectedRevision) return { status: 'conflict', current: current.value }
  if (canonicalJson(candidate.trustAnchors) !== canonicalJson(current.value.trustAnchors)) {
    throw new RunnerTrustError('policy-trust-unauthorized')
  }
  const next = validateTrustPolicy({ ...candidate, revision: expectedRevision + 1 })
  return await writeTrust(storage, current, next)
}

async function rotateTrust(
  storage: RunnerHomeStorage,
  expectedRevision: number,
  anchors: readonly TrustAnchor[],
  authorization: RunnerTrustAuthorization,
): Promise<RunnerTrustReplace> {
  const current = await readTrust(storage)
  const nextAnchors = validateAnchors(anchors)
  if (canonicalJson(nextAnchors) === canonicalJson(current.value.trustAnchors)) {
    return { status: 'updated', policy: current.value }
  }
  if (current.value.revision !== expectedRevision) return { status: 'conflict', current: current.value }
  if (trustSignedAllowlist(current.value.allowlist, nextAnchors).status !== 'trusted') return { status: 'unauthorized' }
  const anchor = current.value.trustAnchors.find(candidate => candidate.keyId === authorization.keyId)
  if (!anchor || !validRotationAuthorization(current.value, nextAnchors, anchor, authorization)) {
    return { status: 'unauthorized' }
  }
  const next = validateTrustPolicy({
    revision: current.value.revision + 1,
    allowlist: current.value.allowlist,
    trustAnchors: nextAnchors,
  })
  const written = await writeTrust(storage, current, next)
  return written.status === 'updated'
    ? { status: 'updated', policy: written.policy }
    : written.status === 'conflict'
      ? written
      : { status: 'storage-unavailable' }
}

async function writeTrust(
  storage: RunnerHomeStorage,
  current: HeldTrustPolicy,
  next: RunnerPolicySnapshot,
): Promise<RunnerPolicyReplace> {
  const stored = await storage.replace('trust', current.sha256, encodeTrust(next))
  if (stored.status === 'written') return { status: 'updated', policy: next }
  if (stored.status === 'storage-unavailable') return { status: 'storage-unavailable' }
  return { status: 'conflict', current: (await readTrust(storage)).value }
}

async function readTrust(storage: RunnerHomeStorage): Promise<HeldTrustPolicy> {
  const held = await storage.read('trust')
  if (held.status === 'storage-unavailable') unavailable()
  if (held.status === 'missing') throw new RunnerTrustError('policy-missing')
  return { value: decodeTrust(held.bytes), sha256: held.sha256 }
}

function decodeTrust(bytes: Uint8Array): RunnerPolicySnapshot {
  if (bytes.byteLength > MAX_TRUST_RECORD_BYTES) malformed()
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    malformed()
  }
  if (!exactRecord(parsed, ['allowlist', 'anchors', 'revision', 'schemaVersion'])) malformed()
  if (parsed.schemaVersion !== TRUST_SCHEMA_VERSION) malformed()
  if (canonicalJson(parsed.anchors) !== canonicalJson(validateAnchors(parsed.anchors))) malformed()
  const policy = validateTrustPolicy({
    revision: parsed.revision,
    allowlist: parsed.allowlist,
    trustAnchors: parsed.anchors,
  })
  if (!Buffer.from(bytes).equals(Buffer.from(encodeTrust(policy)))) malformed()
  return policy
}

function validateTrustPolicy(value: unknown): RunnerPolicySnapshot {
  if (!exactRecord(value, ['allowlist', 'revision', 'trustAnchors'])) malformed()
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) malformed()
  if (!exactRecord(value.allowlist, ['allowlist', 'keyId', 'signature'])) malformed()
  if (!validAllowlistShape(value.allowlist.allowlist)) malformed()
  const allowlist = decodeSignedAllowlist(JSON.stringify(value.allowlist))
  if (!allowlist || !canonicalSignature(allowlist.signature)) malformed()
  const trustAnchors = validateAnchors(value.trustAnchors)
  const trusted = trustSignedAllowlist(allowlist, trustAnchors)
  if (trusted.status === 'untrusted') {
    const failure = trusted.reason === 'unknown-key' ? 'policy-unknown-key' : 'policy-bad-signature'
    throw new RunnerTrustError(failure)
  }
  return { revision: value.revision as number, allowlist, trustAnchors }
}

function validateAnchors(value: unknown): readonly TrustAnchor[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TRUST_ANCHORS) malformed()
  const anchors = value.map(candidate => {
    if (!exactRecord(candidate, ['keyId', 'publicKey'])) malformed()
    if (!isSafeIdentifier(candidate.keyId) || typeof candidate.publicKey !== 'string' || candidate.publicKey.length < 1 || candidate.publicKey.length > 16_384) malformed()
    let derived: string
    try {
      derived = allowlistKeyId(candidate.publicKey)
    } catch {
      malformed()
    }
    if (candidate.keyId !== derived) malformed()
    return { keyId: candidate.keyId, publicKey: candidate.publicKey }
  })
  const sorted = [...anchors].sort((left, right) => left.keyId.localeCompare(right.keyId))
  if (new Set(sorted.map(anchor => anchor.keyId)).size !== sorted.length) malformed()
  return sorted
}

async function stageLegacyMigration(
  storage: RunnerHomeStorage,
  legacy: { bytes: Uint8Array; sha256: string },
  requested: RunnerPolicySnapshot,
): Promise<RunnerPolicySnapshot | null> {
  const pending = decodePendingMigration(legacy.bytes)
  if (pending) return sameAnchors(pending, requested) ? pending : null
  const migrated = validateTrustPolicy({ ...migrateLegacy(legacy.bytes, requested), revision: 1 })
  const staged = await storage.replace('policy', legacy.sha256, encodePendingMigration(migrated))
  if (staged.status === 'storage-unavailable') unavailable()
  if (staged.status === 'written') return migrated
  const winner = await storage.read('policy')
  if (winner.status === 'storage-unavailable') unavailable()
  if (winner.status === 'missing') return null
  const winnerPending = decodePendingMigration(winner.bytes)
  if (winnerPending) return sameAnchors(winnerPending, requested) ? winnerPending : null
  const trustWinner = await storage.read('trust')
  if (trustWinner.status === 'storage-unavailable') unavailable()
  if (trustWinner.status === 'missing') return null
  return sameRunnerPolicy(decodeTrust(trustWinner.bytes), migrated) ? migrated : null
}

function encodePendingMigration(policy: RunnerPolicySnapshot): Uint8Array {
  return Buffer.from(`${canonicalJson({
    migratedTo: 'policy.trust.json',
    pendingTrust: Buffer.from(encodeTrust(policy)).toString('base64'),
    schemaVersion: PENDING_TOMBSTONE_SCHEMA_VERSION,
  })}\n`, 'utf8')
}

function decodePendingMigration(bytes: Uint8Array): RunnerPolicySnapshot | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    return null
  }
  if (!exactRecord(parsed, ['migratedTo', 'pendingTrust', 'schemaVersion'])) return null
  if (parsed.migratedTo !== 'policy.trust.json' || parsed.schemaVersion !== PENDING_TOMBSTONE_SCHEMA_VERSION) return null
  if (typeof parsed.pendingTrust !== 'string') return null
  const decoded = Buffer.from(parsed.pendingTrust, 'base64')
  if (decoded.toString('base64') !== parsed.pendingTrust) return null
  try {
    const policy = decodeTrust(decoded)
    return Buffer.from(bytes).equals(Buffer.from(encodePendingMigration(policy))) ? policy : null
  } catch {
    return null
  }
}

export function sameRunnerPolicy(left: RunnerPolicySnapshot, right: RunnerPolicySnapshot): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function sameAnchors(left: RunnerPolicySnapshot, right: RunnerPolicySnapshot): boolean {
  return canonicalJson(left.trustAnchors) === canonicalJson(right.trustAnchors)
}

function validAllowlistShape(value: unknown): boolean {
  if (!exactRecord(value, ['executables', 'recipes']) || !exactRecord(value.recipes, Object.keys(value.recipes as object))) return false
  for (const recipe of Object.values(value.recipes as Record<string, unknown>)) {
    if (!exactRecord(recipe, ['args', 'command'])) return false
  }
  return true
}

function migrateLegacy(bytes: Uint8Array, candidate: RunnerPolicySnapshot): RunnerPolicySnapshot {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    malformed()
  }
  if (!parsed || typeof parsed !== 'object') malformed()
  const allowlist = decodeSignedAllowlist(JSON.stringify((parsed as Record<string, unknown>).allowlist))
  if (!allowlist || candidate.trustAnchors.length !== 1) malformed()
  const migrated = { revision: 1, allowlist, trustAnchors: candidate.trustAnchors }
  return validateTrustPolicy(migrated)
}

async function ensurePolicyTombstone(storage: RunnerHomeStorage): Promise<void> {
  const bytes = Buffer.from(`${canonicalJson(TOMBSTONE)}\n`, 'utf8')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const held = await storage.read('policy')
    if (held.status === 'storage-unavailable') unavailable()
    if (held.status === 'found' && Buffer.from(held.bytes).equals(bytes)) return
    const result = await storage.replace('policy', held.status === 'found' ? held.sha256 : null, bytes)
    if (result.status === 'written') return
    if (result.status === 'storage-unavailable') unavailable()
  }
  unavailable()
}

function validRotationAuthorization(
  current: RunnerPolicySnapshot,
  nextAnchors: readonly TrustAnchor[],
  anchor: TrustAnchor,
  authorization: RunnerTrustAuthorization,
): boolean {
  if (!canonicalSignature(authorization.signature)) return false
  try {
    return verify(
      null,
      rotationMessage(current, nextAnchors),
      createPublicKey({ key: anchor.publicKey, format: 'pem' }),
      Buffer.from(authorization.signature, 'base64'),
    )
  } catch {
    return false
  }
}

function rotationMessage(current: RunnerPolicySnapshot, nextAnchors: readonly TrustAnchor[]): Buffer {
  return Buffer.from([
    'modula-runner-policy-trust-rotation-v1',
    current.revision.toString(),
    sha256(encodeTrust(current)),
    sha256(Buffer.from(canonicalJson(nextAnchors), 'utf8')),
    sha256(Buffer.from(canonicalJson(current.allowlist), 'utf8')),
  ].join('\n'), 'utf8')
}

function encodeTrust(policy: RunnerPolicySnapshot): Uint8Array {
  const stored: StoredTrustPolicy = {
    schemaVersion: TRUST_SCHEMA_VERSION,
    revision: policy.revision,
    anchors: policy.trustAnchors,
    allowlist: policy.allowlist,
  }
  const bytes = Buffer.from(`${canonicalJson(stored)}\n`, 'utf8')
  if (bytes.byteLength > MAX_TRUST_RECORD_BYTES) malformed()
  return bytes
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value as Record<string, unknown>).sort()
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
}

function canonicalSignature(value: string): boolean {
  try {
    return Buffer.from(value, 'base64').byteLength === 64 && Buffer.from(value, 'base64').toString('base64') === value
  } catch {
    return false
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function malformed(): never {
  throw new RunnerTrustError('policy-malformed')
}

function unavailable(): never {
  throw new RunnerTrustError('state-io-failed')
}

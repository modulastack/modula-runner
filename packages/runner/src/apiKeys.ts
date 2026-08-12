import { hasControlCharacter, isSafeIdentifier } from '@modulastack/runner-protocol'
import { openSealedRecord, type EncryptedStoreOptions } from './identityStore.js'
import { SecretEnv } from './secretEnv.js'

// API keys the operator hands the runner, held under the same custody the pairing binding
// already has: AES-256-GCM with a fresh nonce per write, a separate 32-byte key file, 0600
// on both, exclusive creation, atomic publish, fsync before the rename and on the
// directory, and ownership checked on the descriptor that is read rather than on the path.
// One implementation of that machinery serves both record kinds — a second encrypted store
// would be a second set of those decisions to get right, and the one that drifts is the one
// nobody is looking at.
//
// The honest limit is the same one identityStore states: this defends against casual
// disclosure and silent tampering, not against a local attacker running as this user.
//
// What crosses the seam from here is a label and a last-four fingerprint. Never the key.

export const MAX_KEY_LABELS = 64
export const LAST_FOUR_LENGTH = 4
// Short enough to be a mistake rather than a credential. A fingerprint is only meaningful
// if the key behind it has enough material that four characters do not describe it.
export const MIN_API_KEY_LENGTH = 16
export const MAX_API_KEY_LENGTH = 4096
// A provider name is the stem of an environment variable, so the grammar is the
// intersection of what a vendor is called and what an environment can carry — not a
// superset of either. A dot is the case that proved the point: it looks like a reasonable
// vendor name (`amazon.bedrock`), and a variable name cannot contain one, so a store that
// accepted it stored a key that no profile could ever load and reported success.
//
// One definition, called from all three places that care — the store on the way in, the
// profile assertion, and the derivation below. Two validators that must agree eventually
// will not; one cannot disagree with itself.
const PROVIDER_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

export function assertProviderName(provider: string) {
  if (!PROVIDER_NAME.test(String(provider))) {
    throw new Error('a provider name must start with a letter and hold only letters, digits, dash or underscore')
  }
  return provider
}

// Uppercased with hyphens as underscores, so `anthropic` reads ANTHROPIC_API_KEY and
// `openai` reads OPENAI_API_KEY — right for every vendor worth naming, and no table to
// drift out of date.
//
// The fixed suffix is load-bearing rather than cosmetic: every derived name ends in
// `_API_KEY`, so no provider name an operator can choose will ever produce `PATH`,
// `LD_PRELOAD`, or anything else the loader or the shell reads. Operator-chosen text
// cannot become an arbitrary variable, by construction rather than by validation.
export function keyVariableFor(provider: string) {
  return `${assertProviderName(provider).toUpperCase().replace(/-/g, '_')}_API_KEY`
}

export type ApiKeyRecord = {
  // Operator-chosen, and the name a profile binds to. A safe identifier because it reaches
  // the filesystem in the record and a surface as a label.
  label: string
  // Which vendor the key is for, so a profile cannot inject a key meant for another.
  provider: string
  lastFour: string
  createdAt: string
  // Removal is recorded, not erased — the same rule revoked bindings follow. Destroying the
  // record would also destroy the evidence the key ever existed, which the local audit log
  // needs, and would let a re-add silently reuse a label an operator retired.
  removedAt?: string
}

export type NewApiKey = {
  label: string
  provider: string
  secret: string
}

// What an injection can answer, so the provider check and the sealing are one operation
// rather than two. A caller that reads the record, compares the provider, and then asks for
// the key has a window: a rotation landing inside it injects the new vendor's key under the
// old vendor's variable, into a launch validated against the old vendor — which is exactly
// the disclosure the provider check exists to prevent.
export type KeyInjection =
  | { status: 'injected'; secrets: SecretEnv }
  | { status: 'missing' }
  | { status: 'provider-mismatch' }

export type ApiKeyStore = {
  // Metadata only, in every case. There is no API on this store that returns a key.
  list(): Promise<ApiKeyRecord[]>
  get(label: string): Promise<ApiKeyRecord | null>
  put(entry: NewApiKey): Promise<ApiKeyRecord>
  remove(label: string): Promise<void>
  // The plaintext path, and it does not hand back a string: the stored secret is sealed
  // straight into an injectable value bound to the caller's variable name. Null when the
  // label is unknown or removed — an absent key is refused by name upstream, never resolved
  // to a different one.
  //
  // Use this only where no provider is being asserted. A launch always asserts one, and must
  // use `injectAsForProvider` so the assertion and the seal cannot be split.
  injectAs(label: string, variable: string): Promise<SecretEnv | null>
  // The same door with the provider check inside it. One operation, so nothing can rotate
  // between deciding the key is the right vendor's and sealing it.
  injectAsForProvider(label: string, provider: string, variable: string): Promise<KeyInjection>
}

export type ApiKeyStoreOptions = EncryptedStoreOptions

// The record as it is stored. The plaintext half never leaves this module: `list` and `get`
// project it down to the metadata, and `injectAs` seals it into a value with no getter.
type StoredKey = ApiKeyRecord & { secret?: string }

type Persistence = {
  serialize<T>(operation: () => Promise<T>): Promise<T>
  read(): Promise<StoredKey[]>
  write(entries: StoredKey[]): Promise<void>
}

export function createEncryptedApiKeyStore(options: ApiKeyStoreOptions): ApiKeyStore {
  const file = openSealedRecord('API key store', options)
  return apiKeyStore({
    serialize: operation => file.serialize(operation),
    read: async () => decodeEntries(await file.read()),
    write: entries => file.write({ entries }),
  })
}

export function createMemoryApiKeyStore(): ApiKeyStore {
  let entries: StoredKey[] = []
  let queue: Promise<unknown> = Promise.resolve()
  return apiKeyStore({
    serialize: operation => {
      const result = queue.then(operation, operation)
      // The queue only sequences; a failed operation reports to its own caller.
      queue = result.catch(() => {})
      return result
    },
    read: async () => entries.map(entry => ({ ...entry })),
    write: async next => {
      entries = next.map(entry => ({ ...entry }))
    },
  })
}

// One set of rules over two persistences. The rules are the part that has to be right —
// which labels may be reused, what a removal leaves behind, where the plaintext may go —
// so they are written once and the storage is what varies.
function apiKeyStore(persistence: Persistence): ApiKeyStore {
  const find = (entries: StoredKey[], label: string) => entries.find(entry => entry.label === label) ?? null
  return {
    list: () => persistence.serialize(async () => (await persistence.read()).map(metadataOf)),
    get: label => persistence.serialize(async () => {
      const existing = find(await persistence.read(), label)
      return existing === null ? null : metadataOf(existing)
    }),
    put: entry => persistence.serialize(async () => {
      const stored = withStoredKey(await persistence.read(), validatedKey(entry))
      await persistence.write(stored.entries)
      return metadataOf(stored.record)
    }),
    remove: label => persistence.serialize(async () => {
      const entries = await persistence.read()
      const existing = find(entries, label)
      if (!existing) throw new Error(`this runner holds no key with that label: ${label}`)
      if (existing.removedAt !== undefined) return
      // The record stays and the plaintext goes: the evidence is the metadata, and keeping
      // the key behind a removal flag would leave a credential the operator believes is
      // gone. A pane already running keeps what it was given — that value is in its own
      // environment, and the runner cannot reach in.
      const removed: StoredKey = { ...metadataOf(existing), removedAt: new Date().toISOString() }
      await persistence.write(entries.map(item => (item.label === label ? removed : item)))
    }),
    injectAs: (label, variable) => persistence.serialize(async () => {
      const usable = usableKey(await persistence.read(), label)
      return usable === null ? null : SecretEnv.of({ [variable]: usable.secret })
    }),
    injectAsForProvider: (label, provider, variable) => persistence.serialize(async () => {
      const usable = usableKey(await persistence.read(), label)
      if (usable === null) return { status: 'missing' }
      // Compared inside the operation that seals the key, never before it. Split across two
      // calls, a rotation landing in between would hand the new vendor's key to a launch
      // that was validated against the old vendor — a credential disclosed to a third party.
      if (usable.provider !== provider) return { status: 'provider-mismatch' }
      return { status: 'injected', secrets: SecretEnv.of({ [variable]: usable.secret }) }
    }),
  }
}

// A record that can still be injected: present, not removed, and holding plaintext. One
// definition, so both doors open on the same rule rather than two spellings of it.
function usableKey(entries: StoredKey[], label: string) {
  const existing = entries.find(entry => entry.label === label)
  if (!existing || existing.removedAt !== undefined || existing.secret === undefined) return null
  return { ...existing, secret: existing.secret }
}

// What the record list becomes when a key is stored, separated from how it is persisted
// because this is where the rules live: one active record per label, a rotation in place,
// and a retired label that stays retired.
function withStoredKey(entries: StoredKey[], candidate: NewApiKey) {
  const existing = entries.find(entry => entry.label === candidate.label)
  // A retired label is not reusable. The record is the evidence the key existed, and a
  // silent re-add would make a later reading of the audit trail ambiguous about which key
  // `work` was at the time — so the operator picks a new name rather than the runner
  // quietly reissuing an old one.
  if (existing?.removedAt !== undefined) throw new Error(`that key label was removed and cannot be reused: ${candidate.label}`)
  if (!existing && entries.length >= MAX_KEY_LABELS) throw new Error(`this runner holds the most key records it will store (${MAX_KEY_LABELS})`)
  const record: StoredKey = {
    label: candidate.label,
    provider: candidate.provider,
    lastFour: lastFourOf(candidate.secret),
    // Rotation replaces the key, so the timestamp describes the key that is stored now
    // rather than the first one this label ever held.
    createdAt: new Date().toISOString(),
    secret: candidate.secret,
  }
  return { record, entries: existing ? entries.map(entry => (entry.label === record.label ? record : entry)) : [...entries, record] }
}

// Derived at store time from the plaintext, so nothing downstream needs the key to render
// a fingerprint. A key shorter than the minimum is refused rather than fingerprinted.
export function lastFourOf(secret: string): string {
  if (typeof secret !== 'string' || secret.length < MIN_API_KEY_LENGTH) {
    throw new Error(`an API key must be at least ${MIN_API_KEY_LENGTH} characters for its last four to be a fingerprint rather than the key`)
  }
  return secret.slice(-LAST_FOUR_LENGTH)
}

function metadataOf(entry: StoredKey): ApiKeyRecord {
  const record: ApiKeyRecord = { label: entry.label, provider: entry.provider, lastFour: entry.lastFour, createdAt: entry.createdAt }
  return entry.removedAt === undefined ? record : { ...record, removedAt: entry.removedAt }
}

function validatedKey(entry: NewApiKey): NewApiKey {
  if (!isSafeIdentifier(entry.label)) throw new Error('a key label must be a safe identifier: letters, digits, dot, dash or underscore')
  assertProviderName(entry.provider)
  const secret = entry.secret
  if (typeof secret !== 'string' || secret.length < MIN_API_KEY_LENGTH || secret.length > MAX_API_KEY_LENGTH) {
    throw new Error(`an API key must be between ${MIN_API_KEY_LENGTH} and ${MAX_API_KEY_LENGTH} characters`)
  }
  // A control character in a key is a paste accident — a trailing newline, a smuggled CR —
  // and it would ride into an environment that no real provider key needs it in.
  if (hasControlCharacter(secret)) throw new Error('an API key must not contain control characters')
  return { label: entry.label, provider: entry.provider, secret }
}

// Strict, and the whole file fails rather than the unreadable entry being skipped: a record
// this runner cannot fully read is a record it cannot reason about, and quietly dropping an
// entry would make a key disappear rather than say so.
function decodeEntries(stored: unknown): StoredKey[] {
  if (stored === null) return []
  if (typeof stored !== 'object' || !Array.isArray((stored as { entries?: unknown }).entries)) {
    throw new Error('the stored API keys are not a record this runner can read')
  }
  return (stored as { entries: unknown[] }).entries.map(decodeEntry)
}

function decodeEntry(value: unknown): StoredKey {
  const entry = value as Record<string, unknown>
  if (typeof entry !== 'object' || entry === null) throw new Error('a stored API key record is not an object')
  const { label, provider, lastFour, createdAt, removedAt, secret } = entry
  if (!isSafeIdentifier(label) || !PROVIDER_NAME.test(String(provider))) throw new Error('a stored API key record is incomplete')
  if (typeof lastFour !== 'string' || lastFour.length !== LAST_FOUR_LENGTH) throw new Error('a stored API key record is incomplete')
  if (typeof createdAt !== 'string' || createdAt.length === 0) throw new Error('a stored API key record is incomplete')
  const record: StoredKey = { label, provider: provider as string, lastFour, createdAt }
  // Presence, not truthiness, and each half is checked on its own: a removed record has no
  // secret and a live one has no removal, and neither may be inferred from the other.
  if (removedAt !== undefined) {
    if (typeof removedAt !== 'string' || removedAt.length === 0) throw new Error('a stored API key record is incomplete')
    return { ...record, removedAt }
  }
  if (typeof secret !== 'string' || secret.length === 0) throw new Error('a stored API key record is incomplete')
  return { ...record, secret }
}

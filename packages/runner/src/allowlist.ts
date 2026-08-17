import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto'
import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isSafeIdentifier } from '@modulastack/runner-protocol'

// The command allowlist is the runner's local floor: the set of executables the runner will
// ever spawn, and the preview recipes it will run. It ships signed and is editable only
// locally — the control plane can name a recipe or a pane command, but it can never add one.
// That guarantee is structural on two sides: no wire frame carries an allowlist entry
// (schema, "What never crosses this wire"), and the file the runner trusts is the only source
// of the policy, verified here against a locally configured Ed25519 trust anchor before a
// single executable from it becomes spawnable.
//
// Signed, not encrypted: the operator reads and edits this file, so its secrecy is not the
// property that matters — its authenticity is. An Ed25519 detached signature over a canonical
// serialization answers the one question the floor depends on: did the holder of the trust
// anchor's private key approve exactly these executables? A file that fails that question is
// not honored, and the runner reports an unverifiable local policy rather than falling back to
// a default no operator chose.

// The base executables the runner ships trusting. Panes run these; git/tmux are the runner's
// own machinery. Preview commands are not here — they are recipes, carried in the signed
// document alongside this set, because a dev server's command is operator-configured and a
// base runtime is not.
export const DEFAULT_ALLOWLIST_EXECUTABLES: readonly string[] = ['claude', 'codex', 'pi', 'goose', 'git', 'gh', 'tmux']

// A recipe is the whole command line for a preview, held locally and named on the wire but
// never supplied by it. Allowlisting an executable while accepting its arguments from a peer
// is not an allowlist — `node` plus a caller-controlled argv is arbitrary execution — so the
// args live inside the signed document with the command.
export type PreviewRecipe = {
  command: string
  args: readonly string[]
}

// The allowlist document: what the signature covers. The executable set governs panes and the
// runner's own machinery; the recipes govern previews. Grants (which directories) are a
// separate, mutable, operator-managed concern (per-directory consent) and are deliberately not
// signed here — they change at project-binding time, not at release time.
export type Allowlist = {
  executables: readonly string[]
  recipes: Readonly<Record<string, PreviewRecipe>>
}

// The on-disk envelope: the document plus a detached signature over its canonical form and the
// id of the anchor expected to verify it. The key id is not trust — it selects which anchor to
// check against, and an anchor the runner does not hold makes the file untrusted, never
// honored on the strength of a name it carries about itself.
export type SignedAllowlist = {
  allowlist: Allowlist
  keyId: string
  // Base64 Ed25519 signature over `canonicalAllowlistBytes(allowlist)`.
  signature: string
}

// A trust anchor the runner is locally configured to accept. The public half only; the private
// key that signs edits is held by whoever the operator's trust model authorizes, never by the
// runner at rest.
export type TrustAnchor = {
  keyId: string
  // PEM-encoded SPKI Ed25519 public key.
  publicKey: string
}

// The signing authority for the local re-sign flow: an operator who edits the allowlist
// re-signs it with a private key whose public half is a configured trust anchor. This is what
// makes "editable only locally" and "signed" the same sentence rather than opposing ones.
export type AllowlistSigningKey = {
  keyId: string
  // PEM-encoded PKCS8 Ed25519 private key.
  privateKey: string
}

// Why a file is not trusted. Errors are values here, not exceptions: an untrusted allowlist is
// an expected condition the caller audits and refuses on, never a throw that could be caught
// and swallowed into a silent default. Each reason is distinct because the operator's remedy
// differs — a missing file is set up, a bad signature is investigated.
export type AllowlistRejection = 'missing' | 'malformed' | 'unknown-key' | 'bad-signature'

// The verified policy the spawn seam consults. Deep by intent: callers ask a yes/no question
// about an executable or fetch a recipe by id, and never see the set representation or the
// verification that produced it. There is no method that adds to it — the policy is immutable
// once loaded, which is the runtime half of "the control plane cannot extend the allowlist".
export interface CommandPolicy {
  allowsExecutable(name: string): boolean
  recipe(id: string): PreviewRecipe | null
  readonly executables: readonly string[]
  readonly keyId: string
}

// The load outcome: a trusted policy, or a named rejection. `loadTrustedAllowlist` never
// throws for an untrusted file — an unsigned, tampered, or foreign-signed allowlist resolves
// to `untrusted` with a reason, so the caller fails closed by construction instead of relying
// on a catch it might forget.
export type AllowlistLoad =
  | { status: 'trusted'; policy: CommandPolicy }
  | { status: 'untrusted'; reason: AllowlistRejection }

const MAX_ALLOWLIST_BYTES = 64 * 1024

export type LoadAllowlistOptions = {
  path: string
  trustAnchors: readonly TrustAnchor[]
}

// Read, verify, and classify a signed allowlist file. The order is load-bearing: nothing from
// the document becomes policy until the signature verifies against a held anchor, so a
// tampered `executables` list is rejected as a whole rather than partially honored. Each step
// resolves to a distinct rejection because the operator's remedy differs, and none of them
// throws — an untrusted allowlist is a value the caller audits and refuses on.
export async function loadTrustedAllowlist(options: LoadAllowlistOptions): Promise<AllowlistLoad> {
  const raw = await readBounded(options.path)
  if (raw === null) return { status: 'untrusted', reason: 'missing' }
  const signed = decodeSignedAllowlist(raw)
  if (signed === null) return { status: 'untrusted', reason: 'malformed' }
  // The key id selects which anchor must verify; it is not itself trust. An anchor the runner
  // does not hold makes the file untrusted, never honored on the strength of the name it
  // carries about the key that signed it.
  const anchor = options.trustAnchors.find(candidate => candidate.keyId === signed.keyId)
  if (!anchor) return { status: 'untrusted', reason: 'unknown-key' }
  if (!verifyAllowlistSignature(signed, anchor)) return { status: 'untrusted', reason: 'bad-signature' }
  return { status: 'trusted', policy: commandPolicy(signed.allowlist, anchor.keyId) }
}

// The immutable policy a verified document becomes. `executables` is frozen and the membership
// test reads a private set, so a caller that mutates the exposed array — the shape a
// compromised path would try — changes nothing the seam consults. There is no method that adds
// to the policy: extension is a new file, verified again, not a call.
function commandPolicy(allowlist: Allowlist, keyId: string): CommandPolicy {
  const normalized = normalizeAllowlist(allowlist)
  const executables = Object.freeze([...normalized.executables])
  const allowed = new Set(executables)
  const recipes = normalized.recipes
  return {
    allowsExecutable: name => allowed.has(name),
    recipe: id => {
      // Own-property only: a control-plane recipe id is untrusted, and a bare lookup would
      // resolve inherited names like `toString` to a Function whose `.args` spread then throws —
      // a remote denial of service. An unknown recipe is null, never a prototype member.
      const found = Object.prototype.hasOwnProperty.call(recipes, id) ? recipes[id] : undefined
      return found ? { command: found.command, args: [...found.args] } : null
    },
    executables,
    keyId,
  }
}

// The local re-sign flow. An operator edits the document and re-signs it with a key whose
// public half is a configured anchor; the result is what they write back. This is a pure
// function of the document and the key — no filesystem, no ambient state — so it is equally
// the runner's ops helper and a test's fixture tool.
export function signAllowlist(allowlist: Allowlist, key: AllowlistSigningKey): SignedAllowlist {
  const privateKey = createPrivateKey({ key: key.privateKey, format: 'pem' })
  const signature = cryptoSign(null, canonicalAllowlistBytes(allowlist), privateKey)
  return { allowlist: normalizeAllowlist(allowlist), keyId: key.keyId, signature: signature.toString('base64') }
}

// Verify a signed envelope against one anchor's public key. Separated from loading so the
// cryptographic question — does this signature match this document under this key — is one
// testable primitive, reused by the loader and available to fixtures.
export function verifyAllowlistSignature(signed: SignedAllowlist, anchor: TrustAnchor): boolean {
  try {
    const publicKey = createPublicKey({ key: anchor.publicKey, format: 'pem' })
    return cryptoVerify(null, canonicalAllowlistBytes(signed.allowlist), publicKey, Buffer.from(signed.signature, 'base64'))
  } catch {
    // A malformed key or signature is a verification failure, not a crash: the caller's answer
    // is the same either way — this file is not trusted.
    return false
  }
}

// The exact bytes the signature covers. Signing and verifying must serialize identically or a
// faithful copy would fail its own signature, so the form is canonical: object keys sorted at
// every level, recipes and their args in declared-but-normalized order, no incidental
// whitespace. A second serializer that "looks the same" is the classic drift bug, so there is
// exactly one, called from both sign and verify.
export function canonicalAllowlistBytes(allowlist: Allowlist): Buffer {
  return Buffer.from(canonicalJson(normalizeAllowlist(allowlist)), 'utf8')
}

function normalizeAllowlist(allowlist: Allowlist): Allowlist {
  const recipes: Record<string, PreviewRecipe> = {}
  for (const [id, recipe] of Object.entries(allowlist.recipes)) {
    recipes[id] = { command: recipe.command, args: [...recipe.args] }
  }
  return { executables: [...allowlist.executables], recipes }
}

// Deterministic JSON: keys sorted, arrays preserved. Enough for the allowlist's shape (strings,
// string arrays, and a string→recipe map) and no more — a general canonicalizer would be
// surface this file does not need.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

// Strict decode of the on-disk envelope. A structurally invalid file is `malformed`, never a
// throw and never a partial read: the loader's contract is a classification, and a record the
// runner cannot fully parse is a policy it cannot reason about.
export function decodeSignedAllowlist(raw: string): SignedAllowlist | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const { allowlist, keyId, signature } = parsed as Record<string, unknown>
  if (typeof keyId !== 'string' || keyId.length === 0 || typeof signature !== 'string' || signature.length === 0) return null
  const document = decodeAllowlist(allowlist)
  if (document === null) return null
  return { allowlist: document, keyId, signature }
}

function decodeAllowlist(value: unknown): Allowlist | null {
  if (!value || typeof value !== 'object') return null
  const { executables, recipes } = value as Record<string, unknown>
  if (!Array.isArray(executables) || !executables.every(name => typeof name === 'string' && name.length > 0)) return null
  if (!recipes || typeof recipes !== 'object' || Array.isArray(recipes)) return null
  const decodedRecipes: Record<string, PreviewRecipe> = {}
  for (const id of Object.keys(recipes as Record<string, unknown>)) {
    if (!isSafeIdentifier(id)) return null
    const recipe = (recipes as Record<string, unknown>)[id]
    if (!recipe || typeof recipe !== 'object') return null
    const { command, args } = recipe as Record<string, unknown>
    if (typeof command !== 'string' || command.length === 0) return null
    if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) return null
    decodedRecipes[id] = { command, args: args as string[] }
  }
  return { executables: executables as string[], recipes: decodedRecipes }
}

async function readBounded(path: string): Promise<string | null> {
  let handle
  try {
    // O_NONBLOCK so opening a FIFO named at the path returns rather than blocking for a writer:
    // a policy the runner cannot read as a bounded regular file is no policy, not a stall.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    const stat = await handle.stat()
    // Only a regular file within the ceiling is an allowlist: a FIFO or device would stream
    // unbounded, a directory reads as EISDIR. A size over the ceiling is refused up front.
    if (!stat.isFile() || stat.size > MAX_ALLOWLIST_BYTES) return null
    // Read at most the ceiling + 1, never the size the stat reported: a file enlarged between the
    // stat and the read must not pull an unbounded amount into memory. More than the ceiling — a
    // file that grew past it after the check — is refused rather than truncated into a policy.
    const buffer = Buffer.allocUnsafe(MAX_ALLOWLIST_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > MAX_ALLOWLIST_BYTES) return null
    return buffer.subarray(0, length).toString('utf8')
  } catch {
    // A path that opens but cannot be read as a bounded regular file — a directory (EISDIR), an
    // I/O error — is no trusted allowlist, not a crash: the loader reports errors as values
    // (an untrusted `missing`/`malformed` load), and must never throw into its caller.
    return null
  } finally {
    // A failure to close a descriptor already read from does not change the result and must not
    // replace it with a throw.
    await handle.close().catch(() => undefined)
  }
}

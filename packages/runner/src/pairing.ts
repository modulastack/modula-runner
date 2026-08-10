import { validateHeaderValue } from 'node:http'
import { isSafeIdentifier, type RunnerInfo } from '@modulastack/runner-protocol'
import { assertSecureControlPlaneUrl } from './secureUrl.js'

// Pairing is the one place in the runner where caller-controlled input meets a minted
// credential, so the trust boundary is stated here rather than left to each call site.
//
// A pairing code is a short-lived, single-use bearer capability. It proves only that an
// operator signed into the control plane authorized a new binding; it carries no identity
// of its own and does not authenticate the machine. Local operator presence is the
// authorization: a code enters the runner exactly one way, through the local CLI. The
// runner never accepts one over the wire, because it has no inbound path and pairing does
// not get to invent one. Redemption is outbound; what comes back authenticates one
// WebSocket and nothing else, and never appears inside a frame.

const PAIR_PATH = '/api/runner/v1/pair'
const CONFIRM_PATH = '/api/runner/v1/pair/confirm'
const MAX_TOKEN_LENGTH = 4096
const MAX_CODE_LENGTH = 128
const MAX_RESPONSE_BYTES = 64 * 1024
// 'unreachable' is the only failure worth another attempt; the rest are the account's answer.
const TERMINAL_CONFIRM_FAILURES: readonly PairingFailure[] = ['expired-code', 'invalid-code', 'refused']
const REDEEM_TIMEOUT_MS = 15_000

export const PAIRING_FAILURES = ['invalid-code', 'expired-code', 'unreachable', 'refused', 'malformed-response', 'store-failed', 'settle-failed', 'superseded'] as const
export type PairingFailure = (typeof PAIRING_FAILURES)[number]

export type BindingState = 'unpaired' | 'pending' | 'paired' | 'revoked'

export type RunnerBinding = {
  runnerId: string
  controlPlaneUrl: string
  token: string
  pairedAt: string
  revokedAt?: string
  // Set while a binding has been minted and stored but not yet confirmed to the control
  // plane. A binding with no `pendingSince` is settled — which is also what a binding
  // written before two-phase existed looks like, so old records stay usable.
  pendingSince?: string
}

export type PairRequest = {
  controlPlaneUrl: string
  code: string
  runner: RunnerInfo
}

// Persistence is a port so the encrypted on-disk store and an in-memory test double are
// the same shape. Revocation is recorded, not erased: destroying the record would also
// destroy the evidence that the binding ever existed, which the local audit log needs.
export type PairingStore = {
  load(): Promise<RunnerBinding | null>
  // `expectedToken`, when given, makes the write conditional: it applies only if the
  // stored binding is still the one the caller read. A settlement that completed while a
  // newer binding was installed would otherwise overwrite a live credential with a stale
  // one it had been holding across a network round trip.
  save(binding: RunnerBinding, expectedToken?: string): Promise<void>
  // `expectedToken`, when given, makes the revocation conditional: it applies only if the
  // stored binding is still the one the caller means to end.
  markRevoked(revokedAt: string, expectedToken?: string): Promise<void>
}

export class PairingError extends Error {
  constructor(readonly failure: PairingFailure, message: string) {
    super(message)
    this.name = 'PairingError'
  }
}

function unpairedMessage(state: Exclude<BindingState, 'paired'>) {
  if (state === 'revoked') return 'this runner\'s access was revoked; pair again to reconnect'
  if (state === 'pending') return 'this pairing was never confirmed; run status to resume it'
  return 'this runner is not paired'
}

export class UnpairedError extends Error {
  constructor(readonly state: Exclude<BindingState, 'paired'>) {
    super(unpairedMessage(state))
    this.name = 'UnpairedError'
  }
}

export class RunnerIdentity {
  constructor(private readonly store: PairingStore) {}

  // Redeems the code outbound and persists the minted binding. Rejects with a
  // PairingError naming the failure; a runner that cannot pair says why rather than
  // retrying into the same wall.
  // A code is single-use, so a save that fails after redemption strands an active binding
  // at the control plane that no retry of the spent code can recover. The runner cannot
  // clean that up: there is no revoke endpoint to call, and inventing one this checkpoint
  // cannot test would be a shape the control-plane slice then has to honour or break.
  //
  // So this fails honestly instead of pretending. The runner stays unpaired, the operator
  // is told exactly what happened, and the fix is a hosted contract: redemption must be
  // two-phase — mint a pending binding, persist it locally, confirm activation, and expire
  // whatever is never confirmed. Recorded as a hard requirement in SCHEMA, not a note.
  // Two-phase, in the order that makes a crash survivable: the token is durable before
  // activation is claimed. A control plane that expires unconfirmed bindings can then
  // reclaim anything this runner failed to store, and the single-use code is never spent
  // on a binding nobody holds.
  async pair(request: PairRequest): Promise<RunnerBinding> {
    const minted = await redeemPairingCode(request)
    const pending: RunnerBinding = { ...minted, pendingSince: new Date().toISOString() }
    try {
      await this.store.save(pending)
    } catch (error) {
      throw new PairingError(
        'store-failed',
        `paired with the control plane but could not save the binding locally, so this runner is still unpaired: ${messageOf(error)}`,
      )
    }
    return await this.confirm(pending)
  }

  // Resumes a confirmation interrupted by a restart. The token is already on disk, so the
  // only thing missing is telling the control plane it landed.
  async resumeConfirmation(): Promise<RunnerBinding | null> {
    const binding = await this.store.load()
    if (!binding || binding.revokedAt || !binding.pendingSince) return binding && !binding.revokedAt ? binding : null
    return await this.confirm(binding)
  }

  // A confirmation the control plane will never accept must stop being retried. Only a
  // failure that could succeed later keeps the binding pending; anything terminal ends it,
  // so status tells the operator to pair again rather than retrying a token that is gone.
  private async confirm(binding: RunnerBinding) {
    try {
      await confirmPairing(binding)
    } catch (error) {
      if (error instanceof PairingError && TERMINAL_CONFIRM_FAILURES.includes(error.failure)) {
        await this.store.markRevoked(new Date().toISOString(), binding.token)
      }
      throw error
    }
    const settled: RunnerBinding = { ...binding }
    delete settled.pendingSince
    try {
      await this.store.save(settled, binding.token)
      // A conditional write that did not apply is not an error and is not a success: the
      // binding this call was settling has been replaced, and reporting it as current
      // would hand back a credential that is no longer the runner's.
      const current = await this.store.load()
      // Revoked or still pending counts as replaced: a concurrent endBinding between the
      // write and this read leaves the same token on disk in a terminal state, and
      // returning it would hand back a binding that is no longer usable.
      if (!current || current.token !== binding.token || current.revokedAt !== undefined || current.pendingSince !== undefined) {
        throw new PairingError('superseded', 'this pairing was replaced by a newer one before it could be settled')
      }
    } catch (error) {
      if (error instanceof PairingError) throw error
      // The control plane has activated this binding; only the local record failed to
      // catch up. Pairing again would mint a second binding and overwrite the one usable
      // record of the first, so the guidance is to resume, not to re-pair — which is why
      // the schema requires confirmation to be idempotent.
      throw new PairingError(
        'settle-failed',
        `the pairing was activated but could not be recorded as settled; run status to resume it rather than pairing again: ${messageOf(error)}`,
      )
    }
    return settled
  }

  // One read, both answers. Asking for the binding and then for the state was two reads
  // with a settlement able to land between them, and every ordering of the retry still
  // had a case that reported unpaired over a usable credential.
  async snapshot(): Promise<{ state: BindingState; binding: RunnerBinding | null }> {
    const binding = await this.store.load()
    if (!binding) return { state: 'unpaired', binding: null }
    if (binding.revokedAt !== undefined) return { state: 'revoked', binding: null }
    if (binding.pendingSince !== undefined) return { state: 'pending', binding: null }
    return { state: 'paired', binding }
  }

  async state(): Promise<BindingState> {
    const binding = await this.store.load()
    if (!binding) return 'unpaired'
    // Presence, not truthiness: an empty string is a set field, and reading it as absent
    // made a revoked binding report as paired and hand back a usable token.
    if (binding.revokedAt !== undefined) return 'revoked'
    return binding.pendingSince !== undefined ? 'pending' : 'paired'
  }

  // The usable binding, or null when unpaired or revoked. A revoked binding is never
  // returned as usable, so no caller can dial with a token the account has disowned.
  // An unconfirmed binding is not usable: the control plane may still expire it, and
  // dialing with a token it is about to reclaim would look like revocation.
  async current(): Promise<RunnerBinding | null> {
    const binding = await this.store.load()
    if (!binding || binding.revokedAt !== undefined || binding.pendingSince !== undefined) return null
    return binding
  }

  // Terminal for the binding. Called when the control plane refuses the token, which is
  // what revocation looks like from here — not a transient error to back off from.
  // `expectedToken` names which binding is being ended. A client outliving its own
  // binding could otherwise revoke whatever is stored now, so a stale rejection arriving
  // after the operator paired again would revoke the new binding instead of the dead one.
  async endBinding(expectedToken?: string): Promise<void> {
    // Straight to the store: reading first, then deciding, put an await between the check
    // and the mutation, and a client rebuilt in that gap would dial with the very token
    // this call exists to retire. The store's own queue makes the conditional atomic.
    await this.store.markRevoked(new Date().toISOString(), expectedToken)
  }
}

// The redemption call itself, separated so the CLI and any future setup surface share one
// implementation of the outbound half of the handshake.
export async function redeemPairingCode(request: PairRequest): Promise<RunnerBinding> {
  const base = assertSecureControlPlaneUrl(request.controlPlaneUrl)
  const endpoint = new URL(PAIR_PATH, base)
  const response = await postRedemption(endpoint, request)
  if (!response.ok) throw new PairingError(failureForStatus(response.status), `pairing refused (${response.status})`)
  return bindingFromResponse(await readJson(response), base)
}

async function postRedemption(endpoint: URL, request: PairRequest) {
  try {
    return await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: assertRedeemableCode(request.code), runner: request.runner }),
      // A 307 or 308 preserves the method and body, so a followed redirect would replay a
      // live pairing code to wherever it points — including plaintext. Only the origin the
      // operator typed gets to see the code.
      redirect: 'error',
      signal: AbortSignal.timeout(REDEEM_TIMEOUT_MS),
    })
  } catch (error) {
    if (error instanceof PairingError) throw error
    throw new PairingError('unreachable', `could not reach the control plane: ${messageOf(error)}`)
  }
}

// The body is read through a cap rather than parsed whole. A useful pairing response is a
// few hundred bytes; without a byte bound an endpoint or an intermediary could make the
// runner allocate and parse an arbitrarily large one, and the request timeout bounds
// duration, not volume.
async function readJson(response: Response): Promise<unknown> {
  const text = await readCapped(response)
  try {
    return JSON.parse(text)
  } catch {
    throw new PairingError('malformed-response', 'the control plane did not answer with JSON')
  }
}

async function readCapped(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new PairingError('malformed-response', 'the pairing response was larger than this runner will read')
      chunks.push(value)
    }
  } finally {
    // Releasing the stream; the outcome the caller waits on has already been decided.
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks).toString('utf8')
}

// The response shape this runner expects. CV-1: no control-plane implementation exists
// yet, so this is a proposal for that slice rather than a settled contract, and it is
// validated strictly here so a drifting server fails loudly instead of half-pairing.
function bindingFromResponse(body: unknown, base: URL): RunnerBinding {
  if (typeof body !== 'object' || body === null) throw new PairingError('malformed-response', 'pairing response was not an object')
  const { runnerId, token } = body as Record<string, unknown>
  if (!isSafeIdentifier(runnerId)) throw new PairingError('malformed-response', 'pairing response carried no usable runner id')
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    throw new PairingError('malformed-response', 'pairing response carried no usable token')
  }
  // The token's only job is to ride an Authorization header, so it is validated against
  // that rule here. Persisting one the client will later refuse would report a successful
  // pairing whose every connection attempt throws before it dials.
  try {
    validateHeaderValue('authorization', `Bearer ${token}`)
  } catch {
    throw new PairingError('malformed-response', 'pairing response carried a token that cannot be sent as a credential')
  }
  return { runnerId, token, controlPlaneUrl: base.origin, pairedAt: new Date().toISOString() }
}

// Phase two. A failure here leaves the binding pending rather than lost: the token is
// already durable, so a later run resumes the confirmation instead of spending a new code.
export async function confirmPairing(binding: RunnerBinding) {
  const base = assertSecureControlPlaneUrl(binding.controlPlaneUrl)
  const endpoint = new URL(CONFIRM_PATH, base)
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${binding.token}` },
      body: JSON.stringify({ runnerId: binding.runnerId }),
      redirect: 'error',
      signal: AbortSignal.timeout(REDEEM_TIMEOUT_MS),
    })
  } catch (error) {
    throw new PairingError('unreachable', `could not confirm the pairing: ${messageOf(error)}`)
  }
  try {
    if (!response.ok) throw new PairingError(confirmFailureForStatus(response.status), `pairing confirmation refused (${response.status})`)
  } finally {
    // Only the status was needed. An unread body holds its connection, and confirmation
    // runs on every start until it succeeds.
    await response.body?.cancel().catch(() => undefined)
  }
}

// A code that cannot be a code never becomes a request: the control plane should not be
// asked to rate-limit what the runner can reject locally.
function assertRedeemableCode(code: string) {
  const trimmed = String(code).trim()
  if (trimmed.length === 0 || trimmed.length > MAX_CODE_LENGTH) throw new PairingError('invalid-code', 'that is not a pairing code')
  return trimmed
}

// Terminal means the control plane DECIDED about this request. Everything else means it
// did not answer yet, and the difference matters because a terminal failure revokes a
// credential — so the question is never "is this an error" but "did anyone actually
// reject us".
//
// The enumeration is of decisions, and the default is retry. It was the other way round,
// which made every status nobody had thought about — a timeout, a proxy's invention, a
// gateway's own opinion — destroy a working binding. Getting a retry wrong costs an
// attempt; getting a revocation wrong costs the pairing.
const DECIDED: Record<number, PairingFailure> = {
  400: 'invalid-code',
  401: 'invalid-code',
  403: 'refused',
  404: 'invalid-code',
  405: 'refused',
  409: 'expired-code',
  410: 'expired-code',
  422: 'refused',
}

function failureForStatus(status: number): PairingFailure {
  return DECIDED[status] ?? 'unreachable'
}

// Confirmation reads 404 differently from redemption. At redemption a 404 is the control
// plane saying it does not know that code; at confirmation it usually means it does not
// know this ROUTE — an older deployment without two-phase pairing. Revoking a credential
// that was minted successfully because the server is behind would destroy a working
// binding over version skew, and the redemption shape is still a proposal (see SCHEMA),
// so the skew is expected rather than hypothetical.
function confirmFailureForStatus(status: number): PairingFailure {
  if (status === 404 || status === 405 || status === 501) return 'unreachable'
  return failureForStatus(status)
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

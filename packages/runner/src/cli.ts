import { hostname } from 'node:os'
import type { ApiKeyStore } from './apiKeys.js'
import type { Grants } from './consent.js'
import { PairingError, type RunnerIdentity } from './pairing.js'
import type { PresenceSnapshot } from './presence.js'

export type CommandResult = {
  exitCode: number
  output: string
}

export type PairCommandContext = {
  identity: RunnerIdentity
  controlPlaneUrl: string
  version: string
  // How a code is obtained when it is not on the command line. Supplied by the caller so
  // the prompt can be a hidden TTY read in the binary and a stub in a test.
  readCode?: () => Promise<string>
  // Supplied when a client is running. Without it status can only speak about the
  // binding, and a paired runner whose socket is dead would read exactly like a healthy
  // one — the silence this command exists to explain.
  presence?: () => PresenceSnapshot | null
}

// `modula-runner pair <code>`. The code arrives here and only here: the local CLI is the
// authorization, so there is no wire path and no inbound listener that could supply one.
//
// Neither the code nor the minted token is ever echoed. Terminal scrollback outlives the
// command, and a capability printed back is a capability in the session log.
export async function runPairCommand(argv: readonly string[], context: PairCommandContext): Promise<CommandResult> {
  // A code on the command line is readable by any local process that can list arguments,
  // which is the same exposure the seam contract already forbids for secrets. A pairing
  // code is a bearer capability, so it gets the same treatment: prompted for by default,
  // and accepted from argv only because FR-6 documents that form — with the exposure said
  // out loud rather than left for the operator to discover.
  const code = argv[0] ?? (context.readCode ? (await context.readCode()).trim() : '')
  if (!code) return { exitCode: 2, output: 'usage: modula-runner pair (a code is prompted for if omitted)' }
  const warning = argv[0] ? '\nnote: a code passed as an argument is visible to other processes on this machine; prefer running `modula-runner pair` and entering it when prompted' : ''
  try {
    const binding = await context.identity.pair({
      controlPlaneUrl: context.controlPlaneUrl,
      code,
      runner: runnerInfo(context.version),
    })
    return { exitCode: 0, output: `paired as runner ${binding.runnerId}${warning}` }
  } catch (error) {
    return { exitCode: 1, output: pairingFailureMessage(error) }
  }
}

// `modula-runner status`. Reports the binding state and, when connected, presence — so a
// revoked runner reads as revoked locally rather than as an unexplained silence.
export async function runStatusCommand(_argv: readonly string[], context: PairCommandContext): Promise<CommandResult> {
  // One read, then a fresh one after any confirmation attempt: reading state and binding
  // separately let a concurrent rejection revoke between them, which reported an
  // unconfirmed pairing for a binding that had actually been retired.
  let snapshot = await context.identity.snapshot()
  // Points at the prompted form, not the argument form this same file warns about.
  if (snapshot.state === 'unpaired') return { exitCode: 0, output: 'unpaired — run: modula-runner pair (you will be prompted for the code)' }
  if (snapshot.state === 'revoked') return { exitCode: 0, output: 'revoked — this runner\'s access was withdrawn; run modula-runner pair to reconnect' }
  // A pending binding holds a real token that only needs its activation confirmed, so
  // status is where that gets retried. Falling through to the paired branch would print
  // "paired as runner unknown" and leave a usable token stranded.
  if (snapshot.state === 'pending') {
    try {
      await context.identity.resumeConfirmation()
    } catch (error) {
      return { exitCode: 1, output: `pairing is unconfirmed and could not be completed: ${error instanceof Error ? error.message : String(error)}` }
    }
    snapshot = await context.identity.snapshot()
    if (snapshot.state === 'revoked') return { exitCode: 0, output: 'revoked — this runner\'s access was withdrawn; run modula-runner pair to reconnect' }
  }
  const binding = snapshot.binding
  if (!binding) return { exitCode: 1, output: 'pairing is unconfirmed; run status again once the control plane is reachable' }
  const where = `paired as runner ${binding.runnerId} to ${binding.controlPlaneUrl}`
  const presence = context.presence?.()
  if (!presence) return { exitCode: 0, output: `${where} — not connected in this process` }
  return { exitCode: 0, output: `${where} — ${presence.state}${sinceSuffix(presence)}` }
}

export type KeyCommandContext = {
  keys: ApiKeyStore
  // A hidden TTY read in the binary, a stub in a test. The same shape pairing uses, for the
  // same reason: the value must not reach the terminal's scrollback.
  readSecret: (prompt: string) => Promise<string>
}

// `modula-runner key add <label> --provider <name>`. The key is prompted for and enters here
// and nowhere else.
//
// FR-11 describes a browser hand-off to a local page. That page would be an inbound
// listener, and this runner does not have one — "it listens on no inbound port" is the
// transport's founding rule, and the schema already says of the pairing code that an inbound
// path "would contradict the outbound-only rule the transport is built on… and there will
// not be one". An API key is a stronger credential than a pairing code, so the argument that
// settled the code settles this too; a loopback listener is also reachable by every process
// on the machine and by any page the operator's browser happens to visit. What FR-11
// actually promises — that the key never transits the control plane — is delivered here in
// full. The criterion was amended rather than the rule bent (docs/model-access.md).
//
// Never accepted as an argument, unlike a pairing code: FR-6 documents the argv form for a
// code, nothing documents it for a key, and arguments are readable by any local process.
// Neither the key nor its fingerprint's source is ever echoed.
export async function runKeyAddCommand(argv: readonly string[], context: KeyCommandContext): Promise<CommandResult> {
  const [label, flag, provider, ...extra] = argv
  if (!label || flag !== '--provider' || !provider || extra.length > 0) return { exitCode: 2, output: KEY_ADD_USAGE }
  // Trimmed because a pasted key carries the newline that submitted it, and a key stored
  // with trailing whitespace fails at the provider with an error nobody can trace back here.
  const secret = (await context.readSecret(`API key for ${label} (${provider}): `)).trim()
  if (!secret) return { exitCode: 2, output: 'no key was entered, so nothing was stored' }
  try {
    const record = await context.keys.put({ label, provider, secret })
    return { exitCode: 0, output: `stored ${record.label} for ${record.provider} (****${record.lastFour})` }
  } catch (error) {
    // The message describes the key's shape, never its content: this line is going to a
    // terminal that keeps scrollback.
    return { exitCode: 1, output: `that key was not stored: ${messageOf(error)}` }
  }
}

// `modula-runner key list`. Labels, providers and last-four only — there is no command, and
// no store method, that prints a key.
export async function runKeyListCommand(_argv: readonly string[], context: KeyCommandContext): Promise<CommandResult> {
  const records = await context.keys.list()
  if (records.length === 0) return { exitCode: 0, output: `no keys stored — add one with: ${KEY_ADD_FORM}` }
  const rows = records.map(record => `${record.label}  ${record.provider}  ****${record.lastFour}${record.removedAt ? '  (removed)' : ''}`)
  return { exitCode: 0, output: rows.join('\n') }
}

// `modula-runner key remove <label>`. Recorded as removed rather than erased, the same rule
// a revoked binding follows. A pane already running keeps the value it was given: it lives
// in that process's own environment and the runner cannot reach in. The kill switch is the
// answer that exists, and saying so is better than implying one that does not.
export async function runKeyRemoveCommand(argv: readonly string[], context: KeyCommandContext): Promise<CommandResult> {
  const [label, ...extra] = argv
  if (!label || extra.length > 0) return { exitCode: 2, output: 'usage: modula-runner key remove <label>' }
  try {
    await context.keys.remove(label)
  } catch (error) {
    return { exitCode: 1, output: messageOf(error) }
  }
  return { exitCode: 0, output: `removed ${label} — a pane already running keeps the key it was given; stop it to take the key out of that process` }
}

// The local grant flow (FR-14): directory consent is added, listed, and revoked from the
// operator's own terminal and nowhere else — there is no wire path to grant a directory, so a
// control plane can name one but never authorize one. A grant governs new work; a pane already
// running was admitted against a live grant and is not reached from here.
export type GrantCommandContext = {
  grants: Grants
}

// `modula-runner grant <dir>`. The path is resolved and stored as its real path, so a later
// containment check compares real paths and a grant does not silently follow a swapped symlink.
export async function runGrantAddCommand(argv: readonly string[], context: GrantCommandContext): Promise<CommandResult> {
  const [dir, ...extra] = argv
  if (!dir || extra.length > 0) return { exitCode: 2, output: 'usage: modula-runner grant <directory>' }
  try {
    const resolved = await context.grants.grant(dir)
    return { exitCode: 0, output: `granted ${resolved}` }
  } catch (error) {
    return { exitCode: 1, output: messageOf(error) }
  }
}

// `modula-runner grant list`. The live grants as real paths, plus an honest note where the
// runner cannot read a running process's cwd back to close the resolve-then-enter window.
export async function runGrantListCommand(_argv: readonly string[], context: GrantCommandContext): Promise<CommandResult> {
  const grants = await context.grants.list()
  const window = context.grants.cwdReadBackAvailable
    ? ''
    : '\nnote: this platform cannot read a running process’s working directory back, so a directory swapped after a grant check is not caught'
  if (grants.length === 0) return { exitCode: 0, output: `no directories granted — add one with: modula-runner grant <directory>${window}` }
  return { exitCode: 0, output: `${grants.join('\n')}${window}` }
}

// `modula-runner grant revoke <dir>`. Governs only later admissions — a pane already running is
// not confined or killed by this, which the message says rather than implying a reach it lacks.
export async function runGrantRevokeCommand(argv: readonly string[], context: GrantCommandContext): Promise<CommandResult> {
  const [dir, ...extra] = argv
  if (!dir || extra.length > 0) return { exitCode: 2, output: 'usage: modula-runner grant revoke <directory>' }
  await context.grants.revoke(dir)
  return { exitCode: 0, output: `revoked ${dir} — new work there is refused; a pane already running keeps going until it exits or the kill switch stops it` }
}

const KEY_ADD_FORM = 'modula-runner key add <label> --provider <name>'
const KEY_ADD_USAGE = `usage: ${KEY_ADD_FORM} (the key itself is prompted for and is never accepted as an argument)`

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function sinceSuffix(snapshot: PresenceSnapshot) {
  const seconds = Math.max(0, Math.round((Date.now() - snapshot.since) / 1000))
  return ` since ${seconds}s ago`
}

function runnerInfo(version: string) {
  return { name: hostname(), version, os: process.platform, arch: process.arch }
}

function pairingFailureMessage(error: unknown) {
  if (!(error instanceof PairingError)) return `pairing failed: ${error instanceof Error ? error.message : String(error)}`
  const guidance: Record<string, string> = {
    'invalid-code': 'that pairing code was not accepted — check it and try again',
    'expired-code': 'that pairing code has expired — get a fresh one and try again',
    unreachable: 'could not reach the control plane',
    refused: 'the control plane refused this pairing',
    'malformed-response': 'the control plane answered with something this runner cannot use',
    'store-failed': 'the binding could not be saved locally, so this runner is still unpaired and that code is spent — get a fresh code',
    superseded: 'a newer pairing replaced this one before it finished — run status to see the current binding',
    'settle-failed': 'the pairing was activated but not recorded as settled — run status to resume it, do not pair again',
  }
  return `pairing failed: ${guidance[error.failure] ?? error.failure}`
}

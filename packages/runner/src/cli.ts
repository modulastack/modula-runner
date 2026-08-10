import { hostname } from 'node:os'
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

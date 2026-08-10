import type { RunnerInfo } from '@modulastack/runner-protocol'
import { RunnerClient, type RunnerClientOptions } from './client.js'
import { UnpairedError, type RunnerIdentity } from './pairing.js'
import { websocketUrlFor } from './secureUrl.js'

export type PairedClientOptions = Omit<RunnerClientOptions, 'url' | 'token' | 'runner'> & {
  runner: RunnerInfo
}

// The binding drives the connection: callers ask for a client for whatever this machine is
// paired to and get the revocation semantics with it, instead of each call site
// remembering that an auth rejection is terminal rather than something to back off from.
//
// Rejects with UnpairedError when there is no usable binding, so an unpaired runner never
// dials with a token the account has disowned.
export async function createPairedClient(identity: RunnerIdentity, options: PairedClientOptions) {
  const { state, binding } = await identity.snapshot()
  if (!binding) throw new UnpairedError(state === 'paired' ? 'unpaired' : state)
  const client = new RunnerClient({ ...options, url: websocketUrlFor(binding.controlPlaneUrl), token: binding.token })
  client.on('auth-failed', () => {
    // The rejection already stopped the client; ending the binding is what stops the next
    // launch from dialing again with the same disowned token. Failure to record it must
    // surface rather than become an unhandled rejection.
    //
    // The revocation names this client's own token. An operator who pairs again while an
    // older client is still alive would otherwise have the old client's late rejection
    // revoke the binding that was just minted.
    identity.endBinding(binding.token).catch(error => client.emit('binding-error', error))
  })
  return client
}

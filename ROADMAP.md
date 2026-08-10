# Roadmap

Gate-driven, not date-driven: items ship when their acceptance tests and security
invariants hold, and this file is updated as they land. The repo is public from its first
commit, and so is this plan.

## Now

- **Tri-modal model access** — the next slice: your CLI subscriptions, your API keys in an
  encrypted local store, or local models on your own hardware, with a capability handshake
  so the interface only offers what your machine actually has. *Not started.*

Landed so far: the seam contract ([`docs/runner-seam.md`](docs/runner-seam.md), reconciled
in [`docs/seam-reconciliation.md`](docs/seam-reconciliation.md)); the versioned protocol
schema ([`packages/protocol`](packages/protocol/SCHEMA.md)) including terminal and
job-control channel payload semantics; the outbound-only WebSocket client with reconnect
continuity; the pty host — agent commands in per-worktree tmux sessions bound to terminal
channels, with scrollback replay, resize, reattach, an acknowledged flow-control window,
and deterministic worktree provisioning; and pairing, presence and preview adjacency —
`modula-runner pair <code>` binding a machine and minting a per-runner token into an
encrypted local store, that token authenticating the socket and nothing else, revocation
ending the binding rather than being retried, presence riding the negotiated heartbeat so
offline is visible within the timeout window, and preview servers whose real listening
sockets are checked before their port is reported and for as long as they run, so one that
strays off loopback is stopped rather than served — all tested against a stub control
plane ([`packages/runner`](packages/runner)).

## The split

The path to a runner that executes real jobs against a hosted control plane:

- [x] **Seam contract, protocol schema, outbound WSS** — the contract documents, the
      versioned frames, and the reconnect-continuity client
- [x] **Pty host + worktree provisioning** behind the wire contract — terminals spawn and
      stream identically whether co-resident or split; see *Now* for what landed
- [x] **Pairing, presence, preview adjacency** — device-code pairing with revocable
      per-runner tokens; online/offline visible, never silent; previews that stray off
      your loopback are detected and stopped; see *Now* for what landed
- [ ] **Tri-modal model access** — your CLI subscriptions, your API keys (encrypted local
      store, env-injected only), or local models via any OpenAI-compatible endpoint;
      capability handshake so the UI only offers what your machine actually has
- [ ] **Security invariants, tested** — command allowlist (signed, locally editable,
      never remotely extendable), per-directory consent, kill switch, append-only local
      audit log, and the test asserting the binary never opens CLI auth paths. Also where
      preview containment lands: today a preview that binds off your loopback is found and
      stopped, and an OS containment unit is what would stop it happening at all
- [ ] **Release engineering** — signed binaries (Sigstore), SBOM per release,
      reproducible builds as a stated goal

**Stop-gate before general availability:** an independent third-party security audit of
the runner and pairing protocol — findings triaged, highs fixed, report published in this
repository. Recurs on major protocol revisions.

## After the split

Future work, each item becoming its own spec before it's built:

- [ ] Install script and a packaged self-host quickstart (`modula-runner pair <code>`)
- [ ] Desktop shell pairing — the co-resident wrap of the same seam
- [ ] Windows support (ConPTY; v1 targets macOS + Linux)
- [ ] End-to-end encryption of terminal streams (protocol frames are designed
      E2E-capable from the start; v1 relays over TLS)
- [ ] Forge event relay — reviews and board updates for LAN-only forges with no inbound
      ports and no webhooks
- [ ] Relay scaling for many concurrent sessions per account
- [ ] Capability advisories — honest warnings when a small local model is bound to a
      judgment-heavy role
- [ ] Memory residency options for split mode — project knowledge staying on your machine

## What will never be on this list

The README's "What the runner will never do" is permanent: no reading CLI auth, no
credential upload, no arbitrary remote commands, no operation without your kill switch.

Issues and questions are welcome.

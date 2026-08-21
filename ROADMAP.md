# Roadmap

Gate-driven, not date-driven: items ship when their acceptance tests and security
invariants hold, and this file is updated as they land. The repo is public from its first
commit, and so is this plan.

## Now

- **Runner verification and pre-audit** — CP-1 through CP-6 implementation is on `main`.
  The next slice is the missing black-box layer: approve the execution plan in
  [`docs/frd-runner-verification.md`](docs/frd-runner-verification.md), package a real
  `modula-runner` executable, exercise A1–A6 through that executable, run the physical
  second-machine and hosted-control-plane journeys, then perform the whole-runner internal
  security audit.
- **Close the artifact/operator gap before those journeys.** CP-6 currently produces a
  reproducible library package and release evidence, but `packages/runner/package.json`
  exposes no `bin` entry and no clean-machine operator install path. Command handlers and
  checkpoint acceptance tests are landed; an installed operator-facing process is not.

Landed so far: the seam contract and versioned protocol; outbound-only WSS reconnect
continuity; pty/tmux hosting and deterministic worktrees; pairing, presence, and preview
adjacency; tri-modal model access; the signed local allowlist, per-directory consent, kill
switch, append-only audit evidence, credential and auth-path protections, and preview
containment; plus the pinned release workflow, reproducible package proof, vulnerability
policy, CycloneDX SBOM reconciliation, Sigstore/provenance wiring, immutable-publication
checks, and independent verification runbook. The full local gate currently covers these
surfaces; it is not a substitute for the assembled CLI journeys below.

Release implementation is not release authorization. No tag or release has been executed.
The clean-execution rule in [issue #23](https://forge.modulastack.com/ModulaStack/modula-runner/issues/23),
the dev-shadowed peer rule in [issue #24](https://forge.modulastack.com/ModulaStack/modula-runner/issues/24),
repository protections, the exclusive-writer publication window, and the audit gates remain
required before a real release.

## The split

The path to a runner that executes real jobs against a hosted control plane:

- [x] **Seam contract, protocol schema, outbound WSS** — the contract documents, the
      versioned frames, and the reconnect-continuity client
- [x] **Pty host + worktree provisioning** behind the wire contract — terminals spawn and
      stream identically whether co-resident or split; see *Now* for what landed
- [x] **Pairing, presence, preview adjacency** — device-code pairing with revocable
      per-runner tokens; online/offline visible, never silent; previews that stray off
      your loopback are detected and stopped; see *Now* for what landed
- [x] **Tri-modal model access** — your CLI subscriptions, your API keys (encrypted local
      store, env-injected only), or local models via any OpenAI-compatible endpoint;
      capability handshake so the UI only offers what your machine actually has. Keys enter
      through the local CLI and never a browser page, because the runner opens no inbound
      port; see *Now* for what landed
- [x] **Security invariants, tested** — signed locally editable allowlist, per-directory
      consent, kill switch, durable append-only audit evidence, no CLI-auth-path guarantee,
      credential boundaries, and namespace-backed preview containment with explicit
      detect-and-stop degradation
- [x] **Release engineering implementation** — pinned toolchain, reproducible library
      package, vulnerability and waiver policy, CycloneDX SBOM, Sigstore/provenance and
      immutable-publication workflow, plus independent verification. No real release has
      been authorized or executed, and executable/installer packaging remains below

**Stop-gate before general availability:** an independent third-party security audit of
the runner and pairing protocol — findings triaged, highs fixed, report published in this
repository. Recurs on major protocol revisions.

## Pre-audit verification

Before that external audit, the split earns two internal passes: the runner exercised end to
end through its installed CLI the way an operator uses it, and an adversarial general and
security review at higher capability than it was built with. Both are scoped in the still-draft
[`docs/frd-runner-verification.md`](docs/frd-runner-verification.md).

The checkpoint implementation prerequisite is now satisfied. Execution is not: first approve
that plan and resolve its assumption that a packaged `modula-runner` executable already
exists; then implement A1–A6, run the physical second-machine and real-control-plane gates,
and complete the internal audit. Findings feed back into the security and release boundaries
before the external audit begins.

## After the split

Future work, each item becoming its own spec before it's built:

- [ ] Installer and self-host quickstart for the verified packaged CLI (`modula-runner pair <code>`)
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

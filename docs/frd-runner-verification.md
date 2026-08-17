# FRD — Runner verification and pre-audit

Status: draft · Owner: runner · Precedes: the external third-party security audit (the GA
stop-gate). Prerequisite: CP-5 merged; CP-6 release artifacts available for the artifact and
install-smoke portions.

## Purpose

The split runner (CP-1…CP-6) is a security-sensitive local agent. Before it goes to an
independent third-party audit, it earns two internal verification passes that this document
scopes but does not perform:

1. **A CLI feature-test suite** — the runner exercised end to end the way an operator uses it,
   through `modula-runner`, against a stub and a real control plane. Unit coverage already
   exists per checkpoint; this is the missing black-box layer that proves the assembled binary
   behaves.
2. **A general + security audit** — an adversarial read of the whole codebase at higher
   capability than it was built with, to find what the build-time reviews could not.

This FRD is the groundwork: it enumerates the tests to write and the audit's required contents.
Writing the tests and performing the audit is the executing pass's work, not this document's.

## Target and non-target

In scope: the shipped runner — CP-1 (seam contract, protocol schema, outbound WSS client),
CP-2 (pty host + worktree provisioning), CP-3 (pairing, presence, preview adjacency), CP-4
(tri-modal model access), CP-5 (security invariants), CP-6 (release engineering artifacts).

Out of scope: the control-plane / platform counterpart (CP-1b); any "after the split" feature
not yet built; the external third-party audit itself (separate engagement, later).

## Part A — CLI feature-test suite

Drive the real `modula-runner` binary; assert observable behaviour, not internal state. A stub
control plane stands in for the WS peer; one scenario (A1) also runs against a second physical
machine, which is a standing first-release gate. Each area lists the behaviours a test must
establish; the executing pass writes the cases, fixtures, and harness.

- **A1 — Pairing and identity (CP-3, CP-5/FR-17).** `pair <code>` binds a machine and mints a
  per-runner token into the encrypted store; `status` reflects unpaired → pending → paired →
  revoked; a revoked binding is not silently retried; re-pair works after revoke. The token
  authenticates only the WS upgrade, and the confirm step sends a token *proof*, not the token.
  Includes the **second-machine** pairing-and-execution run (first-release gate).
- **A2 — Terminal / pty (CP-2).** A pane launches in a per-worktree tmux session; output
  streams; resize, detach, reattach, and kill behave; scrollback replays without loss or
  duplication; the flow-control window is honoured; worktree provisioning is deterministic and
  idempotent; co-resident and split modes are observably identical.
- **A3 — Preview adjacency and containment (CP-3, CP-5).** A loopback preview's port is
  reported and reachable from the runner host; a wildcard-binding preview is unreachable from
  every off-machine address for its whole life on a namespace-capable host, and is detected and
  stopped where containment is unavailable; the local status surface states which posture is
  active; a preview binding more than one port is refused, not guessed.
- **A4 — Tri-modal model access (CP-4).** An API key entered through the CLI is never echoed,
  reaches a child's environment, and appears in no argument vector or log; a local
  OpenAI-compatible endpoint binds and serves; the capability handshake advertises exactly what
  the machine can run and nothing about where anything lives.
- **A5 — Security invariants (CP-5).** A signed allowlist loads and a tampered/foreign/malformed
  one is refused by named reason; the control plane cannot extend the allowlist; per-directory
  consent gates spawns and revocation takes effect; the kill switch severs the connection and
  tears down every visible child, reporting what it could not confirm; every spawn, refusal, and
  kill is a durable append-only audit record; the binary opens no CLI auth path.
- **A6 — Release artifacts (CP-6).** Release signatures verify (Sigstore); an SBOM is present and
  well-formed; a from-release install smoke test on a clean machine reaches a working `pair`.

Deliverables: an automated end-to-end CLI suite (committed), and a written manual script for the
second-machine flow that a stranger can follow.

## Part B — General and security audit

An adversarial review of the whole runner. It must **try to break** each guarantee, not merely
confirm it; every finding carries a concrete failure scenario (inputs → wrong outcome), a
`file:line`, a severity, and a fix, and is verified before it is reported.

- **B1 — Trust model and the "never do" list.** The README's permanent guarantees — no reading
  CLI auth, no credential upload, no arbitrary remote commands, no operation without the kill
  switch — each verified to hold in code, not just in prose. The seam's premise (the control
  plane is untrusted; every frame lands on runner enforcement) checked for trust leaks.
- **B2 — Security by component.** Pairing/token lifecycle, store encryption, token scope,
  revocation. The CP-5 invariants re-audited adversarially — the build-time review already found
  real fail-opens (prototype-inherited recipe ids, grant-scope admitting without consent, a pane
  launched in an unresolved path, an evidence aggregate green on omission, an exit acknowledged
  before its record was durable), so this pass should assume more exist and hunt the same
  classes: prototype pollution, TOCTOU / symlink swaps, fail-open on absent input,
  durability-before-acknowledgement, argument/log credential leaks, wire-frame and
  control-character injection, path traversal. Model-access key handling; preview-containment
  isolation and the forwarder's attack surface; the spawn seam as the single choke point and its
  documented descendant/`setsid` residuals.
- **B3 — Correctness and quality.** Concurrency and races in the pty host, preview host, and
  audit queue; fail-closed posture on every error path; resource management (descriptor and
  process leaks, unbounded growth — the CP-5 review already caught audit amplification from
  routine probes); adherence to the house KISS / design-core rules; dead code; comment hygiene.
- **B4 — Dependencies and supply chain.** Known-vulnerability scan of the dependency tree, the
  minimal-dependency posture, and the release supply-chain story (signing, SBOM, the
  reproducible-build goal).

Deliverable: a severity-ranked audit report published in the repository, with highs triaged and
a punch-list of fixes routed back into CP-5 / CP-6 before the external audit.

## Sequencing

Parts A1–A5 and all of B can run against the current codebase once CP-5 merges. A6 and the
install smoke test need CP-6's release artifacts. This whole pass precedes, and feeds, the
external third-party audit that gates general availability.

## Deliverables (summary)

1. Committed end-to-end CLI feature-test suite + a manual second-machine pairing script.
2. A published, severity-ranked general + security audit report.
3. A fix punch-list feeding CP-5 / CP-6 before the external audit begins.

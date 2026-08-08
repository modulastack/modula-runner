# Seam reconciliation — what moved upstream, and what it means here

*2026-08-09 · input to [`runner-seam.md`](runner-seam.md); written before the first line of
protocol code.*

The runner's seam was specified while the control plane kept shipping. Before this
repository commits to a contract, this note pins the upstream changes that landed after the
seam was first drafted and derives what each one means for the seam and the protocol. The
platform FRD (Z4) carries follow-up conditions on this slice; two shape this document — the
seam definition must reconcile post-draft movement (this note), and protocol frames must be
end-to-end-encryption-capable from the first version (§4).

One rule governs every section: **the same contract must be implementable by the
co-resident deployment (both planes on one host) and the split (planes separated by a
network) from the same document.** A design that only works in one topology is treated as
an error, not a variant.

## 1. Coms residency: the standing peer follows the worktree

**What shipped upstream.** Agent-to-agent coms ride unix domain sockets under a per-user
runtime directory (mode `0700`, ownership- and symlink-verified before use), with socket
paths derived from the pool directory and session id — never hand-constructed — and sender
identity validated against the job worktree. On top of that transport, the control plane
gained a *standing Lead peer*: an in-process coms adapter registered under the canonical
pool name `lead`, holding a registry entry with heartbeats, a bounded inbound queue, and
fail-closed behavior on name collision or registry-ownership loss.

**What pins residency.** Unix sockets do not cross hosts, and the pool validates senders
by worktree containment. Worktrees live on the runner. Therefore, in the split, the coms
pool — sockets, registry, and every peer's attach point, including the standing peer's —
is on the runner host. What does *not* move is the Lead's reasoning loop: it reads and
writes hosted state (boards, plans, ledger) and is control-plane logic.

**Seam consequence.** The standing peer decomposes into an execution-plane **attach
point** (socket server, registry entry, heartbeat, inbound queue — runner-side) and a
hosted **consumer** (the reasoning loop). Between them, coms envelopes travel as their own
message class on the runner's single outbound connection. Co-resident deployments collapse
the two into one process — which is exactly what runs today, so both topologies are the
same contract with a different transport underneath.

**Protocol consequences, effective now:**

- The framing reserves a `coms` channel kind. Its payload semantics are a later slice;
  reserving the class is what keeps the frame layout stable when it arrives.
- Socket-path derivation, directory-ownership checks, and identifier validation stay
  runner-side. The control plane never constructs, sees, or transmits a socket path.
  Identifiers that cross the seam and later touch a filesystem (session ids, peer names)
  are validated as safe path segments on the runner before any such use.
- *Registered* and *listening* are different properties: a peer present in a pool registry
  is not necessarily consuming messages. Presence signals across the seam must be able to
  distinguish "channel exists" from "channel attached and consuming" — collapsing the two
  is misleading enough co-resident and worse over a WAN. Recorded here as a requirement on
  the pty/coms slices.

## 2. Forge provisioning: detect and guide, never bundle

**What was decided upstream (2026-08-08).** Local-forge setup is detect-and-guide: the
runner detects an existing Forgejo/Gitea, compatibility-checks it, and wires it through the
runner's localhost setup flow — URL and token are entered there and stored runner-side
only. The hosted plane holds an opaque binding: a name, a backend kind, a health state.
Never the endpoint, never the token. For operators without a forge, the runner generates
setup material (compose/config tuned for the platform) that the **operator** executes; the
runner health-checks each step but never runs installs and holds no install privileges.
Review-webhook wiring is reachability-based, and every forge/reviewer shape ends in exactly
one of two states: configured-and-verified, or pending-with-reason. Never silently unwired.

**Seam consequences, effective now:**

- Frames that describe a forge binding are **health-shaped, never config-shaped**. The
  schema records the invariant: no frame carries a forge endpoint URL, credential, or
  generated setup material toward the control plane. A LAN-only forge's address is not the
  control plane's business.
- Sensitive setup input rides localhost adjacency — the operator's browser and the runner
  share a machine, so tokens travel browser → runner directly, the same pattern as API-key
  entry. The seam contract lists forge detect/wire/health as execution-plane duties.

## 3. Reviews run on the runner

**What was decided upstream (2026-08-08).** Advisory review rounds execute on the runner:
the code under review never leaves the user's machine, and a hosted reviewer reading
customer code server-side is excluded outright. The findings engine is pluggable — a
built-in reviewer role using the user's own model access, an external reviewer whose
credential stays on the runner, or a self-hosted review stack beside the user's forge.

**Seam consequences:**

- Review execution is an execution-plane job like any other lane — same channel classes,
  no special transport, nothing for the protocol to add.
- The hosted plane orchestrates rounds and stores verdicts and receipts. To be precise
  about what that means: the review *input* — the checkout, the diff — never leaves the
  runner; *findings*, including whatever evidence a reviewer quotes, are orchestration
  artifacts the operator's UI displays, and in the split they transit the relay the same
  way terminal output does — readable by the relay in v1, sealable under §4 once
  end-to-end encryption ships.
- The inbound problem folds in here: review triggers are webhook-shaped, the runner
  accepts no inbound connections, and a LAN-only forge can reach nothing hosted. Direction
  recorded now: forge events reach the reviewer either co-resident (forge and reviewer on
  the same side of the seam — today's self-host shape) or relayed up the runner's outbound
  connection as a reserved `forge-event` message class. Never an inbound port on the
  runner, never a hosted reviewer with the code. The class is reserved in v1 framing; its
  semantics arrive with the forge slices.

## 4. End-to-end-capable frames from v1

**Posture.** Version 1 relays session payloads through the control plane over TLS. The
relay can read what it relays, and hosted-mode product copy must say so plainly until
end-to-end encryption ships. What is non-negotiable now is that shipping it later must be
a key exchange away, not a redesign.

**Design, implemented in the schema now:**

- Every session frame separates **routing** (type, channel, sequence) from **payload**;
  the relay routes on the envelope alone and never needs the payload to do its job.
- Payloads declare a codec. `sealed` is reserved from v1: an opaque envelope (algorithm,
  nonce, ciphertext) meaningful only to the endpoints, meaningless to the relay.
- Control frames the relay must read — handshake, heartbeat, channel lifecycle — are
  cleartext by definition and carry no session content. Everything content-bearing is
  sealable.
- The full statement lives in the protocol package (`SCHEMA.md`, "End-to-end capability").

## Traceability

| Section | Upstream reference |
|---|---|
| §1 | Platform FRD Z4, coms-residency question (Q11 in the slice conditions); shipped coms hub work (platform #391) |
| §2 | Platform FRD Z4 FR-24..FR-25, provisioning-posture PR (platform #463); note the FRD text also numbers this decision Q11 — the collision is why this note tracks both by content |
| §3 | Platform FRD Z4 Q10; product PRD §10 decision of 2026-08-08 |
| §4 | Platform FRD Z4 D2 minimum posture (condition C3) |

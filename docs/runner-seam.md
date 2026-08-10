# The runner seam

*Contract version 1 · 2026-08-09 · reconciled against upstream movement in
[`seam-reconciliation.md`](seam-reconciliation.md).*

This document is the contract between the two planes of Modula Stack: the hosted **control
plane** (the web product) and the local **execution plane** (this runner). It enumerates
what runs where, what travels between them, and what may never travel between them. The
wire-level companion is the versioned protocol schema in
[`packages/protocol`](../packages/protocol/SCHEMA.md).

**One contract, two deployments.** In the *split* deployment the planes are separate
machines joined by a single outbound WebSocket. In the *co-resident* deployment both
planes share one host — the transport collapses to a local connection carrying the same
frames, and every localhost-adjacency assumption below becomes trivially true. Co-resident
is the always-reachable special case of this contract, not a fork of it. Anything that
works in only one topology is a bug in this document.

## Principles

1. **Execution follows the credentials.** Repos, git identity, CLI logins, API keys,
   model endpoints, and forge credentials live on the user's machine, so the work that
   needs them executes there.
2. **Outbound only.** The runner dials one authenticated WebSocket out to the control
   plane. It listens on no inbound port. Everything the control plane wants from the
   runner arrives as a reply on that connection, never as a connection *to* the runner.
3. **The hosted plane holds orchestration state and receipts, never secrets.** Profile
   metadata, board state, round verdicts, presence — yes. Credentials, endpoints, code
   checkouts — no.
4. **Staleness is visible, never silent.** When the runner is offline, hosted surfaces
   say so and say why. Nothing queues silently; nothing serves old data as current.
5. **The relay routes, it does not need to read.** Session payloads are structured so a
   later end-to-end encryption mode changes keys, not frames (schema, "End-to-end
   capability").

## Executes on the runner

| Duty | Notes |
|---|---|
| Pty spawn and hosting | Agent CLIs run in ptys under tmux: scrollback, resize, attach/reattach. The terminal a browser renders is a relayed runner pty. |
| Worktree provisioning | Deterministic worktree + branch creation against local repos. One runner owns the checkouts it provisions: lanes are serialized within the runner, and a failed attempt rolls back only what it still owns, so a contender can never delete a registered lane. Two runner processes sharing one checkout is outside this contract. |
| Git and forge operations | All mutations (clone, branch, push, PR, merge) and the default read path, under local credentials — GitHub or a self-hosted forge, including one on a private network. |
| Forge detect, wire, health | Detects an existing local forge, wires it via the runner's localhost setup flow, health-checks it. Guides new installs; never executes them, holds no install privileges. Config stays local; only opaque health crosses the seam. |
| Model access resolution | Tri-modal, resolved entirely locally: subscription CLIs (their own login), API keys (encrypted local store, injected env-only), local models (any OpenAI-compatible endpoint). The pty host injects only non-secret orchestration variables into a session's environment; secret injection (API keys) is the key store's job (FR-11), delivered through a non-argv mechanism so nothing sensitive is visible in process arguments. |
| Advisory review execution | Review rounds run here; the code under review never leaves the machine. |
| Coms pools | Agent-to-agent coms transport: unix sockets, registries, and standing-peer attach points live beside the worktrees they serve. |
| Preview servers and browser-QA targets | **Detected and terminated off-loopback, not prevented from binding there** — see the schema. Bind to the runner's localhost; the operator's browser is on the same machine (split) or same host (co-resident), so no tunneling. The binding is verified against the process's real listening sockets before its port is reported, because a command is free to bind more than it was configured with. Only the port crosses — a host or URL would be an endpoint. |
| Preview process ownership | Previews are spawned into their own process group, and the runner tracks them by group membership as well as parentage — a wrapper that spawns a detached child and exits leaves that child adopted by init, where no ancestry walk finds it again. A descendant that deliberately calls `setsid` escapes both, and closing that needs an OS containment unit: a cgroup on Linux, with no clean equivalent on macOS. Deferred rather than hidden — the runner's own recipes are the only commands it will start, so the escape requires a recipe the operator installed locally. |
| Preview exposure before verification | A preview is spawned in the host's network namespace, so between spawn and the first successful inspection a recipe that ignores the loopback hint can accept external connections. The window is bounded — readiness polls from 50 ms, the tree is settled before readiness is granted, and the sweep re-checks continuously — but it is not zero, and only OS-level network isolation (a network namespace on Linux, no clean equivalent on macOS) closes it. Deferred and stated rather than implied: the exposure requires a recipe the operator installed locally, since the control plane cannot supply a command line. |
| Preview working directory | The grant is checked on the resolved real path, the command is spawned into that resolved path rather than the caller's, and on Linux the running process's own working directory is read back and re-checked against the grants. A platform without that read-back keeps a narrow window between resolving a path and entering it. |
| Pairing and the runner's own credential | A pairing code enters through the local terminal and no other path — prompted for rather than passed as an argument, since arguments are readable by any local process, the same exposure this contract already forbids for secrets; and is redeemed outbound. The minted per-runner token lives in an encrypted local store and authenticates one WebSocket. Revocation is the control plane refusing the upgrade, which ends the binding rather than starting a retry. |
| The local floor | Command allowlist (ships signed, editable only locally), per-directory consent, kill switch, append-only local audit log. Enforced here, configurable only here. |

## Stays on the control plane

| Duty | Notes |
|---|---|
| Project registry and boards | Projects, jobs, flight plan, presence rendering. |
| Planning surfaces | FRD studio, planner, validation ledger, receipts. |
| Coms hub reasoning | The Lead's reasoning loop and page bots — the *consumers* of coms traffic. Their pool attach points are runner-side (see reconciliation §1). |
| Notifications and admin | Notification fan-out; pairing and token issue/revocation; profile metadata (provider, model, mode, label — plus at most a key's label and last-four fingerprint). |
| The web UI and relay | Serves the browser, relays session frames between browser and runner. |

## The wire between them

One outbound WebSocket over TLS, authenticated by a per-runner token whose only power is
this connection — it can call no other API. On it:

- **Versioned handshake.** The runner opens with a `hello` declaring the protocol
  versions it can speak; the control plane answers `welcome` with the negotiated version
  or `reject` naming what it supports. The control plane supports the current version and
  the one before it (N and N−1), so a runner is never forced to upgrade in lockstep.
- **Heartbeats.** Liveness both ways; a missed window means reconnect (runner side) and
  visible offline state (hosted side).
- **Channels.** All session traffic is multiplexed as channels with a declared kind.
  Version 1 defines `terminal`; `coms`, `forge-event`, and `job-control` are reserved
  (reconciliation §1, §3). Channel payloads are opaque to the relay by design.
- **Reconnect and attach continuity.** Channels survive a dropped connection: each side
  keeps per-channel send/receive sequence numbers and a bounded replay buffer; on
  reconnect the runner presents each channel's id, attach token, and sequence state, and
  the two sides replay exactly the gap. A channel whose gap outruns the buffer, or whose
  attach token fails, is resumed as a reset, visibly — never silently spliced. This
  extends the attach-token machinery the terminal stack already uses; it does not replace
  it.

## Never crosses the seam

Enforced by construction runner-side and stated here so both planes can be tested against
the same list. Toward the control plane, no frame ever carries:

- CLI auth material — the runner never reads it in the first place
- API keys or any model credential; local-model endpoint URLs
- Forge credentials (tokens, SSH keys) or forge endpoint URLs
- Generated forge setup material (compose files, config)
- Repo contents as such — code moves only as session payloads the operator's own
  activity produces (terminal output, review findings), which are exactly the payloads
  the end-to-end capability seals

Toward the runner, no frame ever carries: commands outside the runner's local allowlist,
paths outside granted directories, or any extension of either. The control plane can ask;
the runner refuses and audits.

## What each plane trusts

The runner trusts the control plane to schedule work and relay operator input — nothing
more. A fully compromised control plane can send frames, and every frame lands on the
runner's own enforcement: allowlist, directory consent, kill switch, audit log. It cannot
mint credentials (there are none to mint), cannot extend the allowlist, and cannot reach
a forge the runner doesn't choose to reach.

The control plane trusts the runner with nothing secret: a runner token authenticates one
WebSocket and nothing else.

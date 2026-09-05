# Runner protocol schema

*Protocol version **2** · package `@modulastack/runner-protocol` · consumed by the runner
(this repository) and by the control plane.*

The seam this protocol serves is defined in [`docs/runner-seam.md`](../../docs/runner-seam.md).
This document is the wire-level reference: transport rules, versioning policy, frame
reference, channel model, and the end-to-end-encryption capability the frames are designed
for. The TypeScript types and validators in `src/` are the executable form of this schema;
where prose and code disagree, the code of the negotiated version wins and the prose has a
bug to fix.

## Transport

- One WebSocket per runner, dialed **outbound** by the runner to the control plane. The
  runner listens on nothing.
- TLS (`wss://`) is mandatory except toward loopback addresses (local development and the
  co-resident deployment). The loopback exception is a stated trust boundary, not an
  oversight: on a multi-user host, another local user able to bind the port first could
  read the connection credential, so shared machines must front the control plane with
  TLS even locally — the exception is designed for the single-operator co-resident
  install.
- The per-runner token travels as an `Authorization: Bearer` header on the upgrade
  request. It authenticates this connection and nothing else. It never appears inside a
  frame.
- Pairing is outbound HTTP, not a WebSocket frame. Its adopted contract is
  [`docs/runner-launch-contract.md`](../../docs/runner-launch-contract.md), and its shared
  executable shapes live in `src/pairing.ts`. `POST /api/runner/v1/pair` carries only the
  canonical `<22-character base64url pairing id>.<19-character base64url secret>` code and bounded
  runner metadata; success returns a lowercase UUIDv4 binding id,
  safe runner id, canonical 32-byte base64url bearer token, independent 32-byte nonce, and
  UTC confirmation deadline. `POST /api/runner/v1/pair/confirm` carries the binding/runner
  ids, nonce, and lowercase HMAC proof—never the token.
- Redemption is two-phase, serialized locally, and confirmation is idempotent. A pending
  binding expires after ten minutes. The proof binds the raw token bytes to the binding,
  runner, canonical configured origin, and nonce. Lost redemption cannot retrieve a token;
  lost confirmation replays only the exact stored proof. The pre-contract runner client is
  not evidence of this adopted shape and cannot be wired into the packaged CLI until the
  production implementation checkpoint.
- Revocation is expressed as refusing the upgrade. A `401` or `403` is terminal for the
  binding, not a transient error to back off from: a runner whose access was withdrawn
  stops, says so locally, and does not retry into the same wall.
- Every frame is one WebSocket text message containing one JSON object with a `type`
  field. Maximum encoded size: **1 MiB** (`MAX_FRAME_BYTES`). Oversized or structurally
  invalid frames are dropped by the codec (`decodeFrame` returns `null`); a peer may
  answer with an `error` frame but must not crash or splice. Implementations also
  enforce the cap at the socket layer (the runner sets it as the WebSocket
  `maxPayload`), so an oversized message terminates the connection instead of
  being assembled in memory.
- Identifiers on the wire (`channel`, ping `id`) satisfy the safe-segment rule
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. Identifiers can reach a filesystem on the runner,
  so the wire enforces what the runner would have to enforce anyway.

## Versioning

- The protocol version is a positive integer. `PROTOCOL_VERSION` is the newest version the
  active runtime speaks; `MIN_PROTOCOL_VERSION` is the oldest. `SESSION_LAUNCH_PROTOCOL_VERSION`
  names the first version that carries session launch. It equals the active version now that
  the installed runtime and matching control-plane counterpart are implemented.
- The runner's `hello` offers a contiguous range `{min, max}`. The control plane holds a
  set of supported versions — by policy the current version and the one before it
  (**N and N−1**) — and `negotiate()` picks the highest version in both; the connection
  then speaks exactly that version.
- No overlap → the control plane answers `reject`, naming its supported versions, and
  closes. A reject is terminal: the runner reports it and stops rather than retrying into
  the same wall.
- Version bumps: any change that would make a valid frame invalid, or change the meaning
  of an existing field, bumps the version. Adding a new frame type or a new optional
  field does not; unknown *frame types* are a decode error (each version's frame set is
  closed), so new frame types ship with a version bump, while new optional fields on
  existing frames may ship within a version.
- Validators **discard** unknown fields rather than carrying them: each frame is
  reconstructed from the fields its version defines. A new optional field therefore
  travels only between peers that both know it, which is why such a field must be
  genuinely optional and why its absence has to mean something a peer can act on. It is
  also what makes the no-place-to-put-a-secret guarantee at the end of this document
  structural rather than aspirational — an extra property does not survive decoding.
- **Growing a closed enum whose members cross the wire bumps the version**, for the same
  reason a new frame type does: the receiver rejects the unknown member, so a peer written
  against the older document drops traffic the newer one considers valid. This covers
  channel kinds, refusal reasons, and the capability enums. Payload *message types* are
  not enums in this sense — an unrecognised message parses to null and an endpoint ignores
  it, which is how the terminal and preview job-control payloads shipped inside version 1.
  Session launch deliberately takes the stricter v2 gate: silently ignoring a launch leaves
  an orchestrator unable to distinguish unsupported work from work still pending.

## Frames

### Session establishment

| Frame | Direction | Fields |
|---|---|---|
| `hello` | runner → control plane | `protocol {min, max}` · `runner {name, version, os, arch}` · `channels: ChannelResumeState[]` |
| `welcome` | control plane → runner | `protocol` (the negotiated version) · `heartbeat {intervalMs, timeoutMs}` · `channels: ChannelResumeResult[]` |
| `reject` | control plane → runner | `reason` · `supported: number[]` |

`hello` is the first frame on every connection — first connect and reconnect are the same
handshake, differing only in whether `channels` is empty. `ChannelResumeState` carries
`{id, kind, attachToken, sentSeq, receivedSeq}` per surviving channel; `ChannelResumeResult`
answers each with `{id, status: 'resumed', receivedSeq}` or `{id, status: 'expired'}`.
Rosters with duplicate channel ids are invalid (contradictory entries could replay and
delete the same channel), a resume acknowledgment can never exceed the presented
`sentSeq`, and `runner` metadata fields are bounded at 200 characters each.
Establishment frames are valid only while negotiation is pending: once a connection is
welcomed, rejected, or failed, further `welcome`/`reject` frames are protocol errors.

### Liveness

| Frame | Direction | Fields |
|---|---|---|
| `ping` | both | `id` |
| `pong` | both | `id` (echoed) |

The `welcome.heartbeat` policy governs: a peer that hears nothing for `timeoutMs` treats
the connection as dead. Policy values are bounded by the schema — `intervalMs` is at
least 200 ms, `timeoutMs` is at least twice `intervalMs` (a timeout without margin past
the interval dies to ordinary timer jitter), and both stay within the 32-bit timer
range — so a welcome cannot dictate a busy-loop ping rate or an overflowed timer. The runner reconnects; the control plane marks the runner offline
— visibly, within one heartbeat window.

**The window is `timeoutMs`, not `intervalMs`.** Death is observable no later than
`timeoutMs` after the last accepted traffic, and an implementation must not settle for
noticing it on the next ping tick: polling at `intervalMs` would let a dead connection
look alive for `timeoutMs + intervalMs`, which is a bound neither side agreed to. The
deadline is therefore its own timer. Only accepted protocol traffic refreshes it —
garbage and state-invalid frames are not liveness.

### Channels

| Frame | Direction | Fields |
|---|---|---|
| `open` | runner → control plane | `channel` · `kind` · `attachToken` |
| `data` | both | `channel` · `seq` · `payload` |
| `reset` | both | `channel` · `seq` |
| `close` | both | `channel` · `reason?` |
| `error` | both | `message` · `channel?` |

Channel kinds in version 1: `terminal` and `job-control` are defined, with payload
semantics specified in "Terminal channel payloads" and "Job-control channel payloads"
below; `coms` and `forge-event` are **reserved** — structurally valid on the wire,
semantics specified in later revisions (see the seam reconciliation note for why they
exist now).

## Channel model

- Implementations bound their concurrent channel roster (this repository's client:
  1024) so a resume hello always fits the frame cap.
- The runner mints channel ids and attach tokens at `open`. The attach token is the
  resume credential for that channel — the same machinery terminal sessions already use
  for browser reattach, extended across this seam rather than replaced.
- `data` frames carry a per-channel sequence number, starting at 1, monotonic per
  direction. A receiver accepts exactly the next contiguous sequence: anything at or
  below its high-water mark is a replay duplicate and is ignored (replay idempotence),
  and anything past the next sequence is a protocol violation to surface, not splice
  over — a compliant sender never skips ahead except through an explicit `reset`.
- Senders pause transmission when the socket's buffered bytes exceed a high-water
  mark; paused frames stay in the replay buffer and flush strictly in order, so
  backpressure delays a stream but never breaks its continuity.
- Each side retains a bounded replay buffer of sent `data` frames. On reconnect the
  `welcome`'s `receivedSeq` tells the runner exactly what the control plane missed; the
  runner replays the gap, and vice versa in later revisions when the control plane
  originates data.
- If the gap has outrun the buffer, the sender emits `reset {channel, seq}` — "this
  stream restarts at `seq`; content before it is gone" — then resumes from there.
  Continuity loss is always announced, never silently spliced.
- `status: 'expired'` in the resume result (attach-token mismatch or a channel the
  control plane refuses to adopt) ends the channel; reopening is an application-level
  decision.
- A control plane adopting a channel presented at reconnect seeds its own downstream
  sequence at the presented `receivedSeq`, so its next frame extends the runner's
  inbound stream contiguously instead of reusing already-consumed numbers.
- Resets only move forward: a `reset` whose `seq` does not exceed the receiver's
  high-water mark is rejected, because rewinding would make already-consumed frames
  deliverable again.
- The reconnect hello is the authoritative channel roster: the control plane closes
  any channel the runner no longer presents. A `close` frame lost to a dying
  connection therefore heals at the next reconnect instead of leaving an orphan.
- Close is best-effort after drain in version 1: buffered frames and the close are
  written before the channel drops, but a link that dies mid-flight can still lose
  the final frames along with the close — the roster rule guarantees the channel
  closes, not that its tail was delivered. A generic frame-level acknowledged close
  remains deferred; terminal channels do not need it, because their `EXIT` message
  rides a sequenced `data` frame and therefore replays across reconnects like any
  other payload ("Terminal channel payloads" below).
- Until `welcome` arrives, the only valid inbound frames are `welcome` and `reject`;
  session frames on an unnegotiated connection are discarded and surfaced as errors.

## Terminal channel payloads

The `terminal` kind carries the same message set the localhost terminal UI speaks
today, so a pty behaves identically whether its viewer is co-resident or across the
seam. Messages ride as `json` payloads inside ordinary `data` frames — no new frame
types, no change to any existing field, and therefore no version bump under the
versioning rules above: the set of wire-valid frames is unchanged, and these
validators (`parseTerminalClientMessage` / `parseTerminalServerMessage`) run at the
endpoints, never at the relay, which stays payload-blind. An endpoint that receives
a structurally invalid terminal message ignores it and may answer with a terminal
`ERROR` message; the frame layer is not involved.

A terminal channel is bound to exactly one pty session when it is opened, for its
whole life. That binding replaces the localhost `INIT` fields that select a session
(`sessionId`, `attachToken`): across the seam the channel *is* the session handle,
and its attach token — carried in the `open` frame — is the resume credential.
Credentials never ride payloads, so `READY` carries no attach token either.

Control plane → runner (the operator's side of the wire):

| Message | Fields | Meaning |
|---|---|---|
| `INIT` | `cols` · `rows` · `profile?` | A viewer attached: size the pty and replay scrollback. `profile`, when present, must match the bound session's. |
| `INPUT` | `data` | Keystrokes for the pty, verbatim. |
| `RESIZE` | `cols` · `rows` | Resize the pty. |
| `ACK` | `bytes` | Flow control: the viewer has consumed this many output bytes. |
| `KILL` | — | Kill the session and its process. |
| `SCROLL_RESET` | — | Leave scrollback hold (tmux copy-mode) and snap to the live tail. |

Runner → control plane:

| Message | Fields | Meaning |
|---|---|---|
| `READY` | `sessionId` · `profile` · `cwd` · `shell` · `pid` | The pty is attached and streaming. |
| `OUTPUT` | `data` · `replay?` | Pty output. `replay: true` marks scrollback re-emission. |
| `EXIT` | `exitCode` · `signal` | The process ended, with exactly one of `exitCode` or `signal` set. Sequenced end-of-stream: it replays across reconnects, unlike a bare `close`. |
| `ERROR` | `message` | A session-scoped failure (bad init, spawn failure, invalid message). |
| `SCROLL_STATE` | `held` · `newOutput` | Scrollback hold state, so the viewer can show "output held" honestly. |

Field bounds: dimensions are integers 1–1000; `ACK.bytes` is an integer 0–10,000,000;
`profile` is an opaque bounded label (safe identifier, ≤128 chars) — control-plane
vocabulary the protocol does not enumerate, so the public package never has to chase
product role lists; `cwd` and `shell` are non-empty strings ≤1024; `pid` is a
positive integer; `EXIT` populates exactly one of `exitCode` / `signal` (the other is `null`), both non-negative integers; a command killed by signal N is reported as `signal: N`, decoded from the shell's `128 + N` convention — so an explicit exit code above 128 is reported as a signal, the one ambiguity a `$?`-based exit capture cannot resolve; `ERROR.message`
is bounded at 500 like a close reason.

Flow control is end-to-end between viewer and pty, independent of socket
backpressure: the runner counts unacknowledged **live** `OUTPUT` bytes and pauses
the pty above a high-water mark, resuming below a low-water mark once `ACK`s catch
up. The watermark values are host policy, not protocol. A repeated `INIT`
re-requests replay but does not reset the window: acknowledgment debt belongs to
the channel peer, which outlives viewer attach cycles, so only an announced
continuity loss restarts the window at zero. Replayed output
(`replay: true`) is not flow-counted and must not be acknowledged — replay answers
an attach or an announced continuity loss, and counting it would double-charge the
window for bytes the pty already paid for.

`EXIT` is emitted only after output the flow window is still holding has
drained, so the sequenced end-of-stream never overtakes the stream; `ACK`s
therefore stay meaningful after the process is gone, and a `KILL` during the
wait forces `EXIT` out and abandons the undelivered tail. Output a viewer misses
while its window is closed is recoverable through replay rather than the live
path: a terminal multiplexer coalesces output for a client that is not reading,
so scrollback — not the live stream — is what makes a paused viewer whole.

The channel outlives its session: after `EXIT` the runner keeps the channel open
and replayable, and the control plane — the consumer — closes it once `EXIT` is
in hand. A runner-side close racing a dying link could lose the very
end-of-stream the sequenced `EXIT` exists to guarantee.

These are two layers, and they do not wait on each other. The channel layer moves
sequenced frames and is payload-blind; it never suspends its pump for an
application-level recovery, because doing so would make routing depend on
payload semantics the relay is specified not to read. Ordering between a
recovered snapshot and the live stream is carried by the `replay` flag, which is
what a viewer renders on: recovered history redraws scrollback, live output
appends. An endpoint that needs the snapshot to precede its own newer bytes
holds *its own* output, as the pty host does behind its replay barrier.

Replay composes with the channel model in two layers: the channel's replay buffer
heals exact gaps after a reconnect (the sequence machinery above), and the pty
host's scrollback answers anything larger — after a channel `reset` announces that
buffered continuity was lost, the runner re-emits scrollback as `OUTPUT` with
`replay: true`, in bounded chunks so no single replay frame can outgrow a replay
budget. Recovery favours a redundant redraw over a lost byte: output produced while a
capture is being taken may appear both in the snapshot and in the live stream
that follows, and that is deliberate — the snapshot is a full repaint the viewer
renders over, so a duplicate corrects itself, whereas suppressing more to avoid
it would risk discarding output the snapshot did not actually contain. A replay
large enough to outrun that budget itself provokes a `reset`;
that reset does **not** trigger another replay, because the next one would
overflow the same way — the loss stays announced, and a viewer that wants the
scrollback asks again with `INIT`. Replays are bounded per `INIT` for the same
reason: a stream that keeps outrunning the budget converges only if the runner
stops answering it. Continuity loss stays announced, and the viewer still ends up current. A
viewer that observes a mid-stream `reset` on an established connection can send
`INIT` again: `INIT` is always a request for fresh scrollback replay, not only the
first attach.

Recovery is bounded by the session's lifetime. Once `EXIT` is emitted the runner
releases the pane that held the scrollback, so a `reset` arriving after the
end-of-stream is answered with the reset alone. Retaining dead panes until every
channel closed would trade a certain, unbounded resource cost for a narrow
recovery: the case that matters — a viewer whose flow window was closed, so the
multiplexer coalesced output away — is recovered *before* `EXIT`, while the pane
is still alive.

## Job-control channel payloads

The `job-control` kind is the runner-level control channel: preview-server lifecycle, and the
runner's capability state. It is runner-level rather than per-session, which is why exactly
one of these channels exists per connection — a second would leave the control plane guessing
which one a `PREVIEW_START` belongs on. Messages ride as `json` payloads
inside ordinary `data` frames — no new frame types, no change to any existing field, and
therefore no version bump: the set of wire-valid frames is unchanged, exactly as with the
terminal payloads above. `job-control` has been a wire-valid kind since version 1 with its
semantics deferred, and this section is that deferral being paid.

Control plane → runner:

| Message | Fields | Meaning |
|---|---|---|
| `PREVIEW_START` | `previewId` · `recipe` · `cwd` | Start a locally-defined preview recipe in a granted directory. |
| `PREVIEW_STOP` | `previewId` | Stop a preview this runner holds. |

Runner → control plane:

| Message | Fields | Meaning |
|---|---|---|
| `PREVIEW_READY` | `previewId` · `port` | The preview is listening on the runner's loopback at this port. |
| `PREVIEW_EXIT` | `previewId` · `exitCode` · `signal` | The preview process ended. |
| `REFUSED` | `requestId` · `reason` | The runner declined a request, and why. |
| `CAPABILITIES` | `capabilities` | What this machine can run. See "Capability payloads". |

**The control plane names what to run, never how.** `recipe` is an identifier for a
command line the runner holds locally; no command and no argument vector crosses this
wire. Allowlisting an executable while accepting its arguments from a peer is not an
allowlist — an approved interpreter plus a caller-supplied argv is arbitrary execution
under the runner's user, and no argument policy survives contact with an interpreter. An
unknown recipe is refused with `not-allowlisted`. This is the wire form of FR-13: the
allowlist ships with the runner, is editable only locally, and the control plane cannot
extend it.

**The port is discovered, not assigned.** A preview command chooses its own port — that is
what dev servers do — so the runner reports the port the process actually bound rather
than dictating one and assuming obedience. `cwd` is bounded at 1024 characters and `port`
is 1–65535: a sentinel like 0 is not a port a browser can open, so it is not a port this
protocol carries.

**A port is not an endpoint.** `PREVIEW_READY` carries a port and deliberately carries no
host, no URL, and no scheme. The operator's browser is on the runner's machine, in both
the split and co-resident deployments, so the number is all it needs; a host or URL field
would be exactly the endpoint the seam contract says never crosses.

**Loopback binding is verified, not declared, and verification does not stop at
readiness.** The runner inspects the listening sockets of the spawned process and its
descendants, lets the tree settle before judging it — a wrapper binds before its server
does — and reports readiness only when every listener is on a loopback address and exactly
one port is in play. It keeps checking for the preview's life: a tree can bind a new socket
long after it started, so a check performed once certifies an instant rather than the
promise. Losing loopback ends the preview, and so does losing every listener, since a
process that closed its server without exiting would otherwise leave a port advertised that
nothing answers. Refusal means the tree is no longer reachable, not that a signal was
sent.

**This is detection and response, not prevention, and the difference is load-bearing.** A
preview is spawned into the host's network namespace, so an off-loopback listener *can*
exist — briefly during startup, or for as long as one sweep interval afterwards — before
the runner finds it and ends the tree. Ownership is tracked by ancestry and process group
and re-established by start time, which a descendant that calls `setsid` after a double
fork escapes entirely. Closing that requires an OS containment unit whose membership
survives reparenting and session changes: a network namespace or cgroup on Linux, with no
clean equivalent on macOS.

Nothing in this schema should be read as a guarantee that an off-loopback listener cannot
exist. What is guaranteed is that one which appears in a tree the runner can still see is
found and terminated, and that readiness is never reported over it. A conformance suite
that passes against this section is evidence of detection; it is not evidence of
containment.

**Refusals are answers.** Every request the runner declines produces a `REFUSED` naming
its reason — `not-allowlisted`, `path-not-granted`, `runner-paused`, `non-loopback-bind`,
`already-running`, `unknown-preview`, `spawn-failed`, `ambiguous-listener`, `at-capacity`. Nothing is held for a later attempt.
This is the wire form of the seam's fourth principle: an offline or unwilling runner is
visible, and a request that will not be served never looks like one still in progress.

### Session-launch v2 interface

`SESSION_LAUNCH_PROTOCOL_VERSION = 2` is active only after negotiation selects protocol 2.
The contiguous active range remains 1–2 for N−1 compatibility: a connection that selects
version 1 rejects `SESSION_START` and launches nothing, while version 2 routes the validated
message through the runner's durable session job-control path.

Control plane → runner:

| Message | Fields |
|---|---|
| `SESSION_START` | `bindingId` · `requestId` · `expiresAt` · `terminalProfile` · `modelProfileId` · `target {projectId, worktreeName, branch, baseBranch, relativeCwd}` |

Runner → control plane:

| Message | Fields |
|---|---|
| `SESSION_ACCEPTED` | `requestId` |
| `SESSION_STARTED` | `requestId` · `channelId` · `sessionId` |
| `SESSION_REFUSED` | `requestId` · `reason` |
| `SESSION_FAILED` | `requestId` · `reason` |
| `SESSION_FINISHED` | `requestId` · exactly one of `exitCode` / `signal` |

Binding and request ids are lowercase UUIDv4 values. Profile/project/worktree/channel/session
ids use the safe-identifier grammar. Branches are bounded and control-character-free, then
must pass the runner's local `git check-ref-format --branch` before admission. `relativeCwd`
is canonical relative POSIX syntax with no empty, dot, dot-dot, absolute, backslash, or leading
ASCII drive-prefix component. Unknown properties are discarded. In particular there is no command, argv,
arbitrary environment, key label, credential, endpoint, absolute path, allowlist extension,
or signing material in the validated request.

Session refusal reasons are `invalid-request`, `binding-mismatch`, `project-unknown`,
`path-not-granted`, `runner-paused`, `worktree-invalid`, `at-capacity`, `request-conflict`,
`request-expired`, `unknown-profile`, `runtime-unknown`, `runtime-unavailable`,
`runtime-unauthenticated`, `access-unsupported`, `unknown-key`, `key-provider-mismatch`,
`unknown-endpoint`, `endpoint-unavailable`, `model-unavailable`, and `profile-incomplete`.

Session failure reasons are `project-unknown`, `path-not-granted`, `worktree-invalid`,
`worktree-conflict`, `provision-failed`, `spawn-failed`, `channel-unavailable`,
`launch-timeout`, `recovery-uncertain`, `unknown-profile`,
`runtime-unknown`, `runtime-unavailable`, `runtime-unauthenticated`, `access-unsupported`,
`unknown-key`, `key-provider-mismatch`, `unknown-endpoint`, `endpoint-unavailable`,
`model-unavailable`, and `profile-incomplete`.

Canonical equality is SHA-256 over the validated semantic request with recursively fixed
key order. The request deadline governs first admission only; known receipts replay before
deadline checks. Receipt, recovery, durability-first storage failure, and counterpart
obligations remain normative in
[`docs/runner-launch-contract.md`](../../docs/runner-launch-contract.md).

## Capability payloads

`CAPABILITIES` carries what the runner can actually run, so the hosted Models surface offers
only what a machine has. The runner-side contract — resolution, injection, endpoint dialing —
is [`docs/model-access.md`](../../docs/model-access.md); this section is the wire form.

**The probe shapes behind an endpoint's `reachable` and `models` are a proposal**, recorded
in that document rather than here, and deliberately so: they are HTTP calls the runner makes
to a service on its own machine, not traffic that crosses this seam, and the wire schema
should not grow a section describing requests it never carries. They are a proposal for the
same reason the pairing redemption shape above is one — Ollama's API belongs to its project
and the OpenAI-compatible path is a de-facto convention, so both are strictly validated here
and expected to be settled by whoever meets them next.

It rides the job-control channel and not `hello`, deliberately. A `hello` shares one 1 MiB
frame with a resume roster bounded at 1024 channels so the frame always fits; an oversized
`hello` is terminal for the connection, and an operator-sized model inventory in the same
frame would break that arithmetic — a large model library must not leave a runner unable to
connect. A channel is also refreshable and sealable, so one mechanism serves the initial
advertisement and every later change instead of two code paths for one fact.

The snapshot is always **whole**, never a delta: a peer that missed an update must not be left
reconstructing state from a partial history, and a replayed duplicate is then harmless.

Access modes are `subscription`, `api-key` and `local`.
Per-CLI auth states are `authenticated`, `unauthenticated` and `unknown` — `unknown` being the answer for a runtime that offers no way to ask, since reporting a signed-in CLI as signed out renders sign-in guidance at somebody already signed in.
Endpoint kinds are `ollama` and `openai-compatible`.
An unreachable endpoint names one of `not-running`, `refused`, `timed-out`, `unauthorized` or `unreadable-response`.

| Field | Shape |
|---|---|
| `runtimes[]` | `runtime` (safe identifier) · `version` (≤64 chars, or `null` when the runtime would not say) · `auth` · `access[]` |
| `endpoints[]` | `endpointId` (safe identifier) · `kind` · `reachable` · `models[]` · `modelCount` · `reason?` |

**OS and architecture are already on `hello.runner`.** FR-10's advertisement is the two fields
together, and a capability snapshot that restated them would be a second source of truth for
something the handshake already says.

**An advertisement is not an endpoint disclosure.** What crosses is the *fact* of a local
endpoint — an opaque, operator-chosen id, its kind, its health and its inventory — never its
URL, host, port or scheme, because those are on the seam's never-crosses list. The
unreachable reason is enumerated for the same purpose: a transport error message carries the
address it failed to reach, so free text here would leak precisely what the id withholds. The
id is operator-chosen and never derived from the address; a hash of `http://127.0.0.1:<port>`
has an input space of about 65,000 values and is brute-forced back to the port in
milliseconds.

**Everything is bounded, and truncation announces itself.** Runtimes cap at 32, endpoints at
8, models at 64 per endpoint, model names at 128 characters and versions at 64. `modelCount`
carries the true total, so a list shortened to fit says so rather than quietly lying —
staleness is visible, never silent. An endpoint with nothing installed is a reachable endpoint
with an empty inventory, not a failure.

**Model names are not safe identifiers.** Real ones contain a colon
(`llama3.1:8b-instruct-q4_K_M`), which the safe-segment rule rejects, so they cross as bounded
strings free of control characters under their own rule — and therefore must never be used as
a path segment on the runner.

## End-to-end capability

Version 1 relays session payloads through the control plane over TLS: the relay **can
read what it relays**, and product surfaces must say so honestly until end-to-end
encryption ships. (Seam contract v2, 2026-08-13: that readable relay is only ever the
user's own control plane — a relay operated by Modula is content-blind from its first
ship, with end-to-end TLS passthrough to the user's plane as the default posture for
browser sessions and runner WebSockets alike: the upgrade header cannot be frame-sealed,
and a TLS-terminating relay could tamper with sealing code it delivers. `sealed`
payloads may traverse a terminating relay only toward a customer-pinned client whose
integrity is established independently of Modula — and only once the versioned
sealed-suite contract ships (authenticated AEAD, enforced algorithms and nonce rules;
tracked as #12): as reserved today, `sealed` is a frame shape, not an encryption
guarantee, so until then a Modula-operated relay does not terminate TLS at all. Zero
content custody, product PRD §14.) The frames are designed so that shipping it is a key
exchange, not a redesign:

- Routing (`type`, `channel`, `seq`) is separate from content (`payload`) in every
  session frame. The relay routes on the envelope alone.
- Payloads declare a codec. `json` and `text` are the version-1 cleartext codecs.
  The `json` codec carries `JSON.stringify` semantics: values without a JSON
  representation follow the platform's standard coercion, and the serialized
  snapshot taken at send time is byte-identical to anything a replay retransmits.
  `sealed` is **reserved from version 1**: `{codec: 'sealed', alg, nonce, body}` — an
  opaque ciphertext envelope meaningful only to the endpoints. A relay that can route a
  `text` payload can route a `sealed` one without modification, and validators already
  accept it.
- Control frames the relay must read — `hello`, `welcome`, `reject`, `ping`, `pong`,
  `open`, `reset`, `close`, `error` — are cleartext by definition and carry no session
  content. Everything content-bearing rides in `payload`.

## What never crosses this wire

The seam contract's list is normative
([`runner-seam.md`](../../docs/runner-seam.md), "Never crosses the seam"); the schema
restates the parts the protocol can enforce by shape: no frame has a field for
credentials, forge endpoints, or setup material, and forge state that reaches the control
plane in later revisions is health-shaped (kind, reachable, since), never config-shaped.
Absence of a place to put a secret is the strongest schema-level guarantee available;
the runner's own enforcement does the rest.

# Runner protocol schema

*Protocol version **1** · package `@modulastack/runner-protocol` · consumed by the runner
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

- The protocol version is a positive integer. This package's `PROTOCOL_VERSION` is the
  newest version the package describes; `MIN_PROTOCOL_VERSION` is the oldest it can still
  speak.
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
  existing frames may ship within a version because validators ignore unknown fields.

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

### Channels

| Frame | Direction | Fields |
|---|---|---|
| `open` | runner → control plane | `channel` · `kind` · `attachToken` |
| `data` | both | `channel` · `seq` · `payload` |
| `reset` | both | `channel` · `seq` |
| `close` | both | `channel` · `reason?` |
| `error` | both | `message` · `channel?` |

Channel kinds in version 1: `terminal` is defined; `coms`, `forge-event`, and
`job-control` are **reserved** — structurally valid on the wire, semantics specified in
later revisions (see the seam reconciliation note for why they exist now).

## Channel model

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
- Resets only move forward: a `reset` whose `seq` does not exceed the receiver's
  high-water mark is rejected, because rewinding would make already-consumed frames
  deliverable again.
- The reconnect hello is the authoritative channel roster: the control plane closes
  any channel the runner no longer presents. A `close` frame lost to a dying
  connection therefore heals at the next reconnect instead of leaving an orphan.
- Until `welcome` arrives, the only valid inbound frames are `welcome` and `reject`;
  session frames on an unnegotiated connection are discarded and surfaced as errors.

## End-to-end capability

Version 1 relays session payloads through the control plane over TLS: the relay **can
read what it relays**, and product surfaces must say so honestly until end-to-end
encryption ships. The frames are designed so that shipping it is a key exchange, not a
redesign:

- Routing (`type`, `channel`, `seq`) is separate from content (`payload`) in every
  session frame. The relay routes on the envelope alone.
- Payloads declare a codec. `json` and `text` are the version-1 cleartext codecs.
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

# Runner pairing and session-launch counterpart contract

Status: proposed for G1 operator and counterpart-owner approval; total-storage-failure ruling approved · Owner: runner / customer-control-plane backend · Revision: 2026-08-21 · Parent plan: `docs/frd-runner-verification.md` at commit `333bf95f44714a8a14b19528aaadcf6f11283571`

This document settles the missing counterpart contract identified by G1. It does not activate a
new wire version or implement a runtime. Activation requires the interface-first G2 checkpoint,
independent runtime-red acceptance specs, production implementation, and a matching customer-run
control-plane implementation.

Approval of this contract authorizes only those local interface checkpoints. It does not authorize
a push, PR, production control plane, credentials, infrastructure mutation, tag, release,
deployment, audit acceptance, or general-availability claim.

## Drivers

The three primary characteristics are:

1. **Security:** a compromised control plane can name local policy objects but can never select a
   command, arguments, environment, key, endpoint, signing material, or arbitrary local path.
2. **Reliability:** at-least-once delivery, reconnect, and runner restart produce at most one spawn
   or an explicit uncertainty result—never a silent duplicate.
3. **Testability:** every valid request reaches a finite correlated state whenever every
   persistence mutation required for that result succeeds. Failure of any required mutation is an
   explicit connection-level uncertainty exception, while stub evidence stays visibly weaker than
   the real customer-control-plane gate.

The accepted cost is a version-2 rollout and a small durable local receipt ledger. The rejected
alternative—adding a local or test-only `exec` path—would make tests easy by bypassing the security
boundary they are meant to prove.

## G1 decisions requiring approval

| ID | Proposed ruling | Consequence |
|---|---|---|
| B-01 | Freeze `POST /api/runner/v1/pair` and `POST /api/runner/v1/pair/confirm` on the exact configured origin, JSON only, no redirects, TLS except loopback. Exact bodies and status mapping are below. | The customer-control-plane owner must adopt these HTTP contracts before the real journey. |
| B-02 | Replace the reusable plain token digest proposal with an HMAC-SHA-256 proof bound to a server nonce, binding id, runner id, and configured origin. | Redemption returns two additional non-secret confirmation fields and the runner pairing record expands additively. |
| B-03 | Pairing codes and unconfirmed bindings expire after 10 minutes. Pending/paired state blocks another pair; revoked/unpaired state permits it. Concurrent pair calls have one durable winner. | Switching planes requires revocation first; accidental concurrent minting fails closed. |
| B-04 | Protocol v2 adds `SESSION_START`, `SESSION_ACCEPTED`, `SESSION_STARTED`, `SESSION_REFUSED`, `SESSION_FAILED`, and `SESSION_FINISHED` on the one job-control channel. | Six closed message shapes become public and future incompatible enum growth requires another version decision. |
| B-05 | Session launch requires protocol v2, not a v1 feature flag. `MIN_PROTOCOL_VERSION` remains 1 when v2 activates; v1 retains previews/capabilities but cannot launch sessions. | Rollout is explicit and old peers never guess at a message they cannot answer. |
| B-06 | A request names both a local `modelProfileId` and an opaque terminal `terminalProfile`. G1 launches model/agent panes only; generic remote shells are out of scope. | The two existing meanings of “profile” remain separate and command selection stays local. |
| B-07 | A request carries a local `projectId` plus bounded branch/worktree metadata and a relative cwd. A local project registry supplies repository and worktree-root paths. | The control plane may schedule refs/names but never sends an absolute local path. G2 adds a local project create/list/remove surface. |
| B-08 | Launch results use the finite refusal/failure vocabularies below; they do not merge with preview refusals. | Control-plane UI can distinguish pre-admission refusal, post-acceptance failure, and terminal exit. |
| B-09 | Correlation rides explicit job-control results. `SESSION_STARTED` carries request id, current terminal channel id, and stable session id; attach tokens stay only in `open`. | A control plane may briefly buffer an uncorrelated terminal `open`, then binds it when `SESSION_STARTED` arrives. No frame field widens. |
| B-10 | Equality is SHA-256 over the validated semantic request in canonical JSON. The control plane generates a lowercase UUIDv4 request id; the first body for an id is immutable throughout receipt/tombstone retention and the counterpart may never reuse it. | Unknown JSON properties and key order cannot create a second meaning; same-id/different-body is `request-conflict`. |
| B-11 | The receipt state machine is `accepted → provisioned → spawn-intent → started → finished`, with terminal `refused`, `failed`, or `uncertain`. Session id is durable before spawn; restart adopts only a matching owned session. | A crash after spawn intent but without provable ownership reports `recovery-uncertain` and never respawns automatically. |
| B-12 | One runner-home ledger globally holds at most 4,096 receipts / 8 MiB, 32 in flight, and 32,768 tombstones / 16 MiB across current and retired bindings. Terminal receipts remain 24 hours; tombstones remain 30 days. | Capacity is finite, re-pair cannot reset it, and work is refused rather than evicting live or unexpired evidence. |
| B-13 | A well-formed request gets accepted/refused within 5 seconds and, while every required receipt/audit mutation remains durable, started/failed within 180 seconds. Failure of any required mutation instead produces a best-effort connection-level `storage-unavailable` close and counterpart `storage-uncertain` state, never a fabricated per-request result. | Durability-before-ack remains absolute; an ambiguous loss with nonterminal launches also stops redrive until operator reconciliation. |
| B-14 | Idempotency is scoped to `bindingId + requestId`; project/target remains in the body fingerprint. Re-pair creates a new binding id and cannot reuse an old receipt. | A new binding cannot adopt or suppress an old binding’s launch. |
| B-15 | The matching owner is the customer-control-plane backend in `ModulaStack/modulastack`; it must publish matching validators/tests before Task #47. | The runner stub is never accepted as counterpart evidence. Repository/team ownership must be confirmed at this gate. |
| B-16 | Worktree ownership phases live in the same receipt. Restart resumes/adopts only when git registration, branch ref, expected base, path, and journal agree; ambiguity is non-destructive uncertainty. | Recovery may require operator cleanup, but it never deletes another contender’s lane. |

## Terminology

- **Binding:** one activated pairing epoch, identified by `bindingId` and authenticated by one
  bearer token.
- **Model profile:** local access configuration selected by `modelProfileId`; it resolves to a
  runtime, model, and subscription/key/endpoint access without crossing the wire.
- **Terminal profile:** opaque bounded UI/session label such as `coder`; it never selects a command.
- **Project:** local mapping from `projectId` to repository path and worktrees root.
- **Launch receipt:** durable admission and outcome record namespaced by `bindingId + requestId` in
  the globally bounded runner-home ledger.
- **Counterpart:** the customer-run control plane that mints runner credentials and speaks the
  matching HTTP/WSS contract. A Modula-operated coordination service is not this counterpart.

## Part 1 — pairing counterpart

### Routes and transport

| Operation | Method and path | Success |
|---|---|---|
| Redeem code | `POST /api/runner/v1/pair` | `200 application/json` with the pending binding envelope |
| Confirm possession | `POST /api/runner/v1/pair/confirm` | `204` with an empty body |

Both URLs resolve against one canonical origin: the ASCII `origin` returned by the WHATWG URL
algorithm after the secure-URL check. That serialization lowercases scheme/host, converts an IDN to
ASCII, omits the default port, and contains no userinfo, path, query, fragment, or trailing slash
(`https://EXAMPLE.test:443/path` becomes `https://example.test`). The runner stores those exact
UTF-8 bytes. The counterpart uses its configured canonical public origin—not `Host`, `Forwarded`, or
`X-Forwarded-*` input—to derive the same bytes and rejects a deployment whose route does not match.

Redirect following is forbidden, including method-preserving 307/308 responses. HTTPS is mandatory
except the published single-operator loopback HTTP exception. Requests use
`content-type: application/json`; requests and responses over 64 KiB are rejected before JSON
parsing. Request JSON is also limited to 64 nesting levels and 8,192 value nodes before semantic
handling or attempt accounting. An over-limit request receives one bounded generic error; a
non-JSON redemption response is malformed. Parsers copy only declared fields; unknown fields cannot
influence state and provide additive evolution room.

### Redemption

Request:

```json
{
  "code": "22 base64url characters, '.', then 19 base64url characters",
  "runner": {
    "name": "non-empty string, at most 200 characters",
    "version": "non-empty string, at most 200 characters",
    "os": "non-empty string, at most 200 characters",
    "arch": "non-empty string, at most 200 characters"
  }
}
```

Every string is free of control characters. The request carries no bearer token, existing binding,
workload secret, local path, key, endpoint, or allowlist data.

The server creates the opaque code as `<pairingId>.<secret>` from a CSPRNG: `pairingId` is 16 random
bytes encoded as 22 unpadded base64url characters and `secret` is 14 random bytes (112 bits) encoded
as 19 unpadded base64url characters. The non-secret lookup id makes per-pairing throttling possible
without reducing the secret's entropy. Display grouping is outside the wire value; the runner sends
the canonical 42-character form. The server stores an HMAC-SHA-256 verifier under a server-held
pepper, compares fixed-length real or dummy verifiers in constant time, expires the code after ten
minutes, and consumes it exactly once in the same transaction that creates the pending binding.

Redemption permits at most five failed attempts per trusted source in a rolling 60-second window,
ten failed attempts for one `pairingId` over its lifetime, and 100 consecutive failures for the
pairing principal across replacement codes. Issuing a new code does not reset the principal count;
a successful redemption does. Per-source throttling returns generic `429` plus bounded
`Retry-After`; pairing/principal exhaustion returns the same generic `429` without revealing whether
the id existed. Source identity comes only from the authenticated proxy boundary, never an
untrusted forwarded header. Audit records contain counters and source identity, never code,
verifier, token, or confirmation proof.

Response:

```json
{
  "bindingId": "lowercase UUIDv4",
  "runnerId": "safe identifier",
  "token": "exactly 43 base64url characters without padding (32 decoded bytes)",
  "confirmationNonce": "exactly 43 base64url characters without padding (32 decoded bytes)",
  "confirmationExpiresAt": "RFC 3339 UTC timestamp"
}
```

The control plane consumes the code once and creates a pending binding. The runner records
`pendingSince` from its own clock and stores the entire
pending envelope durably before confirmation. The configured origin—not the response—supplies
`controlPlaneUrl`; `pairedAt` is the runner’s local confirmation-completion time. No server timestamp
orders local writes.

The control plane computes and stores the expected confirmation proof and WebSocket token verifier
before discarding the plaintext token. It never exposes an endpoint that retrieves a token after a
lost redemption response. If the response is lost after code consumption, the operator needs a
fresh code.

The token grammar is `[A-Za-z0-9_-]{43}` ASCII with no padding, whitespace, or control characters.
The pairing-code grammar is `[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{19}`.

### Confirmation proof

Both sides base64url-decode the token to the same 32 raw HMAC key bytes; neither uses the
43-character text as the HMAC key. The proof is lowercase hex HMAC-SHA-256 with those raw token
bytes as the key over these exact UTF-8 bytes:

```text
modula-runner-pair-confirm:v1\n<bindingId>\n<runnerId>\n<configured-origin>\n<confirmationNonce>
```

All interpolated fields exclude control characters, so line breaks are unambiguous. The origin is
the canonical WHATWG serialization above; the server never reconstructs it from a forwarded
header.

Cross-language golden vector:

```text
token text: AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8
token bytes: 00 01 02 ... 1f
bindingId: 123e4567-e89b-42d3-a456-426614174000
runnerId: runner-01
origin input: https://EXAMPLE.test:443/path
canonical origin: https://example.test
nonce: ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8
proof: 7610a86a8a314afd963c1348c35d41c46579aa456e99ef612d0a1becf1c9eec0
```

The confirm request is:

```json
{
  "bindingId": "lowercase UUIDv4",
  "runnerId": "safe identifier",
  "confirmationNonce": "the minted nonce",
  "tokenProof": "64 lowercase hexadecimal characters"
}
```

The token itself never rides this request. The server compares the precomputed expected proof in
constant time and activates only the exact pending binding. Before activation, an expired challenge
returns expiry. After activation, an exact repeat returns `204` idempotently for the lifetime of the
binding, which closes the lost-success-response case without creating a second activation. A nonce
or proof is not accepted for another binding, runner, or origin.

### Pairing state and status mapping

The local pairing operation durably reserves the store before redemption. `unpaired` or `revoked`
may reserve; `pending` returns `pairing-in-progress`; `paired` returns `already-paired`. Concurrent
calls serialize at that reservation, so only one code reaches the control plane. If no valid pending
envelope is durably stored—any redemption failure, unknown/lost response, or local store failure—the
reservation is cleared in the same serialized operation. A successfully stored envelope commits the
reservation to `pending` until settlement, terminal refusal/expiry, or explicit revocation. Re-pair
after revocation gets a new `bindingId`; compare-and-swap prevents stale confirmation from settling
or revoking it.

| HTTP result | Redemption outcome | Confirmation outcome |
|---|---|---|
| `100`–`199` | `malformed-response`; clear reservation | `malformed-response`; remain pending |
| `200` | Parse/store pending envelope; otherwise `malformed-response` and clear | `malformed-response`; remain pending (confirmation requires `204`) |
| `201`–`203`, `205`–`299` | `malformed-response`; clear reservation | `malformed-response`; remain pending |
| `204` | `malformed-response`; clear reservation | Confirmed/idempotently confirmed only with an empty body |
| `300`–`399` | `unreachable`; clear reservation | `unreachable`; remain pending |
| `400`, `401` | `invalid-code`; clear reservation | `refused`; atomically revoke pending |
| `403`, `422` | `refused`; clear reservation | `refused`; atomically revoke pending |
| `404` | `invalid-code`; clear reservation | `unreachable`; remain pending (an adopted counterpart uses `410` for unknown/expired pending) |
| `405`, `501` | `refused`; clear reservation | `unreachable`; remain pending (route absent/version skew) |
| `409`, `410` | `expired-code`; clear reservation | `expired-code`; atomically revoke pending |
| `429` | `unreachable`; clear reservation | `unreachable`; remain pending |
| Any other `4xx` | `refused`; clear reservation | `refused`; atomically revoke pending |
| `500`–`599` | `unreachable`; clear reservation | `unreachable`; remain pending |
| Timeout, network failure, redirect | `unreachable`; clear reservation | `unreachable`; remain pending and record an unknown confirmation result |
| Wrong media type, oversized/malformed body, invalid fields | `malformed-response`; clear reservation | `malformed-response`; remain pending |

Redemption is never automatically replayed after an unknown result because the code may already be
spent. Confirmation may replay only the exact stored envelope. The server treats a valid proof as
activation; an exact repeat for an already activated, non-revoked binding remains `204`, including
a lost-success-response retry. A terminal confirmation answer records revoked and can never be
reversed by an old proof.

At the runner-local deadline `pendingSince + 10 minutes`, a still-pending runner performs one final
exact confirmation. `confirmationExpiresAt` records server-side proof validity but cannot extend or
shorten that local deadline. A `204` settles it; authoritative `409` or `410` marks it
revoked/expired locally. A final route-absent
`404`, `405`, or `501` permits local expiry only when every earlier confirmation attempt also ended
in a definite route-absent response. After any network, timeout, `5xx`, malformed response, or other
unknown result, a later route-absent response cannot disprove prior activation: the binding remains
`pending` and status reports `confirmation-uncertain`. Automatic retry and re-pair stop, while an
operator may run `status` to redrive that same proof or revoke/inspect the counterpart. This prevents
permanent route-skew retry without treating a possibly successful confirmation as safe to replace.

Local settlement failure remains `settle-failed`; a stale compare-and-swap remains `superseded`.

This adds `pairing-in-progress`, `already-paired`, and `confirmation-uncertain` to the finite local
`PairingFailure` vocabulary. None is put on the wire.

## Part 2 — protocol version and launch messages

Session launch activates only with protocol version 2. At activation, the runner offers `{min: 1,
max: 2}`. A v2 control plane continues the N/N−1 policy. Negotiated v1 supports the existing
preview/capability and terminal payloads but not session initiation. A compliant control plane never
sends `SESSION_START` unless v2 was selected.

A v2-capable runner that receives launch traffic under v1 spawns nothing, sends a bounded generic
`error` frame on the job-control channel, and closes that channel so the unsupported attempt is
visible. An old v1 runner may ignore an unknown payload, which is why rollout correctness rests on
the v2 control plane obeying negotiation rather than probing old runners.

G2 may publish `SESSION_LAUNCH_PROTOCOL_VERSION = 2` and throwing interface stubs while the active
`PROTOCOL_VERSION` remains 1. The global version changes only in the production implementation
checkpoint that can answer every v2 message; advertising a version with no implementation is
forbidden.

### Client request

```json
{
  "type": "SESSION_START",
  "bindingId": "the lowercase UUIDv4 authenticated on this connection",
  "requestId": "lowercase UUIDv4",
  "expiresAt": "RFC 3339 UTC timestamp, no more than 24 hours ahead",
  "terminalProfile": "safe identifier",
  "modelProfileId": "safe identifier",
  "target": {
    "projectId": "safe identifier",
    "worktreeName": "safe identifier",
    "branch": "bounded git branch name",
    "baseBranch": "bounded git branch name",
    "relativeCwd": "canonical relative POSIX path"
  }
}
```

Branch fields are non-empty, at most 255 characters, control-character-free, must not begin with
`-`, and reject `@{-n}` previous-checkout syntax before passing the literal candidate to local
`git check-ref-format --branch`. Every subsequent resolution uses only fully qualified
`refs/heads/<branch>` or `refs/remotes/origin/<baseBranch>` names. `baseBranch` must exist at that
exact fetched remote ref and resolve to the journaled commit; a wire value is never passed as an
unqualified Git revision. `relativeCwd` is at most 1,024 characters, uses
`/`, is either `.` or a relative path with no empty, `.`, or `..` component, no backslash, no
leading ASCII drive prefix such as `C:`, and no control character. All five target fields are
required; there are no wire defaults.

`bindingId` must equal the binding authenticated on the current connection; an old binding gets
`binding-mismatch` before any receipt lookup or side effect.

The request has no command, executable, argv, argument template, environment, provider, model
override, access override, key label/fingerprint, credential, endpoint id/address, absolute path,
recipe body, allowlist extension, trust anchor, or signing material. Validators return a new object
containing only declared semantic fields.

### Server messages

```text
SESSION_ACCEPTED { requestId }
SESSION_STARTED  { requestId, channelId, sessionId }
SESSION_REFUSED  { requestId, reason }
SESSION_FAILED   { requestId, reason }
SESSION_FINISHED { requestId, exitCode, signal }
```

All ids use their existing safe-identifier bounds. `SESSION_FINISHED` populates exactly one of
`exitCode` or `signal`, like terminal `EXIT`. The terminal attach token appears only in the channel
`open` frame. Results never carry command, argv, environment, local absolute path, profile contents,
key label, secret, endpoint, or signing data.

One accepted request has at most one live terminal channel at any instant. The receipt carries a
monotonic `channelGeneration`, the current `channelId`, and `live`, `closed`, `lost`, or
`replacement-intent` lifecycle. The runner may emit `open` before `SESSION_STARTED`; the counterpart
buffers that channel without sending `INIT` until the correlated started result arrives. If the
request does not reach `SESSION_STARTED`, the runner closes that exact channel before reporting
failure and the counterpart discards the buffered channel on close. Failed or unknown exact-channel
close takes the connection-level storage-uncertain path and permits no correlated failure or started
result to escape until bounded recovery can classify that generation.

A replacement is permitted only after an awaited successful exact-channel close, an authoritative
terminal/lost event from the owning transport, or restart evidence that the prior connection epoch
ended and no live channel remains in the local registry. Reconnect, elapsed timeout, or attempted
close alone is not proof. A durable compare-and-set from retired generation N to
`replacement-intent` N+1 is the sole recovery claim; concurrent losers open nothing and wait for or
replay the winner's durable result. Every callback is correlated by channel id and generation, so a
delayed retired-channel event cannot mutate, close, detach, or settle the current channel/session.

`SESSION_STARTED` is sent only after the child/session and current channel generation are durable
enough to replay honestly. It carries the stable session id and current channel id. Terminal `READY`
then carries the existing session metadata, and `INIT.profile`, if present, must equal
`terminalProfile`; it cannot reselect `modelProfileId`.

### Finite outcomes

`SESSION_REFUSED` is pre-admission and has no spawn or terminal channel. Its reasons are:

```text
invalid-request · binding-mismatch · project-unknown · path-not-granted · runner-paused ·
worktree-invalid · at-capacity · request-conflict · request-expired · unknown-profile · runtime-unknown ·
runtime-unavailable · runtime-unauthenticated · access-unsupported · unknown-key ·
key-provider-mismatch · unknown-endpoint · endpoint-unavailable · model-unavailable ·
profile-incomplete
```

`SESSION_FAILED` follows a durable acceptance when completion could not be achieved:

```text
project-unknown · path-not-granted · worktree-invalid · worktree-conflict · provision-failed ·
spawn-failed · channel-unavailable · launch-timeout · recovery-uncertain ·
unknown-profile · runtime-unknown · runtime-unavailable ·
runtime-unauthenticated · access-unsupported · unknown-key · key-provider-mismatch ·
unknown-endpoint · endpoint-unavailable · model-unavailable · profile-incomplete
```

The repeated access reasons are deliberate: an initial static check may pass and a fresh endpoint,
key, or runtime check immediately before spawn may fail. No reason permits fallback. Preview
`REFUSED` retains its existing nine-reason vocabulary; launch does not overload it.

A syntactically recognizable `SESSION_START` with a safe request id but invalid declared fields gets
`SESSION_REFUSED invalid-request`. A malformed/oversized payload without a trustworthy request id,
an unknown v2 job-control message, or unnegotiated launch traffic gets one generic bounded protocol
error and no reflected input. It never spawns.

## Part 3 — local project and profile authority

G2 exposes local project create/list/remove alongside the approved profile/endpoint commands. A
project record maps `projectId` to `repoPath` and `worktreesRoot`; both paths enter only through the
local CLI, are resolved and ownership/symlink checked, and never cross the wire. The operator grants
the existing worktrees root before remote launches are accepted.

The control plane may choose `worktreeName`, `branch`, `baseBranch`, and `relativeCwd` because those
are orchestration identifiers, not local authority. Acceptance snapshots the exact local project
mapping version and verifies the existing worktrees-root grant. The runner then provisions/reuses
the deterministic worktree, resolves `relativeCwd` inside it, and rechecks the current project
mapping and the same live grant immediately before spawn. Removal/replacement of the project,
revocation, traversal, symlink escape, or a changed target after acceptance produces
`SESSION_FAILED project-unknown`, `path-not-granted`, or `worktree-invalid`; no child starts. Any
request-owned partial worktree is cleaned only when ownership remains proven, otherwise retained as
uncertain. Dirty/mismatched reuse is `worktree-conflict`.

`modelProfileId` selects one local model profile. The local runtime catalog supplies executable,
argv, non-secret environment, and the variable names used for secret injection. The profile and
local key/endpoint stores supply access. `terminalProfile` is only the existing terminal label. G1
does not provide generic remote shell launch and adds no wire path that constructs a command.

## Part 4 — ordering, receipts, retries, and restart

### Canonical equality and namespace

The control plane generates and durably persists a lowercase UUIDv4 `requestId` before first send
and includes the active `bindingId` in the request. The runner requires that id to match the
connection credential, then namespaces receipts by `bindingId + requestId`; `projectId` and all
target/profile fields remain in the body fingerprint. A new pairing gets a new binding namespace,
and an old request is visibly `binding-mismatch` rather than adopted, suppressed, or replayed.

Canonical equality and receipt idempotency begin only after semantic validation. A correlated
`invalid-request` is connection-audited under DA-IF-1 and does not create a receipt or reserve an
idempotency key; the authenticated counterpart permanently retires every request id it used,
including one that received `invalid-request`. All valid fields are required, the target path is in
its canonical form, unknown JSON properties are discarded, and object key/wire ordering is
irrelevant.
The runner serializes the declared semantic object with sorted keys and hashes those UTF-8 bytes
with SHA-256. The first fingerprint for an id is immutable while its full receipt or tombstone is retained, and
the counterpart contract forbids request-id reuse permanently. Lookup precedes expiry: an exact
duplicate with a known full receipt replays its current or terminal message even after the request’s
admission deadline; a different fingerprint returns `request-conflict` and cannot modify the first.
A compact tombstone replays the same terminal refused/failed/finished message during its retention. Once a receipt first becomes `refused`, `failed`, `finished`, or `uncertain`, its persisted semantics are write-once: a later replace is only an exact no-op, and compaction preserves the exact key, fingerprint, terminal result, stable session id when present, and original terminal timestamp.
After tombstone deletion, the exact old body still carries an expired deadline and receives
`request-expired`, which suppresses re-execution but no longer promises the historical message.

`expiresAt` governs first admission only, not ordering, uniqueness, receipt lookup, or a live
session. It must be in the future and no more than 24 hours ahead according to the runner’s clock.
Once accepted, expiry does not kill a session or erase a known outcome.

### Single-writer receipt ledger

The foreground runner is the sole writer. Each receipt is schema version 1 and contains only:

- binding id, request id, canonical body fingerprint, and declared request fields;
- state and phase timestamps from the runner clock;
- deterministic session id and current channel id when known;
- worktree ownership phase, the snapshotted project-map version, and canonical local
  repository/worktree paths plus file/ref identity needed for recovery;
- terminal refusal/failure/exit fields; and
- no resolved executable, argv, environment, key/fingerprint, endpoint/address, attach token,
  bearer token, signing material, or arbitrary child output. Local absolute recovery paths never
  enter wire messages, CLI output, logs, or saved verification evidence.

Writes use atomic replace, file and directory fsync, compare-and-set on current state, and a
single-process serialization queue. Whole-image replacement is a deliberate local reliability
trade-off: the hard 24 MiB aggregate JSON budgets bound each write and simplify crash recovery. The
five-second rule guarantees a visible bounded outcome, not admission on storage too slow to sync;
such storage fails closed. A transactional journal may replace this format only under a separately
reviewed additive migration, not as a review-round rewrite. A receipt/audit state is durable before the corresponding
accepted, refused, started, failed, or finished message is sent. Readers after restart see the last
fully committed version or fail closed; a partial, corrupt, or over-cap ledger never becomes an empty or partially recovered ledger.
Schema evolution is additive: new fields are optional, unknown fields are ignored, and a newer
major schema is a startup failure rather than a guessed migration. Persisted ledger JSON is limited
to 64 levels of nesting, 8,192 value nodes per receipt or tombstone, and 1,000,000 value nodes per
complete image. Non-JSON, cyclic, over-depth, or over-complex values fail as storage-unavailable
before recursive parsing, cloning, byte measurement, equality, or compaction.

Limits apply globally across every current and retired binding in one runner home:

- at most 32 in-flight receipts;
- at most 4,096 full receipts and 8 MiB;
- terminal receipts retained at least 24 hours after terminal state;
- then a compact tombstone containing `bindingId`, `requestId`, fingerprint, terminal message kind,
  reason or exitCode/signal, stable session id when applicable, and expiry timestamps for 30 days;
- at most 32,768 tombstones and 16 MiB; and
- no live, in-flight, unexpired, or not-yet-tombstoned receipt is evicted to make capacity.

Binding revocation prevents new receipts in that namespace and drives its live sessions to the
normal kill/terminal path; its terminal records compact under the same global limits. Re-pair does
not reset budgets or delete old tombstones.

A fixed-size ledger header, outside the receipt/tombstone budgets, owns a durable
`capacityBlockedUntil`. If a full receipt reservation is impossible, the runner atomically raises
that value to at least the request’s `expiresAt`, durably appends the bounded refusal audit, and only
then returns `at-capacity`. While the block is active, every previously unknown request with a later
expiry durably extends the header to that expiry before receiving `at-capacity`; admission cannot
resume until the maximum deadline of every request refused under the block has passed. This global
block is a deliberate idempotency trade-off, bounded by the 24-hour request-expiry ceiling: it
prevents an unbounded stream of unknown request ids refused without individual receipts from later
executing on retry. Per-request capacity tombstones were rejected because they merely move the same
attacker-controlled exhaustion into another finite store.

The runner owns a segmented append-only audit lifecycle under the mode-`0700` `audit.jsonl/`
directory. New schema-v2 records are canonical, secret-free, at most 16 KiB, and receive a monotonic
sequence inside the lifecycle rather than from callers. One segment holds at most 8 MiB or 16,384
records. At most eight segments, including exactly one open segment, remain resident; manifests,
archive acknowledgements, reclamation tombstones, the open commit marker, and the migration marker
share a 1 MiB metadata budget. These are local product constants, not wire-configurable limits.

Routine capability discovery is one aggregate transaction: a bounded admission record is durable
before any version/auth/endpoint probe, and one bounded outcome is durable before its snapshot is
published. Workload, git/tmux, preview, pane, refusal, policy, kill, admission, and outcome events
retain their individual audit treatment. No record contains command, argv, environment, credential,
token, key, endpoint address, CLI output, or raw hostile input.

The segment state machine is `OPEN → SEALED → ACKED → RECLAIMED`. Each append durably records the
exact pending canonical line, syncs segment bytes, and then advances the committed byte/count/hash
marker before acknowledgement. Rotation seals exact bytes and commits a digest-chained manifest with
file and directory sync. Recovery truncates only a proved prefix of the pending line, completes one
unique interrupted final seal, and fails closed on corrupt, missing, conflicting, over-limit, or
newer-major state.

`modula-runner audit archive --output <directory>` is an offline local operator command under the
exclusive runner-home lease. The destination must be an existing current-user mode-`0700` directory
outside the runner home; the control plane cannot select it or receive its contents. Exact segment
and manifest bytes are copied, synced, renamed, reread, and digest-verified. Only then is a
content-specific acknowledgement durable; only an acknowledged segment receives a durable
tombstone and becomes reclaimable. A full resident budget with no acknowledged reclaimable segment
admits/spawns nothing, emits at most the bounded connection-level `storage-unavailable` error, and
closes job control.

A legacy regular `audit.jsonl` migrates without JSON reserialization into a schema-v1 sealed prefix;
new writes continue in schema v2. Fixed `.migrating` and `.legacy` names plus `migration.json` are
crash-recovery phases. The directory installed at the old pathname makes an older binary fail closed
rather than start an empty log. The portable durability claim is process-crash safety after
successful Node/OS file and directory sync calls; it does not claim Darwin `F_FULLFSYNC` physical-
power-loss semantics.
If any header, receipt, or audit mutation required for the claimed result cannot become durable,
durability-before-ack takes priority. This includes either partial at-capacity case: durable header
with failed refusal audit, or durable audit with failed header. The runner immediately enters
storage-unavailable mode, begins no new admission/spawn, emits one bounded connection-level
`storage-unavailable` error if the socket remains writable, and closes job control rather than
fabricating a correlated result it cannot remember. A partially written capacity block remains
fail-closed after recovery. This required-persistence-failure path is not `SESSION_REFUSED` or
`SESSION_FAILED`.

Expired terminal receipts compact oldest-first into replay-capable tombstones. Tombstones delete
oldest-first only after 30 days. Known exact duplicates consult full receipts/tombstones before the
capacity block and replay their known outcome.

### State machine and crash recovery

```text
accepted → provisioned → spawn-intent → started → finished
    └──────────────→ failed
pre-admission ─────→ refused
ambiguous recovery → uncertain
```

- `accepted` is durable before `SESSION_ACCEPTED` and before provisioning side effects.
- Worktree phases journal branch creation, git registration, clean verification, and exact ownership.
- `provisioned` means the exact local target exists/reuses cleanly and remains grant-contained.
- Stable `sessionId` and deterministic tmux identity are durable in `spawn-intent` before spawn.
- `started` is durable only after the matching child/channel exists and required audit outcome is
  durable; then `SESSION_STARTED` may escape.
- `finished`, `refused`, `failed`, and `uncertain` are terminal receipt states.

On restart:

- `accepted` before ownership side effects may resume.
- A journaled branch/worktree whose registration, ref, expected base, path, and clean state all
  match may resume or be adopted.
- A `spawn-intent` with the exact matching owned live tmux session may be adopted under the same
  stable session id only after the prior channel is authoritatively closed/lost and a durable
  generation compare-and-set claims `replacement-intent`; the replayed `SESSION_STARTED` carries the
  new current channel id. Unknown close or competing recovery remains uncertain and mints nothing.
- A completed audit/exit may settle `finished` without respawn.
- If the journal and git/tmux reality disagree, or a spawn may have run and vanished without a
  durable outcome, state becomes `uncertain`, result is `recovery-uncertain`, and no automatic spawn,
  kill, rollback, or deletion occurs.

Rollback/resume touches only a branch/path/session whose durable receipt proves ownership and whose
current identity still matches. A contender’s registered lane is never deleted. A single-home lock
prevents two foreground runners from writing one home. Distinct homes that map the same checkout
remain explicitly outside this contract; the automated single-runner proof is a shadow and makes no
checkout-wide exclusion claim.

### Correlated timing and no silence

- A valid request for which a receipt/audit mutation can become durable receives
  `SESSION_ACCEPTED` or `SESSION_REFUSED` within 5 seconds.
- An accepted request reaches `SESSION_STARTED` or `SESSION_FAILED` within 180 seconds while every
  state/audit mutation required for that result remains durable. Persistence failure within the
  window takes the connection-level uncertainty path instead of an undurable correlated result.
- Deadline expiry triggers bounded cleanup. It emits `launch-timeout` only when cleanup proves no
  launch-owned child/session remains. When the exact channel is confirmed closed but child/session
  cleanup remains unconfirmed, the receipt durably enters `uncertain`, emits only
  `SESSION_FAILED recovery-uncertain`, preserves the operator inspection/kill path, and forbids
  automatic redrive or a new id for the same work. If exact-channel close itself is unknown, the
  connection-level exception above applies and no correlated result is fabricated.
- A session may run indefinitely after `SESSION_STARTED`; terminal liveness/heartbeats and
  `SESSION_FINISHED`/terminal `EXIT` describe that lifecycle rather than the launch deadline.
- Exact duplicates replay the current receipt message within 5 seconds.
- Job-control transport may reconnect automatically. If any launch on the lost channel is
  nonterminal or lacks a received durable admission result, the loss is ambiguous: the counterpart
  marks the affected requests `storage-uncertain` and performs no automatic request redrive. After
  operator reconciliation confirms runner storage health and owned side effects, only the original
  ids may be redriven; a new id or second spawn is never authorized.
- `recovery-uncertain` tells the counterpart to stop automatic redrive and require operator
  inspection/kill; uncertainty is never rendered as success.
- Failure of any persistence mutation required for a claimed result is the sole correlation
  exception. A received connection-level `storage-unavailable` error and an ambiguous job-control
  loss with nonterminal launches have the same safe outcome: the counterpart marks every affected
  request whose durable terminal result is not known as `storage-uncertain`. That is counterpart
  state, not a runner wire result. It sends no automatic retry or substitute request id. After
  runner storage recovery, an operator reconciles using the original ids and any existing receipts;
  a launch-owned child/channel that may have started before failure detection follows ordinary
  `recovery-uncertain` inspection rather than guessed absence.

## Part 5 — pairing and launch evolution

Pairing HTTP path version 1 is independent of WebSocket protocol version 2. Pairing body changes are
additive within the frozen v1 response because the current shape was explicitly a proposal and no
counterpart has shipped; after counterpart adoption, a breaking body change requires `/v2/` paths.

Session-launch message names, required fields, and closed reason enums activate under protocol v2.
New optional response fields may be additive when old readers ignore them. Removing/repurposing a
field, adding a required field, changing meaning, or growing a closed enum in a way an old v2 reader
rejects requires the next protocol version.

## Counterpart ownership and evidence

The proposed adopter is the customer-control-plane backend in `ModulaStack/modulastack`. Before the
real Task #47 journey, that owner must:

1. confirm repository/team ownership and approve B-01…B-16;
2. publish matching pairing and v2 launch types/validators;
3. prove code consumption, pending expiry, nonce-bound constant-time confirmation, and no token
   retrieval;
4. persist request/body/receipt mapping across its reconnect and restart;
5. obey version negotiation and never launch against v1;
6. render accepted, refused, failed, recovery-uncertain, storage-uncertain, offline, and stale
   distinctly, and stop automatic redrive for either uncertainty state;
7. treat both a received storage-unavailable close and an ambiguous loss with nonterminal launches
   as storage-uncertain, then reconcile original request ids under operator control; and
8. pass independent counterpart tests plus the physical two-machine gate.

The runner’s loopback stub proves only transcript compatibility and negative boundary behavior. It
cannot satisfy any server persistence, UI rendering, credential authority, relay, or physical
infrastructure obligation.

## Interface-first handshake after approval

G1-2 may add public pairing and launch types, constants, validators, and store ports with throwing
bodies. It may export `SESSION_LAUNCH_PROTOCOL_VERSION = 2`, but it must not raise the active
`PROTOCOL_VERSION` or accept launch traffic yet. The verifier then writes runtime-red acceptance
specs from this contract and its 145-obligation matrix before production bodies are implemented.

The interface must expose enough to test:

- exact pairing envelopes/proof and status mapping;
- v2 launch messages and closed outcomes;
- request canonicalization/fingerprint;
- project/profile target validation;
- receipt state/CAS, capacity, retention, expiry, and restart recovery ports; and
- version-gated decode/no-silence behavior.

No private adapter, implementation-derived fixture, test-only field, or generic exec command is an
acceptable substitute.

## Fitness checks

The eventual implementation gate includes automated checks that:

- no launch JSON property is named or shaped like command/argv/env/key/endpoint/absolute path;
- v1 negotiation cannot produce a launch spawn;
- same id/same body across concurrent delivery, reconnect, and restart causes at most one spawn;
- same id/different body is immutable conflict;
- every crash boundary resolves to resume/adopt/terminal uncertainty without destructive guessing;
- one request never has competing live terminal channels; recovery replacement requires a durable
  generation winner, and delayed retired-generation events cannot affect the current channel;
- ledger count/byte/time limits refuse instead of evicting live state;
- pairing proof changes under nonce, binding, runner, or origin changes and never reveals the token;
- initial results meet 5 seconds and accepted requests meet 180 seconds while all required
  persistence stays durable;
- failure of any required persistence mutation begins no new admission/spawn after detection,
  closes job control, and leaves every affected nonterminal counterpart request storage-uncertain
  without automatic redrive; a possibly earlier child remains subject to recovery-uncertain
  inspection; and
- the stub suite labels every real-counterpart obligation as a shadow.

## Approval gate

The operator approved the durability-first ruling for total persistence failure on 2026-08-21.
G1-1 otherwise completes only when the operator and named counterpart owner approve B-01…B-16 or
record a revision. Until then, no protocol interface file, active version bump, runtime body,
counterpart implementation, push, or PR is authorized.

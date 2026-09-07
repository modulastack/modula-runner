# JSON output contract

`--json` exists so a co-resident reader — today the desktop shell — can read runner state without
parsing human prose and without a second way into the runner home. `--json` is a rendering: it adds
no surface the human commands do not already have, and a command does the same work with the flag
as without it.

The CLI remains the only reader of the runner home. A consumer that wants runner state runs the
CLI; it does not open the home itself.

## Side effects a consumer inherits

`--json` adds none of its own. It hides none either, so what the human command does, the JSON
rendering does too. Two things it does are worth naming, because a consumer that polls will meet
both.

**Opening the runner home creates it.** Every command opens the home before it answers, and a home
that is absent is created — the root and any missing ancestor, at mode `0700`, fsynced. A consumer
probing a machine that has never run the runner leaves a runner home behind by asking.

**`status` finishes an interrupted pairing confirmation.** When the stored binding is `pending` —
a confirmation that a restart or a network failure left unfinished — `status` resumes it before
answering. That sends a request to the control plane, and every outcome of the exchange writes the
binding record: a confirmation settles it, a refusal or an expired code revokes it, an unreachable
plane marks the confirmation unknown. No other pairing state contacts anything or writes anything.

The consequence for a polling consumer: while a binding stays `pending` because the plane is
unreachable, *every* `status` call retries the confirmation, so the poll interval becomes the retry
interval. Whether an observational consumer should be able to read pairing state without driving
the confirmation is open — see issue #99. Until it is settled, a consumer polling `status` chooses
that interval knowing it is a retry interval.

Every other command named here reads and answers, and writes nothing beyond the home creation
above.

## Envelope

Every `--json` command writes a single JSON value to stdout and nothing else. Diagnostics go to
stderr as they do today, so a consumer can parse stdout unconditionally.

Success is the command's own object. Failure is exactly:

```json
{ "error": { "code": "<code>" } }
```

Failure exits non-zero. `error` and a success payload are never both present. A consumer that sees
`error` needs no other field to act.

`audit tail --json` is the one exception to "a single JSON value": it emits JSON Lines, one record
per line, because it is a stream. Its failures still use the envelope above, on stdout, as one
final line.

## Redaction

**Only fields that are already redacted in human output may appear.** `--json` is a second
rendering of the same facts, never a wider view. In particular:

- `key list` emits `label`, `provider`, `lastFour` — never the key.
- `endpoint list` emits `id` and `kind` — **never `baseUrl`**.
- `profile list` emits `id`, `runtime`, `access`, `model`, `binding`.
- `grant list` emits resolved real paths, `grantedAt`, and the platform note.
- `audit tail` emits records as the audit log already redacts them.

A field absent from human output is absent here. Adding one is a change to what the runner
discloses and belongs in its own review, not in a rendering change.

## Timestamps

Every timestamp is an ISO 8601 string in UTC with a `Z` suffix. No epoch numbers, no local time.
This includes `pairedAt`, `pendingSince`, `revokedAt`, and `grantedAt`.

## `error.code` is one flat vocabulary, and every code is namespaced

`status --json` can fail for two unrelated reasons: the runner home could not be opened, or the
pairing contract refused. Both surface through the same `error.code`. That is deliberate — a
consumer should not need to know which subsystem answered in order to read the failure — but it
only works if the two vocabularies can never produce the same string for different meanings.

**Rule: every code carries a domain prefix.** The prefix is part of the code, not a separate
field. A consumer switches on the whole string.

| Domain | Prefix | Source |
|---|---|---|
| Home preflight | `policy-`, `state-`, `config-`, `audit-` | `RUNNER_HOME_FAILURES` |
| Pairing contract | `pairing-` | `PAIRING_CONTRACT_FAILURES` |

The home vocabulary already satisfies this: all fifteen codes are prefixed. The pairing vocabulary
does not — ten of its eleven codes are bare words (`refused`, `superseded`, `unreachable`,
`store-failed`, …) and exactly one, `pairing-in-progress`, carries the prefix. That single member
is the evidence this was the intended convention all along and drifted; it is not a design that
chose bare words.

**So the pairing codes are renamed to carry the `pairing-` prefix**, and `PAIRING_CONTRACT_FAILURES`
becomes the prefixed list. This is done now, before `--json` emits either vocabulary and before any
consumer exists, because it is free today and a breaking change once the shell ships.

Why a prefix rather than a second field: a `domain` alongside `code` would widen the envelope for
every consumer while still requiring them to switch on `code`. The prefix carries the same
information in the field they already read, and makes a collision impossible to introduce silently
rather than merely unlikely.

Today the two sets are disjoint. The rule is what keeps them disjoint as either grows.

## Home preflight error codes

- `policy-missing`
- `policy-malformed`
- `policy-unknown-key`
- `policy-bad-signature`
- `policy-trust-migration-required`
- `policy-trust-unauthorized`
- `state-wrong-owner`
- `state-insecure-mode`
- `state-not-regular`
- `state-linked`
- `state-io-failed`
- `state-busy`
- `config-invalid`
- `config-duplicate`
- `audit-unavailable`

## Pairing contract error codes

- `pairing-invalid-code`
- `pairing-expired-code`
- `pairing-unreachable`
- `pairing-refused`
- `pairing-malformed-response`
- `pairing-store-failed`
- `pairing-settle-failed`
- `pairing-superseded`
- `pairing-in-progress`
- `pairing-already-paired`
- `pairing-confirmation-uncertain`

## Versioning

The envelope is additive. New fields may appear in a success payload; a consumer must ignore
fields it does not know. Fields are not removed or retyped without a new command surface. New
`error.code` values may be added within an existing prefix, so a consumer must treat an unknown
code as a failure it cannot classify rather than as a parse error.

## The contract is pinned by a test

`docs/model-access.md` and `docAgreement.test.ts` exist because prose and validators drifted
before. The same applies here: a test asserts that every value in `RUNNER_HOME_FAILURES` and
`PAIRING_CONTRACT_FAILURES` appears in this document and carries a prefix from the table above.
A code the runner can emit that this document does not name is a promise nobody can look up.

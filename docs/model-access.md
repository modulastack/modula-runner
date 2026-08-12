# Model access

*Contract version 1 · 2026-08-11 · the runner-side statement of tri-modal model access, the
way [`runner-seam.md`](runner-seam.md) is the runner-side statement of the seam. The
wire-level companion is [`SCHEMA.md`](../packages/protocol/SCHEMA.md).*

Model access is **tri-modal** and resolved **entirely on the runner**: your CLI's own
subscription login, an API key held in the runner's encrypted local store, or a local model
on your own hardware. The hosted plane holds profile metadata and never a secret. This
document is what the acceptance tests cite; where prose and code disagree, the code is right
and this document has a bug.

## The three access modes

| `access` | What authenticates | Where the credential lives |
|---|---|---|
| `subscription` | The CLI's own login, on your machine | The CLI's own store, which the runner never reads |
| `api-key` | A provider key you gave the runner | The runner's encrypted local store, injected env-only |
| `local` | Nothing — the endpoint is yours | Nowhere; the endpoint is on your hardware |

None is required and none is privileged. A profile without an `access` field behaves as
`subscription`, which is what the co-resident deployment did before this existed.

## Two things called "profile"

They are different objects and this repository keeps them apart:

- **Terminal `profile`** — a pane label (`coder`), opaque to the protocol, unchanged since
  the terminal payloads were specified. The protocol deliberately does not enumerate these.
- **Model profile** (`modelProfileId`) — names a model, its access mode, and what serves it.

The field is `access` everywhere. "Mode" is not a word this contract uses.

## What the control plane may do, and may not

A model profile has two halves. The control plane holds the metadata half — provider, model,
`access`, label, and for an `api-key` profile the key's label and last-four fingerprint. The
half that resolves to a credential or an address exists only here.

> The control plane may **name** a model profile the operator created locally. It may not
> create one, may not name or choose a key, may not supply an endpoint address, and may not
> cause a key to be used by any command outside the runner's local runtime catalog. A name
> this runner does not hold is refused by name — never resolved to a default, never resolved
> to "the only key we have", and never treated as a request to create one.

Version 1 has no frame in which the control plane requests a pane, so this boundary is
enforced where a launch is decided: in the runner's resolver. The refusal vocabulary is
defined now so the slice that adds a launch request inherits it rather than inventing a
second one.

**The runtime catalog is the pane-level allowlist.** The moment a control-plane-named profile
selects a runtime, the control plane names a command by proxy. Runtimes are held locally,
keyed by name; no command and no argument vector crosses the wire, exactly as
`PREVIEW_START` names a recipe and never a command line.

### The runtime catalog supplies the arguments

A profile names a model and a mode; it does not name a command line. The local runtime
catalog holds the rest, because argument knowledge is exactly what may not cross the wire:

- `modelFlag` — how this runtime is told which model to run. Defaults to `--model`.
- `accessArgs` — arguments a mode needs. `codex` declares `{ local: ['--oss'] }`, which the
  requirement names explicitly.
- `keyVariable` — which environment variable carries a provider key. Defaults to
  **`<PROVIDER>_API_KEY`**, uppercased with hyphens as underscores. The fixed suffix is
  load-bearing rather than cosmetic: a derived name can never collide with `PATH`,
  `LD_PRELOAD`, or anything else that matters, so operator-chosen text cannot become an
  arbitrary variable.
- `endpointVariable` — which environment variable carries a local endpoint's address.
  Defaults by kind: `ollama` → `OLLAMA_HOST`, `openai-compatible` → `OPENAI_BASE_URL`. It
  lives on the runtime and not the endpoint because the variable a CLI reads is a property of
  the CLI.

Defaults exist so the common case needs no configuration; the overrides exist so a runtime
that disagrees can say so instead of being wrong.

### Provider mismatch fails closed

An `api-key` profile **must** name its `provider`. Absent is `profile-incomplete`, not "no
mismatch is possible": sending an Anthropic key to an OpenAI endpoint is credential
disclosure to a third party, and a check that switches itself off when a field is missing is
the permissive default this document refuses everywhere else. A key whose own `provider`
differs from the profile's is `key-provider-mismatch`.

`provider` lives on the profile, not the runtime, because a CLI can serve several vendors —
one provider per runtime is simply false — while a profile names exactly one.

### Refusals name their reason

Every refusal is an answer, per the seam's fourth principle, and each spawns nothing — no
pty, no tmux session, no child process:

`unknown-profile` · `runtime-unknown` · `runtime-unavailable` · `runtime-unauthenticated` ·
`access-unsupported` · `unknown-key` · `key-provider-mismatch` · `unknown-endpoint` ·
`endpoint-unavailable` · `model-unavailable` · `profile-incomplete`

Unknown runtimes, undeclared access modes and provider mismatches all **fail closed**. The
permissive alternative — try it anyway — is the kind of default that looks harmless.

A refusal answers a question about *this* launch. **Local configuration that could never be
served is a startup failure instead**: a profile whose id is not a safe identifier, whose
provider could not form a variable name, or whose model name carries control characters makes
the resolver throw where it is constructed. The refusal vocabulary is for questions the wire
will one day ask, not for a config file that is wrong on its face — and a runner that starts
anyway would refuse every launch of that profile with a reason describing the symptom.

## The key store

API keys extend the pairing binding's custody rather than getting a second implementation of
it: AES-256-GCM with a fresh nonce per write, a separate 32-byte key file, `0600` on both,
exclusive creation, atomic publish, `fsync` before the rename and on the directory, and
ownership checked on the descriptor that is read rather than on the path. The honest limit is
the one the pairing store already states: this defends against casual disclosure and silent
tampering, not against a local attacker running as you.

**Entry is through the local CLI, prompted.** `modula-runner key add <label>` reads the key
from a hidden prompt. Not from an argument — arguments are readable by any local process —
and not over an inbound port, because the runner has none. The FRD described a browser
hand-off to a local page; that page would be the first inbound listener in the runner's
history, reachable by every process on the machine and by any page your browser visits, and
the schema had already settled the same question for pairing codes ("an inbound path… would
contradict the outbound-only rule the transport is built on"). The criterion was amended
rather than the rule bent. What it actually promised — **the key never transits the control
plane** — is delivered in full.

**Plaintext has one door and it is not a getter.** No API on the store returns a key as a
string. The stored secret is sealed directly into an injectable value bound to a caller-chosen
variable name, and that value renders as `[secret]` under `JSON.stringify`, string
interpolation and `util.inspect` — so a launch plan in a log line is not a credential in a
log file. Made true by construction, because remembering not to log is not a mechanism.

**The fingerprint is the literal last four characters.** That is partial key material, so the
exemption is written here rather than fudged in a test: with a minimum key length of 16, four
characters is a fingerprint and not a credential, and it is the only key-derived value
permitted to leave this machine. This is what reconciles the README's "no credential of any
kind" with the seam's "at most a key's label and last-four fingerprint".

**Injection is env-only, and env means env.** The key reaches the spawned CLI through its
environment and appears in no process's argument vector — not the CLI's, not the shell's, not
the tmux client's, not the tmux server's. The idiomatic tmux route (`new-session -e
KEY=value`) puts the value in a client's argv, world-readable, and is therefore disqualified
for secrets; the existing `env` field on a launch spec is for non-secret orchestration
variables only. The key is scoped to **the process it was injected into and nothing else**: a
tmux server is shared per worktree, so server-level inheritance would hand a provider key to
every later pane in that worktree, including a `local` pane that must never see one.

Env-only defends against other users on the machine — `ps` is world-readable,
`/proc/<pid>/environ` is not. It does not defend against an attacker already running as you.

**A running pane keeps working after its key is removed or rotated.** The value is in that
process's own environment and the runner cannot reach in. That is a property of env injection,
not a defect, and the kill switch is the answer that does exist. Stated because a documented
limitation is fine and a discovered one is a finding.

## Capabilities

At connect the runner advertises what this machine can actually do. Two fields carry it
jointly: `hello.runner` already carries OS and architecture, and the capability snapshot
carries runtimes and endpoints. The snapshot does not restate OS or architecture.

Capability state rides the **job-control channel**, not `hello`. A `hello` shares one 1 MiB
frame with a resume roster bounded at 1024 channels so that the frame always fits, an
oversized `hello` is terminal for the connection, and an operator-sized model inventory would
break that arithmetic — a large model library must not make a runner unable to connect. The
channel is also refreshable and sealable, so one mechanism serves the initial advertisement
and every later change. "At connect" is satisfied by publishing on **channel open**, which is
also the path a channel takes when it is reopened after expiring — the snapshot is announced
on change, so a reconnect that changed nothing would otherwise leave a peer holding none.

**Availability is per component, and not a claim about the combination.** A snapshot saying
this machine has `codex` and that its `local` endpoint is reachable does not say that codex
can drive that endpoint. Measured, not supposed: `codex 0.146.0` refuses Ollama `0.11.6` as
too old for it, and the runner reports that as an ordinary exit rather than predicting it.
This is the same caveat the auth field already carries — "credentials present" is not "a
session will succeed" — and it is why there is no version check here.

### Runtimes

Only **detected** runtimes are listed; absence is how a missing one is expressed, so the
protocol never carries a vocabulary of every CLI that might exist. Each entry reports the
version the runtime itself reported (`null` if it would not say), its auth state, and the
access modes it can serve. Claude Code is `subscription` and `api-key` only — a property of
the runtime, not of the architecture.

**Auth state is asked of the CLI, never read off disk.** The runner's file access excludes CLI
auth stores by construction and a test asserts it; login state is an inference *from* auth
material, so the only honest route is to ask the CLI about itself. `authenticated` means **the
CLI reports credentials present** — not that a session will succeed. Quota, rate limits and
wrong-account are outside this field, and `unknown` is a real answer for a runtime that offers
no way to ask.

Probing is command execution and is governed as such: probe commands come only from the local
runtime catalog, run deadline-bounded and non-interactively with stdin closed, in a neutral
directory, bounded in output and concurrency, and audited. The catalog holds only
version/status subcommands — a capability probe that bills on every reconnect is a real
failure mode, and this is where it is prevented.

### Local endpoints

Endpoints are **configured, not discovered**. The runner does not scan loopback ports; that
would advertise a colleague's model server on a shared machine without anyone asking.
"Detected" means detecting whether a configured endpoint is up. A default Ollama entry ships
in the default configuration — a default you can remove, not a scan.

**What crosses is the fact of an endpoint, never its address.** The wire carries the
endpointId, the kind, reachability, and the model inventory. It carries no URL, host, port or
scheme, because "local-model endpoint URLs" are on the seam's never-crosses list. An
unreachable endpoint reports an **enumerated reason** — `not-running`, `refused`, `timed-out`,
`unauthorized`, `unreadable-response` — and never an error string, because a transport error
carries the address it failed to reach and free text would leak exactly what the rest of this
paragraph withholds.

`endpointId` is **operator-chosen and never derived from the address**. A hash of
`http://127.0.0.1:<port>` has an input space of about 65,000 values and is brute-forced back
to the port in milliseconds. An operator-chosen name is also stable across restarts, so a
hosted binding survives a runner restart.

The endpoint URL reaches the CLI through the **environment, never argv**. It is not a secret,
but it sits on the never-crosses list beside credentials and the stated reason for the argv
rule — arguments are readable by any local process — applies to it verbatim. A non-sensitive
flag such as `--oss` is an ordinary argument.

**Model names are not safe identifiers.** Real ones contain a colon
(`llama3.1:8b-instruct-q4_K_M`), which the wire's safe-segment rule rejects. They cross as
bounded, control-character-free strings under their own rule, and the consequence is a hard
one: **a model name must never reach a filesystem path.**

Inventories are bounded and truncation is **visible**: `modelCount` carries the true total, so
a shortened list says so rather than quietly lying. An endpoint with nothing installed is a
reachable endpoint with an empty inventory, not a failure.

## Timing: what is promised, and what it rests on

The probe cadence is the **runner's**, not the control plane's. Deriving it from the negotiated
heartbeat would let a peer whose trust extends only to "schedule work and relay operator
input" decide how often this machine polls your local service — and the schema's floor of
200 ms would make five probes a second a compliant instruction. The heartbeat policy is
bounded for that same class of reason.

- A capability change is advertised **within one refresh interval** (`CAPABILITY_REFRESH_MS`,
  clamped at `MIN_CAPABILITY_REFRESH_MS`), measured from the change.
- Removing an endpoint from local configuration takes effect **immediately** — no probe is
  involved. Stopping the service is the case with detection lag, and only that one is measured
  against the interval. The acceptance criterion conflated the two; they are separate events.
- A launch against a `local` profile **re-probes under its own deadline before spawning**.
  This is what makes "fails fast, never a hung spawn" true by construction rather than true
  when the cadence happens to have caught up — and it is the only form that covers an endpoint
  which accepts the connection and then answers nothing, where waiting on the OS default is a
  two-minute hang rather than an instant `ECONNREFUSED`.

## Probe shapes — PROPOSAL

Ollama's API belongs to its project and the OpenAI-compatible shape is a de-facto convention,
so these are **this runner's proposal**, recorded the way the pairing redemption shape was —
strictly validated, so a drifting server fails loudly instead of half-working.

| Kind | Health + inventory | Read from the response |
|---|---|---|
| `ollama` | `GET {baseUrl}/api/tags` | `models[].name` |
| `openai-compatible` | `GET {baseUrl}/v1/models` | `data[].id` |

Both were checked against Ollama 0.11.6, which answers *both* paths — so the reference
integration is reachable under either kind, and the two are not mutually exclusive in
practice. The same check is where the model-name rule above stops being theoretical:
`deepseek-r1:32b`, `nomic-embed-text:latest` and `llama3.2:3b` are real inventory entries and
none of them is a safe identifier.

"Compatible" means exactly this much: answering that path with that shape. A 200 whose body
does not parse is `unreadable-response`; a 401 or 403 is `unauthorized`; a connection refused
is `not-running`; anything that outruns the deadline is `timed-out`. Responses are read
through a byte cap, like every other external response this runner reads.

## What this contract does not promise

- **No usage accounting.** The runner counts no tokens, tracks no spend and enforces no cap.
  "Metered" is a cost-framing label the hosted UI renders; cost visibility would be a separate
  obligation and it is not in this one.
- **No version semantics.** Runtime versions are reported as the runtime reported them. There
  is no minimum-version rule and no compatibility check.
- **No binding prevention.** The runner refuses to *serve* a profile whose capability it
  lacks. Preventing the binding from being made is the hosted plane's obligation, derived from
  the advertisement — the runner cannot prevent what it cannot observe.
- **No positional model argument.** `modelFlag` names a flag whose value is the model, which
  covers every runtime in the catalog. A runtime that takes the model as a bare positional
  (`ollama run <model>`) cannot be expressed, and adding one is a catalog change rather than a
  configuration change. Written down because it is a real future case, not a hypothetical one.

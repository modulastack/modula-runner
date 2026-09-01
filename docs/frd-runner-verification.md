# FRD — Runner verification and pre-audit

Status: approved by operator on 2026-08-21 · Owner: runner · Revision: 2026-08-21 ·
Source baseline: `main@c678e2819927525edab55330ecc3955b64a36db7`

This plan precedes the external third-party security audit, which remains the general-
availability stop-gate. Approval of this document authorizes only the bounded implementation
and verification sequence it describes. It does not authorize a tag, release, deployment,
registry publication, repository-setting change, production credential, audit self-approval,
or general-availability claim.

## Outcome

CP-1 through CP-6 are implemented as a library and release-engineering pipeline. The missing
product proof is an installed process exercised from outside the source tree. This plan produces:

1. one directly installable `modula-runner` command without publishing to a package registry;
2. an independent black-box suite that drives the installed command against a contract stub;
3. a two-machine journey against the customer-run control-plane topology;
4. a whole-runner internal security audit; and
5. an evidence package suitable for the later independent external audit.

The plan separates release-candidate evidence from actual-release evidence. Pre-audit work may
build and install an unsigned candidate tarball. Sigstore identity and provenance are verified
only after the audits and a separate human authorizes an immutable tagged release.

## Approval record

On 2026-08-21 the operator approved V-1…V-8 as written and authorized the next local G1/G2
launch-contract and CLI-interface work under verifier checkpoints. This approval does not authorize
a push, PR, credential, infrastructure mutation, tag, release, deployment, audit acceptance, or GA
claim; each remains at its later explicit gate.

## Approved decisions

These rulings are approved as a set. A future revision reopens only the decisions it changes and
must pass the same independent review and human gate.

| ID | Approved ruling | Cost accepted |
|---|---|---|
| V-1 | Keep the source workspace private and make the CP-6 tarball itself the install unit. Its release-stage root manifest exposes one `modula-runner` bin; no npm-registry publication. | Operators need Node/npm and the tarball rather than a standalone native executable. |
| V-2 | The installed process runs in the foreground. `run` owns the outbound connection and all children; SIGINT/SIGTERM invoke the local kill switch. No daemonization, service installer, PID signaling, or local control socket in this slice. | Service-manager integration and a separate `kill` command are deferred. |
| V-3 | Add a separately reviewed launch-contract checkpoint before calling the runtime complete. A control-plane request may name only a local profile and a granted project/worktree target; it may never carry a command, argv, environment, credential, or endpoint. | Task #45 gains a protocol/composition prerequisite; a test-only `exec` backdoor is forbidden. |
| V-4 | The installed `pair` command accepts the code only through a hidden TTY prompt. The lower-level compatibility function that can accept an argv value is not the production command contract. | README/roadmap examples using `pair <code>` must be corrected with the CLI implementation. |
| V-5 | Automated tests use a loopback contract stub. The real gate uses a customer-run control plane, optionally reached through the content-blind coordination/relay topology defined by seam v2; there is no “Modula-hosted control plane.” | Task #47 blocks until the external plane and human-owned infrastructure exist. |
| V-6 | Required first-release evidence targets Ubuntu 24.04 x64 and macOS arm64 with Node `22.22.3`. Other architectures and Windows receive no support claim in this plan. | Broader platform support waits for its own evidence. |
| V-7 | Split A6 into `A6-candidate` before audit and `A6-release` after audit. The first proves reproducibility, contents, SBOM, checksums, installation, and CLI smoke; the second proves Sigstore/provenance and immutable publication. | Pre-audit evidence cannot claim that a signed release exists. |
| V-8 | Independent acceptance ownership applies. After an interface-only CLI/launch commit, the verifier writes the black-box obligation matrix and initial runtime-red tests; the implementer cannot edit those assertions. | Task #45 uses an interface-first checkpoint instead of implementing the whole process in one pass. |

## Scope

In scope:

- CP-1 seam/protocol and outbound WSS lifecycle;
- CP-2 terminal, tmux, flow control, and deterministic worktrees;
- CP-3 pairing, presence, preview adjacency, and containment;
- CP-4 subscription, API-key, and local-model access;
- CP-5 allowlist, consent, kill, audit, and credential boundaries;
- CP-6 candidate packaging, reproducibility, SBOM, vulnerability policy, and later release verification;
- the minimal production composition and persistence adapters needed to run those components.

Out of scope:

- implementation of the customer-run control plane or coordination service;
- npm-registry publication, an installer script, background service registration, auto-update,
  Windows support, or a standalone bundled native executable;
- after-the-split product features;
- a real tag/release before all audit and release gates pass;
- the external audit itself, except preparing its evidence.

## Preconditions and blocking dependencies

| Dependency | State | Gate |
|---|---|---|
| CP-1…CP-6 and PR #22 remediations | Landed | Satisfied by the source baseline. |
| Installable executable/package contract | Missing | Task #45. |
| Production state/policy/profile adapters | Missing | Task #45; must fail closed before `run` connects. |
| Terminal/model launch initiation | Missing | **Blocking launch-contract checkpoint V-3 before runtime implementation.** |
| Pairing endpoint counterpart | Runner proposal only | Stub may freeze the proposal; Task #47 requires explicit adoption by the real control-plane owner. |
| Real customer-run control plane and coordination topology | Outside this repository | Human infrastructure gate before Task #47. |
| Second supported physical machine | Not supplied | Human infrastructure gate before Task #47. |
| Release rules #23 and #24 | Open | Must close before `A6-release`; they do not authorize a release by being fixed. |
| External auditor | Not engaged here | Human gate after the internal audit. |

## Installed CLI contract

### Package and installation

The source monorepo remains `private: true`. The deterministic release staging step creates a
root install manifest named for the runner artifact and maps:

```json
{"bin":{"modula-runner":"packages/runner/dist/bin/modula-runner.js"}}
```

The referenced compiled ESM file begins with `#!/usr/bin/env node`, is included in the tarball,
and is executable on POSIX. A nested workspace `bin` alone is insufficient: the outer tarball
is what the operator installs, so its root manifest owns the command.

The supported pre-release install forms are:

```bash
npm install --global ./modula-runner-<version>.tgz
npm install --global --prefix "$isolated_prefix" ./modula-runner-<version>.tgz
```

The second form is the automated and non-root smoke path. It must create
`$isolated_prefix/bin/modula-runner` and work after the source checkout, original `node_modules`,
original npm cache, and original application home are unavailable.

npm runs dependency lifecycle scripts during a normal tarball install. The shipped runner must
need no TypeScript compiler or development dependency, but Linux may need the documented native
build prerequisites for `node-pty`; the install evidence records whether a prebuild or local
native build was used. `--ignore-scripts` is not an accepted production install because it would
silently disable the pty dependency.

### Command surface

| Command | Contract |
|---|---|
| `modula-runner --help` / `--version` | No state mutation; version equals the candidate manifest. |
| `modula-runner pair --control-plane <https-or-loopback-http-url>` | Reads the code from a hidden TTY prompt, redeems outbound, durably stores the pending binding, confirms by token proof, and never prints the code or token. No positional code is accepted by the production dispatcher. |
| `modula-runner status [--json]` | Reports unpaired/pending/paired/revoked and the exact containment disposition—`network-namespace` or `detect-and-stop`—plus `prevention` and bounded detail, without secrets or a false live-connectivity claim. |
| `modula-runner run` | Foreground composition root. Loads trusted local policy and state before dialing; opens one outbound WSS connection; owns presence, hosts, capabilities, and shutdown. |
| `modula-runner key add/list/remove` | Uses the existing hidden-secret and redacted-output contract. |
| `modula-runner profile add/list/remove` | Creates complete local launch profiles from a runtime, access mode, model, and access-specific provider/key label or endpoint id. It accepts no command, argv template, secret, or endpoint address. List output is redacted and removal affects later launches only. |
| `MODULA_RUNNER_ENDPOINT_URL=<url> modula-runner endpoint add <id> --kind <kind>` / `endpoint list/remove` | Creates configured local endpoints through the model contract’s environment-only URL input. List/capability output never prints the address; removal takes effect immediately. |
| `modula-runner grant <dir>` / `grant list` / `grant revoke <dir>` | Mutates durable local consent only; revocation governs later admissions and does not claim to stop an existing pane. |
| `modula-runner allowlist init/sign/verify/trust rotate` | Keeps operator signing keys outside runner state, stores anchors with the signed policy in one authoritative CAS record, tombstones the legacy self-authenticating record, and requires a currently pinned key to authorize restart-safe anchor rotation. |
| `modula-runner audit archive --output <directory>` | Runs only while the runner is offline under the exclusive home lease. It refuses unsafe/overlapping destinations and conflicting files; copies, syncs, renames, rereads, and verifies exact segment/manifest bytes before acknowledging custody and reclaiming the sealed source. |

Exit code `0` means the requested operation completed, `2` means usage or local configuration was
invalid, and `1` means a runtime operation failed. Errors go to stderr; machine-readable status
goes to stdout only under `--json`. No secret is accepted in argv or a caller-provided environment
variable. The endpoint URL is the one non-secret environment input and is never echoed, persisted in
shell history by the runner, or included in list/capability output.

### Local state boundary

`MODULA_RUNNER_HOME` selects an isolated home for tests and explicit operator setups; the default
is `~/.modula-runner`. That directory is mode `0700`. Secret/key material and mutable records are
regular files owned by the current user and mode `0600`; symlinks, hard-link surprises,
wrong-owner files, and permissive modes fail closed.

The home owns distinct records for the encrypted pairing binding, encrypted API keys, grants,
local model profiles, configured endpoints, signed allowlist, and public trust anchors. Audit is a
mode-`0700` segmented `audit.jsonl/` directory, not a replaceable home record: it owns canonical
append, rotation, digest manifests, offline archive acknowledgement, reclamation tombstones, and
legacy migration behind one lifecycle interface. The implementation owns filenames and atomic
writes; callers receive one home interface rather than independent path knobs. `profile` and
`endpoint` are the public mutation
surfaces: each validates the complete proposed record set, refuses unsafe identifiers, duplicates,
control characters, incomplete access-specific fields, or an invalid URL before an atomic durable
replace, and never leaves a partially updated file. Manual corruption or duplicate records are a
pre-connect startup failure. Their contents never cross the wire, and the control plane cannot
create or edit them.

Startup/policy failures use one stable CLI vocabulary. Lower-level allowlist reasons map to
`policy-missing`, `policy-malformed`, `policy-unknown-key`, and `policy-bad-signature`; filesystem
checks use `state-wrong-owner`, `state-insecure-mode`, `state-not-regular`, `state-linked`, and
`state-io-failed`; invalid or duplicate local configuration uses `config-invalid` or
`config-duplicate`; and an unusable audit sink is `audit-unavailable`. Human stderr begins with the
code and bounded guidance. `status --json` returns the same code under `error.code`, never a second
vocabulary.

`run` performs all preflight checks before connecting. Any failure above prevents connection and
spawning. On the first SIGINT/SIGTERM it stops the client synchronously, gives terminal/preview
teardown 15 seconds, then gives the final audit append 5 seconds. Confirmed teardown plus durable
audit exits `0`; any child uncertainty or audit failure/timeout prints `unconfirmed — …` and exits
`1`, so signal handling finishes within 20 seconds. Additional signals are idempotent while cleanup
runs; a second signal forces immediate exit `1` with `unconfirmed — forced exit during cleanup` and
never starts a second teardown or claims a durable record it could not finish.

## Launch-contract checkpoint

A2 and A4 are not executable from the current public surface: no command or protocol message
initiates a terminal/model session. This is a product-contract block, not a testing limitation.
Before Task #45 implements the runtime, a separate reviewed checkpoint must specify:

- one job-control request with a bounded request id, a locally meaningful profile id, and a
  granted project/worktree target;
- runner-side resolution from that profile to the command, arguments, non-secret environment,
  secret injection, and optional local endpoint;
- deterministic worktree provisioning rules;
- terminal-channel creation and correlation back to the request;
- explicit refusal vocabulary for unknown profile, absent key/endpoint, ungranted path,
  unavailable runtime, invalid target, and capacity;
- replay/idempotency behavior when a request or connection is retried; and
- the matching customer-run control-plane contract.

The request must not carry a command, argv, arbitrary environment, key label, secret, endpoint,
allowlist extension, or signing material. Until this checkpoint is approved and both the stub and
real-plane owner adopt it, A2/A4 execution stays blocked.

## Test architecture and independence

1. Task #45 publishes an interface-only commit: package/bin mapping, command grammar, public
   application interface, and launch-contract types with throwing/not-implemented bodies.
2. The verifier reads this FRD and the public contracts, not implementation bodies or the
   implementer’s tests. It writes one obligation matrix and runtime-red black-box assertions.
3. The coder may implement production code but may not edit verifier-owned assertions. A disputed
   assertion receives a written contract ruling; it is never silently weakened.
4. The test controller builds the candidate tarball, installs it into a new prefix, and spawns the
   installed path from a temporary cwd with a temporary HOME/cache and a scrubbed environment.
5. The stub implements only the public HTTP/WSS contract. It may use the protocol package but may
   not import runner implementation modules. It records bounded, redacted observations.
6. Secret-entry scenarios use a real pty. Pipe-only tests do not prove a hidden TTY prompt.

The automated lane runs on Ubuntu. Platform-specific and real-topology lanes use the same case ids
and evidence format so a manual result cannot be mistaken for an automated one.

## Part A — acceptance scenarios

### A1 — Pairing and identity

- **A1.1:** after trusted policy initialization, an otherwise clean installed `status` is unpaired
  and creates no credential-bearing output. Before policy initialization, `status` fails closed with
  `policy-missing`; `status --json` returns the same code under `error.code`.
- **A1.2:** prompted pairing sends the code only to the exact configured origin, survives no
  redirect, stores pending state before confirmation, sends a token proof rather than the token,
  then reports paired.
- **A1.3:** timeout leaves pending state resumable; terminal refusal records revoked; a revoked
  binding is not retried; re-pair installs a new binding without a stale completion overwriting it.
- **A1.4:** the token appears only in the WSS upgrade authorization header—not frames, argv,
  environment, logs, error text, process listings, or test artifacts.
- **A1.5:** presence becomes online/offline within the negotiated timeout as observed by the stub.
- **A1.6:** Task #47 repeats pair, one safe session, revoke, failed reconnect, and re-pair across
  two physical machines using the real customer-run plane.

### A2 — Terminal, pty, and worktrees

A2 begins only after the launch-contract checkpoint.

- **A2.1:** a permitted launch request resolves a local profile and granted target; the runner
  has at most one live terminal channel for that accepted request and starts the intended command
  in the deterministic worktree. Unknown or ungranted input is refused without spawning.
- **A2.2:** input, output, resize, exit code/signal, detach, reattach, kill, and bounded scrollback
  are observable through the installed process and stub.
- **A2.3:** exact gaps still in the channel buffer replay in order. A larger loss produces an
  announced reset; a full scrollback repaint may overlap live output and is not asserted
  exactly-once.
- **A2.4:** flow-control debt pauses live output, acknowledgements resume it, and EXIT cannot
  silently overtake held output under the protocol’s documented kill exception.
- **A2.5:** provisioning is idempotent for the same repository/ref/worktree request and fails
  closed on conflicting or unsafe targets.
- **A2.6:** co-resident and split topology produce the same protocol-visible session behavior.
- **A2.7:** after the prior channel is authoritatively closed or lost, exact restart adoption may
  durably claim one higher channel generation under the same stable session id. Concurrent recovery
  has one receipt winner; unknown close and stale retired-channel events cannot create, settle, or
  disturb a replacement.

### A3 — Preview adjacency and containment

- **A3.1:** a locally configured loopback recipe becomes reachable only from runner-host loopback,
  reports one discovered port, and exits/cleans up visibly.
- **A3.2:** on namespace-capable Linux, a wildcard bind is unreachable from every non-loopback host
  address and an independent namespace for its whole verified lifetime.
- **A3.3:** with Linux namespaces denied or on macOS, status says `detect-and-stop`, reports
  `prevention: false`, and terminates an observed off-loopback bind without claiming prevention.
- **A3.4:** zero listeners, multiple listeners/ports, unknown recipes, ungranted paths, duplicate
  ids, and capacity overflow receive their named refusals rather than a guessed success.
- **A3.5:** the evidence distinguishes network containment from the documented residual that an
  escaped descendant may not be proven terminated.

### A4 — Tri-modal model access

A4 begins only after the launch-contract checkpoint.

- **A4.1:** subscription runtime discovery probes only the declared executable/version and CLI
  status surfaces, never opens CLI auth stores, and reports `authenticated`, `unauthenticated`, or
  `unknown` without claiming that a session will succeed.
- **A4.2:** an API key entered through the hidden prompt is stored encrypted and reaches only the
  selected child environment. It appears in no argv, frame, process listing, log, audit record,
  status response, or artifact.
- **A4.3:** the test starts an OpenAI-compatible endpoint independently and creates it through the
  public endpoint command. The runner configures, probes, and uses it; the runner does not claim to
  start it. Advertisement may carry opaque `endpointId`, `kind`, `reachable`, bounded `models`, true
  `modelCount`, and enumerated `reason`, but never URL, host, port, scheme, or free-form failure text.
- **A4.4:** each runtime capability contains `runtime`, `version` or `null`, auth state, and supported
  access modes. Each endpoint capability has the exact fields above. Snapshots cap at 32 runtimes,
  8 endpoints, 64 model names per endpoint, 128 characters per model, and 64 per version. An
  endpoint probe has a 2-second default deadline and reads at most 1 MiB before JSON decoding; the
  byte bound also bounds decoded entry count and memory. An over-limit, timed-out, or malformed
  response marks the endpoint unavailable with an enumerated reason. Visible model truncation
  announces the exact `modelCount` only after the complete bounded response was consumed. A local
  change is advertised within one configured refresh interval (default 60 seconds, minimum 500 ms),
  while endpoint removal is immediate.
- **A4.5:** malformed, unsafe, incomplete, or duplicate profile/endpoint configuration prevents the
  runner from connecting. A valid launch request may instead refuse exactly:
  `unknown-profile`, `runtime-unknown`, `runtime-unavailable`, `runtime-unauthenticated`,
  `access-unsupported`, `unknown-key`, `key-provider-mismatch`, `unknown-endpoint`,
  `endpoint-unavailable`, `model-unavailable`, or `profile-incomplete`; every refusal spawns
  nothing and never falls back to another credential, endpoint, runtime, or profile.

### A5 — Security invariants

- **A5.1:** valid policy loads. Missing, malformed, foreign-key, bad-signature, and tampered policy
  inputs map to the four `policy-*` codes; wrong-owner, permissive-mode, non-regular,
  symlink/hard-link, and I/O failures map to the applicable `state-*` code. Each fails before
  connection or spawn and
  uses the same code in stderr and `status --json`.
- **A5.2:** hostile control-plane traffic cannot add an executable, recipe, grant, profile, key, or
  endpoint. Unknown identifiers are refusals, including prototype-inherited names.
- **A5.3:** a durable grant admits its real path; traversal and symlink swaps fail; a revoke that
  has returned durably blocks later admissions. No retroactive pane termination is claimed.
- **A5.4:** SIGINT/SIGTERM severs the socket before awaiting the peer, attempts every visible child,
  and completes within the 15-second teardown plus 5-second audit deadlines. Confirmed/durable exits
  `0`; uncertainty or audit failure exits `1`. Repeated signals follow the idempotent/forced-exit rule
  without converting uncertainty to success.
- **A5.5:** every workload, git/tmux, preview, and pane spawn routed through the seam, plus each
  refusal, outcome, policy rejection, and kill, is individually durable before acknowledgement.
  One routine capability refresh uses a durable admission/outcome aggregate pair rather than one
  record per probe. Records are canonical, secret-free, and at most 16 KiB; segments are at most
  8 MiB or 16,384 records; eight segments including one open segment and 1 MiB of lifecycle metadata
  are the fixed resident limits. Rotation and crash recovery preserve sequence/digest continuity.
  Only the offline local `audit archive --output` command may acknowledge operator custody and
  reclaim a sealed segment; no control-plane input selects the destination. Containment bootstrap
  (`unshare`/`ip`) remains the seam contract’s explicit runner-infrastructure exception and is
  audited separately. Concurrent writers do not truncate, reorder a single operation, or report
  green on omission.
- **A5.6:** filesystem/process/network instrumentation proves the installed process never opens
  known CLI auth paths and never transmits workload credentials.
- **A5.7:** corrupted state, full disk, permission failure, interrupted atomic write, hostile output,
  and control-character input fail closed with bounded sanitized diagnostics. Legacy audit migration
  preserves canonical schema-v1 bytes under a digest-bound marker; malformed, partial, orphaned, or
  newer-major migration state never becomes an empty log or a successful downgrade.

### A6-candidate — unsigned pre-audit artifact

- **A6.1:** two clean, separately isolated builds of the same tracked source produce identical
  candidate bytes; issue #23’s clean execution rule and issue #24’s peer-edge rule must be green
  before this becomes release evidence.
- **A6.2:** the tarball contains the root bin mapping, executable shebang target, compiled runner and
  protocol, `npm-shrinkwrap.json`, metadata, license, and README; packaged `package-lock.json` is not
  an install contract and is forbidden. The tarball excludes source, tests, devDependencies, build
  scripts, and untracked/generated inputs.
- **A6.3:** SHA-256 checksums, vulnerability policy, seeded-red control, exact production SBOM graph,
  CycloneDX validation, and reconciliation of the clean installed dependency tree and integrity
  values against both `npm-shrinkwrap.json` and the production SBOM pass.
- **A6.4:** an isolated-prefix install with empty HOME/cache/temp and no checkout creates the command;
  `--help`, `--version`, `status`, prompted `pair`, and fail-closed `run` smoke use only installed
  files and resolved production dependencies.
- **A6.5:** Linux evidence records the native `node-pty` install path and prerequisites; macOS
  evidence proves the supported arm64 path. A missing prerequisite fails with an actionable
  install error, not a partially working runner.
- **A6.6:** modified package bytes, SBOM, checksum file, bin target, or lock graph are rejected.

### A6-release — post-audit immutable release

This scenario is not part of pre-audit execution. After Tasks #48/#49 pass, issues #23/#24 close,
repository protections are verified, and a human separately authorizes a release:

- the exact tag resolves to reviewed `main` under the no-bypass ruleset;
- the preserved package and SBOM verify against the exact workflow identity and OIDC issuer;
- SLSA provenance binds the package to the exact tag commit and hosted build;
- publication is single-writer, immutable, and independently verified; and
- a fresh supported machine installs the downloaded release and repeats the CLI smoke.

## Physical and real-topology gate

Task #47 uses two human-controlled hosts and no source checkout on the runner host:

- **Host A:** the real customer-run control plane and operator surface. If coordination/relay is
  included, it remains content-blind and holds no runner bearer credential.
- **Host B:** a clean supported runner machine installed from the exact candidate digest.

The script records platform/tool versions, candidate digest, endpoint ownership, pair/revoke times,
one allowlisted fixture session, containment posture, sanitized protocol outcomes, kill result, and
cleanup. It verifies that code, API keys, local endpoint addresses, signing keys, and CLI auth
material never arrive on the coordination service. Credentials are created for the run, supplied by
the human owner, never committed, and revoked/destroyed at the end.

A stub result cannot substitute for this gate. Missing infrastructure, unsettled pairing/launch
counterparts, TLS ambiguity, or unavailable human credentials stops Task #47 rather than producing
a partial pass.

## Platform matrix

| Lane | Required evidence | Posture |
|---|---|---|
| Ubuntu 24.04 x64, Node 22.22.3/npm 10.9.8 | Automated A1–A6-candidate; namespace-capable and namespace-denied cases; native dependency install; process/filesystem/network tracing | Primary automated and containment lane. |
| macOS arm64, Node 22.22.3/npm 10.9.8 | Install smoke plus A1/A2/A4/A5 and A3 detect-and-stop journey | Required first-release manual lane. No namespace-prevention claim. |
| Second physical supported host | A1.6 and one A2 session against the real plane | Required first-release topology lane. |
| Windows, Linux arm64, macOS x64 | None in this plan | Unsupported until separately specified and gated. |

Linux prerequisites include `git`, `tmux`, `iproute2`, user namespaces for prevention evidence,
Python and a C/C++ build toolchain when `node-pty` has no matching prebuild. macOS prerequisites
include `git`, `tmux`, and the packaged native dependency path. The test receipt records exact
versions instead of treating a command’s presence as compatibility.

## Evidence contract

Every run emits a manifest of at most 256 KiB containing case id, source commit, candidate SHA-256,
platform, architecture, Node/npm versions, containment posture, start/end time, outcome, and log
references no longer than 1,024 characters each. Raw evidence stays in ignored local/CI artifact
storage. A separately reviewed, committed summary contains only hashes, results, redacted failure
scenarios, and manual sign-offs.

The controller captures at most 1 MiB from each process stdout/stderr stream and 5 MiB or 10,000
entries of structured events per case. A single CLI diagnostic is at most 8 KiB. Sanitized
diagnostic evidence is capped at 10 MiB per case and 100 MiB for the automated suite; candidate,
SBOM, and provenance assets are referenced by digest and retain CP-6’s separate archive/member
bounds rather than being copied into that budget. Overflow truncates at the cap, records omitted
bytes/entries plus a digest where available, and fails the case—it never passes on partial evidence.

Evidence must never contain pairing codes, bearer tokens, API keys, signing private keys, endpoint
credentials, raw terminal transcripts, user home paths, environment dumps, or unbounded child
output. Secret sentinels are generated per case and scanned for absence before artifacts are saved.
Manual steps record the human actor and observation, not their credentials.

| Operation | Deadline |
|---|---:|
| Help, version, status, or local configuration command | 10 seconds |
| Pairing/confirmation or one WSS handshake | 30 seconds |
| One terminal or preview scenario | 60 seconds |
| Capability service-stop refresh check | 75 seconds |
| Signal cleanup including durable audit | 20 seconds |
| Isolated tarball install, including native dependency build | 10 minutes |
| Reproducible build plus supply-chain candidate gate | 20 minutes |
| Entire automated A1–A6-candidate suite | 45 minutes |
| Human two-machine script | 90 minutes |

A timeout fails the current case, invokes the bounded cleanup path, and records a redacted timeout
marker. It cannot be retried into green without a fresh case receipt.

## Deterministic validation

The implementation plan must make these commands or exact equivalents green:

```bash
npm ci
npm run gate
npm run supply-chain:audit
npm run supply-chain:seeded-red
npm run release:reproducible -- --output dist/release
npm run supply-chain:gate

artifact="dist/release/modula-runner-$(node -p "require('./packages/runner/package.json').version").tgz"
prefix="$(mktemp -d)"
npm install --global --prefix "$prefix" "$artifact"
"$prefix/bin/modula-runner" --version
"$prefix/bin/modula-runner" --help
```

The black-box command runs the installed path with the source checkout and inherited package-bin
paths removed. Focused test names, platform scripts, and evidence directories are fixed in the
G2 interface brief; the size and time ceilings above are already contractual and may only be
narrowed there.

## Part B — internal general and security audit

Task #48 begins only after A1–A6-candidate and Task #47 are green. It must try to break each
promise, not restate test results.

- **B1 — Trust model:** all README “never” claims, untrusted-plane assumptions, outbound-only
  transport, pairing/revocation, and zero-content-custody boundaries.
- **B2 — Component security:** credentials and stores; policy/consent/spawn seam; pairing; terminal,
  preview, worktree, and launch protocol; path/symlink/TOCTOU; prototype/control-character inputs;
  durable-before-acknowledgement; containment and descendant residuals.
- **B3 — Correctness and resources:** state machines, reconnect/replay, concurrency, races, process
  and descriptor cleanup, bounded queues/buffers/output, failure posture, dead code, KISS/design-core.
- **B4 — Supply chain:** dependency risk, native install path, lifecycle scripts, issues #23/#24,
  reproducible candidate, SBOM, signing/provenance workflow, publication authority.

Each finding includes a reproducible input-to-wrong-outcome scenario, `file:line`, severity,
blast radius, and bounded fix. Critical/High findings block progression and require an independent
recheck. Medium/Low findings require explicit fix/defer rationale. The implementation team cannot
approve its own audit or declare production readiness.

## Sequence and checkpoints

1. **G0 — Human plan approval:** decide V-1…V-8 and all blocker rulings.
2. **G1 — Launch/counterpart contract:** approve the minimal local-profile launch request, pairing
   counterpart, refusal/idempotency rules, and control-plane owner. This is inserted before Task #45.
3. **G2 — CLI interface checkpoint:** bin/install contract, command grammar, application-home
   interface, and throwing composition surface only. Verifier writes the obligation matrix and red
   black-box specs before implementation proceeds.
4. **G3 — CLI implementation and automated suite:** implement the composition, stub, and
   A1–A6-candidate on Ubuntu. Resolve #23/#24 before claiming release evidence.
5. **G4 — Physical/platform gate:** macOS lane, second-machine journey, and real customer-run plane.
6. **G5 — Internal audit:** Task #48 with independent finding verification.
7. **G6 — External third-party audit:** Task #49; all Critical/High findings fixed and independently
   verified. This remains the GA stop-gate.
8. **G7 — Release decision:** separate human authorization, repository protection/exclusive-writer
   checks, then A6-release. No earlier gate implies this decision.

Each code checkpoint uses coder → verifier → bug-check → steward review. Docs-only review is capped
at two automated rounds; code review at five. A cap produces tracked rules or a human decision, not
an unbounded extra patch.

## Human gates

Explicit human approval is required for:

- this plan and its launch-contract scope;
- the real control-plane counterpart and physical infrastructure/credentials;
- disposition of any audit finding that is not fixed;
- selection and acceptance of the external auditor/report;
- repository rules, immutable-release environment, and exclusive publication authority; and
- any tag, release, deployment, registry publication, GA claim, or credential change.

A “yes” to this plan is not a “yes” to any later gate.

## Approved-plan completeness

G0 is complete: V-1…V-8 and all 16 shared acceptance blockers have explicit human rulings; no
A1–A6 obligation depends on a test-only backdoor; the launch-contract and real-plane role owners
and dependencies are named; automated, platform, physical, audit, evidence, and cleanup gates are
measurable; forbidden actions and release authority remain explicit; and the task graph must now
insert G1 before Task #45 while preserving interface-first independent acceptance specs at G2.

## Research basis

Repository sources: runner seam v2, protocol schema v1, model-access contract, CP-6 release and
verification docs, package manifests, and published runner exports at the source baseline.

External behavior was checked on 2026-08-21 against official npm 10 documentation:
[`package.json` / `bin`](https://docs.npmjs.com/cli/v10/configuring-npm/package-json/),
[`npm install`](https://docs.npmjs.com/cli/v10/commands/npm-install/), and
[install folders/bin locations](https://docs.npmjs.com/cli/v10/configuring-npm/folders/), plus
the official [Node 22 process/signal contract](https://nodejs.org/docs/latest-v22.x/api/process.html).
These sources support the root-bin, shebang, tarball-install, prefix, lifecycle-script, and
foreground signal rulings. An isolated npm `10.9.8` experiment also confirmed that a nested
workspace `bin` alone creates no global command while the outer tarball’s root `bin` does.
Repository contracts remain authoritative for product behavior.

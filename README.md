# Modula Runner

The local execution daemon for [Modula Stack](https://modulastack.com) — an agentic
engineering platform where a professional directs AI agent teams through plans, approvals,
parallel implementation lanes, reviews, and receipts.

The runner is the only Modula code that runs on your machine. It pairs to your Modula
account with a device code, dials **one outbound WebSocket** to the control plane, and
executes jobs in local git worktrees using **your own agent CLIs, signed in the way you
signed them in**. Your code, credentials, models, and git forge stay on your machine.

**Status: early.** This repo is public from its first commit, on purpose — history is the
trust artifact. Expect rough edges; the protocol is versioned and may change before GA.

## What the runner does

- Spawns your agent CLIs (Claude Code, Codex, and other supported CLIs) in isolated
  worktrees, one lane per job
- Streams terminals up, your input down — over a single authenticated outbound connection
  (no inbound ports; works behind NAT and strict firewalls)
- Performs all git and forge operations locally under your credentials — GitHub, or a
  self-hosted forge that never needs to be reachable from the internet
- Resolves model access locally: your CLI subscriptions, your API keys (in the runner's
  encrypted store), or local models via any OpenAI-compatible endpoint

## What the runner will never do

- **Never reads your CLI auth.** The runner drives the CLI; it never extracts a token.
  A test in this repo asserts the binary does not open `~/.claude` or `~/.codex` auth
  paths.
- **Never uploads credentials.** The hosted plane holds no credential of any kind —
  not subscriptions, not API keys, not forge tokens or SSH keys.
- **Never runs arbitrary commands from the control plane.** The command allowlist ships
  signed with the runner and is editable only locally — the control plane cannot extend it.
- **Never acts without a kill switch.** Pairing is revocable from your side in one click;
  the runner keeps a local, append-only audit log you own.

## Security posture

Apache-2.0 · signed releases (Sigstore) · SBOM with every build · [`SECURITY.md`](SECURITY.md)
for disclosure · an **independent third-party security audit of the runner and pairing
protocol is a hard gate before general availability**, recurring on major protocol
revisions.

## Install & pairing

Coming with the first packaged release: install script, then `modula-runner pair <code>`.
Until then, this repo is where the runner takes shape — watch the releases.

## License

Apache-2.0. "Modula" and the Modula wordmark are trademarks of the Modula project,
reserved separately from this code license.

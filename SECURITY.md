# Security Policy

The runner's security promises are the product. If you find a way to break one of the
"What the runner will never do" guarantees in the README — or any other vulnerability —
we want to hear about it before anyone else does.

## Reporting a vulnerability

- **Preferred:** GitHub's private vulnerability reporting on this repository
  (Security → Report a vulnerability). Reports go directly to the maintainers, privately.
- **Email:** dev@modulastack.com — use a subject starting with `SECURITY:`.

Please include reproduction steps and the runner version/commit. Please do not open a
public issue for a suspected vulnerability.

## What to expect

- Acknowledgement within 72 hours.
- An assessment and remediation plan for confirmed issues; fixes ship as signed releases
  with the issue credited to the reporter (unless you prefer anonymity).
- No legal action for good-faith research within the scope of this repository.

## Scope notes

- The runner never handles your CLI subscription tokens — reports demonstrating access to
  `~/.claude`/`~/.codex` auth material from the runner process are top severity.
- The command allowlist, per-directory consent, and pairing/kill-switch mechanisms are
  hard security boundaries; bypasses are top severity.
- An independent third-party audit gates general availability; its published reports will
  live in this repository.

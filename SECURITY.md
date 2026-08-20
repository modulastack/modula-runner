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

## Release dependency waivers

A release blocks on production High or Critical advisories. An exception must be committed in
[`security/vulnerability-waivers.json`](security/vulnerability-waivers.json) and identify one exact
GHSA, CVE alias, package, locked version, lockfile node, and severity. It must also state why the
advisory is unexploitable in this runner or has no available fix, plus an exclusive UTC expiry date.
The GHSA/CVE pair must also appear in
[`security/advisory-aliases.json`](security/advisory-aliases.json) with its exact official GitHub
advisory URL and the date a reviewer verified the aliases. Expired, malformed, duplicate, broad,
unused, or unverified-pair waivers fail the release gate. Development-only findings remain visible in
the audit summary but do not block a release.

## Scope notes

- The runner never handles your CLI subscription tokens — reports demonstrating access to
  `~/.claude`/`~/.codex` auth material from the runner process are top severity.
- The command allowlist, per-directory consent, and pairing/kill-switch mechanisms are
  hard security boundaries; bypasses are top severity.
- An independent third-party audit gates general availability; its published reports will
  live in this repository.

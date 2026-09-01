# Reproducible release builds

The release package is built from a `v<package-version>` tag with the exact toolchain declared by
`.nvmrc` and `package.json#packageManager`. Dependencies are installed with `npm ci`; the committed
lockfile is the only dependency-resolution input.

## Publication gate

Before a `v*` tag is pushed, a repository administrator must confirm that GitHub immutable releases
are enabled and that an active tag ruleset matching `v*` restricts updates and deletions with no
bypass actor, including GitHub Actions. The `immutable-release` GitHub Actions environment must have
required reviewers, and a reviewer must reconfirm both settings before approving the read-only selector
job. The operator must also establish a controlled release window in which this workflow's publisher is
the only actor with effective release-write authority through immutable post-verification. GitHub
documents no conditional or atomic compare-and-publish Release API, so workflow concurrency cannot
exclude a direct REST/UI writer with equal authority. This no-secret human gate is required because the
job token cannot read the repository Administration settings and a remote-tag check alone cannot
eliminate a check/create race.

After approval, dependency installation, the current vulnerability policy, acceptance tests, and the
two compared package builds run in a fresh read-only job with no release, OIDC, or attestation
authority. The comparison snapshots tracked source before either build starts, then gives each build
its own source tree, dependency installation, npm cache, home/cache directory, temporary directory,
and generated output. That job checks out the immutable event SHA and asserts its working tree is at
that commit before dependency execution. A separate publisher VM does not check out or execute project
code. It validates the exact raw Actions archive, exact REST/download size, internal manifest, checksums,
stream-bounded package members, and SBOM before signing the preserved compared bytes. Every fresh job
checks the required GitHub CLI security floor
before using it. A final read-only job fail-closes the complete job-result matrix and independently
verifies the immutable release. This boundary prevents dependency lifecycle state from reaching
release credentials; artifact hashes prove transport integrity, not that a compromised build produced
honest bytes.

The workflow re-resolves lightweight and annotated tags before any release mutation and again
immediately before publication. It creates an explicit mutable draft only after preserving the six
exact release assets in a 14-day Actions artifact, uploads without clobbering, then publishes that
exact draft ID and verifies the resulting immutable release. If post-publication verification fails,
the immutable release requires administrator disposition; automation must not delete, replace, or
retry publication.

If an interrupted run leaves a draft, do not use **Re-run jobs**: GitHub does not guarantee that an
artifact from an earlier attempt remains addressable by the rerun. Start **Run workflow** from the
exact `v*` tag and provide that same tag as `recovery_tag` within the 14-day evidence window. This
recovery-only dispatch cannot create a release. It accepts one marked draft only when the originating
workflow attempt, Actions artifact ID/digest, internal six-asset manifest, existing draft asset subset,
checksums, Sigstore bundles, provenance, and SBOM all match. Before privileged resume, a fresh
read-only job repeats the lock preflight, clean install, production audit/waiver-expiry policy, and
seeded-negative proof. Its completed audit attempt must equal the publisher attempt, so a selective
failed-job rerun stops before privileged work instead of reusing an earlier audit result. It uploads
only missing assets, never clobbers or deletes. Missing, expired,
duplicate, unexpected, incomplete-upload, null-digest, or mismatched evidence stops for administrator
disposition. An already-published release is accepted only
when it is complete and immutable.

## Rebuild

On a clean checkout of the release tag:

```sh
nvm install
nvm use
npm --version  # must match package.json#packageManager exactly
npm run release:reproducible  # performs two isolated npm ci/build/pack passes
(cd dist/release && sha256sum --check SHA256SUMS)
```

`release:build` compiles the runner and protocol workspaces and creates
`dist/release/modula-runner-<version>.tgz`. The package embeds the private native file-lock
workspaces: reviewed Node 22 members for Linux x64/arm64 and the verified Darwin arm64
descriptor-relative runner-home backend. The current artifact requires Node `22.22.3` and supports
Linux x64, Linux arm64, and macOS arm64. macOS x64 is rejected at runtime because npm cannot express
that OS/CPU matrix without claiming the unsupported cross-product.

The package contains a production-only `npm-shrinkwrap.json`, license, README, and deterministic
build metadata. Staging internalizes runner imports of the bundled workspaces and promotes the
runner's external runtime dependencies to the installable root manifest; otherwise an installed
archive would contain sibling workspace bytes but still ask Node to resolve an unpublished package.
Build metadata binds both the staged shrinkwrap, the original source lockfile, and the Darwin native
source/build provenance plus SHA-256. The package
contains no tests or TypeScript source. `release:reproducible` snapshots tracked working-tree
source before either comparison begins, performs exactly two independently isolated
install/build/staging/packing passes, fails unless their package bytes match, and preserves the first
compared package plus its checksum as the canonical release output. Untracked files, an existing
`node_modules`, and build caches in the caller's checkout are not copied into either boundary. The
release workflow never requests a third package build.

The release workflow also checks that the tag is exactly `v<package-version>` and that the tagged
commit belongs to `main`. A local build outside GitHub may be untagged so changes can be validated
before commit; the tag/ancestry checks become mandatory in the release job.

## Deterministic boundary

The signed `.tgz` and its `SHA256SUMS` entry are expected to reproduce byte for byte. npm's package
writer normalizes archive metadata, and generated files contain no wall-clock time, temporary path,
or random value.

These release-side records are intentionally not reproducible bytes:

- A keyless Sigstore certificate and transparency-log entry contain issuance time and ephemeral
  signing material.
- GitHub's provenance attestation contains builder/run identity and timing.
- The release page and upload metadata are service records.
- A CycloneDX document may contain generator metadata required by its tool. Its dependency inventory
  is reconciled to the same lockfile, but service/tool metadata is not part of the package-byte
  comparison.
- Installing the package can compile `node-pty` for the destination OS and architecture. Those local
  native installation outputs are not embedded in the architecture-neutral release package.

Reproducible bytes establish that the same source and declared toolchain produced the same package.
They do not establish that the source is safe, that dependencies have no unknown vulnerabilities, or
that a particular CI identity built the package; signature, vulnerability, SBOM, and provenance
checks cover those separate claims.

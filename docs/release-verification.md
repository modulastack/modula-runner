# Verify a release

This runbook verifies a release package without trusting the machine that built it. It checks the
immutable GitHub release, downloaded asset digests, GitHub Actions keyless signatures, SLSA build
provenance, the CycloneDX dependency inventory, and the matching public source tag.

It does not install or run the package. The install/quickstart remains a separate release gate.

## Requirements

- GitHub CLI 2.97.0 or newer, authenticated for public GitHub reads
- Cosign 3.1.3 or newer
- CycloneDX CLI 0.30.0
- [nvm](https://github.com/nvm-sh/nvm), installed and loaded in the verification shell
- `git`, `jq`, and either `sha256sum` (Linux) or `shasum` (macOS)

Use the official release pages for these verifier tools. Version floors matter: older GitHub CLI and
Cosign versions contain identity-matching vulnerabilities fixed by these releases.

## Choose the release

Set the tag you intend to verify:

```bash
set -euo pipefail
repo=modulastack/modula-runner
source=https://github.com/modulastack/modula-runner.git
tag=v0.1.0
version="${tag#v}"
artifact="modula-runner-${version}.tgz"
sbom=modula-runner.cdx.json
provenance="modula-runner-${version}.provenance.sigstore.json"
identity="https://github.com/$repo/.github/workflows/release.yml@refs/tags/$tag"
issuer=https://token.actions.githubusercontent.com
commit="$(gh api "repos/$repo/commits/$tag" --jq .sha)"
dir="$(mktemp -d)"
```

## Verify the immutable release and assets

```bash
gh release verify "$tag" --repo "$repo"
gh release download "$tag" --repo "$repo" --dir "$dir"

for file in \
  "$artifact" \
  "$artifact.sigstore.json" \
  "$sbom" \
  "$sbom.sigstore.json" \
  SHA256SUMS \
  "$provenance"; do
  gh release verify-asset "$tag" "$dir/$file" --repo "$repo"
done
```

`gh release verify` must report an immutable release. Each `verify-asset` command checks GitHub's
immutable-release asset attestation rather than trusting only the release page.

Check the published hashes:

```bash
# Linux
(cd "$dir" && sha256sum --check SHA256SUMS)

# macOS: run this instead of the Linux line
# (cd "$dir" && shasum -a 256 -c SHA256SUMS)
```

A checksum detects changed bytes but is not authentic by itself. The next steps authenticate it.

## Verify the Sigstore identities

```bash
for subject in "$artifact" "$sbom"; do
  cosign verify-blob "$dir/$subject" \
    --bundle "$dir/$subject.sigstore.json" \
    --certificate-identity "$identity" \
    --certificate-oidc-issuer "$issuer"
done
```

Both commands must report `Verified OK`. They prove that the exact package and SBOM bytes were signed
by this repository's `release.yml` workflow for this exact tag through GitHub Actions OIDC. They do
not prove that the source is safe or that another machine can reproduce the package.

## Verify provenance and source commit

```bash
gh attestation verify "$dir/$artifact" --repo "$repo" \
  --bundle "$dir/$provenance" \
  --predicate-type https://slsa.dev/provenance/v1 \
  --cert-identity "$identity" \
  --cert-oidc-issuer "$issuer" \
  --source-ref "refs/tags/$tag" \
  --source-digest "$commit" \
  --deny-self-hosted-runners
```

Confirm the public source tag resolves to that commit and belongs to `main`:

```bash
source_dir="$(mktemp -d)"
git clone --no-checkout "$source" "$source_dir/repo"
git -C "$source_dir/repo" fetch origin main --tags
source_commit="$(git -C "$source_dir/repo" rev-parse "$tag^{commit}")"
test "$source_commit" = "$commit"
git -C "$source_dir/repo" merge-base --is-ancestor "$commit" origin/main
```

The provenance check binds the package digest to the GitHub-hosted workflow, exact public tag, and
exact commit. It does not independently prove source review quality, tag authorization, or equality
with the access-controlled canonical Forge; the operator's release exercise records Forge mirror
propagation separately.

## Validate and inspect the SBOM

```bash
cyclonedx validate \
  --input-file "$dir/$sbom" \
  --input-format json \
  --input-version v1_5 \
  --fail-on-errors

jq --arg version "$version" -e '
  .bomFormat == "CycloneDX" and
  .specVersion == "1.5" and
  any(.components[];
    .name == "modula-runner" and .version == $version and
    (.licenses | length) > 0) and
  ([.components[] | select(
    any(.properties[]?; .name == "cdx:npm:package:development"))] | length) == 0
' "$dir/$sbom"

jq '{subject:.metadata.component, components:.components, dependencies:.dependencies}' "$dir/$sbom"
```

Schema validation proves the document is well formed. The release gate additionally reconciles its
production components, dependency edges, licenses, and package hashes to `package-lock.json`; the
inventory still depends on npm and registry metadata being accurate.

## Rebuild independently

From the public source checkout above:

```bash
cd "$source_dir/repo"
git checkout --detach "$tag"
nvm install
nvm use
test "$(node --version)" = v22.22.3
test "$(npm --version)" = 10.9.8
npm ci
npm run release:build
cmp "dist/release/$artifact" "$dir/$artifact"
```

The platform-specific acceptance suite is separate from the byte rebuild: preview containment tests
require a Linux host with unprivileged user and network namespaces plus `tmux`, while other supported
verification hosts may not provide those capabilities. Release CI runs that suite on its prepared
Linux runner. The exact build and `cmp` are the portable R1 reproducibility proof.

`cmp` must produce no output and exit zero. Sigstore certificates, attestation records, SBOM UUIDs and
timestamps, and GitHub release metadata are intentionally not byte-reproducible; the signed `.tgz`
is. See [`reproducible-builds.md`](reproducible-builds.md) for the complete residual boundary.

If every command above succeeds, the package has reached **verified** for this runbook.

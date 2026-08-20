#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { cp, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reportFailure, runProcess } from './cli-process.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const defaultOutput = join(root, 'dist', 'release')

function run(command, args, options = {}) {
  const { capture = false, ...spawnOptions } = options
  return runProcess(command, args, { cwd: root, capture, ...spawnOptions }).trim()
}

async function readJson(path) {
  return JSON.parse(await readFile(join(root, path), 'utf8'))
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

function stripBuildFields(manifest) {
  const release = { ...manifest }
  delete release.scripts
  delete release.devDependencies
  delete release.volta
  return release
}

async function releaseVersion() {
  const workspace = await readJson('package.json')
  const runner = await readJson('packages/runner/package.json')
  const protocol = await readJson('packages/protocol/package.json')
  const versions = [workspace.version, runner.version, protocol.version]
  if (new Set(versions).size !== 1) {
    throw new Error(`workspace versions differ: root ${workspace.version}, runner ${runner.version}, protocol ${protocol.version}`)
  }
  return runner.version
}

async function validateToolchain() {
  const expectedNode = (await readFile(join(root, '.nvmrc'), 'utf8')).trim()
  const rootPackage = await readJson('package.json')
  const expectedNpm = rootPackage.packageManager?.replace(/^npm@/, '')
  const actualNode = process.version.replace(/^v/, '')
  const actualNpm = run('npm', ['--version'], { capture: true })
  if (actualNode !== expectedNode) throw new Error(`Node ${expectedNode} required; found ${actualNode}`)
  if (!expectedNpm || actualNpm !== expectedNpm) {
    throw new Error(`npm ${expectedNpm ?? '(unconfigured)'} required; found ${actualNpm}`)
  }
  return { node: expectedNode, npm: expectedNpm }
}

function validateReleaseRef(version) {
  const ref = process.env.GITHUB_REF_NAME
  if (ref && ref !== `v${version}`) throw new Error(`tag ${ref} does not match package version v${version}`)
}

async function copyPackage(packageName, staging) {
  const source = join(root, 'packages', packageName)
  const target = join(staging, 'packages', packageName)
  const manifest = stripBuildFields(await readJson(`packages/${packageName}/package.json`))
  delete manifest.private
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await cp(join(source, 'dist'), join(target, 'dist'), { recursive: true })
  if (packageName === 'protocol') {
    await copyFile(join(source, 'README.md'), join(target, 'README.md'))
    await copyFile(join(source, 'SCHEMA.md'), join(target, 'SCHEMA.md'))
  }
}

async function stageRelease(staging, version, toolchain) {
  const rootPackage = stripBuildFields(await readJson('package.json'))
  await mkdir(staging, { recursive: true })
  await writeFile(join(staging, 'package.json'), `${JSON.stringify({ ...rootPackage, version }, null, 2)}\n`)
  await copyFile(join(root, 'package-lock.json'), join(staging, 'npm-shrinkwrap.json'))
  await copyFile(join(root, 'README.md'), join(staging, 'README.md'))
  await copyFile(join(root, 'LICENSE'), join(staging, 'LICENSE'))
  await copyPackage('protocol', staging)
  await copyPackage('runner', staging)
  const lockfileSha256 = await sha256(join(root, 'package-lock.json'))
  const metadata = { artifact: 'modula-runner', version, expectedTag: `v${version}`, toolchain, lockfileSha256 }
  await writeFile(join(staging, 'BUILD-METADATA.json'), `${JSON.stringify(metadata, null, 2)}\n`)
}

async function packRelease(staging, output, version) {
  await mkdir(output, { recursive: true })
  const packedOutput = await mkdtemp(join(tmpdir(), 'modula-runner-pack-'))
  const artifact = join(output, `modula-runner-${version}.tgz`)
  try {
    const packed = run('npm', [
      'pack', '--silent', '--ignore-scripts', '--pack-destination', packedOutput, staging,
    ], { capture: true }).split('\n').at(-1)
    if (!packed) throw new Error('npm pack did not report an artifact')
    await copyFile(join(packedOutput, basename(packed)), artifact)
  } finally {
    await rm(packedOutput, { recursive: true, force: true })
  }
  const digest = await sha256(artifact)
  await writeFile(join(output, 'SHA256SUMS'), `${digest}  ${basename(artifact)}\n`)
  return artifact
}

async function buildRelease(output, compile = true) {
  const toolchain = await validateToolchain()
  const version = await releaseVersion()
  validateReleaseRef(version)
  if (compile) {
    await Promise.all([
      rm(join(root, 'packages', 'protocol', 'dist'), { recursive: true, force: true }),
      rm(join(root, 'packages', 'runner', 'dist'), { recursive: true, force: true }),
    ])
    run('npm', ['run', 'build'])
  }
  await mkdir(output, { recursive: true })
  await Promise.all([
    rm(join(output, `modula-runner-${version}.tgz`), { force: true }),
    rm(join(output, 'SHA256SUMS'), { force: true }),
  ])
  const staging = await mkdtemp(join(tmpdir(), 'modula-runner-release-'))
  try {
    await stageRelease(staging, version, toolchain)
    return await packRelease(staging, output, version)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function releaseVerificationScript({ repository, tag, commit, artifact, sbom, provenance, identity }) {
  return `set -euo pipefail
repo=${repository}
tag=${tag}
commit=${commit}
artifact=${artifact}
sbom=${sbom}
provenance=${provenance}
identity=${identity}
issuer=https://token.actions.githubusercontent.com
dir="$(mktemp -d)"
gh release verify "$tag" --repo "$repo"
gh release download "$tag" --repo "$repo" --dir "$dir"
(cd "$dir" && sha256sum --check SHA256SUMS)
for subject in "$artifact" "$sbom"; do
  cosign verify-blob "$dir/$subject" --bundle "$dir/$subject.sigstore.json" \\
    --certificate-identity "$identity" --certificate-oidc-issuer "$issuer"
done
gh attestation verify "$dir/$artifact" --repo "$repo" --bundle "$dir/$provenance" \\
  --predicate-type https://slsa.dev/provenance/v1 --cert-identity "$identity" \\
  --cert-oidc-issuer "$issuer" --source-ref "refs/tags/$tag" \\
  --source-digest "$commit" --deny-self-hosted-runners
cyclonedx validate --input-file "$dir/$sbom" \\
  --input-format json --input-version v1_5 --fail-on-errors`
}

async function writeReleaseNotes(output) {
  const version = await releaseVersion()
  const tag = requiredEnvironment('GITHUB_REF_NAME')
  const commit = requiredEnvironment('GITHUB_SHA')
  const repository = requiredEnvironment('GITHUB_REPOSITORY')
  validateReleaseRef(version)
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`invalid release commit ${commit}`)
  if (repository !== 'modulastack/modula-runner') throw new Error(`refusing release notes for ${repository}`)
  const artifact = `modula-runner-${version}.tgz`
  const sbom = 'modula-runner.cdx.json'
  const provenance = `modula-runner-${version}.provenance.sigstore.json`
  const identity = `https://github.com/${repository}/.github/workflows/release.yml@refs/tags/${tag}`
  const script = releaseVerificationScript({ repository, tag, commit, artifact, sbom, provenance, identity })
  const runbook = `https://github.com/${repository}/blob/${commit}/docs/release-verification.md`
  const notes = `## Verify this release\n\nRequires GitHub CLI >=2.97.0, Cosign >=3.1.3, and CycloneDX CLI 0.30.0.\n\n\`\`\`bash\n${script}\n\`\`\`\n\nmacOS checksum equivalent: \`(cd "$dir" && shasum -a 256 -c SHA256SUMS)\`.\n\nFull verifier runbook and evidence limits: ${runbook}\n`
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, notes)
}

async function compareArtifacts(left, right) {
  const [leftDigest, rightDigest] = await Promise.all([sha256(left), sha256(right)])
  if (leftDigest !== rightDigest) {
    throw new Error(`artifact mismatch: ${leftDigest} != ${rightDigest}`)
  }
  return leftDigest
}

async function preserveComparedArtifact(source, output, digest) {
  const artifact = join(output, basename(source))
  await mkdir(output, { recursive: true })
  await Promise.all([
    rm(artifact, { force: true }),
    rm(join(output, 'SHA256SUMS'), { force: true }),
  ])
  await copyFile(source, artifact)
  await writeFile(join(output, 'SHA256SUMS'), `${digest}  ${basename(artifact)}\n`)
  return artifact
}

async function verifyReproducible(output) {
  const workspace = await mkdtemp(join(tmpdir(), 'modula-runner-reproducible-'))
  try {
    const first = await buildRelease(join(workspace, 'first'))
    const second = await buildRelease(join(workspace, 'second'))
    const digest = await compareArtifacts(first, second)
    const artifact = await preserveComparedArtifact(first, output, digest)
    console.log(`reproducible ${digest}  ${artifact}`)
    return artifact
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

function optionValue(args, name, fallback) {
  const index = args.indexOf(name)
  if (index === -1) return fallback
  const value = args[index + 1]
  if (!value) throw new Error(`${name} requires a value`)
  return resolve(root, value)
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'build' || command === 'pack') {
    const artifact = await buildRelease(optionValue(args, '--output', defaultOutput), command === 'build')
    console.log(artifact)
    return
  }
  if (command === 'reproducible') {
    return verifyReproducible(optionValue(args, '--output', defaultOutput))
  }
  if (command === 'notes') return writeReleaseNotes(optionValue(args, '--output', join(defaultOutput, 'RELEASE_NOTES.md')))
  if (command === 'compare' && args.length === 2) {
    console.log(await compareArtifacts(resolve(args[0]), resolve(args[1])))
    return
  }
  throw new Error('usage: release.mjs build|pack|reproducible [--output DIR] | notes [--output FILE] | compare LEFT RIGHT')
}

main().catch(error => {
  reportFailure('release', error)
  process.exitCode = 1
})

#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { cp, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reportFailure, runProcess } from './cli-process.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const defaultOutput = join(root, 'dist', 'release')

function run(command, args, options = {}) {
  const { capture = false, cwd = root, ...spawnOptions } = options
  return runProcess(command, args, { cwd, capture, ...spawnOptions }).trim()
}

async function readJson(path, projectRoot = root) {
  return JSON.parse(await readFile(join(projectRoot, path), 'utf8'))
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

async function releaseVersion(projectRoot = root) {
  const workspace = await readJson('package.json', projectRoot)
  const runner = await readJson('packages/runner/package.json', projectRoot)
  const protocol = await readJson('packages/protocol/package.json', projectRoot)
  const versions = [workspace.version, runner.version, protocol.version]
  if (new Set(versions).size !== 1) {
    throw new Error(`workspace versions differ: root ${workspace.version}, runner ${runner.version}, protocol ${protocol.version}`)
  }
  return runner.version
}

async function validateToolchain(projectRoot = root, environment = process.env) {
  const expectedNode = (await readFile(join(projectRoot, '.nvmrc'), 'utf8')).trim()
  const rootPackage = await readJson('package.json', projectRoot)
  const expectedNpm = rootPackage.packageManager?.replace(/^npm@/, '')
  const actualNode = process.version.replace(/^v/, '')
  const actualNpm = run('npm', ['--version'], { capture: true, cwd: projectRoot, env: environment })
  if (actualNode !== expectedNode) throw new Error(`Node ${expectedNode} required; found ${actualNode}`)
  if (!expectedNpm || actualNpm !== expectedNpm) {
    throw new Error(`npm ${expectedNpm ?? '(unconfigured)'} required; found ${actualNpm}`)
  }
  return { node: expectedNode, npm: expectedNpm }
}

function validateReleaseRef(version, environment = process.env) {
  const ref = environment.GITHUB_REF_NAME
  if (ref && ref !== `v${version}`) throw new Error(`tag ${ref} does not match package version v${version}`)
}

async function releasePreflight(projectRoot = root, environment = process.env) {
  const toolchain = await validateToolchain(projectRoot, environment)
  const version = await releaseVersion(projectRoot)
  validateReleaseRef(version, environment)
  return { toolchain, version }
}

async function copyPackage(packageName, staging, projectRoot) {
  const source = join(projectRoot, 'packages', packageName)
  const target = join(staging, 'packages', packageName)
  const manifest = stripBuildFields(await readJson(`packages/${packageName}/package.json`, projectRoot))
  delete manifest.private
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await cp(join(source, 'dist'), join(target, 'dist'), { recursive: true })
  if (packageName === 'protocol') {
    await copyFile(join(source, 'README.md'), join(target, 'README.md'))
    await copyFile(join(source, 'SCHEMA.md'), join(target, 'SCHEMA.md'))
  }
}

async function stageRelease(staging, version, toolchain, projectRoot) {
  const rootPackage = stripBuildFields(await readJson('package.json', projectRoot))
  await mkdir(staging, { recursive: true })
  await writeFile(join(staging, 'package.json'), `${JSON.stringify({ ...rootPackage, version }, null, 2)}\n`)
  await copyFile(join(projectRoot, 'package-lock.json'), join(staging, 'npm-shrinkwrap.json'))
  await copyFile(join(projectRoot, 'README.md'), join(staging, 'README.md'))
  await copyFile(join(projectRoot, 'LICENSE'), join(staging, 'LICENSE'))
  await copyPackage('protocol', staging, projectRoot)
  await copyPackage('runner', staging, projectRoot)
  const lockfileSha256 = await sha256(join(projectRoot, 'package-lock.json'))
  const metadata = { artifact: 'modula-runner', version, expectedTag: `v${version}`, toolchain, lockfileSha256 }
  await writeFile(join(staging, 'BUILD-METADATA.json'), `${JSON.stringify(metadata, null, 2)}\n`)
}

async function packRelease(staging, output, version, context) {
  const { projectRoot, environment, temporaryRoot } = context
  await Promise.all([mkdir(output, { recursive: true }), mkdir(temporaryRoot, { recursive: true })])
  const packedOutput = await mkdtemp(join(temporaryRoot, 'modula-runner-pack-'))
  const artifact = join(output, `modula-runner-${version}.tgz`)
  try {
    const packed = run('npm', [
      'pack', '--silent', '--ignore-scripts', '--pack-destination', packedOutput, staging,
    ], { capture: true, cwd: projectRoot, env: environment }).split('\n').at(-1)
    if (!packed) throw new Error('npm pack did not report an artifact')
    await copyFile(join(packedOutput, basename(packed)), artifact)
  } finally {
    await rm(packedOutput, { recursive: true, force: true })
  }
  const digest = await sha256(artifact)
  await writeFile(join(output, 'SHA256SUMS'), `${digest}  ${basename(artifact)}\n`)
  return artifact
}

async function buildRelease(output, compile = true, options = {}) {
  const context = {
    projectRoot: options.projectRoot ?? root,
    environment: options.environment ?? process.env,
    temporaryRoot: options.temporaryRoot ?? tmpdir(),
  }
  const { toolchain, version } = options.preflight ??
    await releasePreflight(context.projectRoot, context.environment)
  if (compile) {
    await Promise.all([
      rm(join(context.projectRoot, 'packages', 'protocol', 'dist'), { recursive: true, force: true }),
      rm(join(context.projectRoot, 'packages', 'runner', 'dist'), { recursive: true, force: true }),
    ])
    run('npm', ['run', 'build'], { cwd: context.projectRoot, env: context.environment })
  }
  await mkdir(output, { recursive: true })
  await Promise.all([
    rm(join(output, `modula-runner-${version}.tgz`), { force: true }),
    rm(join(output, 'SHA256SUMS'), { force: true }),
  ])
  await mkdir(context.temporaryRoot, { recursive: true })
  const staging = await mkdtemp(join(context.temporaryRoot, 'modula-runner-release-'))
  try {
    await stageRelease(staging, version, toolchain, context.projectRoot)
    return await packRelease(staging, output, version, context)
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

function escapesDirectory(directory, target) {
  const boundary = relative(directory, target)
  return boundary === '..' || boundary.startsWith(`..${sep}`) || isAbsolute(boundary)
}

async function validateTrackedPath(path) {
  const source = join(root, path)
  const kind = await lstat(source)
  if (kind.isSymbolicLink()) {
    const link = await readlink(source)
    if (isAbsolute(link)) throw new Error(`tracked symlink ${path} must be relative`)
    if (escapesDirectory(root, resolve(dirname(source), link))) {
      throw new Error(`tracked symlink ${path} escapes source boundary`)
    }
  }
  let target
  try {
    target = realpathSync(source)
  } catch {
    const label = kind.isSymbolicLink() ? 'tracked symlink' : 'tracked path'
    throw new Error(`${label} ${path} has no source target`)
  }
  if (escapesDirectory(realpathSync(root), target)) {
    const label = kind.isSymbolicLink() ? 'tracked symlink' : 'tracked path'
    throw new Error(`${label} ${path} escapes source boundary`)
  }
}

async function copyTrackedPath(destination, path) {
  const output = join(destination, path)
  await mkdir(dirname(output), { recursive: true })
  await cp(join(root, path), output, { recursive: true, verbatimSymlinks: true })
}

async function copyTrackedSource(destination) {
  const paths = runProcess('git', ['ls-files', '-z', '--cached'], { cwd: root, capture: true })
    .split('\0').filter(Boolean)
  if (paths.length === 0) throw new Error('reproducible build has no tracked source inputs')
  await Promise.all(paths.map(validateTrackedPath))
  await Promise.all(paths.map(path => copyTrackedPath(destination, path)))
}

function isDependencyBinPath(path) {
  return basename(path).toLowerCase() === '.bin' &&
    basename(dirname(path)).toLowerCase() === 'node_modules'
}

function inheritedBuildPath() {
  const seen = new Set()
  return Object.entries(process.env)
    .filter(([key, value]) => key.toLowerCase() === 'path' && typeof value === 'string')
    .flatMap(([, value]) => value.split(delimiter))
    .filter(path => path.length > 0 && isAbsolute(path))
    .flatMap(path => {
      try {
        const canonical = normalize(realpathSync(path))
        return statSync(canonical).isDirectory() ? [canonical] : []
      } catch {
        return []
      }
    })
    .filter(path => {
      const identity = process.platform === 'win32' ? path.toLowerCase() : path
      if (isDependencyBinPath(path) || seen.has(identity)) return false
      seen.add(identity)
      return true
    })
    .join(delimiter)
}

const isolatedEnvironmentKeys = new Set([
  'agent_toolsdirectory', 'home', 'npm_config_cache', 'path', 'temp', 'tmp', 'tmpdir',
  'xdg_cache_home', 'xdg_config_home', 'xdg_data_home', 'xdg_runtime_dir', 'xdg_state_home',
])

const ciIdentityKeys = new Set([
  'github_actions', 'github_event_name', 'github_ref', 'github_ref_name', 'github_ref_type',
  'github_sha', 'runner_arch', 'runner_environment', 'runner_os',
])

function inheritEnvironmentKey(key) {
  const normalized = key.toLowerCase()
  if (isolatedEnvironmentKeys.has(normalized)) return false
  if (!normalized.startsWith('github_') && !normalized.startsWith('runner_')) return true
  return ciIdentityKeys.has(normalized) || normalized.startsWith('github_repository') ||
    normalized.startsWith('github_run_') || normalized.startsWith('github_workflow')
}

function hasEnvironmentKey(name) {
  return Object.keys(process.env).some(key => key.toLowerCase() === name)
}

function inheritedBuildEnvironment() {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => {
    return inheritEnvironmentKey(key)
  }))
  const path = inheritedBuildPath()
  if (!path) throw new Error('reproducible build has no trusted executable path')
  return { ...environment, PATH: path }
}

async function isolatedBuildContext(workspace, label, sourceSnapshot) {
  const boundary = join(workspace, label)
  const projectRoot = join(boundary, 'source')
  const temporaryRoot = join(boundary, 'tmp')
  const home = join(boundary, 'home')
  const npmCache = join(boundary, 'npm-cache')
  const toolCache = join(boundary, 'tool-cache')
  const runtimeDirectory = join(boundary, 'xdg-runtime')
  await Promise.all([
    cp(sourceSnapshot, projectRoot, { recursive: true, verbatimSymlinks: true }),
    mkdir(temporaryRoot, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(npmCache, { recursive: true }),
    mkdir(toolCache, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true, mode: 0o700 }),
  ])
  const environment = {
    ...inheritedBuildEnvironment(),
    HOME: home,
    TMPDIR: temporaryRoot,
    TMP: temporaryRoot,
    TEMP: temporaryRoot,
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_RUNTIME_DIR: runtimeDirectory,
    npm_config_cache: npmCache,
    NPM_CONFIG_CACHE: npmCache,
    ...(hasEnvironmentKey('github_workspace') ? { GITHUB_WORKSPACE: projectRoot } : {}),
    ...(hasEnvironmentKey('runner_workspace') ? { RUNNER_WORKSPACE: boundary } : {}),
    ...(hasEnvironmentKey('runner_temp') ? { RUNNER_TEMP: temporaryRoot } : {}),
    ...(hasEnvironmentKey('runner_tool_cache') ? { RUNNER_TOOL_CACHE: toolCache } : {}),
    ...(hasEnvironmentKey('agent_toolsdirectory') ? { AGENT_TOOLSDIRECTORY: toolCache } : {}),
  }
  return { projectRoot, temporaryRoot, environment }
}

async function buildIsolatedRelease(context, output) {
  await releasePreflight(context.projectRoot, context.environment)
  run('npm', ['ci'], { cwd: context.projectRoot, env: context.environment })
  const preflight = await releasePreflight(context.projectRoot, context.environment)
  return buildRelease(output, true, { ...context, preflight })
}

async function verifyReproducible(output) {
  const workspace = await mkdtemp(join(tmpdir(), 'modula-runner-reproducible-'))
  try {
    const sourceSnapshot = join(workspace, 'tracked-source')
    await copyTrackedSource(sourceSnapshot)
    const contexts = await Promise.all([
      isolatedBuildContext(workspace, 'first-build', sourceSnapshot),
      isolatedBuildContext(workspace, 'second-build', sourceSnapshot),
    ])
    const first = await buildIsolatedRelease(contexts[0], join(workspace, 'first-artifact'))
    const second = await buildIsolatedRelease(contexts[1], join(workspace, 'second-artifact'))
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

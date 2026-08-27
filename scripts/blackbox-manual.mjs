#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nodeBinDir = path.dirname(process.execPath)
const captureLimit = 1024 * 1024
const manifestLimit = 256 * 1024
const commandTimeoutMs = 10_000
const runnerManifest = parseJson(readFileSync(path.join(repoRoot, 'packages/runner/package.json'), 'utf8'))
const packageName = requiredString(runnerManifest, 'name')
const packageVersion = requiredString(runnerManifest, 'version')
const blockedCases = [
  { id: 'A1.5', reason: 'installed foreground runtime remains inactive under protocol v1' },
  { id: 'A1.6', reason: 'requires Task #47 human-owned real-plane infrastructure' },
  { id: 'A2', reason: 'requires the unapproved session-launch contract' },
  { id: 'A3.1-A3.2/A3.4-A3.5', reason: 'no installed preview launch surface is active under protocol v1' },
  { id: 'A4', reason: 'requires the unapproved session-launch contract' },
]

class CaseFailure extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

const rawArgs = process.argv.slice(2)
if (rawArgs.length === 1 && (rawArgs[0] === '--help' || rawArgs[0] === '-h')) {
  printHelp()
  process.exit(0)
}
const options = parseArgs(rawArgs)
const workspace = await mkdtemp(path.join(tmpdir(), 'runner-manual-blackbox-'))
const startedAt = new Date().toISOString()
const cases = []
const capturedOutput = []
let artifactSha256 = ''
let containmentPosture = 'unknown'
let nativeDependency = null
let exitCode = 0

try {
  assertToolchain()
  assertTrackedTreeClean()
  const installation = await installCandidate(workspace)
  artifactSha256 = digest(readFileSync(installation.artifact))
  const context = { ...installation, home: path.join(workspace, 'runner-home') }

  await runCase('A6.4', async () => await verifyInstalledSmoke(context))
  const policyReady = await runCase('A5.1', async () => {
    containmentPosture = await verifyPolicyAndStatus(context)
  })
  if (policyReady) {
    await runCase('A3.3', async () => verifyContainmentStatus(containmentPosture))
    await runCase('A5.3', async () => await verifyGrantLifecycle(context))
    if (options.controlPlane) await runCase('A1.2', async () => await verifyInteractivePair(context, options.controlPlane))
    else cases.push(skippedCase('A1.2', 'supply --control-plane to run the human TTY pairing journey'))
  } else {
    cases.push(skippedCase('A3.3', 'requires a valid initialized policy'))
    cases.push(skippedCase('A5.3', 'requires a valid initialized policy'))
    cases.push(skippedCase('A1.2', 'requires a valid initialized policy'))
  }
  await runCase('A5.5', async () => await verifyArchiveRefusal(context))
  await runCase('A6.5', async () => {
    nativeDependency = verifyNativeDependency(installation.packageRoot)
  })
} catch (error) {
  const reason = error instanceof CaseFailure ? error.code : 'unexpected-setup-failure'
  cases.push({ id: 'setup', startedAt, endedAt: new Date().toISOString(), outcome: 'failed', reason, logs: [] })
  exitCode = 1
} finally {
  const manifest = await writeManifest()
  console.log(`evidence: ${path.basename(manifest)}`)
  await rm(workspace, { recursive: true, force: true })
}

process.exitCode = exitCode

async function runCase(id, operation) {
  const start = new Date().toISOString()
  try {
    await operation()
    cases.push({ id, startedAt: start, endedAt: new Date().toISOString(), outcome: 'passed', logs: [] })
    console.log(`${id}: passed`)
    return true
  } catch (error) {
    const reason = error instanceof CaseFailure ? error.code : 'unexpected-failure'
    cases.push({ id, startedAt: start, endedAt: new Date().toISOString(), outcome: 'failed', reason, logs: [] })
    console.error(`${id}: failed (${reason})`)
    exitCode = 1
    return false
  }
}

async function installCandidate(root) {
  const output = path.join(root, 'artifact')
  const prefix = path.join(root, 'prefix')
  await Promise.all([
    mkdir(path.join(root, 'install-home')),
    mkdir(path.join(root, 'npm-cache')),
    mkdir(path.join(root, 'operator'), { mode: 0o700 }),
    mkdir(path.join(root, 'tmp')),
  ])
  checked(process.execPath, [path.join(repoRoot, 'scripts/release.mjs'), 'pack', '--output', output], {
    cwd: repoRoot,
    timeout: 20 * 60_000,
  }, 'candidate-build-failed')
  const artifact = path.join(output, `${packageName}-${packageVersion}.tgz`)
  checked(path.join(nodeBinDir, 'npm'), ['install', '--global', '--prefix', prefix, artifact], {
    cwd: root,
    env: installEnvironment(root),
    timeout: 10 * 60_000,
  }, 'candidate-install-failed')
  return {
    artifact,
    binary: path.join(prefix, 'bin', 'modula-runner'),
    packageRoot: path.join(prefix, 'lib', 'node_modules', packageName),
    root,
  }
}

async function verifyInstalledSmoke(context) {
  if (!existsSync(context.binary)) throw new CaseFailure('installed-binary-missing')
  const version = runInstalled(context, ['--version'])
  if (version.status !== 0 || version.stdout.trim() !== packageVersion || version.stderr) {
    throw new CaseFailure('installed-version-mismatch')
  }
  const help = runInstalled(context, ['--help'])
  if (help.status !== 0 || !help.stdout.includes('modula-runner') || help.stderr) {
    throw new CaseFailure('installed-help-failed')
  }
  const run = runInstalled(context, ['run'])
  if (run.status === 0 || run.status === null || run.stdout || !run.stderr) {
    throw new CaseFailure('installed-run-did-not-fail-closed')
  }
}

async function verifyPolicyAndStatus(context) {
  const keyPath = path.join(context.root, 'operator', 'allowlist.pem')
  const initialized = runInstalled(context, ['allowlist', 'init', '--key', keyPath])
  if (initialized.status !== 0) throw new CaseFailure('policy-init-failed')
  const status = runInstalled(context, ['status', '--json'])
  if (status.status !== 0 || status.stderr) throw new CaseFailure('status-failed')
  const value = parseJson(status.stdout)
  const containment = requiredString(value, 'containment')
  if (typeof value.prevention !== 'boolean') throw new CaseFailure('status-prevention-missing')
  const signingKey = await readFile(keyPath, 'utf8')
  const keyFragments = signingKey.split(/\s+/).filter(fragment => fragment.length >= 16)
  if (capturedOutput.some(output => keyFragments.some(fragment => output.includes(fragment)))) {
    throw new CaseFailure('signing-key-output-leak')
  }
  return containment
}

function verifyContainmentStatus(containment) {
  const allowed = new Set(['network-namespace', 'detect-and-stop', 'unavailable-by-platform'])
  if (!allowed.has(containment)) throw new CaseFailure('containment-status-invalid')
}

async function verifyGrantLifecycle(context) {
  const project = path.join(context.root, 'project')
  await mkdir(project)
  const granted = runInstalled(context, ['grant', project])
  const listed = runInstalled(context, ['grant', 'list'])
  const revoked = runInstalled(context, ['grant', 'revoke', project])
  const after = runInstalled(context, ['grant', 'list'])
  if (granted.status !== 0 || listed.status !== 0 || !listed.stdout.includes(project)) {
    throw new CaseFailure('grant-admission-failed')
  }
  if (revoked.status !== 0 || after.status !== 0 || after.stdout.includes(project)) {
    throw new CaseFailure('grant-revocation-failed')
  }
}

async function verifyArchiveRefusal(context) {
  const result = runInstalled(context, ['audit', 'archive', '--output', context.home])
  if (result.status === 0 || !result.stderr) throw new CaseFailure('archive-overlap-accepted')
}

function verifyNativeDependency(packageRoot) {
  const root = path.join(packageRoot, 'node_modules', 'node-pty')
  const manifest = parseJson(readFileSync(path.join(root, 'package.json'), 'utf8'))
  const version = requiredString(manifest, 'version')
  const prebuilt = path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'pty.node')
  const localBuild = path.join(root, 'build', 'Release', 'pty.node')
  const installPath = existsSync(prebuilt) ? 'prebuilt' : existsSync(localBuild) ? 'local-build' : null
  if (!installPath) throw new CaseFailure('node-pty-native-binary-missing')
  return { dependency: 'node-pty', version, installPath }
}

async function verifyInteractivePair(context, controlPlane) {
  const result = spawnSync(context.binary, ['pair', '--control-plane', controlPlane], {
    cwd: context.root,
    env: runnerEnvironment(context),
    stdio: 'inherit',
    timeout: 30_000,
  })
  if (result.status !== 0) throw new CaseFailure('interactive-pair-failed')
  const status = runInstalled(context, ['status', '--json'])
  if (status.status !== 0 || parseJson(status.stdout).state !== 'paired') {
    throw new CaseFailure('paired-status-missing')
  }
}

function runInstalled(context, args) {
  const result = spawnSync(context.binary, args, {
    cwd: context.root,
    env: runnerEnvironment(context),
    encoding: 'utf8',
    maxBuffer: captureLimit,
    timeout: commandTimeoutMs,
  })
  const output = { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  capturedOutput.push(output.stdout, output.stderr)
  return output
}

function checked(command, args, options, failure) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: 'utf8',
    maxBuffer: 10 * captureLimit,
  })
  if (result.status !== 0) throw new CaseFailure(failure)
  return result.stdout.trim()
}

function installEnvironment(root) {
  return {
    PATH: `${nodeBinDir}:/usr/bin:/bin`,
    HOME: path.join(root, 'install-home'),
    TMPDIR: path.join(root, 'tmp'),
    npm_config_cache: path.join(root, 'npm-cache'),
  }
}

function runnerEnvironment(context) {
  return {
    PATH: `${nodeBinDir}:/usr/bin:/bin`,
    HOME: context.root,
    TMPDIR: path.join(context.root, 'tmp'),
    MODULA_RUNNER_HOME: context.home,
  }
}

async function writeManifest() {
  const output = path.resolve(repoRoot, options.output)
  await mkdir(output, { recursive: true })
  const manifest = {
    schemaVersion: 1,
    sourceCommit: git(['rev-parse', 'HEAD']),
    candidateSha256: artifactSha256 || null,
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    npmVersion: npmVersion(),
    containmentPosture,
    nativeDependency,
    actor: process.env.USER ?? 'local-operator',
    startedAt,
    endedAt: new Date().toISOString(),
    outcome: exitCode === 0 ? 'passed' : 'failed',
    cases,
    blockedCases,
  }
  const encoded = `${JSON.stringify(manifest, null, 2)}\n`
  if (Buffer.byteLength(encoded) > manifestLimit) throw new Error('manual evidence manifest exceeded 256 KiB')
  const target = path.join(output, 'manifest.json')
  await writeFile(target, encoded, { mode: 0o600 })
  return target
}

function assertToolchain() {
  if (process.version !== 'v22.22.3') throw new CaseFailure('node-version-mismatch')
  if (npmVersion() !== '10.9.8') throw new CaseFailure('npm-version-mismatch')
}

function assertTrackedTreeClean() {
  if (git(['status', '--porcelain', '--untracked-files=no'])) throw new CaseFailure('tracked-tree-dirty')
}

function npmVersion() {
  return checked(path.join(nodeBinDir, 'npm'), ['--version'], { cwd: repoRoot, timeout: commandTimeoutMs }, 'npm-version-unavailable')
}

function git(args) {
  return checked('git', args, { cwd: repoRoot, timeout: commandTimeoutMs }, 'git-command-failed')
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function parseJson(value) {
  const parsed = JSON.parse(value)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new CaseFailure('json-object-required')
  return parsed
}

function requiredString(value, field) {
  const held = value[field]
  if (typeof held !== 'string' || held.length === 0) throw new CaseFailure(`missing-${field}`)
  return held
}

function skippedCase(id, reason) {
  const at = new Date().toISOString()
  return { id, startedAt: at, endedAt: at, outcome: 'skipped', reason, logs: [] }
}

function printHelp() {
  console.log(`Usage: npm run blackbox:manual -- [--output <directory>] [--control-plane <url>]

Builds and installs the tracked candidate in an isolated prefix, runs the protocol-v1 manual
A1/A3/A5/A6 checks, and writes a redacted manifest under .artifacts by default.

Requires a clean tracked tree, Node 22.22.3, npm 10.9.8, and the documented native build tools.
Use --control-plane only with a test customer-run control plane; the pairing code stays in the
installed command's hidden TTY prompt.`)
}

function parseArgs(args) {
  let output = '.artifacts/runner-blackbox-manual'
  let controlPlane = null
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--output' && args[index + 1]) output = args[++index]
    else if (args[index] === '--control-plane' && args[index + 1]) controlPlane = args[++index]
    else throw new Error('usage: npm run blackbox:manual -- [--output <directory>] [--control-plane <url>]')
  }
  return { output, controlPlane }
}

#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reportFailure, runProcess } from './cli-process.mjs'
import { evaluateVulnerabilities } from './vulnerability-policy.mjs'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const defaultOutput = join(repositoryRoot, 'dist', 'release')
const defaultWaivers = join(repositoryRoot, 'security', 'vulnerability-waivers.json')
const defaultAliases = join(repositoryRoot, 'security', 'advisory-aliases.json')
const workspaces = ['packages/linux-file-lock', 'packages/protocol', 'packages/runner']

function run(command, args, cwd) {
  return runProcess(command, args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
  })
}

function parseJson(value, label) {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`cannot parse ${label}`)
  }
}

async function readJson(path, label = 'required JSON input') {
  return parseJson(await readFile(path, 'utf8'), label)
}

function option(args, name, fallback) {
  const index = args.indexOf(name)
  if (index === -1) return fallback
  const value = args[index + 1]
  if (!value) throw new Error(`${name} requires a value`)
  return resolve(value)
}

function assertString(value, message) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(message)
  return value
}

function validateIntegrity(path, integrity) {
  const match = assertString(integrity, `${path} has no integrity`).match(/^sha512-([A-Za-z0-9+/]+={0,2})$/)
  if (!match || Buffer.from(match[1], 'base64').length !== 64) {
    throw new Error(`${path} does not have one valid SHA-512 integrity`)
  }
}

function validateLockEntry(path, entry, packages) {
  if (entry.link === true) {
    const target = assertString(entry.resolved, `${path} link has no target`)
    if (!workspaces.includes(target) || !packages[target]) {
      throw new Error(`${path} links to unknown workspace ${target}`)
    }
    return
  }
  assertString(entry.version, `${path} has no pinned version`)
  const resolved = assertString(entry.resolved, `${path} has no resolved artifact`)
  if (!resolved.startsWith('https://')) throw new Error(`${path} does not resolve over HTTPS`)
  validateIntegrity(path, entry.integrity)
}

async function validateWorkspaceEntry(projectRoot, path, entry) {
  const manifest = await readJson(join(projectRoot, path || '.', 'package.json'))
  if (entry.name !== manifest.name || entry.version !== manifest.version) {
    throw new Error(`${path || 'root'} manifest does not match package-lock.json`)
  }
}

function isInstalledPackagePath(path) {
  return path.startsWith('node_modules/') || path.includes('/node_modules/')
}

async function validateLock(projectRoot) {
  const lock = await readJson(join(projectRoot, 'package-lock.json'))
  if (lock.lockfileVersion !== 3 || typeof lock.packages !== 'object' || !lock.packages) {
    throw new Error('package-lock.json must be lockfileVersion 3 with a packages map')
  }
  for (const path of ['', ...workspaces]) {
    if (!lock.packages[path]) throw new Error(`package-lock.json is missing ${path || 'root'}`)
    await validateWorkspaceEntry(projectRoot, path, lock.packages[path])
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (isInstalledPackagePath(path)) validateLockEntry(path, entry, lock.packages)
  }
  return lock
}

function packagePath(component) {
  const property = component.properties?.find(item => item?.name === 'cdx:npm:package:path')
  return property?.value
}

async function canonicalizeSbom(sbom, projectRoot) {
  const names = new Map()
  for (const path of ['', ...workspaces]) {
    const manifest = await readJson(join(projectRoot, path || '.', 'package.json'))
    names.set(path, manifest.name)
  }
  sbom.metadata.component.name = names.get('')
  for (const component of sbom.components) {
    const name = names.get(packagePath(component))
    if (name) component.name = name
  }
  const runner = sbom.components.find(component => packagePath(component) === 'packages/runner')
  const subject = sbom.dependencies.find(item => item.ref === sbom.metadata.component['bom-ref'])
  if (!runner || !subject) throw new Error('SBOM cannot identify its released runner subject')
  subject.dependsOn = [runner['bom-ref']]
}

function expectedComponentPaths(lock) {
  return Object.entries(lock.packages)
    .filter(([path, entry]) => {
      if (workspaces.includes(path)) return true
      return isInstalledPackagePath(path) && entry.link !== true && entry.dev !== true
    })
    .map(([path]) => path)
    .sort()
}

function validateComponent(component, lockEntry) {
  const path = packagePath(component)
  if (typeof path !== 'string') throw new Error(`${component['bom-ref']} has no package path`)
  const label = path || 'root'
  if (component.version !== lockEntry.version) throw new Error(`${label} SBOM version differs from lock`)
  if (!Array.isArray(component.licenses) || component.licenses.length === 0) {
    throw new Error(`${label} SBOM component has no license`)
  }
  const expectedLicense = assertString(lockEntry.license, `${label} lock entry has no license`)
  const actualLicenses = component.licenses.flatMap(item => [
    item?.expression,
    item?.license?.id,
    item?.license?.name,
  ]).filter(value => typeof value === 'string')
  if (!actualLicenses.includes(expectedLicense)) {
    throw new Error(`${label} SBOM license differs from package-lock.json`)
  }
  if (component.properties?.some(item => item?.name === 'cdx:npm:package:development')) {
    throw new Error(`${label} is marked as a development dependency`)
  }
  if (!isInstalledPackagePath(path)) return
  const sri = lockEntry.integrity.slice('sha512-'.length)
  const expected = Buffer.from(sri, 'base64').toString('hex')
  const actual = component.hashes?.find(hash => hash?.alg === 'SHA-512')?.content
  if (actual !== expected) throw new Error(`${label} SBOM hash differs from lock integrity`)
}

function validateDependencyGraph(sbom) {
  const refs = new Set([sbom.metadata.component['bom-ref']])
  for (const component of sbom.components) {
    const ref = assertString(component['bom-ref'], 'SBOM component has no bom-ref')
    if (refs.has(ref)) throw new Error(`duplicate SBOM bom-ref ${ref}`)
    refs.add(ref)
  }
  const graphRefs = new Set()
  for (const dependency of sbom.dependencies) {
    if (!refs.has(dependency.ref)) throw new Error(`unknown dependency ref ${dependency.ref}`)
    if (graphRefs.has(dependency.ref)) throw new Error(`duplicate dependency graph ref ${dependency.ref}`)
    graphRefs.add(dependency.ref)
    for (const target of dependency.dependsOn ?? []) {
      if (!refs.has(target)) throw new Error(`${dependency.ref} depends on unknown ${target}`)
    }
  }
  for (const ref of refs) if (!graphRefs.has(ref)) throw new Error(`dependency graph omits ${ref}`)
}

function resolvedDependencyPath(packages, fromPath, name) {
  let directory = fromPath
  while (true) {
    const candidate = directory ? `${directory}/node_modules/${name}` : `node_modules/${name}`
    const entry = packages[candidate]
    if (entry) return entry.link ? entry.resolved : candidate
    if (!directory) return undefined
    const marker = directory.lastIndexOf('/node_modules/')
    directory = marker >= 0 ? directory.slice(0, marker) : ''
  }
}

function resolveDependencyPath(packages, fromPath, name) {
  const target = resolvedDependencyPath(packages, fromPath, name)
  if (!target) throw new Error(`${fromPath} depends on unresolved ${name}`)
  return target
}

function validatePeerPlacement(lock, path, name) {
  if (isInstalledPackagePath(path) && lock.packages[`${path}/node_modules/${name}`]) {
    throw new Error(`${path} has peer-local dependency ${name}`)
  }
}

function expectedPeerDependencyPaths(lock, path, productionPaths) {
  const entry = lock.packages[path]
  return Object.keys(entry.peerDependencies ?? {}).flatMap(name => {
    const target = resolvedDependencyPath(lock.packages, path, name)
    if (!target) {
      if (entry.peerDependenciesMeta?.[name]?.optional === true) return []
      throw new Error(`${path} depends on unresolved peer ${name}`)
    }
    validatePeerPlacement(lock, path, name)
    return productionPaths.has(target) ? [target] : []
  })
}

function expectedDependencyPaths(lock, path, productionPaths) {
  const entry = lock.packages[path]
  const names = new Set([
    ...Object.keys(entry.dependencies ?? {}),
    ...Object.keys(entry.optionalDependencies ?? {}),
  ])
  const direct = [...names].map(name => resolveDependencyPath(lock.packages, path, name))
  return [...new Set([...direct, ...expectedPeerDependencyPaths(lock, path, productionPaths)])].sort()
}

function validateLockEdges(sbom, lock, byPath) {
  const graph = new Map(sbom.dependencies.map(item => [item.ref, item.dependsOn ?? []]))
  const componentPaths = expectedComponentPaths(lock)
  const productionPaths = new Set(componentPaths)
  for (const path of componentPaths) {
    const component = byPath.get(path)
    const expected = expectedDependencyPaths(lock, path, productionPaths).map(target => {
      const dependency = byPath.get(target)
      if (!dependency) throw new Error(`${path} depends on omitted production component ${target}`)
      return dependency['bom-ref']
    }).sort()
    const actual = [...(graph.get(component['bom-ref']) ?? [])].sort()
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${path} SBOM edges differ from package-lock.json`)
    }
  }
}

function validateSubjectReachability(sbom) {
  const graph = new Map(sbom.dependencies.map(item => [item.ref, item.dependsOn ?? []]))
  const runner = sbom.components.find(component => packagePath(component) === 'packages/runner')
  const rootRef = sbom.metadata.component['bom-ref']
  if (!runner || JSON.stringify(graph.get(rootRef)) !== JSON.stringify([runner['bom-ref']])) {
    throw new Error('SBOM subject must point to the released runner')
  }
  const reachable = new Set([rootRef])
  const pending = [rootRef]
  while (pending.length) {
    for (const target of graph.get(pending.pop()) ?? []) {
      if (!reachable.has(target)) pending.push(target)
      reachable.add(target)
    }
  }
  if (reachable.size !== graph.size) throw new Error('SBOM contains a component unreachable from its subject')
}

function validateSbomGenerator(sbom, npmVersion) {
  const npmTool = sbom.metadata.tools?.find(tool => tool?.vendor === 'npm' && tool?.name === 'cli')
  if (!npmVersion || npmTool?.version !== npmVersion) {
    throw new Error('SBOM generator differs from the pinned npm version')
  }
}

async function validateSbom(sbom, lock, projectRoot) {
  if (sbom.bomFormat !== 'CycloneDX' || sbom.specVersion !== '1.5') {
    throw new Error('SBOM must be CycloneDX 1.5')
  }
  if (sbom.$schema !== 'http://cyclonedx.org/schema/bom-1.5.schema.json') {
    throw new Error('SBOM has an unexpected schema')
  }
  if (!Array.isArray(sbom.components) || !Array.isArray(sbom.dependencies)) {
    throw new Error('SBOM components and dependencies must be arrays')
  }
  const rootManifest = await readJson(join(projectRoot, 'package.json'))
  const npmVersion = rootManifest.packageManager?.replace(/^npm@/, '')
  validateSbomGenerator(sbom, npmVersion)
  if (sbom.metadata.component.name !== rootManifest.name) throw new Error('SBOM subject name differs from root manifest')
  const componentPaths = sbom.components.map(component => packagePath(component))
  if (componentPaths.some(path => typeof path !== 'string') ||
      new Set(componentPaths).size !== componentPaths.length) {
    throw new Error('SBOM contains missing or duplicate package paths')
  }
  const byPath = new Map(sbom.components.map(component => [packagePath(component), component]))
  const actualPaths = [...byPath.keys()].sort()
  const expectedPaths = expectedComponentPaths(lock)
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(`SBOM paths differ from production lock tree: ${actualPaths.join(', ')}`)
  }
  for (const path of expectedPaths) validateComponent(byPath.get(path), lock.packages[path])
  validateComponent(sbom.metadata.component, lock.packages[''])
  validateDependencyGraph(sbom)
  validateLockEdges(sbom, lock, byPath)
  validateSubjectReachability(sbom)
}

function npmSbom(projectRoot) {
  return parseJson(run('npm', [
    'sbom', '--package-lock-only', '--workspace=packages/runner', '--omit=dev',
    '--sbom-format=cyclonedx', '--sbom-type=library',
  ], projectRoot), 'npm SBOM output')
}

async function generateSbom(projectRoot, output, lock) {
  const sbom = npmSbom(projectRoot)
  await canonicalizeSbom(sbom, projectRoot)
  await validateSbom(sbom, lock, projectRoot)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(sbom, null, 2)}\n`)
  return sbom
}

async function validateSbomFile(projectRoot, input) {
  const lock = await validateLock(projectRoot)
  const npmVersion = (await readJson(join(projectRoot, 'package.json'))).packageManager?.replace(/^npm@/, '')
  validateSbomGenerator(npmSbom(projectRoot), npmVersion)
  await validateSbom(await readJson(input), lock, projectRoot)
}

async function evaluateAuditFiles(prodPath, allPath, lock, waiverPath, aliasPath, now) {
  const semver = (await import('semver')).default
  return evaluateVulnerabilities({
    prodReport: await readJson(prodPath, 'production audit report'),
    allReport: await readJson(allPath, 'complete audit report'),
    lock,
    waiverDocument: await readJson(waiverPath),
    aliasDocument: await readJson(aliasPath),
    semver,
    now,
  })
}

async function writeAuditSummary(result, output) {
  const summary = {
    production: { findings: result.prod, blocked: result.blocked },
    developmentOnly: { findings: result.developmentOnly, blocking: false },
    waiversApplied: [...result.applied].map(index => result.waivers[index]),
  }
  await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`)
}

function auditBlocker(result) {
  if (result.unused.length > 0) return { kind: 'unused-waivers' }
  if (result.blocked.length > 0) {
    return { kind: 'production-vulnerabilities', findings: result.blocked }
  }
  return undefined
}

async function evaluateLiveAudit(projectRoot, output, waiverPath, aliasPath, now) {
  const lock = await validateLock(projectRoot)
  const prodPath = join(output, 'audit-prod.json')
  const allPath = join(output, 'audit-all.json')
  await mkdir(output, { recursive: true })
  await writeFile(prodPath, run('npm', ['audit', '--package-lock-only', '--omit=dev', '--audit-level=none', '--json'], projectRoot))
  await writeFile(allPath, run('npm', ['audit', '--package-lock-only', '--include=dev', '--audit-level=none', '--json'], projectRoot))
  const result = await evaluateAuditFiles(prodPath, allPath, lock, waiverPath, aliasPath, now)
  await writeAuditSummary(result, join(output, 'audit-summary.json'))
  return { lock, result, blocker: auditBlocker(result) }
}

function requirePassingAudit(evaluation) {
  if (evaluation.blocker?.kind === 'unused-waivers') {
    throw new Error('vulnerability waiver policy rejected the audit')
  }
  if (evaluation.blocker?.kind === 'production-vulnerabilities') {
    throw new Error('production vulnerability policy rejected the audit')
  }
  return evaluation.lock
}

async function auditGate(projectRoot, output, waiverPath, aliasPath, now) {
  return requirePassingAudit(
    await evaluateLiveAudit(projectRoot, output, waiverPath, aliasPath, now),
  )
}

async function appendSbomChecksum(output, sbomPath) {
  const content = await readFile(sbomPath)
  const digest = createHash('sha256').update(content).digest('hex')
  const sumsPath = join(output, 'SHA256SUMS')
  const sbomName = basename(sbomPath)
  const sums = (await readFile(sumsPath, 'utf8'))
    .trim().split('\n').filter(line => !line.endsWith(`  ${sbomName}`))
  await writeFile(sumsPath, `${sums.join('\n')}\n${digest}  ${sbomName}\n`)
}

async function runGate(projectRoot, output, waiverPath, aliasPath = defaultAliases, now = Date.now()) {
  const lock = await auditGate(projectRoot, output, waiverPath, aliasPath, now)
  const sbomPath = join(output, 'modula-runner.cdx.json')
  await generateSbom(projectRoot, sbomPath, lock)
  await appendSbomChecksum(output, sbomPath)
  process.stdout.write('supply-chain gate passed\n')
}

async function copySeedProject(target) {
  await mkdir(join(target, 'packages', 'linux-file-lock'), { recursive: true })
  await mkdir(join(target, 'packages', 'protocol'), { recursive: true })
  await mkdir(join(target, 'packages', 'runner'), { recursive: true })
  await cp(join(repositoryRoot, 'package.json'), join(target, 'package.json'))
  await cp(join(repositoryRoot, 'package-lock.json'), join(target, 'package-lock.json'))
  await cp(join(repositoryRoot, 'packages', 'linux-file-lock', 'package.json'), join(target, 'packages', 'linux-file-lock', 'package.json'))
  await cp(join(repositoryRoot, 'packages', 'protocol', 'package.json'), join(target, 'packages', 'protocol', 'package.json'))
  await cp(join(repositoryRoot, 'packages', 'runner', 'package.json'), join(target, 'packages', 'runner', 'package.json'))
}

const expectedSeedFindings = [
  {
    ghsa: 'GHSA-35jh-r3h4-6jhm',
    package: 'lodash',
    version: '4.17.20',
    node: 'node_modules/lodash',
    severity: 'high',
  },
  {
    ghsa: 'GHSA-r5fr-rjxr-66jc',
    package: 'lodash',
    version: '4.17.20',
    node: 'node_modules/lodash',
    severity: 'high',
  },
]

function findingKey(finding) {
  return ['ghsa', 'package', 'version', 'node', 'severity']
    .map(field => finding[field])
    .join('\0')
}

function provesExpectedSeed(evaluation) {
  if (evaluation.blocker?.kind !== 'production-vulnerabilities') return false
  const actual = evaluation.blocker.findings.map(findingKey).sort()
  const expected = expectedSeedFindings.map(findingKey).sort()
  return JSON.stringify(actual) === JSON.stringify(expected)
}

async function proveKnownVulnerabilityFails() {
  const project = await mkdtemp(join(tmpdir(), 'modula-runner-known-vulnerability-'))
  try {
    await copySeedProject(project)
    run('npm', [
      'install', '--package-lock-only', '--ignore-scripts', '--save-exact',
      '--workspace=packages/runner', 'lodash@4.17.20',
    ], project)
    const evaluation = await evaluateLiveAudit(
      project,
      join(project, 'dist', 'release'),
      defaultWaivers,
      defaultAliases,
      Date.now(),
    )
    if (!provesExpectedSeed(evaluation)) {
      throw new Error('seeded vulnerability proof did not produce the exact expected blocking set')
    }
    process.stdout.write(
      'seeded vulnerability proof passed: GHSA-35jh-r3h4-6jhm, GHSA-r5fr-rjxr-66jc\n',
    )
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

async function runAuditFixtures(args) {
  const projectRoot = option(args, '--root', repositoryRoot)
  const output = option(args, '--output', defaultOutput)
  const prod = option(args, '--prod')
  const all = option(args, '--all')
  const waivers = option(args, '--waivers', defaultWaivers)
  const aliases = option(args, '--aliases', defaultAliases)
  if (!prod || !all) throw new Error('audit requires --prod and --all')
  const lock = await validateLock(projectRoot)
  const now = Date.parse(args.includes('--now') ? args[args.indexOf('--now') + 1] : new Date().toISOString())
  if (!Number.isFinite(now)) throw new Error('audit --now must be an ISO timestamp')
  const result = await evaluateAuditFiles(prod, all, lock, waivers, aliases, now)
  await mkdir(output, { recursive: true })
  await writeAuditSummary(result, join(output, 'audit-summary.json'))
  if (result.unused.length || result.blocked.length) throw new Error('audit fixtures did not pass the waiver gate')
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'lock') return validateLock(option(args, '--root', repositoryRoot))
  if (command === 'sbom') {
    const projectRoot = option(args, '--root', repositoryRoot)
    const output = option(args, '--output', join(defaultOutput, 'modula-runner.cdx.json'))
    return generateSbom(projectRoot, output, await validateLock(projectRoot))
  }
  if (command === 'validate-sbom') {
    const projectRoot = option(args, '--root', repositoryRoot)
    const input = option(args, '--input')
    if (!input) throw new Error('validate-sbom requires --input')
    return validateSbomFile(projectRoot, input)
  }
  if (command === 'gate' || command === 'live-audit') {
    const projectRoot = option(args, '--root', repositoryRoot)
    const output = option(args, '--output', defaultOutput)
    const waivers = option(args, '--waivers', defaultWaivers)
    const aliases = option(args, '--aliases', defaultAliases)
    if (command === 'live-audit') {
      return auditGate(projectRoot, output, waivers, aliases, Date.now())
    }
    return runGate(projectRoot, output, waivers, aliases)
  }
  if (command === 'audit') return runAuditFixtures(args)
  if (command === 'seed-known-vulnerability') return proveKnownVulnerabilityFails()
  throw new Error('usage: supply-chain.mjs lock|sbom|validate-sbom|gate|live-audit|audit|seed-known-vulnerability [options]')
}

main().catch(error => {
  reportFailure('supply-chain', error)
  process.exitCode = 1
})

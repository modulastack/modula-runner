import { spawnSync } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const root = process.cwd()
const supplyChainScript = join(root, 'scripts', 'supply-chain.mjs')
const workspaces: string[] = []

type AuditPaths = {
  prod: string
  all: string
  waivers: string
  aliases: string
  output: string
}

function runSupplyChain(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [supplyChainScript, ...args], {
    cwd: root,
    encoding: 'utf8',
    env,
  })
}

async function temporaryWorkspace() {
  const target = await mkdtemp(join(tmpdir(), 'modula-runner-supply-test-'))
  workspaces.push(target)
  await mkdir(join(target, 'packages', 'protocol'), { recursive: true })
  await mkdir(join(target, 'packages', 'runner'), { recursive: true })
  await cp(join(root, 'package.json'), join(target, 'package.json'))
  await cp(join(root, 'package-lock.json'), join(target, 'package-lock.json'))
  await cp(join(root, 'packages', 'protocol', 'package.json'), join(target, 'packages', 'protocol', 'package.json'))
  await cp(join(root, 'packages', 'runner', 'package.json'), join(target, 'packages', 'runner', 'package.json'))
  return target
}

function auditReport(vulnerabilities: Record<string, unknown> = {}) {
  return { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: {} } }
}

function highVulnerability(name = 'ws') {
  return {
    [name]: {
      name,
      severity: 'high',
      isDirect: true,
      via: [{
        source: 1,
        name,
        dependency: name,
        title: 'fixture',
        url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
        severity: 'high',
        range: '<9',
      }],
      effects: [],
      range: '<9',
      nodes: [`node_modules/${name}`],
      fixAvailable: false,
    },
  }
}

function highWaiver(overrides: Record<string, string> = {}) {
  return {
    ghsa: 'GHSA-aaaa-bbbb-cccc',
    cve: 'CVE-2026-1234',
    package: 'ws',
    version: '8.21.3',
    node: 'node_modules/ws',
    severity: 'high',
    reason: 'fixture context is unreachable',
    expires: '2026-09-01',
    ...overrides,
  }
}

function advisoryAliases(): {
  version: number
  advisories: Record<string, { cves: string[], source: string, verified: string }>
} {
  return {
    version: 1,
    advisories: {
      'GHSA-aaaa-bbbb-cccc': {
        cves: ['CVE-2026-1234'],
        source: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
        verified: '2026-01-01',
      },
    },
  }
}

async function writeAuditInputs(
  workspace: string,
  prod: object,
  all: object,
  waivers: object,
  aliases: object = { version: 1, advisories: {} },
): Promise<AuditPaths> {
  const paths = {
    prod: join(workspace, 'prod.json'),
    all: join(workspace, 'all.json'),
    waivers: join(workspace, 'waivers.json'),
    aliases: join(workspace, 'aliases.json'),
    output: join(workspace, 'output'),
  }
  await writeFile(paths.prod, JSON.stringify(prod))
  await writeFile(paths.all, JSON.stringify(all))
  await writeFile(paths.waivers, JSON.stringify(waivers))
  await writeFile(paths.aliases, JSON.stringify(aliases))
  return paths
}

function auditCommand(workspace: string, paths: AuditPaths, now?: string) {
  const command = [
    'audit', '--root', workspace, '--prod', paths.prod, '--all', paths.all,
    '--waivers', paths.waivers, '--aliases', paths.aliases, '--output', paths.output,
  ]
  if (now) command.push('--now', now)
  return command
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('release supply-chain gate', () => {
  it('requires integrity at root and workspace-nested registry locations', async () => {
    expect(runSupplyChain(['lock']).status).toBe(0)
    const workspace = await temporaryWorkspace()
    const lockPath = join(workspace, 'package-lock.json')
    const lock = JSON.parse(await readFile(lockPath, 'utf8'))
    delete lock.packages['node_modules/ws'].integrity
    await writeFile(lockPath, JSON.stringify(lock))
    const result = runSupplyChain(['lock', '--root', workspace])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('node_modules/ws has no integrity')

    const nestedWorkspace = await temporaryWorkspace()
    const nestedLockPath = join(nestedWorkspace, 'package-lock.json')
    const nestedLock = JSON.parse(await readFile(nestedLockPath, 'utf8'))
    nestedLock.packages['packages/runner/node_modules/is-number'] = {
      version: '7.0.0',
      resolved: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz',
      dev: true,
      license: 'MIT',
    }
    await writeFile(nestedLockPath, JSON.stringify(nestedLock))
    const nestedResult = runSupplyChain(['lock', '--root', nestedWorkspace])
    expect(nestedResult.status).toBe(1)
    expect(nestedResult.stderr).toContain('packages/runner/node_modules/is-number has no integrity')
  })

  it('keeps the pre-install lock check free of node_modules imports', async () => {
    const isolated = await mkdtemp(join(tmpdir(), 'modula-runner-preinstall-'))
    workspaces.push(isolated)
    const scripts = join(isolated, 'scripts')
    await mkdir(scripts)
    for (const name of ['cli-process.mjs', 'supply-chain.mjs', 'vulnerability-policy.mjs']) {
      await cp(join(root, 'scripts', name), join(scripts, name))
    }

    const result = spawnSync(
      process.execPath,
      [join(scripts, 'supply-chain.mjs'), 'lock', '--root', root],
      { cwd: isolated, encoding: 'utf8' },
    )
    expect(result.status).toBe(0)
  })

  it('generates a reachable production-only CycloneDX inventory', async () => {
    const workspace = await temporaryWorkspace()
    const output = join(workspace, 'runner.cdx.json')
    expect(runSupplyChain(['sbom', '--output', output]).status).toBe(0)
    const sbom = JSON.parse(await readFile(output, 'utf8'))
    expect(sbom.bomFormat).toBe('CycloneDX')
    expect(sbom.specVersion).toBe('1.5')
    expect(sbom.metadata.component.name).toBe('modula-runner-workspace')
    expect(sbom.components.map((component: { name: string }) => component.name)).toEqual([
      'node-addon-api', 'node-pty', 'ws', '@modulastack/runner-protocol', 'modula-runner',
    ])
    expect(JSON.stringify(sbom)).not.toContain('cdx:npm:package:development')
    const subject = sbom.dependencies.find(
      (dependency: { ref: string }) => dependency.ref === sbom.metadata.component['bom-ref'],
    )
    expect(subject.dependsOn).toEqual(['modula-runner@0.1.0'])
  })

  it('rejects duplicate package paths before subject or graph trust', async () => {
    const workspace = await temporaryWorkspace()
    const output = join(workspace, 'runner.cdx.json')
    expect(runSupplyChain(['sbom', '--output', output]).status).toBe(0)
    const sbom = JSON.parse(await readFile(output, 'utf8'))
    const runner = sbom.components.find((component: { properties?: Array<{ name: string, value: string }> }) =>
      component.properties?.some(property =>
        property.name === 'cdx:npm:package:path' && property.value === 'packages/runner'))
    const bogus = structuredClone(runner)
    bogus['bom-ref'] = `${runner['bom-ref']}-bogus`
    bogus.version = '9.9.9'
    sbom.components.unshift(bogus)
    const rootDependency = sbom.dependencies.find(
      (dependency: { ref: string }) => dependency.ref === sbom.metadata.component['bom-ref'],
    )
    rootDependency.dependsOn = [bogus['bom-ref']]
    sbom.dependencies.unshift({ ref: bogus['bom-ref'], dependsOn: [runner['bom-ref']] })
    await writeFile(output, JSON.stringify(sbom))

    const result = runSupplyChain(['validate-sbom', '--input', output])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('SBOM contains missing or duplicate package paths')
  })

  it('rejects an SBOM license that differs from the locked package', async () => {
    const workspace = await temporaryWorkspace()
    const output = join(workspace, 'runner.cdx.json')
    expect(runSupplyChain(['sbom', '--output', output]).status).toBe(0)
    const sbom = JSON.parse(await readFile(output, 'utf8'))
    const ws = sbom.components.find((component: { properties?: Array<{ name: string, value: string }> }) =>
      component.properties?.some(property =>
        property.name === 'cdx:npm:package:path' && property.value === 'node_modules/ws'))
    ws.licenses = [{ license: { id: 'GPL-3.0-only' } }]
    await writeFile(output, JSON.stringify(sbom))

    const result = runSupplyChain(['validate-sbom', '--input', output])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('node_modules/ws SBOM license differs from package-lock.json')
  })

  it('rejects a removed transitive production edge', async () => {
    const workspace = await temporaryWorkspace()
    const output = join(workspace, 'runner.cdx.json')
    expect(runSupplyChain(['sbom', '--output', output]).status).toBe(0)
    const sbom = JSON.parse(await readFile(output, 'utf8'))
    const nodePty = sbom.dependencies.find(
      (dependency: { ref: string }) => dependency.ref === 'node-pty@1.1.0',
    )
    nodePty.dependsOn = []
    await writeFile(output, JSON.stringify(sbom))
    const result = runSupplyChain(['validate-sbom', '--input', output])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('node_modules/node-pty SBOM edges differ')
  })

  it('blocks an unwaived production High advisory', async () => {
    const workspace = await temporaryWorkspace()
    const report = auditReport(highVulnerability())
    const paths = await writeAuditInputs(workspace, report, report, { version: 1, waivers: [] })
    expect(runSupplyChain(auditCommand(workspace, paths)).status).toBe(1)
    const summary = JSON.parse(await readFile(join(paths.output, 'audit-summary.json'), 'utf8'))
    expect(summary.production.blocked[0].ghsa).toBe('GHSA-aaaa-bbbb-cccc')
  })

  it('accepts only an exact active waiver and re-blocks it at expiry', async () => {
    const workspace = await temporaryWorkspace()
    const report = auditReport(highVulnerability())
    const paths = await writeAuditInputs(
      workspace,
      report,
      report,
      { version: 1, waivers: [highWaiver()] },
      advisoryAliases(),
    )
    expect(runSupplyChain(auditCommand(workspace, paths, '2026-08-31T23:59:59Z')).status).toBe(0)
    expect(runSupplyChain(auditCommand(workspace, paths, '2026-09-01T00:00:00Z')).status).toBe(1)
  })

  it('rejects a nonexistent Gregorian waiver date', async () => {
    const workspace = await temporaryWorkspace()
    const report = auditReport(highVulnerability())
    const paths = await writeAuditInputs(
      workspace,
      report,
      report,
      { version: 1, waivers: [highWaiver({ expires: '2026-02-30' })] },
      advisoryAliases(),
    )
    const result = runSupplyChain(auditCommand(workspace, paths, '2026-02-28T00:00:00Z'))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('invalid waiver expiry 2026-02-30')
  })

  it('rejects a syntactically valid but unverified GHSA/CVE pair', async () => {
    const workspace = await temporaryWorkspace()
    const report = auditReport(highVulnerability())
    const paths = await writeAuditInputs(
      workspace,
      report,
      report,
      { version: 1, waivers: [highWaiver({ cve: 'CVE-2099-9999' })] },
      advisoryAliases(),
    )
    const result = runSupplyChain(auditCommand(workspace, paths, '2026-08-31T00:00:00Z'))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('unverified GHSA/CVE pair')
  })

  it('matches each advisory only to installed versions in its own range', async () => {
    const workspace = await temporaryWorkspace()
    const lockPath = join(workspace, 'package-lock.json')
    const lock = JSON.parse(await readFile(lockPath, 'utf8'))
    const nestedNode = 'packages/runner/node_modules/ws'
    lock.packages[nestedNode] = {
      version: '9.0.0-beta.1',
      resolved: 'https://registry.npmjs.org/ws/-/ws-9.0.0-beta.1.tgz',
      integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
      license: 'MIT',
    }
    await writeFile(lockPath, JSON.stringify(lock))
    const report = auditReport({
      ws: {
        name: 'ws', severity: 'high', isDirect: true, effects: [], range: '<8.22.0 || >=9.0.0-beta.0 <9.0.0',
        via: [
          {
            source: 1, name: 'ws', dependency: 'ws', title: 'stable fixture',
            url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'high', range: '<8.22.0',
          },
          {
            source: 2, name: 'ws', dependency: 'ws', title: 'prerelease fixture',
            url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff', severity: 'high',
            range: '>=9.0.0-beta.0 <9.0.0',
          },
        ],
        nodes: ['node_modules/ws', nestedNode],
        fixAvailable: false,
      },
    })
    const aliases = advisoryAliases()
    aliases.advisories['GHSA-dddd-eeee-ffff'] = {
      cves: ['CVE-2026-5678'],
      source: 'https://github.com/advisories/GHSA-dddd-eeee-ffff',
      verified: '2026-01-01',
    }
    const paths = await writeAuditInputs(
      workspace,
      report,
      report,
      {
        version: 1,
        waivers: [
          highWaiver(),
          highWaiver({
            ghsa: 'GHSA-dddd-eeee-ffff', cve: 'CVE-2026-5678',
            version: '9.0.0-beta.1', node: nestedNode,
          }),
        ],
      },
      aliases,
    )

    expect(runSupplyChain(auditCommand(workspace, paths, '2026-08-31T00:00:00Z')).status).toBe(0)
    const summary = JSON.parse(await readFile(join(paths.output, 'audit-summary.json'), 'utf8'))
    expect(summary.production.findings.map(
      (finding: { ghsa: string, node: string }) => [finding.ghsa, finding.node],
    )).toEqual([
      ['GHSA-aaaa-bbbb-cccc', 'node_modules/ws'],
      ['GHSA-dddd-eeee-ffff', nestedNode],
    ])
  })

  it('fails closed on a malformed advisory range', async () => {
    const workspace = await temporaryWorkspace()
    const vulnerabilities = highVulnerability()
    const advisory = vulnerabilities.ws?.via[0]
    if (!advisory) throw new Error('fixture advisory is missing')
    advisory.range = 'not a semver range ('
    const report = auditReport(vulnerabilities)
    const paths = await writeAuditInputs(workspace, report, report, { version: 1, waivers: [] })

    const result = runSupplyChain(auditCommand(workspace, paths))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('invalid advisory range for GHSA-aaaa-bbbb-cccc')
  })

  it('does not accept or disclose a malformed seeded advisory URL', async () => {
    const workspace = await temporaryWorkspace()
    const bin = join(workspace, 'bin')
    const canary = 'successful-audit-secret-canary'
    await mkdir(bin)
    await writeFile(join(bin, 'npm'), `#!/bin/sh
case "$1" in
  install) exit 0 ;;
  audit) printf '%s\\n' "$FAKE_AUDIT_REPORT"; exit 0 ;;
  *) exit 64 ;;
esac
`)
    await chmod(join(bin, 'npm'), 0o755)
    const vulnerabilities = highVulnerability()
    const advisory = vulnerabilities.ws?.via[0]
    if (!advisory) throw new Error('fixture advisory is missing')
    advisory.url = `https://github.com/advisories/GHSA-35jh-r3h4-6jhm?credential=\u001b[31m${canary}`
    const result = runSupplyChain(['seed-known-vulnerability'], {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_AUDIT_REPORT: JSON.stringify(auditReport(vulnerabilities)),
    })

    expect(result.status).toBe(1)
    expect(`${result.stdout}${result.stderr}`).not.toContain(canary)
    expect(`${result.stdout}${result.stderr}`).not.toContain('\u001b')
    expect(result.stdout).not.toContain('seeded vulnerability proof passed')

    const invalidJson = runSupplyChain(['seed-known-vulnerability'], {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_AUDIT_REPORT: `{"credential":"${canary}`,
    })
    expect(invalidJson.status).toBe(1)
    expect(`${invalidJson.stdout}${invalidJson.stderr}`).not.toContain(canary)
  })

  it('accepts only the exact structured seeded blocking set', async () => {
    const workspace = await temporaryWorkspace()
    const bin = join(workspace, 'bin')
    const mutator = join(workspace, 'add-lodash.cjs')
    await mkdir(bin)
    await writeFile(mutator, `const fs = require('node:fs')
const path = process.argv[2]
const lock = JSON.parse(fs.readFileSync(path, 'utf8'))
lock.packages['node_modules/lodash'] = {
  version: '4.17.20',
  resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz',
  integrity: 'sha512-${Buffer.alloc(64, 2).toString('base64')}',
  license: 'MIT'
}
fs.writeFileSync(path, JSON.stringify(lock))
`)
    await writeFile(join(bin, 'npm'), `#!/bin/sh
case "$1" in
  install) node "$LOCK_MUTATOR" "$PWD/package-lock.json"; exit 0 ;;
  audit) printf '%s\\n' "$FAKE_AUDIT_REPORT"; exit 0 ;;
  *) exit 64 ;;
esac
`)
    await chmod(join(bin, 'npm'), 0o755)
    const vulnerabilities = {
      lodash: {
        name: 'lodash', severity: 'high', isDirect: true, effects: [], range: '<4.17.21',
        via: [
          {
            source: 1, name: 'lodash', dependency: 'lodash', title: 'fixture one',
            url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm',
            severity: 'high', range: '<4.17.21',
          },
          {
            source: 2, name: 'lodash', dependency: 'lodash', title: 'fixture two',
            url: 'https://github.com/advisories/GHSA-r5fr-rjxr-66jc',
            severity: 'high', range: '<4.17.21',
          },
        ],
        nodes: ['node_modules/lodash'], fixAvailable: false,
      },
    }
    const result = runSupplyChain(['seed-known-vulnerability'], {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      LOCK_MUTATOR: mutator,
      FAKE_AUDIT_REPORT: JSON.stringify(auditReport(vulnerabilities)),
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout.trim()).toBe(
      'seeded vulnerability proof passed: GHSA-35jh-r3h4-6jhm, GHSA-r5fr-rjxr-66jc',
    )
  })

  it('does not repeat credentials from a failed npm child process', async () => {
    const workspace = await temporaryWorkspace()
    const canary = 'diagnostic-canary:secret'
    const result = runSupplyChain(
      ['gate', '--root', workspace, '--output', join(workspace, 'output')],
      {
        ...process.env,
        npm_config_registry: `http://${canary}@127.0.0.1:9/`,
        npm_config_fetch_retries: '0',
        npm_config_fetch_timeout: '200',
      },
    )

    expect(result.status).toBe(1)
    expect(result.stderr).not.toContain(canary)
    expect(result.stderr).toContain('npm failed with exit')
  })

  it('reports a development-only High advisory without blocking', async () => {
    const workspace = await temporaryWorkspace()
    const paths = await writeAuditInputs(
      workspace,
      auditReport(),
      auditReport(highVulnerability('vitest')),
      { version: 1, waivers: [] },
    )
    expect(runSupplyChain(auditCommand(workspace, paths)).status).toBe(0)
    const summary = JSON.parse(await readFile(join(paths.output, 'audit-summary.json'), 'utf8'))
    expect(summary.developmentOnly).toEqual({
      findings: [{
        ghsa: 'GHSA-aaaa-bbbb-cccc', package: 'vitest', version: '3.2.7',
        node: 'node_modules/vitest', severity: 'high',
      }],
      blocking: false,
    })
  })
})

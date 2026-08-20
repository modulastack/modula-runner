import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = process.cwd()
const releaseScript = join(root, 'scripts', 'release.mjs')
const releaseWorkflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8')
const releaseRunbook = readFileSync(join(root, 'docs', 'release-verification.md'), 'utf8')
const reproducibleBuilds = readFileSync(join(root, 'docs', 'reproducible-builds.md'), 'utf8')
const readme = readFileSync(join(root, 'README.md'), 'utf8')
const packageVersion = JSON.parse(
  readFileSync(join(root, 'packages', 'runner', 'package.json'), 'utf8'),
).version as string
let workspace = ''
let firstArtifact = ''
let secondArtifact = ''

function runRelease(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [releaseScript, ...args], {
    cwd: root,
    encoding: 'utf8',
    env,
  })
}

function artifactPath(output: string) {
  return join(output, `modula-runner-${packageVersion}.tgz`)
}

function archivedJson(artifact: string, path: string) {
  const result = spawnSync('tar', ['-xOzf', artifact, path], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  return JSON.parse(result.stdout) as Record<string, unknown>
}

function workflowJob(name: string, workflow = releaseWorkflow) {
  const start = workflow.indexOf(`  ${name}:\n`)
  if (start === -1) throw new Error(`workflow job ${name} is missing`)
  const tail = workflow.slice(start + 1)
  const match = tail.match(/^  [a-z][a-z0-9-]*:\n/m)
  return workflow.slice(start, match ? start + 1 + (match.index ?? 0) : workflow.length)
}

function workflowStepScript(name: string) {
  const stepStart = releaseWorkflow.indexOf(`      - name: ${name}\n`)
  if (stepStart === -1) throw new Error(`workflow step ${name} is missing`)
  const runStart = releaseWorkflow.indexOf('        run: |\n', stepStart)
  if (runStart === -1) throw new Error(`workflow step ${name} has no script`)
  const nextStep = releaseWorkflow.indexOf('\n      - name:', runStart)
  const tail = releaseWorkflow.slice(runStart)
  const nextJobMatch = tail.match(/\n  [a-z][a-z0-9-]*:\n/)
  const nextJob = nextJobMatch ? runStart + (nextJobMatch.index ?? 0) : releaseWorkflow.length
  const end = nextStep === -1 ? nextJob : Math.min(nextStep, nextJob)
  const block = releaseWorkflow.slice(runStart + '        run: |\n'.length, end)
  return block.split('\n').map(line => line.replace(/^ {10}/, '')).join('\n')
}

function assertReleasePrivilegeContract(workflow: string) {
  const build = workflowJob('build', workflow)
  const publisher = workflowJob('publisher', workflow)
  if (/contents: write|id-token: write|attestations: write/.test(build)) {
    throw new Error('build owns release authority')
  }
  if (/actions\/checkout|actions\/setup-node|actions\/cache|npm ci|npm run/.test(publisher)) {
    throw new Error('publisher executes dependency or project code')
  }
  if (!publisher.includes("needs.build.result == 'success'")) {
    throw new Error('publisher accepts a non-successful build')
  }
  if (!publisher.includes('actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c')) {
    throw new Error('publisher does not use the approved raw artifact boundary')
  }
}

describe('release engineering', () => {
  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'modula-runner-release-test-'))
    const firstOutput = join(workspace, 'first')
    const secondOutput = join(workspace, 'second')
    expect(runRelease(['pack', '--output', firstOutput]).status).toBe(0)
    expect(runRelease(['pack', '--output', secondOutput]).status).toBe(0)
    firstArtifact = artifactPath(firstOutput)
    secondArtifact = artifactPath(secondOutput)
  }, 120_000)

  afterAll(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true })
  })

  it('rebuilds the release package byte for byte', async () => {
    expect(await readFile(firstArtifact)).toEqual(await readFile(secondArtifact))
    expect(runRelease(['compare', firstArtifact, secondArtifact]).status).toBe(0)
  })

  it('publishes one of exactly two compared stateful builds', async () => {
    const fixture = join(workspace, 'stateful-reproducibility-fixture')
    const bin = join(fixture, 'bin')
    const output = join(fixture, 'output')
    const count = join(fixture, 'pack-count')
    await Promise.all([
      mkdir(bin, { recursive: true }),
      mkdir(join(fixture, 'scripts'), { recursive: true }),
      mkdir(join(fixture, 'packages', 'protocol'), { recursive: true }),
      mkdir(join(fixture, 'packages', 'runner'), { recursive: true }),
      mkdir(output, { recursive: true }),
    ])
    for (const path of [
      '.nvmrc', 'package.json', 'package-lock.json', 'README.md', 'LICENSE',
      'packages/protocol/package.json', 'packages/protocol/README.md', 'packages/protocol/SCHEMA.md',
      'packages/runner/package.json', 'scripts/cli-process.mjs', 'scripts/release.mjs',
    ]) {
      await copyFile(join(root, path), join(fixture, path))
    }
    await writeFile(join(output, 'keep.txt'), 'caller owned\n')
    await writeFile(join(bin, 'npm'), `#!/bin/sh
if test "$1" = --version; then printf '10.9.8\\n'; exit 0; fi
if test "$1 $2" = 'run build'; then
  mkdir -p packages/protocol/dist packages/runner/dist
  printf 'export {}\\n' > packages/protocol/dist/index.js
  printf 'export {}\\n' > packages/runner/dist/index.js
  exit 0
fi
if test "$1" = pack; then
  destination=
  previous=
  for argument in "$@"; do
    if test "$previous" = --pack-destination; then destination="$argument"; fi
    previous="$argument"
  done
  current=0
  if test -f "$PACK_COUNT"; then current="$(cat "$PACK_COUNT")"; fi
  current=$((current + 1))
  printf '%s\\n' "$current" > "$PACK_COUNT"
  value=A
  if test "$current" -gt 2; then value=B; fi
  printf '%s' "$value" > "$destination/modula-runner-workspace-0.1.0.tgz"
  printf 'modula-runner-workspace-0.1.0.tgz\\n'
  exit 0
fi
exit 64
`)
    await chmod(join(bin, 'npm'), 0o755)

    const result = spawnSync(
      process.execPath,
      [join(fixture, 'scripts', 'release.mjs'), 'reproducible', '--output', output],
      {
        cwd: fixture,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PACK_COUNT: count },
      },
    )
    expect(result.status).toBe(0)
    expect(await readFile(count, 'utf8')).toBe('2\n')
    expect(await readFile(join(output, `modula-runner-${packageVersion}.tgz`), 'utf8')).toBe('A')
    expect(await readFile(join(output, 'keep.txt'), 'utf8')).toBe('caller owned\n')
  })

  it('preserves caller-owned files in the output directory', async () => {
    const output = join(workspace, 'caller-owned-output')
    const sentinels = new Map([
      [join(output, 'keep.txt'), 'keep\n'],
      [join(output, 'modula-runner-workspace-0.1.0.tgz'), 'caller archive\n'],
    ])
    await mkdir(output, { recursive: true })
    await Promise.all([...sentinels].map(([path, value]) => writeFile(path, value)))

    expect(runRelease(['pack', '--output', output]).status).toBe(0)
    for (const [path, value] of sentinels) {
      expect(await readFile(path, 'utf8')).toBe(value)
    }
  })

  it('does not repeat output from a failed release build child', async () => {
    const fixture = join(workspace, 'failed-build-fixture')
    const bin = join(fixture, 'bin')
    const fixtureScripts = join(fixture, 'scripts')
    const canary = 'release-child-secret-canary'
    await Promise.all([
      mkdir(bin, { recursive: true }),
      mkdir(fixtureScripts, { recursive: true }),
      mkdir(join(fixture, 'packages', 'protocol'), { recursive: true }),
      mkdir(join(fixture, 'packages', 'runner'), { recursive: true }),
    ])
    for (const path of [
      '.nvmrc', 'package.json', 'packages/protocol/package.json', 'packages/runner/package.json',
      'scripts/cli-process.mjs', 'scripts/release.mjs',
    ]) {
      await copyFile(join(root, path), join(fixture, path))
    }
    await writeFile(join(bin, 'npm'), `#!/bin/sh
if test "$1" = --version; then printf '10.9.8\\n'; exit 0; fi
printf '\\033[31m%s\\033[0m\\n' '${canary}' >&2
exit 33
`)
    await chmod(join(bin, 'npm'), 0o755)

    const result = spawnSync(
      process.execPath,
      [join(fixtureScripts, 'release.mjs'), 'build', '--output', join(fixture, 'output')],
      { cwd: fixture, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).not.toContain(canary)
    expect(result.stderr).not.toContain('\u001b')
    expect(result.stderr).toContain('npm failed with exit 33')
  })

  it('rejects a real byte injected into a built artifact', async () => {
    const tampered = join(workspace, 'tampered.tgz')
    await copyFile(firstArtifact, tampered)
    await appendFile(tampered, Buffer.from([0]))
    const result = runRelease(['compare', firstArtifact, tampered])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('artifact mismatch')
  })

  it('contains built packages without source, tests, or machine paths', () => {
    const listing = spawnSync('tar', ['-tzf', firstArtifact], { encoding: 'utf8' })
    const contents = spawnSync('tar', ['-xOzf', firstArtifact], { encoding: 'buffer' })
    expect(listing.status).toBe(0)
    expect(contents.status).toBe(0)
    expect(listing.stdout).toContain('package/npm-shrinkwrap.json')
    expect(listing.stdout).toContain('package/packages/protocol/dist/index.js')
    expect(listing.stdout).toContain('package/packages/runner/dist/index.js')
    expect(listing.stdout).toContain('package/packages/runner/dist/previewForwarder.mjs')
    expect(listing.stdout).not.toContain('/src/')
    expect(listing.stdout).not.toContain('/test/')
    expect(contents.stdout.includes(Buffer.from(root))).toBe(false)
    for (const path of [
      'package/package.json',
      'package/packages/protocol/package.json',
      'package/packages/runner/package.json',
    ]) {
      const manifest = archivedJson(firstArtifact, path)
      expect(manifest.scripts).toBeUndefined()
      expect(manifest.devDependencies).toBeUndefined()
    }
  })

  it('rejects a tag that does not match the package version', () => {
    const result = runRelease(
      ['pack', '--output', join(workspace, 'wrong-tag')],
      { ...process.env, GITHUB_REF_NAME: 'v9.9.9' },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`does not match package version v${packageVersion}`)
  })

  it('pins every release action to an immutable commit', () => {
    const uses = [...releaseWorkflow.matchAll(/uses:\s+([^@\s]+)@([^\s#]+)/g)]
    expect(uses.map(match => match[1])).toEqual([
      'actions/checkout',
      'actions/checkout',
      'actions/setup-node',
      'actions/upload-artifact',
      'sigstore/cosign-installer',
      'actions/download-artifact',
      'actions/attest-build-provenance',
      'actions/upload-artifact',
      'sigstore/cosign-installer',
    ])
    expect(uses.every(match => /^[0-9a-f]{40}$/.test(match[2] ?? ''))).toBe(true)
  })

  it('separates dependency execution from release authority', () => {
    const selector = workflowJob('selector')
    const build = workflowJob('build')
    const publisher = workflowJob('publisher')
    const terminal = workflowJob('terminal')
    expect(releaseWorkflow).toContain("- 'v*'")
    expect(releaseWorkflow).toContain('permissions: {}')
    expect(selector).toContain('environment: immutable-release')
    expect(selector).toMatch(/permissions:\n      contents: read/)
    expect(build).toMatch(/permissions:\n      contents: read/)
    expect(build).not.toMatch(/contents: write|id-token: write|attestations: write/)
    expect(publisher).toMatch(
      /permissions:\n      actions: read\n      contents: write\n      id-token: write\n      attestations: write/,
    )
    expect(terminal).toMatch(/permissions:\n      contents: read/)
    expect(terminal).not.toMatch(/contents: write|id-token: write|attestations: write/)
    expect(publisher).not.toMatch(/actions\/checkout|actions\/setup-node|actions\/cache/)
    expect(publisher).not.toMatch(/run:\s+(npm|node scripts\/)|npm ci|npm run/)
    expect(publisher).not.toContain('environment:')
    expect(releaseWorkflow).not.toContain('packages: write')
    expect(releaseWorkflow).toContain('git merge-base --is-ancestor "$GITHUB_SHA" refs/remotes/origin/main')
    expect(build).toContain('package-manager-cache: false')
    expect(build).toContain('node scripts/supply-chain.mjs lock')
    expect(build.indexOf('node scripts/supply-chain.mjs lock')).toBeLessThan(build.indexOf('npm ci'))
    expect(build).toContain('npm run supply-chain:audit')
    expect(build).toContain('npm run supply-chain:seeded-red')
    expect(build).toContain('trap restore_userns_policy EXIT')
    expect(build).toContain('sudo -n sysctl -q -w "$key=0"')
    expect(build).toContain('sudo -n sysctl -q -w "$key=$original"')
    expect(build).toContain("unshare --user --map-root-user --net -- sh -c 'ip link set lo up'")
    expect(build.indexOf('sudo -n sysctl -q -w "$key=0"')).toBeLessThan(build.indexOf('npm run gate'))
    expect(build.indexOf('unshare --user --map-root-user --net')).toBeLessThan(build.indexOf('npm run gate'))
    expect(build).toContain('npm run release:reproducible -- --output dist/release')
    expect(build).not.toContain('npm run release:build')
    expect(publisher).toContain('subject-path: ${{ steps.build-evidence.outputs.artifact }}')
    expect(publisher).toContain('${{ steps.provenance.outputs.bundle-path }}')
  })

  it('binds the unprivileged build checkout to the immutable event commit', () => {
    const build = workflowJob('build')
    const checkout = build.indexOf('ref: ${{ github.sha }}')
    const sourceCheck = build.indexOf('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"')
    expect(checkout).toBeGreaterThan(-1)
    expect(build).not.toContain('ref: ${{ github.ref }}')
    expect(sourceCheck).toBeGreaterThan(checkout)
    expect(sourceCheck).toBeLessThan(build.indexOf('npm ci'))

    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
    const script = workflowStepScript('Verify the immutable build source')
    const verify = (sha: string) => spawnSync('bash', ['-c', script], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_SHA: sha },
    })
    expect(verify(head).status).toBe(0)
    expect(verify('0'.repeat(40)).status).toBe(1)
  })

  it('binds resume publication to a current-attempt audit', () => {
    const build = workflowJob('build')
    const publisher = workflowJob('publisher')
    expect(build).toContain('audit_attempt:')
    expect(publisher).toContain('BUILD_AUDIT_ATTEMPT: ${{ needs.build.outputs.audit_attempt }}')

    const script = workflowStepScript('Validate the privileged publication boundary')
    const runBoundary = (runAttempt: string, auditAttempt: string) => spawnSync(
      'bash', ['-c', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          MODE: 'resume',
          BUILD_RESULT: 'success',
          BUILD_AUDIT_ATTEMPT: auditAttempt,
          GITHUB_EVENT_NAME: 'workflow_dispatch',
          GITHUB_RUN_ATTEMPT: runAttempt,
          GITHUB_OUTPUT: '/dev/null',
        },
      },
    )
    expect(runBoundary('2', '2').status).toBe(0)
    expect(runBoundary('2', '1').status).toBe(1)
  })

  it('checks the required GitHub CLI version in each fresh release job', () => {
    for (const name of ['publisher', 'terminal']) {
      const job = workflowJob(name)
      const versionCheck = job.indexOf('gh_version="$(gh --version | awk \'NR==1 {print $3}\')"')
      const comparison = job.indexOf('dpkg --compare-versions "$gh_version" ge 2.97.0')
      const firstUse = job.search(/\bgh (?:api|release|attestation)\b/)
      expect(versionCheck, name).toBeGreaterThan(-1)
      expect(comparison, name).toBeGreaterThan(versionCheck)
      expect(firstUse, name).toBeGreaterThan(comparison)
    }
  })

  it('mutation-proves the release privilege boundary', () => {
    expect(() => assertReleasePrivilegeContract(releaseWorkflow)).not.toThrow()
    const build = workflowJob('build')
    const privilegedBuild = releaseWorkflow.replace(
      build,
      build.replace('contents: read', 'contents: write'),
    )
    expect(() => assertReleasePrivilegeContract(privilegedBuild)).toThrow('build owns release authority')

    const publisher = workflowJob('publisher')
    const dependencyPublisher = releaseWorkflow.replace(
      publisher,
      publisher.replace('    steps:\n', '    steps:\n      - name: Forbidden dependency execution\n        run: npm ci\n'),
    )
    expect(() => assertReleasePrivilegeContract(dependencyPublisher))
      .toThrow('publisher executes dependency or project code')
    const skippedBuildPublisher = releaseWorkflow.replace(
      "needs.build.result == 'success'",
      "needs.build.result != 'failure'",
    )
    expect(() => assertReleasePrivilegeContract(skippedBuildPublisher))
      .toThrow('publisher accepts a non-successful build')
  })

  it('validates, signs, and negative-tests the production package evidence', () => {
    expect(releaseWorkflow).toContain('npm run supply-chain:gate')
    expect(releaseWorkflow).toContain('npm run supply-chain:seeded-red')
    expect(releaseWorkflow).toContain('cyclonedx-linux-x64')
    expect(releaseWorkflow).toContain('--input-version v1_5')
    expect(releaseWorkflow).toContain('cosign-release: v3.1.3')
    expect(releaseWorkflow).toContain('cosign sign-blob --yes')
    expect(releaseWorkflow).toContain('for subject in "$ARTIFACT" "$SBOM"')
    expect(releaseWorkflow).toContain('--certificate-oidc-issuer "$CERTIFICATE_OIDC_ISSUER"')
    expect(releaseWorkflow).toContain('tampered artifact unexpectedly verified')
    expect(releaseWorkflow).toContain('"${SBOM}.sigstore.json"')
  })

  it('generates tag-specific verification commands for release notes', async () => {
    const output = join(workspace, 'RELEASE_NOTES.md')
    const commit = 'a'.repeat(40)
    const result = runRelease(['notes', '--output', output], {
      ...process.env,
      GITHUB_REF_NAME: `v${packageVersion}`,
      GITHUB_SHA: commit,
      GITHUB_REPOSITORY: 'modulastack/modula-runner',
    })
    expect(result.status).toBe(0)
    const notes = await readFile(output, 'utf8')
    expect(notes).toContain(`@refs/tags/v${packageVersion}`)
    expect(notes).toContain(`commit=${commit}`)
    expect(notes).toContain('cosign verify-blob')
    expect(notes).toContain('gh attestation verify')
    expect(notes).toContain('--deny-self-hosted-runners')
    expect(notes).toContain(`/blob/${commit}/docs/release-verification.md`)
  })

  it('binds publication to a protected remote tag', () => {
    expect(reproducibleBuilds).toContain('active tag ruleset matching `v*`')
    expect(reproducibleBuilds).toContain('restricts updates and deletions')
    expect(reproducibleBuilds).toContain('bypass actor, including GitHub Actions')
    expect(reproducibleBuilds).toContain('only actor with effective release-write authority')
    expect(reproducibleBuilds).toContain('no conditional or atomic compare-and-publish Release API')
    expect(reproducibleBuilds).toMatch(/automation must not delete, replace, or\s+retry publication/)
    expect(releaseWorkflow).toContain('git ls-remote --exit-code')
    expect(releaseWorkflow).not.toContain('git ls-remote --refs')
    expect(releaseWorkflow).toContain('direct="$(awk -v ref="refs/tags/$TAG"')
    expect(releaseWorkflow).toContain('peeled="$(awk -v ref="refs/tags/$TAG^{}"')
    expect(releaseWorkflow).toContain('test "$remote_commit" = "$GITHUB_SHA"')
    expect(releaseWorkflow.indexOf('git ls-remote --exit-code'))
      .toBeLessThan(releaseWorkflow.indexOf('release_json="$(gh api --method POST'))
    expect(releaseWorkflow.match(/git ls-remote --exit-code/g)?.length).toBe(3)
  })

  it('fail-closes every invalid terminal job-result combination', () => {
    const script = workflowStepScript('Validate the complete release job-result matrix')
    const modes = ['publish', 'resume', 'recover', 'unknown']
    const results = ['success', 'failure', 'cancelled', 'skipped']
    for (const mode of modes) {
      for (const selector of results) {
        for (const build of results) {
          for (const publisher of results) {
            const valid = selector === 'success' && (
              ((mode === 'publish' || mode === 'resume') && build === 'success' && publisher === 'success') ||
              (mode === 'recover' && build === 'skipped' && publisher === 'skipped')
            )
            const result = spawnSync('bash', ['-c', script], {
              encoding: 'utf8',
              env: {
                ...process.env,
                MODE: mode,
                SELECTOR_RESULT: selector,
                BUILD_RESULT: build,
                PUBLISHER_RESULT: publisher,
                GITHUB_OUTPUT: '/dev/null',
              },
            })
            expect(result.status, `${mode}/${selector}/${build}/${publisher}`).toBe(valid ? 0 : 1)
          }
        }
      }
    }
  })

  it('routes a draft only through a fresh exact-tag recovery dispatch', async () => {
    const bin = join(workspace, 'release-selector-bin')
    await mkdir(bin)
    await writeFile(join(bin, 'gh'), `#!/bin/sh
if test "$1" = --version; then echo 'gh version 2.97.0'; exit 0; fi
if test "$1" = api; then printf '%s\\n' "$GH_API_RESPONSE"; exit 0; fi
exit 64
`)
    await writeFile(join(bin, 'dpkg'), '#!/bin/sh\nexit 0\n')
    await Promise.all(['gh', 'dpkg'].map(name => chmod(join(bin, name), 0o755)))
    const sha = 'a'.repeat(40)
    const digest = 'b'.repeat(64)
    const marker = `<!-- modula-runner-recovery:v1 run_id=41 attempt=2 sha=${sha} artifact_id=77 artifact_digest=sha256:${digest} -->`
    const draft = JSON.stringify([[{
      id: 13, tag_name: `v${packageVersion}`, draft: true, prerelease: false,
      immutable: false, body: `notes\n${marker}`,
    }]])
    const runSelector = async (event: string, response: string, recoveryTag = '') => {
      const output = join(workspace, `selector-${event}-${recoveryTag || 'none'}-${response.length}`)
      const result = spawnSync('bash', ['-c', workflowStepScript(
        'Select publish, draft-resume, or immutable-recovery mode',
      )], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GH_API_RESPONSE: response,
          GITHUB_REPOSITORY: 'modulastack/modula-runner',
          GITHUB_REF_TYPE: 'tag',
          GITHUB_REF: `refs/tags/v${packageVersion}`,
          GITHUB_REF_NAME: `v${packageVersion}`,
          GITHUB_SHA: sha,
          GITHUB_RUN_ID: '99',
          GITHUB_RUN_ATTEMPT: '1',
          GITHUB_EVENT_NAME: event,
          GITHUB_OUTPUT: output,
          RECOVERY_TAG: recoveryTag,
        },
      })
      return { result, output: result.status === 0 ? await readFile(output, 'utf8') : '' }
    }

    expect((await runSelector('push', '[[]]')).output).toContain('mode=publish')
    expect((await runSelector('push', draft)).result.status).toBe(1)
    const resumed = await runSelector('workflow_dispatch', draft, `v${packageVersion}`)
    expect(resumed.result.status).toBe(0)
    expect(resumed.output).toContain('mode=resume')
    expect(resumed.output).toContain('artifact_id=77')
    expect((await runSelector('workflow_dispatch', '[[]]', `v${packageVersion}`)).result.status).toBe(1)
  })

  it('publishes once and recovers only exact durable evidence', () => {
    expect(releaseWorkflow).toContain('environment: immutable-release')
    expect(releaseWorkflow).not.toContain('/immutable-releases')
    expect(reproducibleBuilds).toContain('Before a `v*` tag is pushed')
    expect(reproducibleBuilds).toContain('`immutable-release` GitHub Actions environment')
    expect(reproducibleBuilds).toContain('do not use **Re-run jobs**')
    expect(reproducibleBuilds).toContain('provide that same tag as `recovery_tag`')
    expect(releaseWorkflow).toContain('workflow_dispatch:')
    expect(releaseWorkflow).toContain('recovery_tag:')
    expect(releaseWorkflow).toContain('mode=publish')
    expect(releaseWorkflow).toContain('mode=resume')
    expect(releaseWorkflow).toContain('mode=recover')
    expect(releaseWorkflow).toContain('draft release requires a fresh workflow_dispatch')
    expect(releaseWorkflow).toContain("if: needs.selector.outputs.mode == 'resume'")
    expect(releaseWorkflow).toContain("if: needs.selector.outputs.mode == 'publish'")
    expect(releaseWorkflow).toContain('needs.build.result == \'success\'')
    expect(releaseWorkflow).toMatch(
      /Sign and verify the preserved package and SBOM\n        if: needs\.selector\.outputs\.mode == 'publish'/,
    )
    expect(releaseWorkflow).toMatch(
      /Attest the preserved release package provenance\n        if: needs\.selector\.outputs\.mode == 'publish'/,
    )
    expect(releaseWorkflow).toMatch(
      /Preserve one of exactly two byte-for-byte package builds\n        if: needs\.selector\.outputs\.mode == 'publish'/,
    )
    expect(releaseWorkflow).toContain('skip-decompress: true')
    expect(releaseWorkflow).toContain('digest-mismatch: error')
    expect(releaseWorkflow).toContain('RECOVERY-MANIFEST.json')
    expect(releaseWorkflow).toContain('artifact_id=${artifact_id} artifact_digest=${artifact_digest}')
    expect(releaseWorkflow).toContain('actions/runs/${ORIGIN_RUN}/attempts/${ORIGIN_ATTEMPT}')
    expect(releaseWorkflow).toContain('actions/artifacts/${ARTIFACT_ID}/zip')
    expect(releaseWorkflow).toContain('retention-days: 14')
    expect(releaseWorkflow).toContain('--hostname uploads.github.com')
    expect(releaseWorkflow).toContain('repos/${GITHUB_REPOSITORY}/releases/${release_id}')
    expect(releaseWorkflow).toContain('gh release verify-asset "$TAG" "$directory/$name"')
    expect(releaseWorkflow).toContain('sha256sum --strict --check SHA256SUMS')
    expect(releaseWorkflow).toContain('--source-digest "$GITHUB_SHA"')
    expect(releaseWorkflow).toContain("printf '{\"draft\":false}\\n'")
    expect(releaseWorkflow).toContain('gh release verify "$TAG"')
    expect(releaseWorkflow).not.toContain('gh release create')
    expect(releaseWorkflow).not.toContain('--clobber')
    expect(releaseWorkflow).not.toContain('release delete')
    expect(releaseWorkflow).not.toContain('--method DELETE')
  })

  it('documents the independent path from release assets to verified', () => {
    expect(readme).toContain('cosign verify-blob')
    expect(readme).toContain('docs/release-verification.md')
    expect(releaseRunbook).toContain('gh release verify-asset')
    expect(releaseRunbook).toContain('[nvm](https://github.com/nvm-sh/nvm)')
    expect(releaseRunbook).toContain('loaded in the verification shell')
    expect(releaseRunbook).toContain('--certificate-identity "$identity"')
    expect(releaseRunbook).toContain('--source-digest "$commit"')
    expect(releaseRunbook).toContain('--deny-self-hosted-runners')
    expect(releaseRunbook).toContain('source=https://github.com/modulastack/modula-runner.git')
    expect(releaseRunbook).toContain('cyclonedx validate')
    expect(releaseRunbook).not.toContain('npm run gate')
    expect(releaseRunbook).toContain('platform-specific acceptance suite is separate')
    expect(releaseRunbook).toContain('unprivileged user and network namespaces plus `tmux`')
    expect(releaseRunbook).toContain('cmp "dist/release/$artifact" "$dir/$artifact"')
    expect(releaseRunbook).toContain('If every command above succeeds')
  })
})

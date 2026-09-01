import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = process.cwd()
const releaseScript = join(root, 'scripts', 'release.mjs')
const releaseWorkflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8')
const releaseRunbook = readFileSync(join(root, 'docs', 'release-verification.md'), 'utf8')
const reproducibleBuilds = readFileSync(join(root, 'docs', 'reproducible-builds.md'), 'utf8')
const readme = readFileSync(join(root, 'README.md'), 'utf8')
const pinnedNode = readFileSync(join(root, '.nvmrc'), 'utf8').trim()
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

const isolatedReleaseFixturePaths = [
  '.nvmrc', 'package.json', 'package-lock.json', 'README.md', 'LICENSE',
  'packages/darwin-file-lock/package.json', 'packages/darwin-file-lock/index.js', 'packages/darwin-file-lock/index.d.ts',
  'packages/darwin-file-lock/VENDORING.md',
  'packages/darwin-file-lock/binaries/fs-ext-darwin-arm64-node-22.0.0.node',
  'packages/linux-file-lock/package.json', 'packages/linux-file-lock/index.js', 'packages/linux-file-lock/index.d.ts',
  'packages/linux-file-lock/UPSTREAM-LICENSE.txt', 'packages/linux-file-lock/VENDORING.md',
  'packages/linux-file-lock/binaries/fs-ext-linux-arm64-node-22.0.0.node',
  'packages/linux-file-lock/binaries/fs-ext-linux-x64-node-22.0.0.node',
  'packages/protocol/package.json', 'packages/protocol/README.md', 'packages/protocol/SCHEMA.md',
  'packages/runner/package.json',
  'packages/runner/native/darwin_runner_home.c',
  'packages/runner/native/darwin-runner-home-arm64-node-22.0.0.node',
  'scripts/cli-process.mjs', 'scripts/release.mjs', 'scripts/verify-darwin-runner-home-native.mjs',
]

async function copyReleaseFixtureFile(source: string, path: string) {
  const target = join(source, path)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(join(root, path), target)
}

async function isolatedReleaseFixture(name: string) {
  const fixture = join(workspace, name)
  const source = join(fixture, 'source')
  const bin = join(fixture, 'bin')
  const output = join(fixture, 'output')
  await Promise.all([
    mkdir(source, { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(output, { recursive: true }),
    ...isolatedReleaseFixturePaths.map(path => copyReleaseFixtureFile(source, path)),
  ])
  for (const args of [['init', '--quiet'], ['add', '.']]) {
    const result = spawnSync('git', args, { cwd: source, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`fixture git ${args[0]} failed`)
  }
  return { fixture, source, bin, output }
}

function runFixtureRelease(
  fixture: Awaited<ReturnType<typeof isolatedReleaseFixture>>,
  environment: NodeJS.ProcessEnv,
) {
  return spawnSync(
    process.execPath,
    [join(fixture.source, 'scripts', 'release.mjs'), 'reproducible', '--output', fixture.output],
    {
      cwd: fixture.source,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fixture.bin}:${process.env.PATH}`, ...environment },
    },
  )
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

  it('publishes one of exactly two independently isolated builds', async () => {
    const fixture = await isolatedReleaseFixture('isolated-reproducibility-fixture')
    const count = join(fixture.fixture, 'pack-count')
    const isolationLog = join(fixture.fixture, 'isolation-log')
    const toolchainLog = join(fixture.fixture, 'toolchain-log')
    await writeFile(join(fixture.output, 'keep.txt'), 'caller owned\n')
    await writeFile(join(fixture.bin, 'npm'), `#!/bin/sh
if test "$1" = --version; then
  printf 'checked\\n' >> "$TOOLCHAIN_LOG"
  printf '10.9.8\\n'; exit 0
fi
if test "$1" = ci; then
  printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\\n' \
    "$PWD" "$npm_config_cache" "$NPM_CONFIG_CACHE" "$TMPDIR" "$HOME" \
    "$GITHUB_WORKSPACE" "$RUNNER_WORKSPACE" "$RUNNER_TEMP" "$RUNNER_TOOL_CACHE" \
    "$AGENT_TOOLSDIRECTORY" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" \
    "$XDG_STATE_HOME" "$XDG_RUNTIME_DIR" "$GITHUB_ENV" "$GITHUB_OUTPUT" \
    "$GITHUB_PATH" "$GITHUB_STEP_SUMMARY" "$GITHUB_STATE" "$GITHUB_EVENT_PATH" \
    "$GITHUB_ARTIFACTS" "$GITHUB_ARTIFACTS_LIST" "$GITHUB_ACTION_PATH" \
    "$GITHUB_REF_NAME" >> "$ISOLATION_LOG"
  exit 0
fi
if test "$1 $2" = 'run build'; then
  mkdir -p packages/protocol/dist packages/runner/dist/bin
  printf 'A' > packages/protocol/dist/index.js
  printf 'A' > packages/runner/dist/index.js
  printf '#!/usr/bin/env node\n' > packages/runner/dist/bin/modula-runner.js
  exit 0
fi
if test "$1" = pack; then
  destination=; staging=; previous=
  for argument in "$@"; do
    if test "$previous" = --pack-destination; then destination="$argument"; fi
    previous="$argument"; staging="$argument"
  done
  current=0; if test -f "$PACK_COUNT"; then current="$(cat "$PACK_COUNT")"; fi
  printf '%s\\n' "$((current + 1))" > "$PACK_COUNT"
  cat "$staging/packages/runner/dist/index.js" > "$destination/modula-runner-workspace-0.1.0.tgz"
  printf 'modula-runner-workspace-0.1.0.tgz\\n'; exit 0
fi
exit 64
`)
    await chmod(join(fixture.bin, 'npm'), 0o755)

    const result = runFixtureRelease(fixture, {
      PACK_COUNT: count,
      ISOLATION_LOG: isolationLog,
      TOOLCHAIN_LOG: toolchainLog,
      NPM_CONFIG_CACHE: join(fixture.fixture, 'inherited-shared-cache'),
      GITHUB_WORKSPACE: join(fixture.fixture, 'shared-workspace'),
      RUNNER_WORKSPACE: join(fixture.fixture, 'shared-runner-workspace'),
      RUNNER_TEMP: join(fixture.fixture, 'shared-runner-temp'),
      RUNNER_TOOL_CACHE: join(fixture.fixture, 'shared-tool-cache'),
      AGENT_TOOLSDIRECTORY: join(fixture.fixture, 'shared-agent-tools'),
      GITHUB_ENV: join(fixture.fixture, 'github-env'),
      GITHUB_OUTPUT: join(fixture.fixture, 'github-output'),
      GITHUB_PATH: join(fixture.fixture, 'github-path'),
      GITHUB_STEP_SUMMARY: join(fixture.fixture, 'github-summary'),
      GITHUB_STATE: join(fixture.fixture, 'github-state'),
      GITHUB_EVENT_PATH: join(fixture.fixture, 'event.json'),
      GITHUB_ARTIFACTS: join(fixture.fixture, 'github-artifacts'),
      GITHUB_ARTIFACTS_LIST: join(fixture.fixture, 'github-artifacts-list'),
      GITHUB_ACTION_PATH: join(fixture.fixture, 'github-action'),
      GITHUB_REF_NAME: `v${packageVersion}`,
    })
    expect(result.status).toBe(0)
    expect(await readFile(count, 'utf8')).toBe('2\n')
    expect((await readFile(toolchainLog, 'utf8')).trim().split('\n')).toHaveLength(4)
    const boundaries = (await readFile(isolationLog, 'utf8')).trim().split('\n')
      .map(line => line.split('|'))
    expect(boundaries).toHaveLength(2)
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
      expect(new Set(boundaries.map(parts => parts[index])).size).toBe(2)
    }
    for (const index of [15, 16, 17, 18, 19, 20, 21, 22, 23]) {
      expect(boundaries.every(parts => parts[index] === '')).toBe(true)
    }
    expect(boundaries.every(parts => parts[24] === `v${packageVersion}`)).toBe(true)
    expect(await readFile(artifactPath(fixture.output), 'utf8')).toBe('A')
    expect(await readFile(join(fixture.output, 'keep.txt'), 'utf8')).toBe('caller owned\n')
  })

  it('does not execute caller checkout bins inside isolated builds', async () => {
    const fixture = await isolatedReleaseFixture('caller-bin-isolation-fixture')
    const callerBin = join(fixture.fixture, 'caller', 'node_modules', '.bin')
    const callerAlias = join(fixture.fixture, 'build-tools')
    const callerLog = join(fixture.fixture, 'caller-bin-log')
    const pathLog = join(fixture.fixture, 'path-log')
    await mkdir(callerBin, { recursive: true })
    await symlink(callerBin, callerAlias, 'dir')
    await writeFile(join(callerBin, 'fixture-build'), `#!/bin/sh
printf 'called\\n' >> "$CALLER_BIN_LOG"
mkdir -p packages/protocol/dist packages/runner/dist
printf 'caller owned' > packages/protocol/dist/index.js
printf 'caller owned' > packages/runner/dist/index.js
`)
    await writeFile(join(fixture.bin, 'npm'), `#!/bin/sh
if test "$1" = --version; then printf '10.9.8\\n'; exit 0; fi
if test "$1" = ci; then
  printf '%s|%s|%s\\n' "$PATH" "$Path" "$pAtH" >> "$PATH_LOG"
  exit 0
fi
if test "$1 $2" = 'run build'; then
  PATH="$PWD/node_modules/.bin:$PATH" fixture-build
  exit $?
fi
if test "$1" = pack; then
  destination=; staging=; previous=
  for argument in "$@"; do
    if test "$previous" = --pack-destination; then destination="$argument"; fi
    previous="$argument"; staging="$argument"
  done
  cat "$staging/packages/runner/dist/index.js" > "$destination/modula-runner-workspace-0.1.0.tgz"
  printf 'modula-runner-workspace-0.1.0.tgz\\n'; exit 0
fi
exit 64
`)
    await Promise.all([
      chmod(join(callerBin, 'fixture-build'), 0o755),
      chmod(join(fixture.bin, 'npm'), 0o755),
    ])

    const result = runFixtureRelease(fixture, {
      CALLER_BIN_LOG: callerLog,
      PATH_LOG: pathLog,
      PATH: ['', fixture.bin, callerAlias, `${callerAlias}/`, 'relative/bin', fixture.bin, process.env.PATH ?? '']
        .join(delimiter),
      Path: callerAlias,
      pAtH: [callerAlias, 'relative/bin'].join(delimiter),
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('npm failed with exit 127')
    const pathFields = (await readFile(pathLog, 'utf8')).trim().split('|')
    expect(pathFields).toHaveLength(3)
    const [upperPath = '', mixedPath = '', alternatePath = ''] = pathFields
    const inheritedPaths = upperPath.split(delimiter)
    expect(inheritedPaths.every(path => isAbsolute(path))).toBe(true)
    expect(new Set(inheritedPaths).size).toBe(inheritedPaths.length)
    expect(inheritedPaths.some(path => {
      return basename(path).toLowerCase() === '.bin' &&
        basename(dirname(path)).toLowerCase() === 'node_modules'
    })).toBe(false)
    expect(mixedPath).toBe('')
    expect(alternatePath).toBe('')
    await expect(readFile(callerLog)).rejects.toThrow()
    await expect(readFile(artifactPath(fixture.output))).rejects.toThrow()
  })

  it('rejects state shared through tracked symlink rewrites', async () => {
    const fixture = await isolatedReleaseFixture('tracked-symlink-fixture')
    const stateDirectory = join(fixture.source, 'fixture-state')
    const nonceCount = join(fixture.fixture, 'nonce-count')
    await mkdir(stateDirectory)
    await writeFile(join(stateDirectory, 'value'), '')
    await symlink('value', join(stateDirectory, 'link'))
    const tracked = spawnSync('git', ['add', 'fixture-state'], { cwd: fixture.source, encoding: 'utf8' })
    expect(tracked.status, tracked.stderr).toBe(0)
    await writeFile(join(fixture.bin, 'npm'), `#!/bin/sh
if test "$1" = --version || test "$1" = ci; then
  if test "$1" = --version; then printf '10.9.8\\n'; fi
  exit 0
fi
if test "$1 $2" = 'run build'; then
  state=fixture-state/link
  if ! test -s "$state"; then
    current=0; if test -f "$NONCE_COUNT"; then current="$(cat "$NONCE_COUNT")"; fi
    current=$((current + 1)); printf '%s\\n' "$current" > "$NONCE_COUNT"
    printf '%s' "$current" > "$state"
  fi
  mkdir -p packages/protocol/dist packages/runner/dist/bin
  cp "$state" packages/protocol/dist/index.js
  cp "$state" packages/runner/dist/index.js
  printf '#!/usr/bin/env node\n' > packages/runner/dist/bin/modula-runner.js
  exit 0
fi
if test "$1" = pack; then
  destination=; staging=; previous=
  for argument in "$@"; do
    if test "$previous" = --pack-destination; then destination="$argument"; fi
    previous="$argument"; staging="$argument"
  done
  cat "$staging/packages/runner/dist/index.js" > "$destination/modula-runner-workspace-0.1.0.tgz"
  printf 'modula-runner-workspace-0.1.0.tgz\\n'; exit 0
fi
exit 64
`)
    await chmod(join(fixture.bin, 'npm'), 0o755)

    const result = runFixtureRelease(fixture, { NONCE_COUNT: nonceCount })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('artifact mismatch')
    expect(await readFile(nonceCount, 'utf8')).toBe('2\n')
    await expect(readFile(artifactPath(fixture.output))).rejects.toThrow()
  })

  it('rejects tracked symlinks that escape the source boundary', async () => {
    const fixture = await isolatedReleaseFixture('escaping-symlink-fixture')
    await writeFile(join(fixture.fixture, 'outside'), 'caller owned\n')
    await symlink('../outside', join(fixture.source, 'escape-link'))
    const tracked = spawnSync('git', ['add', 'escape-link'], { cwd: fixture.source, encoding: 'utf8' })
    expect(tracked.status, tracked.stderr).toBe(0)

    const result = runFixtureRelease(fixture, {})
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('tracked symlink escape-link escapes source boundary')
    await expect(readFile(artifactPath(fixture.output))).rejects.toThrow()
  })

  it('rejects tracked leaves beneath escaping ancestor symlinks', async () => {
    const fixture = await isolatedReleaseFixture('ancestor-symlink-fixture')
    const trackedDirectory = join(fixture.source, 'tracked-parent')
    const externalDirectory = join(fixture.fixture, 'external-parent')
    const installMarker = join(fixture.fixture, 'install-marker')
    await mkdir(trackedDirectory)
    await writeFile(join(trackedDirectory, 'value'), 'tracked\n')
    const tracked = spawnSync('git', ['add', 'tracked-parent/value'], {
      cwd: fixture.source,
      encoding: 'utf8',
    })
    expect(tracked.status, tracked.stderr).toBe(0)
    await mkdir(externalDirectory)
    await writeFile(join(externalDirectory, 'value'), 'external\n')
    await rm(trackedDirectory, { recursive: true })
    await symlink(externalDirectory, trackedDirectory, 'dir')
    await writeFile(join(fixture.bin, 'npm'), `#!/bin/sh
if test "$1" = --version; then printf '10.9.8\\n'; exit 0; fi
if test "$1" = ci; then printf 'installed\\n' > "$INSTALL_MARKER"; exit 0; fi
exit 64
`)
    await chmod(join(fixture.bin, 'npm'), 0o755)

    const result = runFixtureRelease(fixture, { INSTALL_MARKER: installMarker })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('tracked path tracked-parent/value escapes source boundary')
    await expect(readFile(installMarker)).rejects.toThrow()
  })

  it('rejects absolute tracked symlink text inside the source tree', async () => {
    const fixture = await isolatedReleaseFixture('absolute-symlink-fixture')
    const state = join(fixture.source, 'absolute-state')
    await writeFile(state, 'shared\n')
    await symlink(state, join(fixture.source, 'absolute-link'))
    const tracked = spawnSync('git', ['add', 'absolute-link', 'absolute-state'], {
      cwd: fixture.source,
      encoding: 'utf8',
    })
    expect(tracked.status, tracked.stderr).toBe(0)

    const result = runFixtureRelease(fixture, {})
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('tracked symlink absolute-link must be relative')
    await expect(readFile(artifactPath(fixture.output))).rejects.toThrow()
  })

  it('rejects an invalid release before dependency installation', async () => {
    const fixture = await isolatedReleaseFixture('preinstall-release-preflight-fixture')
    const installMarker = join(fixture.fixture, 'install-marker')
    await writeFile(join(fixture.bin, 'npm'), `#!/bin/sh
if test "$1" = --version; then printf '10.9.8\\n'; exit 0; fi
if test "$1" = ci; then printf 'installed\\n' > "$INSTALL_MARKER"; exit 0; fi
exit 64
`)
    await chmod(join(fixture.bin, 'npm'), 0o755)

    const result = runFixtureRelease(fixture, {
      GITHUB_REF_NAME: 'v9.9.9',
      INSTALL_MARKER: installMarker,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('does not match package version')
    await expect(readFile(installMarker)).rejects.toThrow()
  })

  it('revalidates release inputs after dependency installation', async () => {
    const fixture = await isolatedReleaseFixture('postinstall-release-preflight-fixture')
    const packCount = join(fixture.fixture, 'pack-count')
    await writeFile(join(fixture.bin, 'npm'), `#!/bin/sh
if test "$1" = --version; then printf '10.9.8\\n'; exit 0; fi
if test "$1" = ci; then
  node -e "const fs=require('node:fs'); const p='packages/runner/package.json'; const m=JSON.parse(fs.readFileSync(p)); m.version='9.9.9'; m.dependencies['@modulastack/darwin-file-lock']='9.9.9'; m.optionalDependencies['@modulastack/linux-file-lock']='9.9.9'; fs.writeFileSync(p, JSON.stringify(m))"
  exit 0
fi
if test "$1 $2" = 'run build'; then
  mkdir -p packages/protocol/dist packages/runner/dist
  printf 'A' > packages/protocol/dist/index.js
  printf 'A' > packages/runner/dist/index.js
  exit 0
fi
if test "$1" = pack; then
  printf 'packed\\n' >> "$PACK_COUNT"
  destination=; staging=; previous=
  for argument in "$@"; do
    if test "$previous" = --pack-destination; then destination="$argument"; fi
    previous="$argument"; staging="$argument"
  done
  cat "$staging/packages/runner/dist/index.js" > "$destination/modula-runner-workspace-0.1.0.tgz"
  printf 'modula-runner-workspace-0.1.0.tgz\\n'; exit 0
fi
exit 64
`)
    await chmod(join(fixture.bin, 'npm'), 0o755)

    const result = runFixtureRelease(fixture, { PACK_COUNT: packCount })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('workspace versions differ')
    await expect(readFile(packCount)).rejects.toThrow()
    await expect(readFile(artifactPath(fixture.output))).rejects.toThrow()
  })

  it('rejects nondeterminism memoized outside dist', async () => {
    const fixture = await isolatedReleaseFixture('memoized-nondeterminism-fixture')
    const nonceCount = join(fixture.fixture, 'nonce-count')
    const cacheLog = join(fixture.fixture, 'cache-log')
    const inheritedCache = join(fixture.fixture, 'inherited-shared-cache')
    await mkdir(inheritedCache)
    await writeFile(join(inheritedCache, 'sentinel'), 'parent owned\n')
    await writeFile(join(fixture.bin, 'npm'), `#!/bin/sh
if test "$1" = --version || test "$1" = ci; then
  if test "$1" = --version; then printf '10.9.8\\n'; fi
  exit 0
fi
if test "$1 $2" = 'run build'; then
  effective_cache="$(env | awk -F= 'tolower($1) == "npm_config_cache" { sub(/^[^=]*=/, ""); value=$0 } END { print value }')"
  printf '%s\\n' "$effective_cache" >> "$CACHE_LOG"
  mkdir -p "$effective_cache" packages/protocol/dist packages/runner/dist/bin
  printf '#!/usr/bin/env node\n' > packages/runner/dist/bin/modula-runner.js
  if ! test -f "$effective_cache/value"; then
    current=0; if test -f "$NONCE_COUNT"; then current="$(cat "$NONCE_COUNT")"; fi
    current=$((current + 1)); printf '%s\\n' "$current" > "$NONCE_COUNT"
    printf '%s' "$current" > "$effective_cache/value"
  fi
  cp "$effective_cache/value" packages/protocol/dist/index.js
  cp "$effective_cache/value" packages/runner/dist/index.js
  exit 0
fi
if test "$1" = pack; then
  destination=; staging=; previous=
  for argument in "$@"; do
    if test "$previous" = --pack-destination; then destination="$argument"; fi
    previous="$argument"; staging="$argument"
  done
  cat "$staging/packages/runner/dist/index.js" > "$destination/modula-runner-workspace-0.1.0.tgz"
  printf 'modula-runner-workspace-0.1.0.tgz\\n'; exit 0
fi
exit 64
`)
    await chmod(join(fixture.bin, 'npm'), 0o755)

    const result = runFixtureRelease(fixture, {
      CACHE_LOG: cacheLog,
      NONCE_COUNT: nonceCount,
      npm_config_cache: join(fixture.fixture, 'inherited-lowercase-cache'),
      NPM_CONFIG_CACHE: join(fixture.fixture, 'inherited-uppercase-cache'),
      Npm_Config_Cache: inheritedCache,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('artifact mismatch')
    expect(await readFile(nonceCount, 'utf8')).toBe('2\n')
    const effectiveCaches = (await readFile(cacheLog, 'utf8')).trim().split('\n')
    expect(effectiveCaches).toHaveLength(2)
    expect(new Set(effectiveCaches).size).toBe(2)
    expect(effectiveCaches).not.toContain(inheritedCache)
    expect(await readFile(join(inheritedCache, 'sentinel'), 'utf8')).toBe('parent owned\n')
    await expect(readFile(join(inheritedCache, 'value'))).rejects.toThrow()
    await expect(readFile(artifactPath(fixture.output))).rejects.toThrow()
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
      mkdir(join(fixture, 'packages', 'darwin-file-lock'), { recursive: true }),
      mkdir(join(fixture, 'packages', 'linux-file-lock'), { recursive: true }),
      mkdir(join(fixture, 'packages', 'protocol'), { recursive: true }),
      mkdir(join(fixture, 'packages', 'runner'), { recursive: true }),
    ])
    for (const path of [
      '.nvmrc', 'package.json', 'packages/darwin-file-lock/package.json', 'packages/linux-file-lock/package.json', 'packages/protocol/package.json', 'packages/runner/package.json',
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
    const contents = spawnSync('tar', ['-xOzf', firstArtifact], { encoding: 'buffer', maxBuffer: 160 * 1024 * 1024 })
    expect(listing.status).toBe(0)
    expect(contents.status).toBe(0)
    expect(listing.stdout).toContain('package/npm-shrinkwrap.json')
    expect(listing.stdout).toContain('package/packages/darwin-file-lock/index.js')
    expect(listing.stdout).toContain('package/packages/darwin-file-lock/VENDORING.md')
    expect(listing.stdout).toContain('package/packages/darwin-file-lock/binaries/fs-ext-darwin-arm64-node-22.0.0.node')
    expect(listing.stdout).toContain('package/packages/linux-file-lock/index.js')
    expect(listing.stdout).toContain('package/packages/linux-file-lock/VENDORING.md')
    expect(listing.stdout).toContain('package/packages/linux-file-lock/binaries/fs-ext-linux-x64-node-22.0.0.node')
    expect(listing.stdout).toContain('package/packages/protocol/dist/index.js')
    expect(listing.stdout).toContain('package/packages/runner/dist/index.js')
    expect(listing.stdout).toContain('package/packages/runner/dist/bin/modula-runner.js')
    expect(listing.stdout).toContain('package/packages/runner/dist/previewForwarder.mjs')
    expect(listing.stdout).not.toContain('/src/')
    expect(listing.stdout).not.toContain('/test/')
    expect(contents.stdout.includes(Buffer.from(root))).toBe(false)
    for (const path of [
      'package/package.json',
      'package/packages/darwin-file-lock/package.json',
      'package/packages/linux-file-lock/package.json',
      'package/packages/protocol/package.json',
      'package/packages/runner/package.json',
    ]) {
      const manifest = archivedJson(firstArtifact, path)
      expect(manifest.scripts).toBeUndefined()
      expect(manifest.devDependencies).toBeUndefined()
    }
    const installManifest = archivedJson(firstArtifact, 'package/package.json')
    expect(installManifest.engines).toEqual({ node: pinnedNode })
    expect(installManifest.os).toEqual(['darwin', 'linux'])
    expect(installManifest.cpu).toEqual(['x64', 'arm64'])
    expect(installManifest.name).toBe('modula-runner')
    expect(installManifest.private).toBeUndefined()
    expect(installManifest.bin).toEqual({ 'modula-runner': 'packages/runner/dist/bin/modula-runner.js' })
    const binEntry = 'package/packages/runner/dist/bin/modula-runner.js'
    const verbose = spawnSync('tar', ['-tvzf', firstArtifact, binEntry], { encoding: 'utf8' })
    expect(verbose.status).toBe(0)
    expect(verbose.stdout).toMatch(new RegExp(`^-rwxr-xr-x .* ${binEntry}$`, 'm'))
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
    expect(releaseRunbook).toContain('macOS arm64 verifies the detect-and-stop preview posture')
    expect(releaseRunbook).toContain('cmp "dist/release/$artifact" "$dir/$artifact"')
    expect(releaseRunbook).toContain('If every command above succeeds')
  })
})

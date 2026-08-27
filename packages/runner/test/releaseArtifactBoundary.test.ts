import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = process.cwd()
const releaseScript = join(root, 'scripts', 'release.mjs')
const releaseWorkflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8')
const packageVersion = JSON.parse(
  readFileSync(join(root, 'packages', 'runner', 'package.json'), 'utf8'),
).version as string
let workspace = ''
let releaseArtifact = ''

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

async function sha256File(path: string) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'modula-runner-artifact-boundary-'))
  const output = join(workspace, 'release')
  const result = spawnSync(process.execPath, [releaseScript, 'pack', '--output', output], {
    cwd: root,
    encoding: 'utf8',
  })
  expect(result.status).toBe(0)
  releaseArtifact = join(output, `modula-runner-${packageVersion}.tgz`)
}, 120_000)

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true })
})

describe('privileged release artifact boundary', () => {
  it('runs from an installed package layout with internal protocol imports and declared runtime dependencies', async () => {
    const install = join(workspace, 'installed-layout')
    const nodeModules = join(install, 'node_modules')
    const packageRoot = join(nodeModules, 'modula-runner')
    await mkdir(packageRoot, { recursive: true })
    const extracted = spawnSync('tar', ['-xzf', releaseArtifact, '-C', packageRoot, '--strip-components=1'], { encoding: 'utf8' })
    expect(extracted.status).toBe(0)
    await Promise.all([
      symlink(join(root, 'node_modules', 'node-pty'), join(nodeModules, 'node-pty'), 'dir'),
      symlink(join(root, 'node_modules', 'ws'), join(nodeModules, 'ws'), 'dir'),
    ])
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(manifest).toMatchObject({
      name: 'modula-runner',
      version: packageVersion,
      dependencies: { 'node-pty': '^1.0.0', ws: '^8.18.0' },
      main: './packages/runner/dist/index.js',
    })
    expect(manifest).not.toHaveProperty('workspaces')
    const client = await readFile(join(packageRoot, 'packages', 'runner', 'dist', 'client.js'), 'utf8')
    expect(client).not.toContain('@modulastack/runner-protocol')
    expect(client).toContain('../../protocol/dist/index.js')

    const bin = join(packageRoot, 'packages', 'runner', 'dist', 'bin', 'modula-runner.js')
    const version = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' })
    expect(version).toMatchObject({ status: 0, stdout: `${packageVersion}\n`, stderr: '' })
    const help = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' })
    expect(help.status).toBe(0)
    expect(help.stdout).toContain('local pairing, state, and foreground runner commands')
    const status = spawnSync(process.execPath, [bin, 'status', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, MODULA_RUNNER_HOME: join(install, 'home') },
    })
    expect(status).toMatchObject({ status: 1, stdout: '{"error":{"code":"policy-missing"}}\n', stderr: '' })
  })

  it('rejects malformed raw build artifacts before signing', async () => {
    const fixture = join(workspace, 'raw-build-artifact')
    const baseEvidence = join(fixture, 'evidence')
    const bin = join(fixture, 'bin')
    const sha = 'a'.repeat(40)
    const run = '91'
    const attempt = '2'
    const repositoryId = 42
    const tag = `v${packageVersion}`
    const packageName = `modula-runner-${packageVersion}.tgz`
    await Promise.all([mkdir(baseEvidence, { recursive: true }), mkdir(bin, { recursive: true })])
    await copyFile(releaseArtifact, join(baseEvidence, packageName))
    await Promise.all([
      writeFile(join(baseEvidence, 'modula-runner.cdx.json'), '{"bomFormat":"CycloneDX"}\n'),
      writeFile(join(baseEvidence, 'audit-summary.json'), JSON.stringify({
        production: { findings: [], blocked: [] },
        developmentOnly: { findings: [], blocking: false },
        waiversApplied: [],
      })),
      writeFile(join(baseEvidence, 'RELEASE_NOTES.md'), `identity @refs/tags/${tag}\ncommit=${sha}\n`),
    ])
    const packageDigest = await sha256File(join(baseEvidence, packageName))
    const sbomDigest = await sha256File(join(baseEvidence, 'modula-runner.cdx.json'))
    await writeFile(
      join(baseEvidence, 'SHA256SUMS'),
      `${packageDigest}  ${packageName}\n${sbomDigest}  modula-runner.cdx.json\n`,
    )
    const evidenceNames = [
      packageName, 'modula-runner.cdx.json', 'SHA256SUMS',
      'audit-summary.json', 'RELEASE_NOTES.md',
    ]
    const assets = await Promise.all(evidenceNames.map(async name => {
      const content = await readFile(join(baseEvidence, name))
      return { name, size: content.length, sha256: createHash('sha256').update(content).digest('hex') }
    }))
    await writeFile(join(baseEvidence, 'BUILD-EVIDENCE-MANIFEST.json'), JSON.stringify({
      version: 1,
      kind: 'unsigned-build-evidence',
      repository: 'modulastack/modula-runner',
      workflow: '.github/workflows/release.yml',
      tag,
      sha,
      runId: run,
      runAttempt: attempt,
      packageDigest,
      assets,
    }))
    await writeFile(join(bin, 'gh'), `#!/bin/sh
case "$*" in
  *'/attempts/'*) cat "$ATTEMPT_JSON" ;;
  *) cat "$ARTIFACT_JSON" ;;
esac
`)
    await chmod(join(bin, 'gh'), 0o755)
    const script = workflowStepScript('Validate and extract the unprivileged build evidence')
    expect(script).not.toContain('getmembers()')
    let caseNumber = 0
    type CaseOptions = {
      archiveMutation?: string
      digestOverride?: string
      packageDigestOverride?: string
      packageMutation?:
        | 'members-512'
        | 'members-513'
        | 'duplicate-normalized-name'
        | 'unsafe-path'
        | 'nonregular-type'
        | 'oversized-member'
        | 'cumulative-size'
        | 'decompression-overflow'
      mutateMetadata?: (artifact: Record<string, unknown>, attemptJson: Record<string, unknown>) => void
    }
    const runCase = async (options: CaseOptions = {}) => {
      const directory = join(fixture, `case-${caseNumber++}`)
      const evidence = join(directory, 'evidence')
      const download = join(directory, 'download')
      const runnerTemp = join(directory, 'runner-temp')
      await Promise.all([
        cp(baseEvidence, evidence, { recursive: true }),
        mkdir(download, { recursive: true }),
        mkdir(runnerTemp, { recursive: true }),
      ])
      let effectivePackageDigest = packageDigest
      if (options.packageMutation) {
        const packagePath = join(evidence, packageName)
        const mutation = spawnSync('python3', ['-c', `
import os, sys, tarfile
source, mutation = sys.argv[1:]
target = source + '.mutated'

class Zeros:
    def __init__(self, size): self.remaining = size
    def read(self, size=-1):
        if self.remaining == 0: return b''
        count = self.remaining if size < 0 else min(size, self.remaining)
        self.remaining -= count
        return b'\\0' * count

def add_file(archive, name, size=0):
    member = tarfile.TarInfo(name)
    member.mode = 0o644
    member.mtime = 0
    member.size = size
    archive.addfile(member, Zeros(size))

with tarfile.open(source, 'r:gz') as incoming, tarfile.open(target, 'w:gz') as outgoing:
    count = 0
    for member in incoming:
        reader = incoming.extractfile(member) if member.isfile() else None
        outgoing.addfile(member, reader)
        count += 1
    if mutation.startswith('members-'):
        target_count = int(mutation.split('-')[1])
        if count > target_count: raise SystemExit('base package exceeds target member count')
        for index in range(target_count - count):
            add_file(outgoing, f'package/padding/{index:04d}')
    elif mutation == 'duplicate-normalized-name':
        member = tarfile.TarInfo('package/LICENSE/')
        member.type = tarfile.DIRTYPE
        member.mode = 0o755
        member.mtime = 0
        outgoing.addfile(member)
    elif mutation == 'unsafe-path':
        add_file(outgoing, '../escape')
    elif mutation == 'nonregular-type':
        member = tarfile.TarInfo('package/link')
        member.type = tarfile.SYMTYPE
        member.linkname = 'target'
        member.mtime = 0
        outgoing.addfile(member)
    elif mutation == 'oversized-member':
        add_file(outgoing, 'package/oversized', 50 * 1024 * 1024 + 1)
    elif mutation == 'cumulative-size':
        for index in range(3):
            add_file(outgoing, f'package/cumulative-{index}', 50 * 1024 * 1024)
    elif mutation == 'decompression-overflow':
        add_file(outgoing, 'package/decompression-overflow', 161 * 1024 * 1024)
    else:
        raise SystemExit('unknown package mutation')
os.replace(target, source)
`, packagePath, options.packageMutation], { encoding: 'utf8' })
        expect(mutation.status).toBe(0)
        effectivePackageDigest = await sha256File(packagePath)
        const sumsPath = join(evidence, 'SHA256SUMS')
        await writeFile(
          sumsPath,
          `${effectivePackageDigest}  ${packageName}\n${sbomDigest}  modula-runner.cdx.json\n`,
        )
        const manifestPath = join(evidence, 'BUILD-EVIDENCE-MANIFEST.json')
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
          packageDigest: string
          assets: Array<{ name: string; size: number; sha256: string }>
        }
        manifest.packageDigest = effectivePackageDigest
        for (const asset of manifest.assets) {
          if (asset.name !== packageName && asset.name !== 'SHA256SUMS') continue
          const path = join(evidence, asset.name)
          const content = await readFile(path)
          asset.size = content.length
          asset.sha256 = createHash('sha256').update(content).digest('hex')
        }
        await writeFile(manifestPath, JSON.stringify(manifest))
      }
      const archive = join(download, 'artifact.zip')
      const zip = spawnSync('python3', ['-c', `
import json, os, stat, sys, zipfile
source, target, mutation, package = sys.argv[1:]
manifest_path = os.path.join(source, 'BUILD-EVIDENCE-MANIFEST.json')
if mutation.startswith('manifest-'):
    manifest = json.load(open(manifest_path))
    if mutation == 'manifest-identity': manifest['sha'] = 'b' * 40
    if mutation == 'manifest-size': manifest['assets'][0]['size'] += 1
    if mutation == 'manifest-hash': manifest['assets'][0]['sha256'] = '0' * 64
    open(manifest_path, 'w').write(json.dumps(manifest))
with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_STORED) as archive:
    for name in os.listdir(source):
        path = os.path.join(source, name)
        if mutation == 'missing' and name == 'RELEASE_NOTES.md': continue
        if mutation == 'oversized' and name == 'RELEASE_NOTES.md':
            archive.writestr(name, b'x' * (1024 * 1024 + 1)); continue
        if mutation == 'nested' and name == package:
            archive.write(path, 'nested/' + name); continue
        if mutation == 'traversal' and name == package:
            archive.write(path, '../' + name); continue
        if mutation == 'nonregular' and name == package:
            entry = zipfile.ZipInfo(name)
            entry.create_system = 3
            entry.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(entry, b'target'); continue
        archive.write(path, name)
    if mutation == 'extra': archive.writestr('EXTRA', b'extra')
    if mutation == 'duplicate': archive.write(os.path.join(source, package), package)
if mutation == 'encrypted':
    content = bytearray(open(target, 'rb').read())
    for signature, offset in ((b'PK\\x03\\x04', 6), (b'PK\\x01\\x02', 8)):
        position = 0
        while (position := content.find(signature, position)) >= 0:
            flags = int.from_bytes(content[position + offset:position + offset + 2], 'little') | 1
            content[position + offset:position + offset + 2] = flags.to_bytes(2, 'little')
            position += 4
    open(target, 'wb').write(content)
`, evidence, archive, options.archiveMutation ?? 'valid', packageName], { encoding: 'utf8' })
      expect(zip.status).toBe(0)
      const archiveDigest = `sha256:${await sha256File(archive)}`
      const archiveSize = (await readFile(archive)).length
      const artifactJson: Record<string, unknown> = {
        id: 77,
        name: `modula-runner-build-${tag}-run-${run}-attempt-${attempt}`,
        expired: false,
        size_in_bytes: archiveSize,
        digest: options.digestOverride ?? archiveDigest,
        workflow_run: {
          id: Number(run), head_sha: sha,
          repository_id: repositoryId, head_repository_id: repositoryId,
        },
      }
      const attemptJson: Record<string, unknown> = {
        id: Number(run), run_attempt: Number(attempt), head_sha: sha,
        event: 'push', path: '.github/workflows/release.yml',
        repository: { full_name: 'modulastack/modula-runner', id: repositoryId },
        head_repository: { full_name: 'modulastack/modula-runner', id: repositoryId },
        status: 'in_progress', conclusion: null,
      }
      options.mutateMetadata?.(artifactJson, attemptJson)
      const artifactPath = join(directory, 'artifact.json')
      const attemptPath = join(directory, 'attempt.json')
      const output = join(directory, 'output')
      await Promise.all([
        writeFile(artifactPath, JSON.stringify(artifactJson)),
        writeFile(attemptPath, JSON.stringify(attemptJson)),
      ])
      const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          ARTIFACT_JSON: artifactPath,
          ATTEMPT_JSON: attemptPath,
          ARTIFACT_ID: '77',
          ARTIFACT_DIGEST: options.digestOverride ?? archiveDigest,
          ARTIFACT_NAME: `modula-runner-build-${tag}-run-${run}-attempt-${attempt}`,
          ARTIFACT_SIZE: String(archiveSize),
          BUILD_PACKAGE_DIGEST: options.packageDigestOverride ?? effectivePackageDigest,
          DOWNLOAD_PATH: download,
          GITHUB_OUTPUT: output,
          GITHUB_REF_NAME: tag,
          GITHUB_REPOSITORY: 'modulastack/modula-runner',
          GITHUB_REPOSITORY_ID: String(repositoryId),
          GITHUB_RUN_ID: run,
          GITHUB_RUN_ATTEMPT: attempt,
          GITHUB_SHA: sha,
          RUNNER_TEMP: runnerTemp,
        },
      })
      return { result, output }
    }

    const valid = await runCase()
    expect(valid.result.status, valid.result.stderr).toBe(0)
    expect(await readFile(valid.output, 'utf8')).toContain(`package_digest=${packageDigest}`)

    const invalidCases: Array<[string, CaseOptions]> = [
      ['wrong id', { mutateMetadata: artifact => { artifact.id = 78 } }],
      ['wrong name', { mutateMetadata: artifact => { artifact.name = 'wrong' } }],
      ['wrong REST size', { mutateMetadata: artifact => { artifact.size_in_bytes = 1 } }],
      ['wrong REST digest', { mutateMetadata: artifact => { artifact.digest = `sha256:${'1'.repeat(64)}` } }],
      ['wrong run', { mutateMetadata: artifact => { (artifact.workflow_run as Record<string, unknown>).id = 92 } }],
      ['wrong repository', { mutateMetadata: artifact => { (artifact.workflow_run as Record<string, unknown>).repository_id = 43 } }],
      ['wrong SHA', { mutateMetadata: artifact => { (artifact.workflow_run as Record<string, unknown>).head_sha = 'b'.repeat(40) } }],
      ['wrong attempt', { mutateMetadata: (_artifact, attemptJson) => { attemptJson.run_attempt = 3 } }],
      ['archive digest mismatch', { digestOverride: `sha256:${'0'.repeat(64)}` }],
      ['missing member', { archiveMutation: 'missing' }],
      ['extra member', { archiveMutation: 'extra' }],
      ['duplicate member', { archiveMutation: 'duplicate' }],
      ['nested member', { archiveMutation: 'nested' }],
      ['traversal member', { archiveMutation: 'traversal' }],
      ['nonregular member', { archiveMutation: 'nonregular' }],
      ['encrypted member', { archiveMutation: 'encrypted' }],
      ['oversized member', { archiveMutation: 'oversized' }],
      ['manifest identity', { archiveMutation: 'manifest-identity' }],
      ['manifest size', { archiveMutation: 'manifest-size' }],
      ['manifest hash', { archiveMutation: 'manifest-hash' }],
      ['package digest', { packageDigestOverride: '2'.repeat(64) }],
    ]
    for (const [label, options] of invalidCases) {
      expect((await runCase(options)).result.status, label).not.toBe(0)
    }
    const maximumMembers = await runCase({ packageMutation: 'members-512' })
    expect(maximumMembers.result.status).toBe(0)
    const innerBoundaryCases = [
      ['member count', 'members-513', 'release package member count contract failed'],
      ['normalized duplicate', 'duplicate-normalized-name', 'release package member count contract failed'],
      ['unsafe path', 'unsafe-path', 'release package member safety failed'],
      ['nonregular type', 'nonregular-type', 'release package member safety failed'],
      ['member size', 'oversized-member', 'release package size contract failed'],
      ['cumulative size', 'cumulative-size', 'release package size contract failed'],
      ['decompression size', 'decompression-overflow', 'release package decompression limit failed'],
    ] as const
    for (const [label, packageMutation, error] of innerBoundaryCases) {
      const invalid = await runCase({ packageMutation })
      expect(invalid.result.status, label).not.toBe(0)
      expect(invalid.result.stderr, label).toContain(error)
    }
  })
})

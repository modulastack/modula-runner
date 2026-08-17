import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { probeRuntime, type RuntimeSpec } from '../src/capabilities.js'
import { provisionWorktree } from '../src/worktrees.js'
import { PreviewHost, TerminalSession, DEFAULT_FLOW, DEFAULT_REPLAY_LINES } from '../src/index.js'
import { denyingSpawnSeam, permissiveConsent, recordingAudit } from './spawnSeamSupport.js'
import { createGrants, createMemoryGrantStore, createSpawnSeam, type AuditRecord } from '../src/index.js'

// IC1-B1: the seam is not an enforced floor unless the real spawn sites route through it. Each
// test here denies the policy and proves the real call site creates no process — a sentinel a
// spawned command would write stays absent, and the refusal is audited where the site audits.

const directories: string[] = []

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'runner-routing-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

// A runtime whose probe would touch a sentinel file if it ever ran.
async function sentinelRuntime(directory: string): Promise<{ spec: RuntimeSpec; sentinel: string }> {
  const sentinel = join(directory, 'probe-ran')
  const script = join(directory, 'runtime.mjs')
  await writeFile(script, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(sentinel)}, 'ran')\nprocess.stdout.write('1.0.0')\n`)
  return {
    sentinel,
    spec: { runtime: 'sentinel', command: process.execPath, versionArgs: [script], authArgs: null, access: ['subscription'] },
  }
}

describe('IC1-B1 — real spawn sites route through the seam', () => {
  it('capability probe: a denied policy yields no probe process and audits the refusal', async () => {
    const directory = await workspace()
    const { spec, sentinel } = await sentinelRuntime(directory)
    const audit = recordingAudit()

    const capability = await probeRuntime(spec, denyingSpawnSeam(audit))

    expect(capability).toBeNull()
    expect(existsSync(sentinel)).toBe(false)
    expect(audit.records.some((record: AuditRecord) => record.kind === 'refused' && record.reason === 'not-allowlisted')).toBe(true)
  })

  it('capability probe: an allowed policy runs the probe and audits admission and outcome', async () => {
    const directory = await workspace()
    const { spec, sentinel } = await sentinelRuntime(directory)
    const audit = recordingAudit()
    const seam = createSpawnSeam({
      policy: { allowsExecutable: name => name === process.execPath, recipe: () => null, executables: [process.execPath], keyId: 'test' },
      audit,
    })

    const capability = await probeRuntime(spec, seam)

    expect(capability).toMatchObject({ runtime: 'sentinel', version: '1.0.0' })
    expect(existsSync(sentinel)).toBe(true)
    expect(audit.records.map(record => record.kind)).toContain('spawn-admitted')
    expect(audit.records.map(record => record.kind)).toContain('spawn-outcome')
  })

  it('worktree provisioning: a denied policy refuses git and provisions nothing', async () => {
    const directory = await workspace()
    const repo = join(directory, 'repo')
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' })
    execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], {
      stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    })
    const audit = recordingAudit()

    await expect(
      provisionWorktree({ repoPath: repo, worktreesRoot: join(directory, 'wt'), name: 'lane', branch: 'lane/x', seam: denyingSpawnSeam(audit) }),
    ).rejects.toThrow()

    expect(existsSync(join(directory, 'wt', 'lane'))).toBe(false)
    // The first git the provisioner reaches for is refused by the allowlist, recorded as such.
    expect(audit.records.some((record: AuditRecord) => record.kind === 'refused' && record.reason === 'not-allowlisted')).toBe(true)
    expect(audit.records.some(record => record.kind === 'spawn-admitted')).toBe(false)
  })

  it('pane launch: a denied policy refuses tmux and starts no session', async () => {
    const directory = await workspace()
    const audit = recordingAudit()
    const policy = { flow: DEFAULT_FLOW, replayLines: DEFAULT_REPLAY_LINES, pollMs: 50 }
    const events = { send: () => undefined, onExited: () => undefined }

    await expect(
      TerminalSession.launch({ command: process.execPath, args: ['-e', ''], cwd: directory }, policy, events, denyingSpawnSeam(audit)),
    ).rejects.toThrow()

    // The session's tmux creation is refused, so the pane's command never runs.
    expect(audit.records.some((record: AuditRecord) => record.kind === 'refused' && record.reason === 'not-allowlisted')).toBe(true)
    expect(audit.records.some(record => record.kind === 'spawn-admitted')).toBe(false)
  })

  it('preview: a denied policy refuses the recipe and starts no process', async () => {
    const directory = await workspace()
    const audit = recordingAudit()
    const host = new PreviewHost({ seam: denyingSpawnSeam(audit), consent: permissiveConsent([directory]) })

    const outcome = await host.start({ previewId: 'p', recipe: 'app', cwd: directory })
    await host.stopAll()

    expect(outcome).toEqual({ status: 'refused', reason: 'not-allowlisted' })
    expect(audit.records.some((record: AuditRecord) => record.kind === 'refused' && record.reason === 'not-allowlisted')).toBe(true)
    expect(audit.records.some(record => record.kind === 'spawn-admitted')).toBe(false)
  })

  it('pane launch: consent goes through the seam — an ungranted cwd is refused before tmux', async () => {
    const directory = await workspace()
    const granted = join(directory, 'granted')
    const ungranted = join(directory, 'ungranted')
    await import('node:fs/promises').then(fs => Promise.all([fs.mkdir(granted), fs.mkdir(ungranted)]))
    const audit = recordingAudit()
    const consent = createGrants({ store: createMemoryGrantStore([granted]) })
    const seam = createSpawnSeam({
      policy: { allowsExecutable: name => name === process.execPath || name === 'tmux', recipe: () => null, executables: [process.execPath, 'tmux'], keyId: 'pane-consent' },
      audit,
      consent,
    })

    await expect(
      TerminalSession.launch(
        { command: process.execPath, args: ['-e', ''], cwd: ungranted },
        { flow: DEFAULT_FLOW, replayLines: DEFAULT_REPLAY_LINES, pollMs: 50 },
        { send: () => undefined, onExited: () => undefined },
        seam,
      ),
    ).rejects.toThrow()

    // The pane command is allowlisted, so the refusal is the ungranted directory, not the command.
    expect(audit.records.some((record: AuditRecord) => record.kind === 'refused' && record.reason === 'path-not-granted')).toBe(true)
    expect(audit.records.some(record => record.kind === 'spawn-admitted')).toBe(false)
  })
})

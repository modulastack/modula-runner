import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installedRunner, type InstalledRunner, type RunResult } from './harness.js'
import { PairingContractStub } from './pairingContractStub.js'

const roots: string[] = []

describe('installed protocol-v2 runtime', () => {
  let runner: InstalledRunner

  beforeAll(async () => {
    runner = await installedRunner()
  }, 600_000)

  afterAll(async () => {
    await runner?.dispose()
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })

  it('negotiates v2, launches one locally-resolved safe session, and shuts down cleanly', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'runner-v2-installed-'))
    roots.push(workspace)
    const runnerHome = join(workspace, 'runner-home')
    const fakeBin = join(workspace, 'bin')
    const marker = join(workspace, 'session-ran')
    const { repo, worktrees } = await createProject(workspace)
    await mkdir(fakeBin, { mode: 0o700 })
    await writeFakeCodex(join(fakeBin, 'codex'), marker)
    await initializePolicy(runner, runnerHome, join(workspace, 'allowlist.pem'))
    await expectSuccess(await runner.run(['project', 'create', 'project-1', '--repo', repo, '--worktrees-root', worktrees], { home: runnerHome }))
    await expectSuccess(await runner.run(['grant', worktrees], { home: runnerHome }))
    await expectSuccess(await runner.run(['profile', 'add', 'daily', '--runtime', 'codex', '--access', 'subscription'], { home: runnerHome }))

    const stub = await new PairingContractStub({ confirmation: ['confirmed'] }).start()
    try {
      const paired = await runner.runInPty(
        ['pair', '--control-plane', stub.url],
        { home: runnerHome, input: { after: 'code', value: stub.inputCode }, timeoutMs: 30_000 },
      )
      expect(paired.status).toBe(0)
      stub.queueSession({
        type: 'SESSION_START',
        bindingId: stub.pairedBindingId(),
        requestId: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        terminalProfile: 'coder',
        modelProfileId: 'daily',
        target: {
          projectId: 'project-1',
          worktreeName: 'runtime-v2',
          branch: 'feat/runtime-v2',
          baseBranch: 'main',
          relativeCwd: '.',
        },
      })
      const finished = stub.waitForSessionFinished()
      const bounded = Promise.race([finished, deadline(30_000)])
      const result = await runner.run(['run'], {
        home: runnerHome,
        extraPath: fakeBin,
        stopWhen: bounded,
        timeoutMs: 60_000,
      })

      expect(await bounded, JSON.stringify(stub.sessionMessages)).toMatchObject({ type: 'SESSION_FINISHED', exitCode: 0, signal: null })
      expect(stub.sessionMessages.map(message => message.type)).toEqual([
        'SESSION_ACCEPTED',
        'SESSION_STARTED',
        'SESSION_FINISHED',
      ])
      expect((await readFile(marker, 'utf8')).trim()).toBe('session')
      expect(result).toMatchObject({ status: 0, signal: null, stderr: '' })
      expect(result.stdout).toBe('runner stopped — all identified children terminated\n')
      expect(stub.containsFixtureSecret(`${result.stdout}${result.stderr}`)).toBe(false)
    } finally {
      await stub.stop()
    }
  }, 180_000)

  it('kills an active locally-launched session before confirming SIGTERM cleanup', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'runner-v2-shutdown-'))
    roots.push(workspace)
    const runnerHome = join(workspace, 'runner-home')
    const fakeBin = join(workspace, 'bin')
    const pidFile = join(workspace, 'session.pid')
    const { repo, worktrees } = await createProject(workspace)
    await mkdir(fakeBin, { mode: 0o700 })
    await writeBlockingCodex(join(fakeBin, 'codex'), pidFile)
    await initializePolicy(runner, runnerHome, join(workspace, 'allowlist.pem'))
    await expectSuccess(await runner.run(['project', 'create', 'project-1', '--repo', repo, '--worktrees-root', worktrees], { home: runnerHome }))
    await expectSuccess(await runner.run(['grant', worktrees], { home: runnerHome }))
    await expectSuccess(await runner.run(['profile', 'add', 'daily', '--runtime', 'codex', '--access', 'subscription'], { home: runnerHome }))

    const stub = await new PairingContractStub({ confirmation: ['confirmed'] }).start()
    try {
      const paired = await runner.runInPty(
        ['pair', '--control-plane', stub.url],
        { home: runnerHome, input: { after: 'code', value: stub.inputCode }, timeoutMs: 30_000 },
      )
      expect(paired.status).toBe(0)
      stub.queueSession({
        type: 'SESSION_START',
        bindingId: stub.pairedBindingId(),
        requestId: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        terminalProfile: 'coder',
        modelProfileId: 'daily',
        target: {
          projectId: 'project-1',
          worktreeName: 'runtime-v2-stop',
          branch: 'feat/runtime-v2-stop',
          baseBranch: 'main',
          relativeCwd: '.',
        },
      })
      const started = Promise.race([stub.waitForSessionStarted(), deadline(30_000)])
      const result = await runner.run(['run'], {
        home: runnerHome,
        extraPath: fakeBin,
        stopWhen: started,
        timeoutMs: 60_000,
      })

      expect(await started, JSON.stringify(stub.sessionMessages)).toMatchObject({ type: 'SESSION_STARTED' })
      const pid = Number((await readFile(pidFile, 'utf8')).trim())
      expect(await processExited(pid)).toBe(true)
      expect(result).toMatchObject({ status: 0, signal: null, stderr: '' })
      expect(result.stdout).toBe('runner stopped — all identified children terminated\n')
      expect(stub.containsFixtureSecret(`${result.stdout}${result.stderr}`)).toBe(false)
    } finally {
      await stub.stop()
    }
  }, 180_000)
})

async function initializePolicy(runner: InstalledRunner, runnerHome: string, keyPath: string) {
  const { privateKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  await writeFile(keyPath, privateKey, { mode: 0o600 })
  await expectSuccess(await runner.run(['allowlist', 'init', '--key', keyPath], { home: runnerHome }))
}

async function createProject(workspace: string) {
  const origin = join(workspace, 'origin.git')
  const repo = join(workspace, 'repo')
  const worktrees = join(workspace, 'worktrees')
  execFileSync('git', ['init', '--bare', origin])
  execFileSync('git', ['clone', origin, repo])
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'runner@example.test'])
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Runner Test'])
  await writeFile(join(repo, 'README.md'), 'runtime v2\n')
  execFileSync('git', ['-C', repo, 'add', 'README.md'])
  execFileSync('git', ['-C', repo, 'commit', '-m', 'initial'])
  execFileSync('git', ['-C', repo, 'branch', '-M', 'main'])
  execFileSync('git', ['-C', repo, 'push', '-u', 'origin', 'main'])
  await mkdir(worktrees, { mode: 0o700 })
  return { repo, worktrees }
}

async function writeFakeCodex(path: string, marker: string) {
  const script = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 1.0.0"; exit 0; fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then exit 0; fi
printf 'session\\n' > '${marker}'
`
  await writeFile(path, script, { mode: 0o700 })
  await chmod(path, 0o700)
}

async function writeBlockingCodex(path: string, pidFile: string) {
  const script = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 1.0.0"; exit 0; fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then exit 0; fi
printf '%s\\n' "$$" > '${pidFile}'
trap 'exit 0' HUP INT TERM
while :; do sleep 1; done
`
  await writeFile(path, script, { mode: 0o700 })
  await chmod(path, 0o700)
}

async function processExited(pid: number) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return false
}

function deadline(ms: number) {
  return new Promise<null>(resolve => {
    const timer = setTimeout(() => resolve(null), ms)
    timer.unref()
  })
}

async function expectSuccess(result: RunResult) {
  expect(result.status, result.stderr).toBe(0)
  expect(result.signal).toBeNull()
}

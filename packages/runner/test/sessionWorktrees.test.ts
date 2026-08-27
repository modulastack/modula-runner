import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createGrants,
  createMemoryGrantStore,
  createSessionWorktreePort,
  type SessionBranchCreatedSnapshot,
  type SpawnSeam,
} from '../src/index.js'
import { permissiveSpawnSeam } from './spawnSeamSupport.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.email=dev@example.com', '-c', 'user.name=dev', ...args], { cwd, encoding: 'utf8' }).trim()
}

function repositories() {
  const root = mkdtempSync(path.join(tmpdir(), 'runner-session-worktrees-'))
  roots.push(root)
  const origin = path.join(root, 'origin.git')
  const seed = path.join(root, 'seed')
  const repoPath = path.join(root, 'checkout')
  const worktreesRoot = path.join(root, 'worktrees')
  execFileSync('git', ['init', '--bare', '-b', 'main', origin])
  execFileSync('git', ['init', '-b', 'main', seed])
  writeFileSync(path.join(seed, 'README.md'), 'seed\n')
  git(seed, ['add', '.'])
  git(seed, ['commit', '-m', 'seed'])
  git(seed, ['push', origin, 'main'])
  execFileSync('git', ['clone', origin, repoPath], { stdio: 'ignore' })
  mkdirSync(worktreesRoot)
  return {
    root,
    project: { projectId: 'modulastack', repoPath, worktreesRoot, revision: 1 },
    target: { projectId: 'modulastack', worktreeName: 'lane-01', branch: 'lane/topic-1', baseBranch: 'main', relativeCwd: '.' },
  }
}

function port(repos: ReturnType<typeof repositories>, granted = true, seam = permissiveSpawnSeam()) {
  const grants = createGrants({ store: createMemoryGrantStore(granted ? [repos.project.worktreesRoot] : []) })
  return createSessionWorktreePort({ seam, grants })
}

function abortAfterGit(controller: AbortController, command: string, subcommand?: string): SpawnSeam {
  const base = permissiveSpawnSeam()
  return {
    check: (executable, recipeId) => base.check(executable, recipeId),
    recordRefusal: (request, reason) => base.recordRefusal(request, reason),
    authorize: request => base.authorize(request),
    run: async (request, runner) => {
      const result = await base.run(request, runner)
      if (request.kind === 'git' && request.args?.[0] === command && (!subcommand || request.args[1] === subcommand)) controller.abort()
      return result
    },
  }
}

const signal = () => new AbortController().signal

describe('production session worktree port', () => {
  it('persists branch, registration, and verification evidence in distinct phases', async () => {
    const repos = repositories()
    const firstPort = port(repos)
    const prepared = await firstPort.prepare(repos.project, repos.target, signal())
    expect(prepared.status).toBe('ready')
    if (prepared.status !== 'ready' || prepared.snapshot.phase !== 'branch-created') throw new Error('branch phase missing')
    expect(prepared.snapshot).not.toHaveProperty('worktreePath')
    expect(existsSync(path.join(repos.project.worktreesRoot, repos.target.worktreeName))).toBe(false)
    expect(git(repos.project.repoPath, ['rev-parse', '--verify', repos.target.branch])).toBe(prepared.snapshot.headCommit)

    const restartedPort = port(repos)
    const registered = await restartedPort.register(prepared.snapshot, repos.project, repos.target, signal())
    expect(registered.status).toBe('ready')
    if (registered.status !== 'ready') throw new Error('registration failed')
    expect(registered.snapshot).toMatchObject({ phase: 'worktree-registered', ownership: 'created' })
    expect(await restartedPort.inspect(registered.snapshot)).toBe('exact')

    const verified = await restartedPort.verify(registered.snapshot, '.', signal())
    expect(verified.status).toBe('ready')
    if (verified.status !== 'ready') throw new Error('verification failed')
    expect(verified.snapshot).toMatchObject({ phase: 'verified', clean: true, relativeCwd: '.' })
    expect(await restartedPort.inspect(verified.snapshot)).toBe('exact')
    await expect(restartedPort.rollback(verified.snapshot)).resolves.toBe('rolled-back')
    expect(existsSync(registered.snapshot.worktreePath)).toBe(false)
    expect(() => git(repos.project.repoPath, ['rev-parse', '--verify', repos.target.branch])).toThrow()
  })

  it('reuses an exact clean lane without claiming rollback ownership', async () => {
    const repos = repositories()
    const first = port(repos)
    const prepared = await first.prepare(repos.project, repos.target, signal())
    if (prepared.status !== 'ready' || prepared.snapshot.phase !== 'branch-created') throw new Error('branch phase missing')
    const registered = await first.register(prepared.snapshot, repos.project, repos.target, signal())
    if (registered.status !== 'ready') throw new Error('registration failed')
    const second = await first.prepare(repos.project, repos.target, signal())
    expect(second).toMatchObject({ status: 'ready', snapshot: { phase: 'worktree-registered', ownership: 'reused' } })
    if (second.status !== 'ready') throw new Error('reuse failed')
    await expect(first.rollback(second.snapshot)).resolves.toBe('not-owned')
    expect(existsSync(registered.snapshot.worktreePath)).toBe(true)
  })

  it('rechecks the worktrees-root grant before recovered registration mutates disk', async () => {
    const repos = repositories()
    const grants = createGrants({ store: createMemoryGrantStore([repos.project.worktreesRoot]) })
    const worktrees = createSessionWorktreePort({ seam: permissiveSpawnSeam(), grants })
    const prepared = await worktrees.prepare(repos.project, repos.target, signal())
    if (prepared.status !== 'ready' || prepared.snapshot.phase !== 'branch-created') throw new Error('branch phase missing')
    await grants.revoke(repos.project.worktreesRoot)
    await expect(worktrees.register(prepared.snapshot, repos.project, repos.target, signal()))
      .resolves.toEqual({ status: 'failed', reason: 'path-not-granted' })
    expect(existsSync(path.join(repos.project.worktreesRoot, repos.target.worktreeName))).toBe(false)
  })

  it('removes an exact worktree when post-add registration inspection fails', async () => {
    const repos = repositories()
    const base = permissiveSpawnSeam()
    let added = false
    let failedPostAddList = false
    const seam: SpawnSeam = {
      check: (executable, recipeId) => base.check(executable, recipeId),
      recordRefusal: (request, reason) => base.recordRefusal(request, reason),
      authorize: request => base.authorize(request),
      run: async (request, runner) => {
        if (added && !failedPostAddList && request.kind === 'git' && request.args?.[0] === 'worktree' && request.args[1] === 'list') {
          failedPostAddList = true
          throw new Error('post-add inspection failed')
        }
        const result = await base.run(request, runner)
        if (request.kind === 'git' && request.args?.[0] === 'worktree' && request.args[1] === 'add') added = true
        return result
      },
    }
    const worktrees = port(repos, true, seam)
    const prepared = await worktrees.prepare(repos.project, repos.target, signal())
    if (prepared.status !== 'ready' || prepared.snapshot.phase !== 'branch-created') throw new Error('branch phase missing')
    await expect(worktrees.register(prepared.snapshot, repos.project, repos.target, signal()))
      .resolves.toEqual({ status: 'failed', reason: 'provision-failed' })
    expect(failedPostAddList).toBe(true)
    expect(existsSync(path.join(repos.project.worktreesRoot, repos.target.worktreeName))).toBe(false)
  })

  it('rejects repositories whose Git directory is separated from the main checkout', async () => {
    const repos = repositories()
    const origin = path.join(repos.root, 'origin.git')
    const separate = path.join(repos.root, 'separate.git')
    rmSync(repos.project.repoPath, { recursive: true, force: true })
    execFileSync('git', ['clone', '--separate-git-dir', separate, origin, repos.project.repoPath], { stdio: 'ignore' })
    await expect(port(repos).prepare(repos.project, repos.target, signal()))
      .resolves.toEqual({ status: 'failed', reason: 'worktree-invalid' })
  })

  it('treats unexpected ref inspection failures as uncertain, not missing', async () => {
    const repos = repositories()
    const first = port(repos)
    const prepared = await first.prepare(repos.project, repos.target, signal())
    if (prepared.status !== 'ready' || prepared.snapshot.phase !== 'branch-created') throw new Error('branch phase missing')
    const base = permissiveSpawnSeam()
    const failing: SpawnSeam = {
      check: (executable, recipeId) => base.check(executable, recipeId),
      recordRefusal: (request, reason) => base.recordRefusal(request, reason),
      authorize: request => base.authorize(request),
      run: async (request, runner) => {
        if (request.kind === 'git' && request.args?.[0] === 'show-ref') throw new Error('git unavailable')
        return await base.run(request, runner)
      },
    }
    const restarted = port(repos, true, failing)
    await expect(restarted.inspect(prepared.snapshot)).resolves.toBe('mismatch')
    await expect(restarted.rollback(prepared.snapshot)).resolves.toBe('uncertain')
  })

  it('rejects dirty, ungranted, and pre-aborted provisioning without destructive guesses', async () => {
    const repos = repositories()
    const worktrees = port(repos)
    const prepared = await worktrees.prepare(repos.project, repos.target, signal())
    if (prepared.status !== 'ready' || prepared.snapshot.phase !== 'branch-created') throw new Error('branch phase missing')
    const registered = await worktrees.register(prepared.snapshot, repos.project, repos.target, signal())
    if (registered.status !== 'ready') throw new Error('registration failed')
    writeFileSync(path.join(registered.snapshot.worktreePath, 'dirty.txt'), 'dirty')
    await expect(worktrees.verify(registered.snapshot, '.', signal())).resolves.toEqual({ status: 'failed', reason: 'worktree-conflict' })
    await expect(worktrees.rollback(registered.snapshot)).resolves.toBe('uncertain')
    expect(existsSync(registered.snapshot.worktreePath)).toBe(true)

    const other = repositories()
    await expect(port(other, false).prepare(other.project, other.target, signal())).resolves.toEqual({ status: 'failed', reason: 'path-not-granted' })
    const controller = new AbortController()
    controller.abort()
    await expect(port(other).prepare(other.project, { ...other.target, branch: 'lane/aborted' }, controller.signal))
      .resolves.toEqual({ status: 'failed', reason: 'provision-failed' })
    expect(() => git(other.project.repoPath, ['rev-parse', '--verify', 'lane/aborted'])).toThrow()
  })

  it('cleans unjournaled branch and registration side effects when cancellation wins', async () => {
    const branchRepos = repositories()
    const branchAbort = new AbortController()
    const branchResult = await port(branchRepos, true, abortAfterGit(branchAbort, 'branch'))
      .prepare(branchRepos.project, branchRepos.target, branchAbort.signal)
    expect(branchAbort.signal.aborted).toBe(true)
    expect(branchResult).toEqual({ status: 'failed', reason: 'provision-failed' })
    expect(() => git(branchRepos.project.repoPath, ['rev-parse', '--verify', branchRepos.target.branch])).toThrow()

    const registrationRepos = repositories()
    const prepared = await port(registrationRepos).prepare(registrationRepos.project, registrationRepos.target, signal())
    if (prepared.status !== 'ready' || prepared.snapshot.phase !== 'branch-created') throw new Error('branch phase missing')
    const registrationAbort = new AbortController()
    const registrationResult = await port(registrationRepos, true, abortAfterGit(registrationAbort, 'worktree', 'add'))
      .register(prepared.snapshot, registrationRepos.project, registrationRepos.target, registrationAbort.signal)
    expect(registrationAbort.signal.aborted).toBe(true)
    expect(registrationResult).toEqual({ status: 'failed', reason: 'provision-failed' })
    expect(existsSync(path.join(registrationRepos.project.worktreesRoot, registrationRepos.target.worktreeName))).toBe(false)
    expect(git(registrationRepos.project.repoPath, ['rev-parse', '--verify', registrationRepos.target.branch])).toBe(prepared.snapshot.headCommit)
    await expect(port(registrationRepos).rollback(prepared.snapshot)).resolves.toBe('rolled-back')
  })

  it('rolls back only exact created evidence and leaves mismatches uncertain', async () => {
    const repos = repositories()
    const worktrees = port(repos)
    const prepared = await worktrees.prepare(repos.project, repos.target, signal())
    if (prepared.status !== 'ready' || prepared.snapshot.phase !== 'branch-created') throw new Error('branch phase missing')
    const mismatch: SessionBranchCreatedSnapshot = { ...prepared.snapshot, headCommit: 'f'.repeat(40) }
    await expect(worktrees.rollback(mismatch)).resolves.toBe('uncertain')
    expect(git(repos.project.repoPath, ['rev-parse', '--verify', repos.target.branch])).toBeTruthy()
    await expect(worktrees.rollback(prepared.snapshot)).resolves.toBe('rolled-back')
    expect(() => git(repos.project.repoPath, ['rev-parse', '--verify', repos.target.branch])).toThrow()
  })
})

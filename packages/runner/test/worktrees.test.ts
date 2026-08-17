import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deterministicWorktreePath, provisionWorktree } from '../src/worktrees.js'
import { permissiveSpawnSeam } from './spawnSeamSupport.js'

let baseDirs: string[] = []

afterEach(() => {
  for (const dir of baseDirs) rmSync(dir, { recursive: true, force: true })
  baseDirs = []
})

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.email=dev@example.com', '-c', 'user.name=dev', ...args], { cwd, encoding: 'utf8' }).trim()
}

function createRepos() {
  const base = mkdtempSync(path.join(tmpdir(), 'mr-worktrees-'))
  baseDirs.push(base)
  const origin = path.join(base, 'origin.git')
  const seed = path.join(base, 'seed')
  const repoPath = path.join(base, 'checkout')
  const worktreesRoot = path.join(base, 'worktrees')
  execFileSync('git', ['init', '--bare', '-b', 'main', origin])
  execFileSync('git', ['init', '-b', 'main', seed])
  writeFileSync(path.join(seed, 'README.md'), 'seed\n')
  git(seed, ['add', '.'])
  git(seed, ['commit', '-m', 'seed'])
  git(seed, ['push', origin, 'main'])
  execFileSync('git', ['clone', origin, repoPath], { stdio: 'ignore' })
  return { base, origin, seed, repoPath, worktreesRoot }
}

function request(repos: ReturnType<typeof createRepos>, overrides: Partial<Parameters<typeof provisionWorktree>[0]> = {}) {
  return { repoPath: repos.repoPath, worktreesRoot: repos.worktreesRoot, name: 'lane-1', branch: 'lane/topic-1', seam: permissiveSpawnSeam(), ...overrides }
}

describe('worktree provisioning', () => {
  it('creates a deterministic worktree on a fresh branch from origin/main', async () => {
    const repos = createRepos()
    const result = await provisionWorktree(request(repos))
    expect(result).toEqual({ branch: 'lane/topic-1', worktreePath: path.join(repos.worktreesRoot, 'lane-1'), reused: false })
    expect(git(result.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('lane/topic-1')
    expect(git(result.worktreePath, ['rev-parse', 'HEAD'])).toBe(git(repos.repoPath, ['rev-parse', 'origin/main']))
    expect(git(result.worktreePath, ['status', '--short'])).toBe('')
  })

  it('reuses an existing clean worktree registered for the same branch', async () => {
    const repos = createRepos()
    const first = await provisionWorktree(request(repos))
    const second = await provisionWorktree(request(repos))
    expect(second).toEqual({ ...first, reused: true })
  })

  it('refuses to reuse a dirty worktree', async () => {
    const repos = createRepos()
    const result = await provisionWorktree(request(repos))
    writeFileSync(path.join(result.worktreePath, 'dirty.txt'), 'x')
    await expect(provisionWorktree(request(repos))).rejects.toThrow(/uncommitted changes/)
  })

  it('refuses a worktree path registered for a different branch', async () => {
    const repos = createRepos()
    await provisionWorktree(request(repos))
    await expect(provisionWorktree(request(repos, { branch: 'lane/other-2' }))).rejects.toThrow(/already registered for lane\/topic-1/)
  })

  it('refuses a branch that exists without a matching worktree', async () => {
    const repos = createRepos()
    git(repos.repoPath, ['branch', 'lane/stray', 'origin/main'])
    await expect(provisionWorktree(request(repos, { branch: 'lane/stray' }))).rejects.toThrow(/already exists without a matching worktree/)
  })

  it('refuses a branch already attached to another worktree', async () => {
    const repos = createRepos()
    await provisionWorktree(request(repos))
    await expect(provisionWorktree(request(repos, { name: 'lane-2' }))).rejects.toThrow(/already attached to another worktree/)
  })

  it('refuses a worktree path that already exists on disk', async () => {
    const repos = createRepos()
    mkdirSync(path.join(repos.worktreesRoot, 'lane-1'), { recursive: true })
    await expect(provisionWorktree(request(repos))).rejects.toThrow(/already exists/)
  })

  it('refuses stale worktree registrations instead of adopting them', async () => {
    const repos = createRepos()
    const result = await provisionWorktree(request(repos))
    rmSync(result.worktreePath, { recursive: true, force: true })
    await expect(provisionWorktree(request(repos))).rejects.toThrow(/stale and must be pruned/)
  })

  it('refuses invalid branch names', async () => {
    const repos = createRepos()
    await expect(provisionWorktree(request(repos, { branch: 'bad branch' }))).rejects.toThrow(/invalid git branch name/)
    await expect(provisionWorktree(request(repos, { branch: 'bad..branch' }))).rejects.toThrow(/invalid git branch name/)
  })

  it('refuses worktree names that are not safe path segments', async () => {
    const repos = createRepos()
    await expect(provisionWorktree(request(repos, { name: '../escape' }))).rejects.toThrow(/not a safe path segment/)
    expect(() => deterministicWorktreePath(repos.worktreesRoot, 'a/b')).toThrow(/not a safe path segment/)
  })

  it('refuses a repo path that is not the main checkout root', async () => {
    const repos = createRepos()
    const nested = path.join(repos.repoPath, 'nested')
    mkdirSync(nested)
    await expect(provisionWorktree(request(repos, { repoPath: nested }))).rejects.toThrow(/main checkout mismatch/)
  })

  it('provisions from a configured base branch', async () => {
    const repos = createRepos()
    writeFileSync(path.join(repos.seed, 'develop.txt'), 'develop\n')
    git(repos.seed, ['add', '.'])
    git(repos.seed, ['commit', '-m', 'develop work'])
    git(repos.seed, ['push', repos.origin, 'main:develop'])
    const result = await provisionWorktree(request(repos, { baseBranch: 'develop' }))
    expect(git(result.worktreePath, ['rev-parse', 'HEAD'])).toBe(git(repos.seed, ['rev-parse', 'HEAD']))
  })

  it('updates the remote-tracking ref even in a narrow single-branch clone', async () => {
    const repos = createRepos()
    writeFileSync(path.join(repos.seed, 'develop.txt'), 'develop\n')
    git(repos.seed, ['add', '.'])
    git(repos.seed, ['commit', '-m', 'develop work'])
    git(repos.seed, ['push', repos.origin, 'main:develop'])
    const narrow = path.join(repos.base, 'narrow')
    execFileSync('git', ['clone', '--single-branch', '--branch', 'main', repos.origin, narrow], { stdio: 'ignore' })
    const result = await provisionWorktree({ repoPath: narrow, worktreesRoot: repos.worktreesRoot, name: 'lane-narrow', branch: 'lane/narrow-1', baseBranch: 'develop', seam: permissiveSpawnSeam() })
    expect(git(result.worktreePath, ['rev-parse', 'HEAD'])).toBe(git(repos.seed, ['rev-parse', 'HEAD']))
  })

  it('provisions from the advanced origin base, never a stale tracking ref', async () => {
    const repos = createRepos()
    writeFileSync(path.join(repos.seed, 'advance.txt'), 'advance\n')
    git(repos.seed, ['add', '.'])
    git(repos.seed, ['commit', '-m', 'advance main'])
    git(repos.seed, ['push', repos.origin, 'main'])
    const result = await provisionWorktree(request(repos))
    expect(git(result.worktreePath, ['rev-parse', 'HEAD'])).toBe(git(repos.seed, ['rev-parse', 'HEAD']))
  })

  it('leaves no branch behind when the checkout fails, so a retry can succeed', async () => {
    const repos = createRepos()
    const blocked = path.join(repos.base, 'blocked')
    mkdirSync(blocked, { mode: 0o500 })
    await expect(provisionWorktree(request(repos, { worktreesRoot: blocked }))).rejects.toThrow()
    // The rollback removed the branch this attempt created: without it, every
    // retry would refuse the branch as pre-existing.
    const retried = await provisionWorktree(request(repos))
    expect(retried.reused).toBe(false)
    expect(git(retried.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('lane/topic-1')
  })

  it('serializes concurrent provisioning so a loser cannot delete the winner', async () => {
    const repos = createRepos()
    const results = await Promise.allSettled([
      provisionWorktree(request(repos)),
      provisionWorktree(request(repos)),
      provisionWorktree(request(repos)),
    ])
    const fulfilled = results.filter(result => result.status === 'fulfilled')
    // Every call agrees on the same lane, and the winner's worktree survives.
    expect(fulfilled.length).toBe(3)
    const worktreePath = path.join(repos.worktreesRoot, 'lane-1')
    expect(git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('lane/topic-1')
    expect(git(repos.repoPath, ['rev-parse', '--verify', 'lane/topic-1'])).toBeTruthy()
  })

  it('refuses to provision from a linked worktree', async () => {
    const repos = createRepos()
    const lane = await provisionWorktree(request(repos))
    // A linked worktree answers --show-toplevel with its own root, so only the
    // git-dir comparison tells it apart from the main checkout.
    await expect(provisionWorktree({ repoPath: lane.worktreePath, worktreesRoot: repos.worktreesRoot, name: 'lane-2', branch: 'lane/topic-2', seam: permissiveSpawnSeam() }))
      .rejects.toThrow(/not a linked worktree/)
  })

  it('rolls back only what the failed attempt owns, never a registered lane', async () => {
    const repos = createRepos()
    const survivor = await provisionWorktree(request(repos))
    const blocked = path.join(repos.base, 'blocked-2')
    mkdirSync(blocked, { mode: 0o500 })
    // The failing attempt's rollback runs while another lane is registered: it
    // must clean up its own branch and leave the registered one untouched.
    await expect(provisionWorktree(request(repos, { worktreesRoot: blocked, name: 'lane-2', branch: 'lane/topic-2' }))).rejects.toThrow()
    expect(git(survivor.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('lane/topic-1')
    expect(git(repos.repoPath, ['rev-parse', '--verify', 'lane/topic-1'])).toBeTruthy()
    expect(() => git(repos.repoPath, ['rev-parse', '--verify', 'lane/topic-2'])).toThrow()
  })

  it('refuses an empty base branch instead of silently defaulting', async () => {
    const repos = createRepos()
    await expect(provisionWorktree(request(repos, { baseBranch: '' }))).rejects.toThrow(/invalid base branch/)
    await expect(provisionWorktree(request(repos, { baseBranch: '   ' }))).rejects.toThrow(/invalid base branch/)
  })

  it('refuses when the base branch cannot be fetched', async () => {
    const repos = createRepos()
    await expect(provisionWorktree(request(repos, { baseBranch: 'missing-base' }))).rejects.toThrow(/unable to fetch origin\/missing-base/)
  })
})

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { isSafeIdentifier } from '@modulastack/runner-protocol'
import type { SpawnSeam } from './spawnSeam.js'

const run = promisify(execFile)

export type WorktreeProvisionRequest = {
  repoPath: string
  worktreesRoot: string
  name: string
  branch: string
  baseBranch?: string
  // Provisioning runs git, so it passes the allowlist gate every runner-owned spawn does: a
  // control plane that cannot extend the allowlist cannot make the runner run git it forbade.
  seam: SpawnSeam
}

type GitOptions = { timeout?: number; encoding?: BufferEncoding }

// The one place worktree provisioning spawns git, so the allowlist gate and the audit record
// live in a single spot rather than at each of a dozen call sites. A refused git command is a
// thrown provisioning failure — the caller already treats an unavailable git as fatal.
async function execGit(seam: SpawnSeam, cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
  const result = await seam.run(
    { kind: 'git', executable: 'git', args, cwd, grantScoped: false },
    async vetted => {
      const output = await run(vetted.command, [...vetted.args], { cwd, encoding: 'utf8', ...options })
      return { outcome: { exitCode: 0, signal: null }, value: output.stdout }
    },
  )
  if (result.status === 'refused') throw new Error(`git is not on the runner's command allowlist: ${result.reason}`)
  return result.value
}

export type WorktreeProvisionResult = {
  branch: string
  worktreePath: string
  reused: boolean
}

type ListedWorktree = { path: string; branch?: string; prunable: boolean }

const LOCAL_GIT_TIMEOUT_MS = 5_000
const FETCH_GIT_TIMEOUT_MS = 30_000
// A checkout is proportional to the repository, not to a local query: sharing
// the 5-second bound would abort large worktrees halfway and strand the branch.
const CHECKOUT_GIT_TIMEOUT_MS = 120_000

// Deterministic lane provisioning: the same request always resolves to the same
// path and branch, an existing worktree is reused only when it is exactly the one
// asked for and clean, and every ambiguous state is a refusal, never a guess.
// Fully asynchronous: a slow origin costs this provisioning call its deadline,
// never the event loop the terminal streams and heartbeats run on.
export async function provisionWorktree(request: WorktreeProvisionRequest): Promise<WorktreeProvisionResult> {
  // Resolution is read-only, so it runs outside the lock; the lock itself keys
  // on the repository's common git directory, which every checkout of that
  // repository agrees on. Serializing on a path would let a linked worktree and
  // its main checkout take different locks and race each other's rollbacks.
  // This orders lanes within one runner; it is not a lock against a second
  // process operating on the same checkout.
  const checkout = await resolveMainCheckoutCached(request.repoPath, request.seam)
  return serializeByRepo(checkout.commonDir, () => provision(request, checkout.repoPath))
}

// Resolution is read-only and stable for a path, so a burst against one
// repository collapses to a single set of git calls instead of three per
// request racing ahead of the queue's depth limit.
const checkoutCache = new Map<string, Promise<{ repoPath: string; commonDir: string }>>()

function resolveMainCheckoutCached(repoPath: string, seam: SpawnSeam) {
  const key = path.resolve(repoPath)
  let resolving = checkoutCache.get(key)
  if (!resolving) {
    resolving = resolveMainCheckout(repoPath, seam)
    checkoutCache.set(key, resolving)
    // Evict once settled — the cache exists to collapse a concurrent burst into
    // one resolution, not to hold every path the runner ever saw.
    const evict = () => {
      if (checkoutCache.get(key) === resolving) checkoutCache.delete(key)
    }
    void resolving.then(evict, evict)
  }
  return resolving
}

const provisioning = new Map<string, Promise<unknown>>()
const provisioningDepth = new Map<string, number>()
// A checkout can hold the chain for minutes, so an unbounded queue turns a
// burst into unbounded latency and O(N) retained closures. Refusing is the
// honest answer: the caller can retry when the lane ahead of it finishes.
const MAX_QUEUED_PROVISIONS = 32

async function serializeByRepo<T>(key: string, task: () => Promise<T>): Promise<T> {
  const depth = provisioningDepth.get(key) ?? 0
  if (depth >= MAX_QUEUED_PROVISIONS) throw new Error(`too many provisioning requests queued for ${key}`)
  provisioningDepth.set(key, depth + 1)
  try {
    return await queueOnRepo(key, task)
  } finally {
    const remaining = (provisioningDepth.get(key) ?? 1) - 1
    if (remaining > 0) provisioningDepth.set(key, remaining)
    else provisioningDepth.delete(key)
  }
}

async function queueOnRepo<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = provisioning.get(key) ?? Promise.resolve()
  const current = previous.then(task, task)
  const settled = current.then(() => undefined, () => undefined)
  provisioning.set(key, settled)
  try {
    return await current
  } finally {
    if (provisioning.get(key) === settled) provisioning.delete(key)
  }
}

async function provision(request: WorktreeProvisionRequest, repoPath: string): Promise<WorktreeProvisionResult> {
  const seam = request.seam
  const branch = request.branch.trim()
  // Only an absent base means "the default"; an empty or blank one is a
  // malformed request, and silently provisioning from main would answer a
  // question the caller did not ask.
  const base = request.baseBranch === undefined ? 'main' : request.baseBranch.trim()
  await validateBranch(seam, repoPath, branch)
  validateBranchName(base)
  const worktreePath = deterministicWorktreePath(request.worktreesRoot, request.name)
  const listed = await listedWorktrees(seam, repoPath)
  const existing = listed.find(item => samePath(item.path, worktreePath))
  if (existing) return reusedWorktree(seam, existing, branch)
  return createWorktree(seam, { repoPath, branch, base, worktreePath, listed })
}

// Worktree names obey the wire's safe-segment rule, so a name that arrived over a
// channel can never resolve outside the worktrees root.
export function deterministicWorktreePath(worktreesRoot: string, name: string) {
  if (!isSafeIdentifier(name)) throw new Error(`worktree name is not a safe path segment: ${name}`)
  return path.resolve(worktreesRoot, name)
}

type CreateInput = { repoPath: string; branch: string; base: string; worktreePath: string; listed: ListedWorktree[] }

async function createWorktree(seam: SpawnSeam, input: CreateInput): Promise<WorktreeProvisionResult> {
  const { repoPath, branch, base, worktreePath, listed } = input
  if (existsSync(worktreePath)) throw new Error(`lane worktree path already exists: ${worktreePath}`)
  if (listed.some(item => item.branch === branch)) throw new Error(`lane branch is already attached to another worktree: ${branch}`)
  if (await branchExists(seam, repoPath, branch)) throw new Error(`lane branch already exists without a matching worktree: ${branch}`)
  await fetchOriginBase(seam, repoPath, base)
  await ensureOriginBase(seam, repoPath, base)
  // Creating the ref is atomic and fails if anyone already holds the name, so
  // succeeding here *is* the ownership proof: everything cleaned up afterwards
  // is provably this attempt's, with no inference from what happens to be
  // registered at the time.
  try {
    await execGit(seam, repoPath, ['branch', branch, `origin/${base}`], { timeout: LOCAL_GIT_TIMEOUT_MS })
  } catch {
    throw new Error(`lane branch already exists without a matching worktree: ${branch}`)
  }
  let worktreeAdded = false
  try {
    await execGit(seam, repoPath, ['worktree', 'add', worktreePath, branch], { timeout: CHECKOUT_GIT_TIMEOUT_MS })
    worktreeAdded = true
    await ensureCleanWorktree(seam, worktreePath, `provisioned lane worktree is unexpectedly dirty: ${worktreePath}`)
  } catch (error) {
    await discardOwnedWorktree(seam, repoPath, branch, worktreePath, worktreeAdded)
    throw error
  }
  return { branch, worktreePath, reused: false }
}

// Creating the ref proved ownership of the branch, and nothing else. The path
// is only this attempt's if this attempt's `worktree add` is what registered it;
// a failed add leaves an ambiguous directory that may be a contender's live
// lane, uncommitted work and all, so it is never force-removed.
async function discardOwnedWorktree(seam: SpawnSeam, repoPath: string, branch: string, worktreePath: string, worktreeAdded: boolean) {
  // Removing a worktree deletes a checkout — repository-sized work, not a local
  // query — so it gets the checkout timeout; a 5-second bound would strand the
  // path on a large repo and make every retry fail on the leftover directory.
  if (worktreeAdded) await quietGit(seam, repoPath, ['worktree', 'remove', '--force', worktreePath], CHECKOUT_GIT_TIMEOUT_MS)
  await quietGit(seam, repoPath, ['worktree', 'prune'])
  await quietGit(seam, repoPath, ['branch', '-D', branch])
}

async function quietGit(seam: SpawnSeam, cwd: string, args: string[], timeout = LOCAL_GIT_TIMEOUT_MS) {
  try {
    await execGit(seam, cwd, args, { timeout })
  } catch {}
}

async function reusedWorktree(seam: SpawnSeam, worktree: ListedWorktree, expectedBranch: string): Promise<WorktreeProvisionResult> {
  if (worktree.prunable) throw new Error(`lane worktree registration is stale and must be pruned before reuse: ${worktree.path}`)
  if (worktree.branch !== expectedBranch) throw new Error(`lane worktree path is already registered for ${worktree.branch || 'detached HEAD'}: ${worktree.path}`)
  await ensureCleanWorktree(seam, worktree.path, `lane worktree has uncommitted changes: ${worktree.path}`)
  return { branch: expectedBranch, worktreePath: worktree.path, reused: true }
}

// Provisioning runs only against the main checkout: pointing it at a worktree
// would nest worktrees and confuse every listing that follows. A linked
// worktree looks like a repository root to `--show-toplevel`, so the test is
// whether its git dir *is* the common one.
async function resolveMainCheckout(repoPath: string, seam: SpawnSeam) {
  const resolved = path.resolve(repoPath)
  const root = await git(seam, resolved, ['rev-parse', '--show-toplevel'])
  if (!samePath(root, resolved)) throw new Error(`main checkout mismatch: expected ${resolved}, got ${root}`)
  const gitDir = path.resolve(resolved, await git(seam, resolved, ['rev-parse', '--absolute-git-dir']))
  const commonDir = path.resolve(resolved, await git(seam, resolved, ['rev-parse', '--git-common-dir']))
  if (!samePath(gitDir, commonDir)) throw new Error(`provisioning requires the main checkout, not a linked worktree: ${resolved}`)
  return { repoPath: resolved, commonDir }
}

async function validateBranch(seam: SpawnSeam, repoPath: string, branch: string) {
  let checked = ''
  try {
    checked = await git(seam, repoPath, ['check-ref-format', '--branch', branch])
  } catch {
    throw new Error(`invalid git branch name: ${branch}`)
  }
  if (checked !== branch) throw new Error(`invalid git branch name: ${branch}`)
}

function validateBranchName(base: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(base) || base.includes('..')) {
    throw new Error(`invalid base branch name: ${base}`)
  }
}

async function branchExists(seam: SpawnSeam, repoPath: string, branch: string) {
  try {
    await execGit(seam, repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { timeout: LOCAL_GIT_TIMEOUT_MS })
    return true
  } catch (error) {
    if (timedOut(error)) throw new Error('unable to check lane branch before provisioning')
    return false
  }
}

// The explicit refspec updates the remote-tracking ref in every clone shape:
// a narrow fetch refspec (single-branch clone) would otherwise leave
// refs/remotes/origin/<base> stale or absent and provision from an old commit.
async function fetchOriginBase(seam: SpawnSeam, repoPath: string, base: string) {
  try {
    await execGit(seam, repoPath, ['fetch', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], { timeout: FETCH_GIT_TIMEOUT_MS })
  } catch {
    throw new Error(`unable to fetch origin/${base} before provisioning`)
  }
}

async function ensureOriginBase(seam: SpawnSeam, repoPath: string, base: string) {
  try {
    await execGit(seam, repoPath, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`], { timeout: LOCAL_GIT_TIMEOUT_MS })
  } catch {
    throw new Error(`missing refs/remotes/origin/${base} after fetch`)
  }
}

async function ensureCleanWorktree(seam: SpawnSeam, worktreePath: string, message: string) {
  const dirty = await git(seam, worktreePath, ['status', '--short', '--untracked-files=all'])
  if (dirty) throw new Error(message)
}

async function listedWorktrees(seam: SpawnSeam, repoPath: string) {
  const output = await git(seam, repoPath, ['worktree', 'list', '--porcelain', '-z'], false)
  return output.split('\u0000\u0000').filter(Boolean).map(parseWorktreeBlock)
}

function parseWorktreeBlock(block: string): ListedWorktree {
  const lines = block.split('\u0000').filter(Boolean)
  const worktreePath = fieldValue(lines, 'worktree')
  if (!worktreePath) throw new Error('unparseable git worktree list output')
  const branchRef = fieldValue(lines, 'branch')
  return {
    path: worktreePath,
    ...(branchRef?.startsWith('refs/heads/') ? { branch: branchRef.slice('refs/heads/'.length) } : {}),
    prunable: lines.some(line => line.startsWith('prunable ')),
  }
}

function fieldValue(lines: string[], name: string) {
  return lines.find(line => line.startsWith(`${name} `))?.slice(name.length + 1).trim()
}

async function git(seam: SpawnSeam, cwd: string, args: string[], trim = true) {
  try {
    const stdout = await execGit(seam, cwd, args, { timeout: LOCAL_GIT_TIMEOUT_MS })
    return trim ? stdout.trim() : stdout
  } catch {
    throw new Error(`git command failed in ${cwd}: git ${args.join(' ')}`)
  }
}

function samePath(left: string, right: string) {
  return path.resolve(left) === path.resolve(right)
}

function timedOut(error: unknown) {
  if (typeof error !== 'object' || error === null) return false
  const failure = error as { killed?: unknown; signal?: unknown }
  return failure.killed === true || failure.signal === 'SIGTERM'
}

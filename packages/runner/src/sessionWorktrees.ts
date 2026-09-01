import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { SessionLaunchTarget } from '@modulastack/runner-protocol'
import type { Grants } from './consent.js'
import type {
  LocalFileIdentity,
  SessionBranchCreatedSnapshot,
  SessionBranchEvidence,
  SessionProjectSnapshot,
  SessionRegistrationEvidence,
  SessionWorktreePort,
  SessionWorktreeRegisteredSnapshot,
  SessionWorktreeSnapshot,
  SessionWorktreeVerifiedSnapshot,
} from './sessionLaunch.js'
import type { SpawnSeam } from './spawnSeam.js'
import { deterministicWorktreePath } from './worktrees.js'

const run = promisify(execFile)
const LOCAL_TIMEOUT_MS = 5_000
const FETCH_TIMEOUT_MS = 30_000
const CHECKOUT_TIMEOUT_MS = 120_000
const MAX_QUEUED_OPERATIONS = 32

export type SessionWorktreePortOptions = {
  seam: SpawnSeam
  grants: Grants
}

export function createSessionWorktreePort(options: SessionWorktreePortOptions): SessionWorktreePort {
  return {
    prepare: (project, target, signal) => prepare(options, project, target, signal),
    register: (snapshot, project, target, signal) => register(options, snapshot, project, target, signal),
    verify: (snapshot, relativeCwd, signal) => verify(options, snapshot, relativeCwd, signal),
    inspect: snapshot => inspect(options, snapshot),
    rollback: snapshot => rollback(options, snapshot),
  }
}

async function prepare(
  options: SessionWorktreePortOptions,
  project: SessionProjectSnapshot,
  target: SessionLaunchTarget,
  signal: AbortSignal,
) {
  try {
    const checkout = await mainCheckout(options, project, signal)
    return await serialize(checkout.commonDir, async () => {
      if (signal.aborted) return failed('provision-failed')
      await validateBranch(options, checkout.repoPath, target.branch, signal)
      await validateBranch(options, checkout.repoPath, target.baseBranch, signal)
      const grantedRoot = await options.grants.resolveGrantedCwd(project.worktreesRoot)
      if (!grantedRoot || !samePath(grantedRoot, project.worktreesRoot)) return failed('path-not-granted')
      const worktreePath = deterministicWorktreePath(project.worktreesRoot, target.worktreeName)
      const listed = await listedWorktrees(options, checkout.repoPath, signal)
      const existing = listed.find(worktree => samePath(worktree.path, worktreePath))
      await fetchBase(options, checkout.repoPath, target.baseBranch, signal)
      const expectedBaseCommit = await git(options, checkout.repoPath, ['rev-parse', `refs/remotes/origin/${target.baseBranch}`], signal)
      if (existing) {
        if (existing.prunable || existing.locked || existing.branch !== target.branch) return failed('worktree-conflict')
        const evidence = await branchEvidence(options, existing.path, target, checkout.commonDir, expectedBaseCommit, signal)
        await ensureClean(options, existing.path, signal)
        return { status: 'ready' as const, snapshot: await registeredSnapshot(options, evidence, existing.path, 'reused', signal) }
      }
      if (await exists(worktreePath) || listed.some(worktree => worktree.branch === target.branch)) return failed('worktree-conflict')
      if (await refExists(options, checkout.repoPath, `refs/heads/${target.branch}`, signal)) return failed('worktree-conflict')
      try {
        await git(options, checkout.repoPath, ['branch', target.branch, `refs/remotes/origin/${target.baseBranch}`], signal)
      } catch {
        if (!(await exactBranch(options, checkout.repoPath, target.branch, expectedBaseCommit))) return failed('provision-failed')
      }
      const evidence: SessionBranchEvidence = {
        branch: target.branch,
        branchRef: `refs/heads/${target.branch}`,
        baseBranch: target.baseBranch,
        headCommit: await git(options, checkout.repoPath, ['rev-parse', `refs/heads/${target.branch}`]),
        expectedBaseCommit,
        gitCommonDir: checkout.commonDir,
      }
      if (signal.aborted) {
        if (!(await deleteExactBranch(options, checkout.repoPath, evidence.branchRef, evidence.headCommit))) {
          throw new WorktreeError('provision-failed')
        }
        return failed('provision-failed')
      }
      return {
        status: 'ready' as const,
        snapshot: { phase: 'branch-created' as const, ownership: 'created' as const, ...evidence },
      }
    })
  } catch (error) {
    return failed(reasonOf(error))
  }
}

async function register(
  options: SessionWorktreePortOptions,
  snapshot: SessionBranchCreatedSnapshot,
  project: SessionProjectSnapshot,
  target: SessionLaunchTarget,
  signal: AbortSignal,
) {
  try {
    const checkout = await mainCheckout(options, project, signal)
    return await serialize(checkout.commonDir, async () => {
      if (!samePath(snapshot.gitCommonDir, checkout.commonDir) || snapshot.branch !== target.branch || snapshot.baseBranch !== target.baseBranch) {
        return failed('worktree-conflict')
      }
      if (!(await exactBranch(options, checkout.repoPath, snapshot.branch, snapshot.headCommit))) return failed('worktree-conflict')
      const grantedRoot = await options.grants.resolveGrantedCwd(project.worktreesRoot)
      if (!grantedRoot || !samePath(grantedRoot, project.worktreesRoot)) return failed('path-not-granted')
      const worktreePath = deterministicWorktreePath(project.worktreesRoot, target.worktreeName)
      let listed = await listedWorktrees(options, checkout.repoPath, signal)
      const existing = listed.find(worktree => samePath(worktree.path, worktreePath))
      if (existing) {
        if (existing.prunable || existing.locked || existing.branch !== snapshot.branch) return failed('worktree-conflict')
        const registered = await registeredSnapshot(options, snapshot, worktreePath, 'created')
        if (!signal.aborted) return { status: 'ready' as const, snapshot: registered }
        if (!(await cleanupAbortedRegistration(options, checkout.repoPath, worktreePath, snapshot.branch))) {
          throw new WorktreeError('provision-failed')
        }
        return failed('provision-failed')
      }
      if (await exists(worktreePath) || listed.some(worktree => worktree.branch === snapshot.branch)) return failed('worktree-conflict')
      try {
        await git(options, checkout.repoPath, ['worktree', 'add', worktreePath, snapshot.branch], signal, CHECKOUT_TIMEOUT_MS)
      } catch {
        // Interrupted add has no documented rollback point; only the post-signal Git listing is authoritative.
      }
      try {
        listed = await listedWorktrees(options, checkout.repoPath)
        const committed = listed.filter(worktree => samePath(worktree.path, worktreePath) && worktree.branch === snapshot.branch)
        if (committed.length !== 1 || committed[0]!.prunable || committed[0]!.locked) throw new Error('registration not exact')
        const registered = await registeredSnapshot(options, snapshot, worktreePath, 'created')
        if (!signal.aborted) return { status: 'ready' as const, snapshot: registered }
        if (!(await cleanupAbortedRegistration(options, checkout.repoPath, worktreePath, snapshot.branch))) {
          return failed('recovery-uncertain')
        }
        return failed('provision-failed')
      } catch {
        const cleaned = await cleanupAbortedRegistration(options, checkout.repoPath, worktreePath, snapshot.branch)
        return failed(cleaned ? 'provision-failed' : 'recovery-uncertain')
      }
    })
  } catch (error) {
    return failed(reasonOf(error))
  }
}

async function verify(
  options: SessionWorktreePortOptions,
  snapshot: SessionWorktreeRegisteredSnapshot,
  relativeCwd: string,
  signal: AbortSignal,
) {
  if (signal.aborted) return failed('provision-failed')
  const inspected = await inspect(options, snapshot)
  if (inspected !== 'exact') return failed('worktree-invalid')
  try {
    await ensureClean(options, snapshot.worktreePath, signal)
    const resolvedCwdPath = await realpath(path.resolve(snapshot.worktreePath, relativeCwd))
    if (!contained(snapshot.worktreePath, resolvedCwdPath)) return failed('worktree-invalid')
    const granted = await options.grants.resolveGrantedCwd(resolvedCwdPath)
    if (!granted || !samePath(granted, resolvedCwdPath)) return failed('path-not-granted')
    const resolvedCwdIdentity = await fileIdentity(resolvedCwdPath)
    if (signal.aborted) return failed('provision-failed')
    const verified: SessionWorktreeVerifiedSnapshot = {
      ...snapshot,
      phase: 'verified',
      relativeCwd,
      resolvedCwdPath,
      resolvedCwdIdentity,
      clean: true,
    }
    return { status: 'ready' as const, snapshot: verified }
  } catch (error) {
    return failed(reasonOf(error))
  }
}

async function inspect(options: SessionWorktreePortOptions, snapshot: SessionWorktreeSnapshot): Promise<'exact' | 'missing' | 'mismatch'> {
  if (snapshot.phase === 'none') return 'exact'
  try {
    const repoPath = path.dirname(snapshot.gitCommonDir)
    if (!(await refExists(options, repoPath, snapshot.branchRef))) return 'missing'
    if (!(await exactBranch(options, repoPath, snapshot.branch, snapshot.headCommit))) return 'mismatch'
    if (snapshot.phase === 'branch-created') return 'exact'
    if (!(await sameIdentity(snapshot.worktreePath, snapshot.worktreeIdentity))) return await exists(snapshot.worktreePath) ? 'mismatch' : 'missing'
    if (!(await sameIdentity(path.join(snapshot.worktreePath, '.git'), snapshot.gitEntryIdentity))) return 'mismatch'
    const gitDir = path.resolve(await git(options, snapshot.worktreePath, ['rev-parse', '--absolute-git-dir']))
    const commonDir = path.resolve(await git(options, snapshot.worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
    const branchRef = await git(options, snapshot.worktreePath, ['symbolic-ref', '-q', 'HEAD'])
    if (!samePath(gitDir, snapshot.worktreeGitDir) || !samePath(commonDir, snapshot.gitCommonDir) || branchRef !== snapshot.branchRef) return 'mismatch'
    if (snapshot.phase === 'worktree-registered') return 'exact'
    if (!(await sameIdentity(snapshot.resolvedCwdPath, snapshot.resolvedCwdIdentity))) return 'mismatch'
    return contained(snapshot.worktreePath, await realpath(snapshot.resolvedCwdPath)) ? 'exact' : 'mismatch'
  } catch {
    return 'mismatch'
  }
}

async function rollback(options: SessionWorktreePortOptions, snapshot: SessionWorktreeSnapshot) {
  if (snapshot.phase === 'none') return 'rolled-back' as const
  if ('ownership' in snapshot && snapshot.ownership === 'reused') return 'not-owned' as const
  const state = await inspect(options, snapshot)
  if (state === 'mismatch') return 'uncertain' as const
  if (state === 'missing') return snapshot.phase === 'branch-created' ? 'rolled-back' as const : 'uncertain' as const
  const repoPath = path.dirname(snapshot.gitCommonDir)
  try {
    return await serialize(snapshot.gitCommonDir, async () => {
      if (snapshot.phase !== 'branch-created') {
        const listed = await listedWorktrees(options, repoPath)
        const owned = listed.find(worktree => samePath(worktree.path, snapshot.worktreePath) && worktree.branch === snapshot.branch)
        if (!owned || owned.locked || owned.prunable) throw new WorktreeError('provision-failed')
        await ensureClean(options, snapshot.worktreePath)
        await git(options, repoPath, ['worktree', 'remove', '--force', snapshot.worktreePath], undefined, CHECKOUT_TIMEOUT_MS)
        await quietGit(options, repoPath, ['worktree', 'prune'])
        if ((await listedWorktrees(options, repoPath)).some(worktree => worktree.branch === snapshot.branch)) {
          throw new WorktreeError('provision-failed')
        }
      }
      await git(options, repoPath, ['update-ref', '-d', snapshot.branchRef, snapshot.headCommit])
      return 'rolled-back' as const
    })
  } catch {
    return 'uncertain' as const
  }
}

async function mainCheckout(options: SessionWorktreePortOptions, project: SessionProjectSnapshot, signal?: AbortSignal) {
  const repoPath = await ownedDirectory(project.repoPath)
  if (!repoPath) throw new WorktreeError('worktree-invalid')
  if (!(await ownedDirectory(project.worktreesRoot))) throw new WorktreeError('path-not-granted')
  const root = await git(options, repoPath, ['rev-parse', '--show-toplevel'], signal)
  if (!samePath(root, repoPath)) throw new WorktreeError('worktree-invalid')
  const gitDir = path.resolve(repoPath, await git(options, repoPath, ['rev-parse', '--absolute-git-dir'], signal))
  const commonDir = path.resolve(await git(options, repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal))
  if (!samePath(gitDir, commonDir) || !samePath(commonDir, path.join(repoPath, '.git'))) {
    throw new WorktreeError('worktree-invalid')
  }
  return { repoPath, commonDir }
}

async function branchEvidence(
  options: SessionWorktreePortOptions,
  worktreePath: string,
  target: SessionLaunchTarget,
  commonDir: string,
  expectedBaseCommit: string,
  signal?: AbortSignal,
): Promise<SessionBranchEvidence> {
  return {
    branch: target.branch,
    branchRef: `refs/heads/${target.branch}`,
    baseBranch: target.baseBranch,
    headCommit: await git(options, worktreePath, ['rev-parse', 'HEAD'], signal),
    expectedBaseCommit,
    gitCommonDir: commonDir,
  }
}

async function registeredSnapshot(
  options: SessionWorktreePortOptions,
  evidence: SessionBranchEvidence,
  worktreePath: string,
  ownership: 'created' | 'reused',
  signal?: AbortSignal,
): Promise<SessionWorktreeRegisteredSnapshot> {
  const resolvedWorktreePath = await realpath(worktreePath)
  const worktreeGitDir = path.resolve(await git(options, resolvedWorktreePath, ['rev-parse', '--absolute-git-dir'], signal))
  const registration: SessionRegistrationEvidence = {
    ownership,
    worktreePath: resolvedWorktreePath,
    worktreeIdentity: await fileIdentity(worktreePath),
    worktreeGitDir,
    gitEntryIdentity: await fileIdentity(path.join(worktreePath, '.git')),
  }
  return { ...evidence, phase: 'worktree-registered', ...registration }
}

async function fetchBase(options: SessionWorktreePortOptions, repoPath: string, base: string, signal: AbortSignal) {
  await git(options, repoPath, ['fetch', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], signal, FETCH_TIMEOUT_MS)
}

async function validateBranch(options: SessionWorktreePortOptions, repoPath: string, branch: string, signal: AbortSignal) {
  if (branch.startsWith('-') || branch.startsWith('@{')) throw new WorktreeError('worktree-invalid')
  const checked = await git(options, repoPath, ['check-ref-format', '--branch', branch], signal)
  if (checked !== branch) throw new WorktreeError('worktree-invalid')
}

async function exactBranch(options: SessionWorktreePortOptions, repoPath: string, branch: string, head: string) {
  try {
    return await git(options, repoPath, ['rev-parse', `refs/heads/${branch}`]) === head
  } catch {
    return false
  }
}

async function deleteExactBranch(
  options: SessionWorktreePortOptions,
  repoPath: string,
  branchRef: string,
  expectedHead: string,
): Promise<boolean> {
  if ((await listedWorktrees(options, repoPath)).some(worktree => worktree.branch && `refs/heads/${worktree.branch}` === branchRef)) return false
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!(await refExists(options, repoPath, branchRef))) return true
    try {
      await git(options, repoPath, ['update-ref', '-d', branchRef, expectedHead])
    } catch {
      // A transient Git ref lock may clear before the next bounded exact-CAS attempt.
    }
  }
  return !(await refExists(options, repoPath, branchRef))
}

async function cleanupAbortedRegistration(
  options: SessionWorktreePortOptions,
  repoPath: string,
  worktreePath: string,
  branch: string,
): Promise<boolean> {
  try {
    const listed = await listedWorktrees(options, repoPath)
    const exact = listed.filter(worktree => samePath(worktree.path, worktreePath) && worktree.branch === branch)
    if (exact.length !== 1 || exact[0]!.locked || exact[0]!.prunable) return false
    await git(options, repoPath, ['worktree', 'remove', '--force', worktreePath], undefined, CHECKOUT_TIMEOUT_MS)
    await quietGit(options, repoPath, ['worktree', 'prune'])
    const remaining = await listedWorktrees(options, repoPath)
    return !remaining.some(worktree => samePath(worktree.path, worktreePath) || worktree.branch === branch)
  } catch {
    return false
  }
}

async function refExists(options: SessionWorktreePortOptions, repoPath: string, ref: string, signal?: AbortSignal) {
  if (signal?.aborted) throw new WorktreeError('provision-failed')
  const result = await options.seam.run(
    { kind: 'git', executable: 'git', args: ['show-ref', '--verify', '--quiet', ref], cwd: repoPath, grantScoped: false },
    async vetted => {
      try {
        await run(vetted.command, [...vetted.args], { cwd: repoPath, encoding: 'utf8', timeout: LOCAL_TIMEOUT_MS, signal })
        return { outcome: { exitCode: 0 as const, signal: null }, value: true }
      } catch (error) {
        if (processExitCode(error) === 1) return { outcome: { exitCode: 0 as const, signal: null }, value: false }
        throw error
      }
    },
  )
  if (result.status === 'refused') throw new WorktreeError('provision-failed')
  return result.value
}

function processExitCode(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null
  return typeof error.code === 'number' ? error.code : null
}

async function ensureClean(options: SessionWorktreePortOptions, worktreePath: string, signal?: AbortSignal) {
  if (await git(options, worktreePath, ['status', '--short', '--untracked-files=all'], signal)) throw new WorktreeError('worktree-conflict')
}

type ListedWorktree = { path: string; branch?: string; prunable: boolean; locked: boolean }

async function listedWorktrees(options: SessionWorktreePortOptions, repoPath: string, signal?: AbortSignal): Promise<ListedWorktree[]> {
  const output = await git(options, repoPath, ['worktree', 'list', '--porcelain', '-z'], signal, LOCAL_TIMEOUT_MS, false)
  return output.split('\u0000\u0000').filter(Boolean).map(block => {
    const lines = block.split('\u0000').filter(Boolean)
    const worktreePath = lines.find(line => line.startsWith('worktree '))?.slice(9)
    const branchRef = lines.find(line => line.startsWith('branch '))?.slice(7)
    if (!worktreePath) throw new WorktreeError('worktree-invalid')
    return {
      path: worktreePath,
      ...(branchRef?.startsWith('refs/heads/') ? { branch: branchRef.slice(11) } : {}),
      prunable: lines.some(line => line.startsWith('prunable ')),
      locked: lines.some(line => line === 'locked' || line.startsWith('locked ')),
    }
  })
}

async function git(
  options: SessionWorktreePortOptions,
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  timeout = LOCAL_TIMEOUT_MS,
  trim = true,
): Promise<string> {
  if (signal?.aborted) throw new WorktreeError('provision-failed')
  const result = await options.seam.run(
    { kind: 'git', executable: 'git', args, cwd, grantScoped: false },
    async vetted => {
      const output = await run(vetted.command, [...vetted.args], { cwd, encoding: 'utf8', timeout, signal })
      return { outcome: { exitCode: 0 as const, signal: null }, value: output.stdout }
    },
  )
  if (result.status === 'refused') throw new WorktreeError('provision-failed')
  return trim ? result.value.trim() : result.value
}

async function quietGit(options: SessionWorktreePortOptions, cwd: string, args: string[]) {
  try {
    await git(options, cwd, args)
  } catch {
    // Rollback continues through every owned cleanup step; the final exact inspection decides certainty.
  }
}

async function ownedDirectory(target: string): Promise<string | null> {
  try {
    const lexical = await lstat(target)
    if (!lexical.isDirectory() || lexical.isSymbolicLink() || lexical.uid !== process.getuid?.()) return null
    const resolved = await realpath(target)
    return samePath(resolved, target) ? resolved : null
  } catch {
    return null
  }
}

async function fileIdentity(target: string): Promise<LocalFileIdentity> {
  const info = await lstat(target, { bigint: true })
  return { device: info.dev.toString(), inode: info.ino.toString() }
}

async function sameIdentity(target: string, expected: LocalFileIdentity): Promise<boolean> {
  try {
    const identity = await fileIdentity(target)
    return identity.device === expected.device && identity.inode === expected.inode
  } catch {
    return false
  }
}

async function exists(target: string): Promise<boolean> {
  return await lstat(target).then(() => true, () => false)
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function samePath(left: string, right: string): boolean {
  return canonicalPathText(left) === canonicalPathText(right)
}

function canonicalPathText(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'darwin' ? resolved.replace(/^\/private\/var\//, '/var/') : resolved
}

function failed(reason: 'path-not-granted' | 'worktree-invalid' | 'worktree-conflict' | 'provision-failed' | 'recovery-uncertain') {
  return { status: 'failed' as const, reason }
}

class WorktreeError extends Error {
  constructor(readonly reason: 'path-not-granted' | 'worktree-invalid' | 'worktree-conflict' | 'provision-failed') {
    super(reason)
  }
}

function reasonOf(error: unknown) {
  return error instanceof WorktreeError ? error.reason : 'provision-failed' as const
}

const queues = new Map<string, Promise<unknown>>()
const depths = new Map<string, number>()

async function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const depth = depths.get(key) ?? 0
  if (depth >= MAX_QUEUED_OPERATIONS) throw new WorktreeError('provision-failed')
  depths.set(key, depth + 1)
  const previous = queues.get(key) ?? Promise.resolve()
  const current = previous.then(operation, operation)
  const settled = current.then(() => undefined, () => undefined)
  queues.set(key, settled)
  try {
    return await current
  } finally {
    const remaining = (depths.get(key) ?? 1) - 1
    if (remaining) depths.set(key, remaining)
    else depths.delete(key)
    if (queues.get(key) === settled) queues.delete(key)
  }
}

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, SESSION_LAUNCH_PROTOCOL_VERSION, type SessionStartMessage } from '@modulastack/runner-protocol'
import {
  MAX_FULL_SESSION_RECEIPTS,
  MAX_IN_FLIGHT_SESSION_RECEIPTS,
  MAX_SESSION_LEDGER_JSON_DEPTH,
  MAX_SESSION_LEDGER_JSON_NODES,
  MAX_SESSION_RECEIPT_JSON_NODES,
  MAX_SESSION_TOMBSTONES,
  PAIRING_CONTRACT_FAILURES,
  SESSION_LAUNCH_STORAGE_UNAVAILABLE,
  SESSION_RECEIPT_SCHEMA_VERSION,
  PairingContractError,
  PairingContractNotImplementedError,
  SessionLaunchNotImplementedError,
  createUnimplementedPairingContractService,
  createUnimplementedSessionLauncher,
  type SessionLaunchAction,
  type SessionReceipt,
  type SessionWorktreeSnapshot,
} from '../src/index.js'
import { openAuditLogFixture } from './appendOnlyAuditFixture.js'

const roots: string[] = []
const request: SessionStartMessage = {
  type: 'SESSION_START',
  bindingId: '123e4567-e89b-42d3-a456-426614174000',
  requestId: '223e4567-e89b-42d3-a456-426614174001',
  expiresAt: '2026-08-22T12:00:00Z',
  terminalProfile: 'coder',
  modelProfileId: 'daily',
  target: { projectId: 'modulastack', worktreeName: 'lane-01', branch: 'feat/lane-01', baseBranch: 'main', relativeCwd: '.' },
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function next(actions: AsyncIterable<SessionLaunchAction>) {
  return await actions[Symbol.asyncIterator]().next()
}

describe('session-launch interface checkpoint', () => {
  it('keeps the explicit unimplemented launcher fail-closed after v2 activation', async () => {
    expect(PROTOCOL_VERSION).toBe(2)
    expect(SESSION_LAUNCH_PROTOCOL_VERSION).toBe(PROTOCOL_VERSION)
    const launcher = createUnimplementedSessionLauncher()
    await expect(next(launcher.handle(request))).rejects.toBeInstanceOf(SessionLaunchNotImplementedError)
    await expect(next(launcher.recover())).rejects.toBeInstanceOf(SessionLaunchNotImplementedError)
  })

  it('exposes storage failure as a connection action rather than a session result', () => {
    const action: SessionLaunchAction = { kind: 'close-job-control', error: SESSION_LAUNCH_STORAGE_UNAVAILABLE }
    expect(action).toEqual({ kind: 'close-job-control', error: 'storage-unavailable' })
    expect(action).not.toHaveProperty('message.type')
  })

  it('publishes the adopted pairing port without activating the legacy runtime', async () => {
    expect(PAIRING_CONTRACT_FAILURES).toContain('pairing-in-progress')
    expect(PAIRING_CONTRACT_FAILURES).toContain('confirmation-uncertain')
    expect(new PairingContractError('confirmation-uncertain', 'unknown result').failure).toBe('confirmation-uncertain')
    const pairing = createUnimplementedPairingContractService()
    await expect(pairing.snapshot()).rejects.toBeInstanceOf(PairingContractNotImplementedError)
    await expect(pairing.resumeConfirmation()).rejects.toBeInstanceOf(PairingContractNotImplementedError)
  })

  it('journals only the recovery evidence available at each worktree phase', () => {
    const branchEvidence = {
      branch: 'feat/lane-01',
      branchRef: 'refs/heads/feat/lane-01',
      baseBranch: 'main',
      headCommit: 'a'.repeat(40),
      expectedBaseCommit: 'b'.repeat(40),
      gitCommonDir: '/repo/.git',
    }
    const registrationEvidence = {
      ownership: 'created' as const,
      worktreePath: '/worktrees/lane-01',
      worktreeIdentity: { device: '8', inode: '101' },
      worktreeGitDir: '/repo/.git/worktrees/lane-01',
      gitEntryIdentity: { device: '8', inode: '102' },
    }
    const snapshots: SessionWorktreeSnapshot[] = [
      { phase: 'none' },
      { phase: 'branch-created', ownership: 'created', ...branchEvidence },
      { phase: 'worktree-registered', ...branchEvidence, ...registrationEvidence },
      {
        phase: 'verified',
        ...branchEvidence,
        ...registrationEvidence,
        relativeCwd: '.',
        resolvedCwdPath: '/worktrees/lane-01',
        resolvedCwdIdentity: { device: '8', inode: '101' },
        clean: true,
      },
    ]
    type WorktreeIsRequired = {} extends Pick<SessionReceipt, 'worktree'> ? false : true
    const worktreeIsRequired: WorktreeIsRequired = true
    expect(snapshots.map(snapshot => snapshot.phase)).toEqual([
      'none',
      'branch-created',
      'worktree-registered',
      'verified',
    ])
    expect(snapshots[1]).not.toHaveProperty('worktreePath')
    expect(snapshots[2]).not.toHaveProperty('clean')
    expect(snapshots[3]).toHaveProperty('clean', true)
    expect(worktreeIsRequired).toBe(true)
  })

  it('publishes the approved global receipt bounds', () => {
    expect(SESSION_RECEIPT_SCHEMA_VERSION).toBe(1)
    expect(MAX_IN_FLIGHT_SESSION_RECEIPTS).toBe(32)
    expect(MAX_FULL_SESSION_RECEIPTS).toBe(4_096)
    expect(MAX_SESSION_TOMBSTONES).toBe(32_768)
    expect(MAX_SESSION_LEDGER_JSON_DEPTH).toBe(64)
    expect(MAX_SESSION_RECEIPT_JSON_NODES).toBe(8_192)
    expect(MAX_SESSION_LEDGER_JSON_NODES).toBe(1_000_000)
  })

  it('reuses the durable audit writer for session-launch interface records', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'runner-launch-interface-'))
    roots.push(root)
    const auditPath = path.join(root, 'audit.jsonl')
    const audit = openAuditLogFixture({ path: auditPath })
    await audit.append({
      kind: 'session-launch',
      key: { bindingId: request.bindingId, requestId: request.requestId },
      state: 'accepted',
      at: '2026-08-21T13:00:00Z',
    })
    expect(JSON.parse((await readFile(auditPath, 'utf8')).trim())).toEqual({
      kind: 'session-launch',
      key: { bindingId: request.bindingId, requestId: request.requestId },
      state: 'accepted',
      at: '2026-08-21T13:00:00Z',
    })
  })
})

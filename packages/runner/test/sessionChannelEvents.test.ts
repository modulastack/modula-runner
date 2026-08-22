import { describe, expect, it } from 'vitest'
import {
  createSessionChannelEventCoordinator,
  type SessionChannelEvent,
  type SessionReceipt,
  type SessionReceiptLedger,
} from '../src/index.js'

const key = {
  bindingId: '123e4567-e89b-42d3-a456-426614174000',
  requestId: '223e4567-e89b-42d3-a456-426614174000',
}

function receipt(): SessionReceipt {
  return {
    schemaVersion: 1,
    revision: 2,
    key,
    fingerprint: 'a'.repeat(64),
    request: {
      type: 'SESSION_START',
      ...key,
      expiresAt: '2026-08-22T00:10:00Z',
      terminalProfile: 'coder',
      modelProfileId: 'daily',
      target: { projectId: 'project-1', worktreeName: 'lane', branch: 'feat/lane', baseBranch: 'main', relativeCwd: '.' },
    },
    state: 'started',
    phaseTimestamps: {
      accepted: '2026-08-22T00:00:00Z',
      provisioned: '2026-08-22T00:00:01Z',
      'spawn-intent': '2026-08-22T00:00:02Z',
      started: '2026-08-22T00:00:03Z',
    },
    worktree: {
      phase: 'verified', ownership: 'created', branch: 'feat/lane', branchRef: 'refs/heads/feat/lane', baseBranch: 'main',
      headCommit: 'a'.repeat(40), expectedBaseCommit: 'b'.repeat(40), gitCommonDir: '/projects/project-1/.git',
      worktreePath: '/worktrees/lane', worktreeIdentity: { device: '1', inode: '2' },
      worktreeGitDir: '/projects/project-1/.git/worktrees/lane', gitEntryIdentity: { device: '1', inode: '3' },
      relativeCwd: '.', resolvedCwdPath: '/worktrees/lane', resolvedCwdIdentity: { device: '1', inode: '2' }, clean: true,
    },
    sessionId: 'session-1',
    channel: { generation: 2, lifecycle: 'live', channelId: 'channel-current' },
    channelId: 'channel-current',
  }
}

function subject(initial: SessionReceipt | null = receipt(), auditFails = false) {
  let current = initial
  const order: string[] = []
  const receipts: SessionReceiptLedger = {
    lookup: async () => current ? { status: 'receipt', receipt: structuredClone(current) } : { status: 'missing' },
    claim: async () => ({ status: 'storage-unavailable' }),
    replace: async (expected, next) => {
      order.push('replace')
      if (!current || current.revision !== expected) return { status: 'conflict', current }
      current = { ...structuredClone(next), revision: expected + 1 }
      return { status: 'updated', receipt: structuredClone(current) }
    },
    recover: async () => current ? [structuredClone(current)] : [],
    compact: async () => undefined,
  }
  const coordinator = createSessionChannelEventCoordinator({
    receipts,
    audit: {
      append: async () => {
        order.push('audit')
        if (auditFails) throw new Error('audit unavailable')
      },
    },
    clock: { now: () => Date.parse('2026-08-22T00:01:00Z'), sleep: async () => undefined },
  })
  return { coordinator, current: () => current, order }
}

function event(overrides: { sessionId?: string; channelId?: string; generation?: number } = {}): SessionChannelEvent {
  return { kind: 'lost', key, sessionId: 'session-1', channelId: 'channel-current', generation: 2, ...overrides }
}

function terminalEvent(exitCode: number | null, signal: number | null): SessionChannelEvent {
  return { kind: 'terminal', key, sessionId: 'session-1', channelId: 'channel-current', generation: 2, exitCode, signal }
}

describe('generation-scoped channel events', () => {
  it('ignores a provably retired generation without mutating or auditing', async () => {
    const held = subject()
    await expect(held.coordinator.handle(event({ channelId: 'channel-retired', generation: 1 })))
      .resolves.toEqual({ status: 'retired' })
    expect(held.current()?.channel).toMatchObject({ generation: 2, lifecycle: 'live' })
    expect(held.order).toEqual([])
  })

  it('keeps an event unknown when no current receipt can classify it', async () => {
    const held = subject(null)
    await expect(held.coordinator.handle(event())).resolves.toEqual({ status: 'unknown' })
    expect(held.order).toEqual([])
  })

  it('persists and audits an exact current channel loss before reporting it applied', async () => {
    const held = subject()
    const result = await held.coordinator.handle(event())
    expect(result).toMatchObject({ status: 'applied', action: null })
    expect(held.current()?.channel).toEqual({ generation: 2, lifecycle: 'lost', channelId: 'channel-current' })
    expect(held.order).toEqual(['replace', 'audit'])
  })

  it('settles an exact terminal event and returns its action only after durable audit', async () => {
    const held = subject()
    const result = await held.coordinator.handle(terminalEvent(0, null))
    expect(result).toMatchObject({
      status: 'applied',
      action: { kind: 'message', message: { type: 'SESSION_FINISHED', exitCode: 0, signal: null } },
    })
    expect(held.current()).toMatchObject({ state: 'finished', channel: { lifecycle: 'closed' } })
    expect(held.order).toEqual(['replace', 'audit'])
  })

  it('returns storage-unavailable instead of an action when terminal audit fails', async () => {
    const held = subject(receipt(), true)
    await expect(held.coordinator.handle(terminalEvent(null, 15)))
      .resolves.toEqual({ status: 'storage-unavailable' })
    expect(held.current()).toMatchObject({ state: 'finished', result: { signal: 15 } })
    expect(held.order).toEqual(['replace', 'audit'])
  })
})

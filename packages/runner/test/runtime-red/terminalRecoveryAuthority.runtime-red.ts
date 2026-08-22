import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  RunnerClient,
  createSessionChannelEventCoordinator,
  createSessionTerminalPorts,
  type SessionReceipt,
  type SessionReceiptLedger,
} from '../../src/index.js'
import { permissiveSpawnSeam } from '../spawnSeamSupport.js'
import { StubControlPlane } from '../stubControlPlane.js'

const runner = { name: 'runtime-red', version: '0.1.0', os: process.platform, arch: process.arch }

describe('terminal recovery authority is intentionally red', () => {
  it('does not treat an unobserved channel as authoritatively lost', async () => {
    const controlPlane = await new StubControlPlane({ holdExitedChannels: true }).start()
    const client = new RunnerClient({ url: controlPlane.url, token: 'stub-token', runner, backoff: { baseMs: 20, capMs: 50 } })
    const connected = once(client, 'connected')
    client.connect()
    await connected
    const ports = createSessionTerminalPorts({ client, seam: permissiveSpawnSeam() })
    try {
      await expect(ports.recoveryChannels.status('unobserved-prior-channel', 1)).resolves.toBe('unknown')
    } finally {
      await ports.shutdown()
      client.stop()
      await controlPlane.stop()
    }
  })

  it('retains the terminal channel epoch in the durable terminal receipt', async () => {
    const key = { bindingId: '123e4567-e89b-42d3-a456-426614174000', requestId: '223e4567-e89b-42d3-a456-426614174000' }
    let current: SessionReceipt = {
      schemaVersion: 1,
      revision: 1,
      key,
      fingerprint: 'a'.repeat(64),
      request: {
        type: 'SESSION_START', ...key, expiresAt: '2026-08-22T00:10:00Z', terminalProfile: 'coder', modelProfileId: 'daily',
        target: { projectId: 'project-1', worktreeName: 'lane', branch: 'feat/lane', baseBranch: 'main', relativeCwd: '.' },
      },
      state: 'started',
      phaseTimestamps: { accepted: '2026-08-22T00:00:00Z', provisioned: '2026-08-22T00:00:01Z', 'spawn-intent': '2026-08-22T00:00:02Z', started: '2026-08-22T00:00:03Z' },
      worktree: {
        phase: 'verified', branch: 'feat/lane', branchRef: 'refs/heads/feat/lane', baseBranch: 'main', headCommit: 'a'.repeat(40), expectedBaseCommit: 'b'.repeat(40), gitCommonDir: '/projects/project-1/.git',
        ownership: 'created', worktreePath: '/worktrees/lane', worktreeIdentity: { device: '1', inode: '2' }, worktreeGitDir: '/projects/project-1/.git/worktrees/lane', gitEntryIdentity: { device: '1', inode: '3' },
        relativeCwd: '.', resolvedCwdPath: '/worktrees/lane', resolvedCwdIdentity: { device: '1', inode: '2' }, clean: true,
      },
      sessionId: 'session-1',
      channel: { generation: 2, lifecycle: 'live', channelId: 'channel-current', connectionEpoch: 'epoch-1' },
      channelId: 'channel-current',
    }
    const receipts: SessionReceiptLedger = {
      lookup: async () => ({ status: 'receipt', receipt: structuredClone(current) }),
      claim: async () => ({ status: 'storage-unavailable' }),
      replace: async (_revision, next) => {
        current = { ...structuredClone(next), revision: next.revision + 1 }
        return { status: 'updated', receipt: structuredClone(current) }
      },
      recover: async () => [],
      compact: async () => undefined,
    }
    const coordinator = createSessionChannelEventCoordinator({
      receipts,
      audit: { append: async () => undefined },
      clock: { now: () => Date.parse('2026-08-22T00:01:00Z'), sleep: async () => undefined },
    })

    await expect(coordinator.handle({ kind: 'terminal', key, sessionId: 'session-1', channelId: 'channel-current', generation: 2, exitCode: 0, signal: null }))
      .resolves.toMatchObject({ status: 'applied' })
    expect(current.channel).toMatchObject({ lifecycle: 'closed', connectionEpoch: 'epoch-1' })
  })
})

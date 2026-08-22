import { describe, expect, it, vi } from 'vitest'
import {
  SecretEnv,
  createSessionLauncher,
  createSessionReceiptLedger,
  type AuditRecord,
  type SessionLaunchAction,
  type SessionLauncherOptions,
  type SessionReceipt,
  type SessionReceiptLedgerImage,
  type SessionReceiptStorage,
} from '../src/index.js'
import { sessionStartFingerprint, type SessionStartMessage } from '@modulastack/runner-protocol'

const now = Date.parse('2026-08-21T00:00:00Z')
const nonExpiringClock = { now: () => now, sleep: async () => await new Promise<void>(() => undefined) }
const request: SessionStartMessage = {
  type: 'SESSION_START',
  bindingId: '123e4567-e89b-42d3-a456-426614174000',
  requestId: '223e4567-e89b-42d3-a456-426614174001',
  expiresAt: '2026-08-21T00:10:00Z',
  terminalProfile: 'coder',
  modelProfileId: 'daily',
  target: { projectId: 'modulastack', worktreeName: 'lane-01', branch: 'feat/lane-01', baseBranch: 'main', relativeCwd: '.' },
}
const project = { projectId: 'modulastack', repoPath: '/repos/modulastack', worktreesRoot: '/worktrees', revision: 1 }

function receiptStorage() {
  let image: SessionReceiptLedgerImage = { schemaVersion: 1, revision: 0, capacityBlockedUntil: null, receipts: [], tombstones: [] }
  const storage: SessionReceiptStorage = {
    load: async () => ({ status: 'loaded', image: structuredClone(image) }),
    replace: async (expectedRevision, next) => {
      if (expectedRevision !== image.revision) return { status: 'conflict', current: structuredClone(image) }
      image = { ...structuredClone(next), revision: expectedRevision + 1 }
      return { status: 'updated', image: structuredClone(image) }
    },
  }
  return { storage, image: () => structuredClone(image) }
}

function options(overrides: Partial<SessionLauncherOptions> = {}) {
  const held = receiptStorage()
  const clock = { now: () => now, sleep: async () => undefined }
  const audit: AuditRecord[] = []
  let processStarts = 0
  const base: SessionLauncherOptions = {
    bindingId: () => request.bindingId,
    projects: {
      create: async value => ({ ...value, revision: 1 }),
      list: async () => [project],
      get: async () => project,
      remove: async () => 'missing',
    },
    receipts: createSessionReceiptLedger({ storage: held.storage, clock }),
    access: {
      resolve: async modelProfileId => ({
        status: 'resolved',
        plan: {
          modelProfileId,
          access: 'subscription',
          runtime: 'claude',
          command: '/usr/bin/claude',
          args: ['--model', 'approved'],
          env: { RUNNER_MODE: '1' },
          secrets: SecretEnv.empty(),
        },
      }),
    },
    worktrees: {
      prepare: async () => ({
        status: 'ready',
        snapshot: {
          phase: 'branch-created', ownership: 'created', branch: 'feat/lane-01', branchRef: 'refs/heads/feat/lane-01',
          baseBranch: 'main', headCommit: 'a'.repeat(40), expectedBaseCommit: 'a'.repeat(40), gitCommonDir: '/repos/modulastack/.git',
        },
      }),
      register: async snapshot => ({
        status: 'ready',
        snapshot: {
          ...snapshot, phase: 'worktree-registered', worktreePath: '/worktrees/lane-01',
          worktreeIdentity: { device: '8', inode: '101' }, worktreeGitDir: '/repos/modulastack/.git/worktrees/lane-01',
          gitEntryIdentity: { device: '8', inode: '102' },
        },
      }),
      verify: async snapshot => ({
        status: 'ready',
        snapshot: {
          ...snapshot, phase: 'verified', relativeCwd: '.', resolvedCwdPath: '/worktrees/lane-01',
          resolvedCwdIdentity: { device: '8', inode: '101' }, clean: true,
        },
      }),
      inspect: async () => 'exact',
      rollback: async () => 'rolled-back',
    },
    channels: { open: async () => ({ status: 'opened', channelId: 'channel-1' }), close: async () => undefined },
    processes: {
      start: async value => {
        processStarts += 1
        return { status: 'started', handle: { sessionId: value.sessionId, finished: Promise.resolve({ exitCode: 0, signal: null }) } }
      },
      adopt: async value => ({ status: 'started', handle: { sessionId: value.sessionId, finished: Promise.resolve({ exitCode: 0, signal: null }) } }),
      inspect: async () => 'exact',
      terminate: async () => 'terminated',
    },
    identifiers: { nextSessionId: () => 'session-1' },
    audit: { append: async record => { audit.push(record) } },
    clock,
  }
  return {
    value: { ...base, ...overrides },
    held,
    audit,
    processStarts: () => processStarts,
  }
}

function trackWorktreeConcurrency(worktrees: SessionLauncherOptions['worktrees']) {
  let active = 0
  let maximum = 0
  const prepare: SessionLauncherOptions['worktrees']['prepare'] = async (...args) => {
    active += 1
    maximum = Math.max(maximum, active)
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      return await worktrees.prepare(...args)
    } finally {
      active -= 1
    }
  }
  return { worktrees: { ...worktrees, prepare }, maximum: () => maximum }
}

function recoveryReceipt(): SessionReceipt {
  return {
    schemaVersion: 1,
    revision: 3,
    key: { bindingId: request.bindingId, requestId: request.requestId },
    fingerprint: sessionStartFingerprint(request),
    request,
    state: 'spawn-intent',
    phaseTimestamps: {
      accepted: '2026-08-21T00:00:00Z',
      provisioned: '2026-08-21T00:00:01Z',
      'spawn-intent': '2026-08-21T00:00:02Z',
    },
    project,
    worktree: {
      phase: 'verified', ownership: 'created', branch: 'feat/lane-01', branchRef: 'refs/heads/feat/lane-01',
      baseBranch: 'main', headCommit: 'a'.repeat(40), expectedBaseCommit: 'a'.repeat(40), gitCommonDir: '/repos/modulastack/.git',
      worktreePath: '/worktrees/lane-01', worktreeIdentity: { device: '8', inode: '101' },
      worktreeGitDir: '/repos/modulastack/.git/worktrees/lane-01', gitEntryIdentity: { device: '8', inode: '102' },
      relativeCwd: '.', resolvedCwdPath: '/worktrees/lane-01', resolvedCwdIdentity: { device: '8', inode: '101' }, clean: true,
    },
    sessionId: 'session-stable',
    channelId: 'channel-old',
  }
}

function recoveryReceipts(receipt: SessionReceipt) {
  let current = structuredClone(receipt)
  return {
    value: {
      lookup: async () => ({ status: 'receipt' as const, receipt: structuredClone(current) }),
      claim: async () => ({ status: 'known' as const, value: structuredClone(current) }),
      replace: async (_revision: number, next: SessionReceipt) => {
        current = { ...structuredClone(next), revision: next.revision + 1 }
        return { status: 'updated' as const, receipt: structuredClone(current) }
      },
      recover: async () => [structuredClone(current)],
      compact: async () => undefined,
    },
    current: () => structuredClone(current),
  }
}

async function collect(values: AsyncIterable<SessionLaunchAction>) {
  const actions: SessionLaunchAction[] = []
  for await (const action of values) actions.push(action)
  return actions
}

describe('production session launcher', () => {
  it('persists and audits each externally visible lifecycle action without storing the launch plan', async () => {
    const subject = options()
    const launcher = createSessionLauncher(subject.value)
    await expect(collect(launcher.handle(request))).resolves.toEqual([
      { kind: 'message', message: { type: 'SESSION_ACCEPTED', requestId: request.requestId } },
      { kind: 'message', message: { type: 'SESSION_STARTED', requestId: request.requestId, channelId: 'channel-1', sessionId: 'session-1' } },
      { kind: 'message', message: { type: 'SESSION_FINISHED', requestId: request.requestId, exitCode: 0, signal: null } },
    ])
    expect(subject.audit.map(record => record.kind === 'session-launch' ? record.state : record.kind)).toEqual(['accepted', 'started', 'finished'])
    expect(subject.processStarts()).toBe(1)
    expect(JSON.stringify(subject.held.image())).not.toMatch(/\/usr\/bin\/claude|RUNNER_MODE|secrets/)
  })

  it('serializes distinct requests that target the same worktree lane', async () => {
    const subject = options()
    const tracked = trackWorktreeConcurrency(subject.value.worktrees)
    const launcher = createSessionLauncher({ ...subject.value, worktrees: tracked.worktrees, clock: nonExpiringClock })
    const second = { ...request, requestId: '223e4567-e89b-42d3-a456-426614174002' }
    await expect(Promise.all([collect(launcher.handle(request)), collect(launcher.handle(second))])).resolves.toHaveLength(2)
    expect(tracked.maximum()).toBe(1)
    expect(subject.processStarts()).toBe(2)
  })

  it('keeps creator cleanup inside the lane lock before a reused contender provisions', async () => {
    const base = options()
    const resolvedAccess = await base.value.access.resolve(request.modelProfileId, new AbortController().signal)
    let releaseFirstFresh!: (value: { status: 'refused'; reason: 'runtime-unavailable' }) => void
    const firstFresh = new Promise<{ status: 'refused'; reason: 'runtime-unavailable' }>(resolve => { releaseFirstFresh = resolve })
    let accessCalls = 0
    let rollbackComplete = false
    let secondFreshReached = false
    const rollback = vi.fn(async () => {
      rollbackComplete = true
      return 'rolled-back' as const
    })
    const subject = options({
      access: {
        resolve: async () => {
          accessCalls += 1
          if (accessCalls === 2) return await firstFresh
          if (accessCalls === 4) {
            secondFreshReached = true
            if (!rollbackComplete) throw new Error('second lane provisioned before creator cleanup')
          }
          return resolvedAccess
        },
      },
      worktrees: { ...base.value.worktrees, rollback },
      clock: nonExpiringClock,
    })
    const launcher = createSessionLauncher(subject.value)
    const second = { ...request, requestId: '223e4567-e89b-42d3-a456-426614174002' }
    const firstRun = collect(launcher.handle(request))
    while (accessCalls < 2) await new Promise<void>(resolve => setImmediate(resolve))
    const secondRun = collect(launcher.handle(second))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(secondFreshReached).toBe(false)
    releaseFirstFresh({ status: 'refused', reason: 'runtime-unavailable' })
    await expect(firstRun).resolves.toContainEqual({
      kind: 'message', message: { type: 'SESSION_FAILED', requestId: request.requestId, reason: 'runtime-unavailable' },
    })
    await expect(secondRun).resolves.toContainEqual({
      kind: 'message', message: { type: 'SESSION_STARTED', requestId: second.requestId, channelId: 'channel-1', sessionId: 'session-1' },
    })
    expect(rollback).toHaveBeenCalledOnce()
    expect(secondFreshReached).toBe(true)
  })

  it('allows distinct worktree lanes to provision concurrently', async () => {
    const subject = options()
    const tracked = trackWorktreeConcurrency(subject.value.worktrees)
    const launcher = createSessionLauncher({ ...subject.value, worktrees: tracked.worktrees, clock: nonExpiringClock })
    const second = {
      ...request,
      requestId: '223e4567-e89b-42d3-a456-426614174002',
      target: { ...request.target, worktreeName: 'lane-02', branch: 'feat/lane-02' },
    }
    await expect(Promise.all([collect(launcher.handle(request)), collect(launcher.handle(second))])).resolves.toHaveLength(2)
    expect(tracked.maximum()).toBe(2)
    expect(subject.processStarts()).toBe(2)
  })

  it('replays a durable terminal receipt without a second process start', async () => {
    const subject = options()
    const launcher = createSessionLauncher(subject.value)
    const first = await collect(launcher.handle(request))
    const second = await collect(launcher.handle(request))
    expect(second).toEqual([first.at(-1)])
    expect(subject.processStarts()).toBe(1)
  })

  it('replays a durable accepted receipt without terminally mutating in-flight work', async () => {
    const accepted: SessionReceipt = {
      schemaVersion: 1,
      revision: 1,
      key: { bindingId: request.bindingId, requestId: request.requestId },
      fingerprint: sessionStartFingerprint(request),
      request,
      state: 'accepted',
      phaseTimestamps: { accepted: '2026-08-21T00:00:00Z' },
      project,
      worktree: { phase: 'none' },
    }
    const replace = vi.fn(async () => ({ status: 'storage-unavailable' as const }))
    const subject = options({
      receipts: {
        lookup: async () => ({ status: 'receipt', receipt: accepted }),
        claim: async () => ({ status: 'storage-unavailable' }),
        replace,
        recover: async () => [],
        compact: async () => undefined,
      },
    })
    await expect(collect(createSessionLauncher(subject.value).handle(request))).resolves.toEqual([{
      kind: 'message', message: { type: 'SESSION_ACCEPTED', requestId: request.requestId },
    }])
    expect(replace).not.toHaveBeenCalled()
    expect(accepted.state).toBe('accepted')
  })

  it('closes storage-unavailable when required audit persistence fails before acknowledgement', async () => {
    const start = vi.fn(async () => ({ status: 'failed' as const, reason: 'spawn-failed' as const }))
    const subject = options({
      audit: { append: async () => { throw new Error('disk full') } },
      processes: {
        ...options().value.processes,
        start,
      },
    })
    const launcher = createSessionLauncher(subject.value)
    await expect(collect(launcher.handle(request))).resolves.toEqual([{ kind: 'close-job-control', error: 'storage-unavailable' }])
    expect(start).not.toHaveBeenCalled()
  })

  it('turns unprovable timeout compensation into recovery uncertainty', async () => {
    let sleeps = 0
    let lateSpawned = false
    let attemptLateStart = () => undefined
    const terminate = vi.fn(async () => 'uncertain' as const)
    const clock = {
      now: () => now,
      sleep: async () => {
        sleeps += 1
        if (sleeps === 8) return
        return await new Promise<void>(() => undefined)
      },
    }
    const subject = options({
      clock,
      processes: {
        ...options().value.processes,
        start: async (value, signal) => await new Promise(resolve => {
          signal.addEventListener('abort', () => resolve({ status: 'failed', reason: 'spawn-failed' }), { once: true })
          attemptLateStart = () => {
            if (signal.aborted) return
            lateSpawned = true
            resolve({ status: 'started', handle: { sessionId: value.sessionId, finished: Promise.resolve({ exitCode: 0, signal: null }) } })
          }
        }),
        terminate,
      },
    })
    const actions = await collect(createSessionLauncher(subject.value).handle(request))
    expect(actions).toEqual([
      { kind: 'message', message: { type: 'SESSION_ACCEPTED', requestId: request.requestId } },
      { kind: 'message', message: { type: 'SESSION_FAILED', requestId: request.requestId, reason: 'recovery-uncertain' } },
    ])
    attemptLateStart()
    await Promise.resolve()
    expect(lateSpawned).toBe(false)
    expect(terminate).toHaveBeenCalledWith('session-1')
    expect(subject.held.image().receipts[0]?.state).toBe('uncertain')
  })

  it('adopts only an exact surviving session under its stable id and a new channel', async () => {
    const held = recoveryReceipts(recoveryReceipt())
    const adopt = vi.fn(async value => ({
      status: 'started' as const,
      handle: { sessionId: value.sessionId, finished: Promise.resolve({ exitCode: 0, signal: null }) },
    }))
    const base = options()
    const subject = options({
      receipts: held.value,
      worktrees: { ...base.value.worktrees, inspect: async () => 'exact' },
      processes: { ...base.value.processes, inspect: async () => 'exact', adopt },
    })
    const actions = await collect(createSessionLauncher(subject.value).recover())
    expect(actions[0]).toEqual({
      kind: 'message', message: { type: 'SESSION_STARTED', requestId: request.requestId, channelId: 'channel-1', sessionId: 'session-stable' },
    })
    expect(actions.at(-1)).toMatchObject({ kind: 'message', message: { type: 'SESSION_FINISHED' } })
    expect(adopt).toHaveBeenCalledOnce()
    expect(held.current()).toMatchObject({ state: 'finished', sessionId: 'session-stable', channelId: 'channel-1' })
  })

  it('closes a pre-start recovery channel when another recovery stream aborts the job control', async () => {
    const first = recoveryReceipt()
    const { sessionId: _sessionId, channelId: _channelId, ...secondBase } = recoveryReceipt()
    const second: SessionReceipt = {
      ...secondBase,
      key: { bindingId: request.bindingId, requestId: '223e4567-e89b-42d3-a456-426614174002' },
      request: { ...request, requestId: '223e4567-e89b-42d3-a456-426614174002' },
      state: 'accepted',
      phaseTimestamps: { accepted: '2026-08-21T00:00:00Z' },
      worktree: { phase: 'none' },
    }
    let persist!: (value: { status: 'updated'; receipt: SessionReceipt }) => void
    const persisted = new Promise<{ status: 'updated'; receipt: SessionReceipt }>(resolve => { persist = resolve })
    let releaseSecondAudit!: () => void
    const secondAudit = new Promise<void>(resolve => { releaseSecondAudit = resolve })
    let opened!: () => void
    const firstOpened = new Promise<void>(resolve => { opened = resolve })
    const close = vi.fn(async () => undefined)
    const base = options()
    const subject = options({
      receipts: {
        lookup: async () => ({ status: 'missing' }),
        claim: async () => ({ status: 'storage-unavailable' }),
        recover: async () => [first, second],
        compact: async () => undefined,
        replace: async (_revision, next) => {
          if (next.key.requestId === first.key.requestId && next.channelId === 'channel-1') return await persisted
          return { status: 'storage-unavailable' }
        },
      },
      channels: { open: async () => { opened(); return { status: 'opened', channelId: 'channel-1' } }, close },
      worktrees: { ...base.value.worktrees, inspect: async () => 'exact' },
      audit: {
        append: async record => {
          if (!('key' in record) || record.key.requestId !== second.key.requestId) return
          await secondAudit
          throw new Error('audit unavailable')
        },
      },
    })
    const actions = collect(createSessionLauncher(subject.value).recover())
    await firstOpened
    releaseSecondAudit()
    await expect(actions).resolves.toEqual([{ kind: 'close-job-control', error: 'storage-unavailable' }])
    persist({ status: 'updated', receipt: { ...first, revision: first.revision + 1, channelId: 'channel-1' } })
    await Promise.resolve()
    expect(close).toHaveBeenCalledWith('channel-1', 'storage-unavailable')
  })

  it('closes a correlated channel when recovery aborts while process start is pending', async () => {
    const first = recoveryReceipt()
    const { sessionId: _sessionId, channelId: _channelId, ...secondBase } = recoveryReceipt()
    const second: SessionReceipt = {
      ...secondBase,
      key: { bindingId: request.bindingId, requestId: '223e4567-e89b-42d3-a456-426614174002' },
      request: { ...request, requestId: '223e4567-e89b-42d3-a456-426614174002' },
      state: 'accepted',
      phaseTimestamps: { accepted: '2026-08-21T00:00:00Z' },
      worktree: { phase: 'none' },
    }
    let releaseSecondAudit!: () => void
    const secondAudit = new Promise<void>(resolve => { releaseSecondAudit = resolve })
    let started!: () => void
    const firstStarted = new Promise<void>(resolve => { started = resolve })
    const close = vi.fn(async () => undefined)
    const base = options()
    const subject = options({
      clock: { now: () => now, sleep: async () => await new Promise<void>(() => undefined) },
      receipts: {
        lookup: async () => ({ status: 'missing' }),
        claim: async () => ({ status: 'storage-unavailable' }),
        recover: async () => [first, second],
        compact: async () => undefined,
        replace: async (_revision, next) => ({ status: 'updated', receipt: { ...next, revision: next.revision + 1 } }),
      },
      channels: { open: async () => ({ status: 'opened', channelId: 'channel-1' }), close },
      processes: { ...base.value.processes, adopt: async () => { started(); return await new Promise(() => undefined) } },
      worktrees: { ...base.value.worktrees, inspect: async () => 'exact' },
      audit: {
        append: async record => {
          if (!('key' in record) || record.key.requestId !== second.key.requestId) return
          await secondAudit
          throw new Error('audit unavailable')
        },
      },
    })
    const actions = collect(createSessionLauncher(subject.value).recover())
    await firstStarted
    releaseSecondAudit()
    await expect(actions).resolves.toEqual([{ kind: 'close-job-control', error: 'storage-unavailable' }])
    expect(close).toHaveBeenCalledWith('channel-1', 'storage-unavailable')
  })

  it('marks mismatched recovery uncertain without spawn, terminate, or rollback', async () => {
    const held = recoveryReceipts(recoveryReceipt())
    const adopt = vi.fn(async () => { throw new Error('must not adopt') })
    const terminate = vi.fn(async () => 'terminated' as const)
    const rollback = vi.fn(async () => 'rolled-back' as const)
    const base = options()
    const subject = options({
      receipts: held.value,
      worktrees: { ...base.value.worktrees, inspect: async () => 'exact', rollback },
      processes: { ...base.value.processes, inspect: async () => 'mismatch', adopt, terminate },
    })
    await expect(collect(createSessionLauncher(subject.value).recover())).resolves.toEqual([{
      kind: 'message', message: { type: 'SESSION_FAILED', requestId: request.requestId, reason: 'recovery-uncertain' },
    }])
    expect(adopt).not.toHaveBeenCalled()
    expect(terminate).not.toHaveBeenCalled()
    expect(rollback).not.toHaveBeenCalled()
    expect(held.current().state).toBe('uncertain')
  })

  it('refuses binding mismatch before receipt lookup or process work', async () => {
    const lookup = vi.fn(async () => ({ status: 'missing' as const }))
    const subject = options({
      bindingId: () => '323e4567-e89b-42d3-a456-426614174002',
      receipts: {
        lookup,
        claim: async () => ({ status: 'storage-unavailable' }),
        replace: async () => ({ status: 'storage-unavailable' }),
        recover: async () => [],
        compact: async () => undefined,
      },
    })
    const launcher = createSessionLauncher(subject.value)
    await expect(collect(launcher.handle(request))).resolves.toEqual([{
      kind: 'message', message: { type: 'SESSION_REFUSED', requestId: request.requestId, reason: 'binding-mismatch' },
    }])
    expect(lookup).not.toHaveBeenCalled()
    expect(subject.processStarts()).toBe(0)
  })
})

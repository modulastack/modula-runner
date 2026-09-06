import { describe, expect, it, vi } from 'vitest'
import {
  SecretEnv,
  SessionReceiptBusyError,
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
const sameWorktree: SessionStartMessage = { ...request, requestId: '423e4567-e89b-42d3-a456-426614174003' }
const otherWorktree: SessionStartMessage = {
  ...request,
  requestId: '523e4567-e89b-42d3-a456-426614174004',
  target: { ...request.target, worktreeName: 'lane-02', branch: 'feat/lane-02' },
}
// One more than the bounded wait a caller gives a saturated ledger, so a case can run that wait out
// at a chosen write and let every later one through.
const REFUSALS_PAST_THE_LEDGER_WAIT = 41

function receiptStorage(inherited: readonly SessionReceipt[] = []) {
  let image: SessionReceiptLedgerImage = {
    schemaVersion: 1, revision: 0, capacityBlockedUntil: null, receipts: structuredClone(inherited) as SessionReceipt[], tombstones: [],
  }
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

function options(overrides: Partial<SessionLauncherOptions> = {}, inherited: readonly SessionReceipt[] = []) {
  const held = receiptStorage(inherited)
  const clock = { now: () => now, sleep: async () => undefined }
  const audit: AuditRecord[] = []
  let processStarts = 0
  const channels: SessionLauncherOptions['channels'] = {
    open: async () => ({ status: 'opened', channelId: 'channel-1' }),
    close: async () => undefined,
  }
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
    channels,
    recoveryChannels: recoveryChannelPorts(channels),
    processes: {
      start: async value => {
        processStarts += 1
        return {
          status: 'started',
          handle: {
            sessionId: value.sessionId,
            channelId: value.channelId,
            ...(value.channelGeneration === undefined ? {} : { channelGeneration: value.channelGeneration }),
            finished: Promise.resolve({ exitCode: 0, signal: null }),
          },
        }
      },
      adopt: async value => ({
        status: 'started',
        handle: {
          sessionId: value.sessionId,
          channelId: value.channelId,
          ...(value.channelGeneration === undefined ? {} : { channelGeneration: value.channelGeneration }),
          finished: Promise.resolve({ exitCode: 0, signal: null }),
        },
      }),
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
    // Inherited phases precede the fixture clock, so a real ledger accepts the phase a recovery
    // pass stamps next instead of reading it as history rewritten.
    phaseTimestamps: {
      accepted: '2026-08-20T23:59:58Z',
      provisioned: '2026-08-20T23:59:59Z',
      'spawn-intent': '2026-08-21T00:00:00Z',
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
    channel: { generation: 1, lifecycle: 'lost', channelId: 'channel-old' },
    channelId: 'channel-old',
  }
}

function provisionedReceipt(): SessionReceipt {
  const { sessionId: _sessionId, channelId: _channelId, channel: _channel, ...base } = recoveryReceipt()
  return {
    ...base,
    revision: 2,
    state: 'provisioned',
    phaseTimestamps: { accepted: '2026-08-20T23:59:58Z', provisioned: '2026-08-20T23:59:59Z' },
  }
}

function acceptedReceipt(): SessionReceipt {
  const { sessionId: _sessionId, channelId: _channelId, channel: _channel, ...base } = recoveryReceipt()
  return {
    ...base,
    revision: 1,
    state: 'accepted',
    phaseTimestamps: { accepted: '2026-08-21T00:00:00Z' },
    worktree: { phase: 'none' },
  }
}

function startedOnLiveChannel(): SessionReceipt {
  const base = recoveryReceipt()
  return {
    ...base,
    state: 'started',
    phaseTimestamps: { ...base.phaseTimestamps, started: '2026-08-21T00:00:03Z' },
    channel: { generation: 1, lifecycle: 'live', channelId: 'channel-old', connectionEpoch: 'epoch-1' },
  }
}

function recoveryChannelPorts(
  channels: SessionLauncherOptions['channels'],
): NonNullable<SessionLauncherOptions['recoveryChannels']> {
  return {
    ...channels,
    status: async () => 'lost',
    closeExact: async (channelId, _generation, reason) => {
      await channels.close(channelId, reason)
      return 'closed'
    },
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

// A ledger that takes `allowed` receipt writes and then refuses `rejections` of them the way a
// saturated one does, so a case can place the back-pressure at a chosen point in a launch and
// watch it either waited out or run past the bounded wait.
function busyLedger(receipts: SessionLauncherOptions['receipts'], allowed: number, rejections: number) {
  let permitted = allowed
  let remaining = rejections
  let refused = 0
  const value: SessionLauncherOptions['receipts'] = {
    lookup: key => receipts.lookup(key),
    claim: (start, fingerprint, now) => receipts.claim(start, fingerprint, now),
    replace: async (revision, receipt) => {
      if (permitted > 0) permitted -= 1
      else if (remaining > 0) {
        remaining -= 1
        refused += 1
        throw new SessionReceiptBusyError()
      }
      return await receipts.replace(revision, receipt)
    },
    recover: () => receipts.recover(),
    compact: now => receipts.compact(now),
  }
  return { value, rejections: () => refused }
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

  it('does not replay SESSION_STARTED for a channel already marked lost', async () => {
    const lost: SessionReceipt = {
      ...recoveryReceipt(),
      state: 'started',
      phaseTimestamps: { ...recoveryReceipt().phaseTimestamps, started: '2026-08-21T00:00:03Z' },
    }
    const subject = options({
      receipts: {
        lookup: async () => ({ status: 'receipt', receipt: lost }),
        claim: async () => ({ status: 'storage-unavailable' }),
        replace: async () => ({ status: 'storage-unavailable' }),
        recover: async () => [],
        compact: async () => undefined,
      },
    })
    await expect(collect(createSessionLauncher(subject.value).handle(request))).resolves.toEqual([{
      kind: 'message', message: { type: 'SESSION_ACCEPTED', requestId: request.requestId },
    }])
  })

  it('does not emit a refusal that lost its receipt compare-and-set', async () => {
    const winner = recoveryReceipt()
    const audit = vi.fn(async () => undefined)
    const subject = options({
      audit: { append: audit },
      receipts: {
        lookup: async () => ({ status: 'missing' }),
        claim: async () => ({ status: 'storage-unavailable' }),
        replace: async () => ({ status: 'conflict', current: winner }),
        recover: async () => [],
        compact: async () => undefined,
      },
    })
    const expired = { ...request, expiresAt: '2020-01-01T00:00:00Z' }
    await expect(collect(createSessionLauncher(subject.value).handle(expired)))
      .resolves.toEqual([{ kind: 'close-job-control', error: 'storage-unavailable' }])
    expect(audit).not.toHaveBeenCalled()
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

  it('uses connection-level uncertainty when an exact pre-start close is unknown', async () => {
    const base = options()
    const closeExact = vi.fn(async () => 'unknown' as const)
    const subject = options({
      recoveryChannels: { ...base.value.recoveryChannels!, closeExact },
      processes: {
        ...base.value.processes,
        start: async () => ({ status: 'failed', reason: 'spawn-failed' }),
      },
    })

    await expect(collect(createSessionLauncher(subject.value).handle(request))).resolves.toEqual([
      { kind: 'message', message: { type: 'SESSION_ACCEPTED', requestId: request.requestId } },
      { kind: 'close-job-control', error: 'storage-unavailable' },
    ])
    expect(closeExact).toHaveBeenCalledOnce()
    expect(subject.held.image().receipts[0]?.state).toBe('spawn-intent')
    expect(subject.held.image().receipts[0]?.result).toBeUndefined()
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
    expect(terminate).toHaveBeenCalledWith({ sessionId: 'session-1', cwd: '/worktrees/lane-01' })
    expect(subject.held.image().receipts[0]?.state).toBe('uncertain')
  })

  it('re-verifies provisioned worktree cleanliness before recovery starts a process', async () => {
    const { sessionId: _sessionId, channelId: _channelId, channel: _channel, ...baseReceipt } = recoveryReceipt()
    const receipt: SessionReceipt = {
      ...baseReceipt,
      state: 'provisioned',
      revision: 2,
      phaseTimestamps: { accepted: '2026-08-21T00:00:00Z', provisioned: '2026-08-21T00:00:01Z' },
    }
    const held = recoveryReceipts(receipt)
    const base = options()
    const verify = vi.fn(async () => ({ status: 'failed' as const, reason: 'worktree-conflict' as const }))
    const subject = options({
      receipts: held.value,
      worktrees: { ...base.value.worktrees, inspect: async () => 'exact', verify },
    })
    await expect(collect(createSessionLauncher(subject.value).recover())).resolves.toEqual([{
      kind: 'message', message: { type: 'SESSION_FAILED', requestId: request.requestId, reason: 'worktree-conflict' },
    }])
    expect(verify).toHaveBeenCalledOnce()
    expect(subject.processStarts()).toBe(0)
  })

  it('leaves a started session alone when its channel is still live on this connection', async () => {
    const held = recoveryReceipts(startedOnLiveChannel())
    const base = options()
    const adopt = vi.fn(async () => { throw new Error('must not adopt') })
    const subject = options({
      receipts: held.value,
      recoveryChannels: { ...base.value.recoveryChannels!, status: async () => 'live' },
      processes: { ...base.value.processes, adopt },
    })
    await expect(collect(createSessionLauncher(subject.value).recover())).resolves.toEqual([])
    expect(adopt).not.toHaveBeenCalled()
    expect(held.current()).toMatchObject({ state: 'started', revision: startedOnLiveChannel().revision })
  })

  it('recovers that same started session once its channel is reported lost', async () => {
    const held = recoveryReceipts(startedOnLiveChannel())
    const base = options()
    const adopt = vi.fn(base.value.processes.adopt)
    const subject = options({
      receipts: held.value,
      recoveryChannels: { ...base.value.recoveryChannels!, status: async () => 'lost' },
      processes: { ...base.value.processes, adopt },
    })
    const actions = await collect(createSessionLauncher(subject.value).recover())
    expect(actions[0]).toEqual({
      kind: 'message', message: { type: 'SESSION_STARTED', requestId: request.requestId, channelId: 'channel-1', sessionId: 'session-stable' },
    })
    expect(actions.at(-1)).toMatchObject({ kind: 'message', message: { type: 'SESSION_FINISHED' } })
    expect(adopt).toHaveBeenCalledOnce()
    expect(held.current()).toMatchObject({ state: 'finished', channelId: 'channel-1' })
  })

  it('adopts only an exact surviving session under its stable id and a new channel', async () => {
    const held = recoveryReceipts(recoveryReceipt())
    const adopt = vi.fn(async value => ({
      status: 'started' as const,
      handle: {
        sessionId: value.sessionId,
        channelId: value.channelId,
        channelGeneration: value.channelGeneration,
        finished: Promise.resolve({ exitCode: 0, signal: null }),
      },
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
    const { sessionId: _sessionId, channelId: _channelId, channel: _channel, ...secondBase } = recoveryReceipt()
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
    let opened!: () => void
    const firstOpened = new Promise<void>(resolve => { opened = resolve })
    const close = vi.fn(async () => undefined)
    const channels: SessionLauncherOptions['channels'] = {
      open: async () => { opened(); return { status: 'opened', channelId: 'channel-1' } },
      close,
    }
    const base = options()
    const subject = options({
      receipts: {
        lookup: async () => ({ status: 'missing' }),
        claim: async () => ({ status: 'storage-unavailable' }),
        recover: async () => [first, second],
        compact: async () => undefined,
        replace: async (_revision, next) => next.key.requestId === first.key.requestId
          ? { status: 'updated', receipt: { ...next, revision: next.revision + 1 } }
          : { status: 'storage-unavailable' },
      },
      channels,
      recoveryChannels: recoveryChannelPorts(channels),
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
    await Promise.resolve()
    expect(close).toHaveBeenCalledWith('channel-1', 'storage-unavailable')
  })

  it('closes a correlated channel when recovery aborts while process start is pending', async () => {
    const first = recoveryReceipt()
    const { sessionId: _sessionId, channelId: _channelId, channel: _channel, ...secondBase } = recoveryReceipt()
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
    const channels: SessionLauncherOptions['channels'] = {
      open: async () => ({ status: 'opened', channelId: 'channel-1' }),
      close,
    }
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
      channels,
      recoveryChannels: recoveryChannelPorts(channels),
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

  it('terminates an owned process when recovery aborts before SESSION_STARTED is durable', async () => {
    const { sessionId: _sessionId, channelId: _channelId, channel: _channel, ...firstBase } = recoveryReceipt()
    const first: SessionReceipt = {
      ...firstBase,
      state: 'provisioned',
      phaseTimestamps: { accepted: '2026-08-21T00:00:00Z', provisioned: '2026-08-21T00:00:01Z' },
    }
    const { sessionId: _otherSessionId, channelId: _otherChannelId, channel: _otherChannel, ...secondBase } = recoveryReceipt()
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
    let enterStartedPersistence!: () => void
    const startedPersistence = new Promise<void>(resolve => { enterStartedPersistence = resolve })
    let releaseStartedPersistence!: (value: { status: 'updated'; receipt: SessionReceipt }) => void
    const persisted = new Promise<{ status: 'updated'; receipt: SessionReceipt }>(resolve => { releaseStartedPersistence = resolve })
    const terminate = vi.fn(async () => 'terminated' as const)
    const base = options()
    const subject = options({
      clock: { now: () => now, sleep: async () => await new Promise<void>(() => undefined) },
      receipts: {
        lookup: async () => ({ status: 'missing' }),
        claim: async () => ({ status: 'storage-unavailable' }),
        recover: async () => [first, second],
        compact: async () => undefined,
        replace: async (_revision, next) => {
          if (next.key.requestId === first.key.requestId && next.state === 'started') {
            enterStartedPersistence()
            return await persisted
          }
          return { status: 'updated', receipt: { ...next, revision: next.revision + 1 } }
        },
      },
      processes: {
        ...base.value.processes,
        start: async value => ({ status: 'started', handle: { sessionId: value.sessionId, finished: new Promise(() => undefined) } }),
        terminate,
      },
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
    await startedPersistence
    releaseSecondAudit()
    await expect(actions).resolves.toEqual([{ kind: 'close-job-control', error: 'storage-unavailable' }])
    expect(terminate).toHaveBeenCalledWith({ sessionId: 'session-1', cwd: '/worktrees/lane-01' })
    releaseStartedPersistence({ status: 'updated', receipt: { ...first, revision: first.revision + 2, state: 'started', channelId: 'channel-1', sessionId: 'session-1' } })
  })

  it('terminates an owned process when recovery aborts between start commitment and handle observation', async () => {
    const { sessionId: _sessionId, channelId: _channelId, channel: _channel, ...firstBase } = recoveryReceipt()
    const first: SessionReceipt = {
      ...firstBase,
      state: 'provisioned',
      phaseTimestamps: { accepted: '2026-08-21T00:00:00Z', provisioned: '2026-08-21T00:00:01Z' },
    }
    const { sessionId: _otherSessionId, channelId: _otherChannelId, channel: _otherChannel, ...secondBase } = recoveryReceipt()
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
    let enteredSecondAudit!: () => void
    const secondAuditEntered = new Promise<void>(resolve => { enteredSecondAudit = resolve })
    const terminate = vi.fn(async () => 'terminated' as const)
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
      processes: {
        ...base.value.processes,
        start: async value => {
          await secondAuditEntered
          releaseSecondAudit()
          return { status: 'started', handle: { sessionId: value.sessionId, finished: new Promise(() => undefined) } }
        },
        terminate,
      },
      worktrees: { ...base.value.worktrees, inspect: async () => 'exact' },
      audit: {
        append: async record => {
          if (!('key' in record) || record.key.requestId !== second.key.requestId) return
          enteredSecondAudit()
          await secondAudit
          throw new Error('audit unavailable')
        },
      },
    })
    await expect(collect(createSessionLauncher(subject.value).recover())).resolves.toEqual([
      { kind: 'close-job-control', error: 'storage-unavailable' },
    ])
    expect(terminate).toHaveBeenCalledWith({ sessionId: 'session-1', cwd: '/worktrees/lane-01' })
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

  it('abandons a recovered receipt whose compare-and-set another writer won', async () => {
    const conflicted = acceptedReceipt()
    const replace = vi.fn(async () => ({ status: 'conflict' as const, current: { ...conflicted, revision: 4 } }))
    const subject = options({
      receipts: {
        lookup: async () => ({ status: 'receipt', receipt: conflicted }),
        claim: async () => ({ status: 'storage-unavailable' }),
        replace,
        recover: async () => [conflicted],
        compact: async () => undefined,
      },
    })
    await expect(collect(createSessionLauncher(subject.value).recover())).resolves.toEqual([
      { kind: 'message', message: { type: 'SESSION_ACCEPTED', requestId: request.requestId } },
    ])
    expect(replace).toHaveBeenCalled()
  })

  it('closes job control when a launch loses the compare-and-set on its own receipt', async () => {
    const claimed = acceptedReceipt()
    const subject = options({
      receipts: {
        lookup: async () => ({ status: 'missing' }),
        claim: async () => ({ status: 'claimed', receipt: claimed }),
        replace: async () => ({ status: 'conflict', current: { ...claimed, revision: 4 } }),
        recover: async () => [],
        compact: async () => undefined,
      },
    })
    await expect(collect(createSessionLauncher(subject.value).handle(request))).resolves.toEqual([
      { kind: 'message', message: { type: 'SESSION_ACCEPTED', requestId: request.requestId } },
      { kind: 'close-job-control', error: 'storage-unavailable' },
    ])
  })

  it('holds recovery off a receipt its own launch drives and hands it back once that launch is abandoned', async () => {
    const subject = options({ clock: nonExpiringClock })
    const launcher = createSessionLauncher(subject.value)
    const accepted = { kind: 'message', message: { type: 'SESSION_ACCEPTED', requestId: request.requestId } }
    let driven = 0
    for await (const action of launcher.handle(request)) {
      driven += 1
      expect(action).toEqual(accepted)
      await expect(collect(launcher.recover())).resolves.toEqual([])
      break
    }
    expect(driven).toBe(1)
    await expect(collect(launcher.recover())).resolves.toContainEqual(accepted)
    expect(subject.processStarts()).toBe(1)
  })

  it('refuses at capacity instead of closing job control when the ledger is too busy to look up', async () => {
    const replace = vi.fn(async () => ({ status: 'storage-unavailable' as const }))
    const subject = options({
      receipts: {
        lookup: async () => { throw new SessionReceiptBusyError() },
        claim: async () => ({ status: 'storage-unavailable' }),
        replace,
        recover: async () => [],
        compact: async () => undefined,
      },
    })
    await expect(collect(createSessionLauncher(subject.value).handle(request))).resolves.toEqual([{
      kind: 'message', message: { type: 'SESSION_REFUSED', requestId: request.requestId, reason: 'at-capacity' },
    }])
    expect(replace).not.toHaveBeenCalled()
    expect(subject.audit.map(record => record.kind === 'session-launch' ? record.state : record.kind)).toEqual(['refused'])
  })

  it('refuses at capacity when the ledger goes busy between lookup and claim', async () => {
    const replace = vi.fn(async () => ({ status: 'storage-unavailable' as const }))
    const subject = options({
      receipts: {
        lookup: async () => ({ status: 'missing' }),
        claim: async () => { throw new SessionReceiptBusyError() },
        replace,
        recover: async () => [],
        compact: async () => undefined,
      },
    })
    await expect(collect(createSessionLauncher(subject.value).handle(request))).resolves.toEqual([{
      kind: 'message', message: { type: 'SESSION_REFUSED', requestId: request.requestId, reason: 'at-capacity' },
    }])
    expect(replace).not.toHaveBeenCalled()
    expect(subject.processStarts()).toBe(0)
  })

  it('waits out a ledger that goes busy after admission and finishes the launch', async () => {
    const subject = options()
    const saturated = busyLedger(subject.value.receipts, 0, 3)
    const launcher = createSessionLauncher({ ...subject.value, receipts: saturated.value })
    await expect(collect(launcher.handle(request))).resolves.toEqual([
      { kind: 'message', message: { type: 'SESSION_ACCEPTED', requestId: request.requestId } },
      { kind: 'message', message: { type: 'SESSION_STARTED', requestId: request.requestId, channelId: 'channel-1', sessionId: 'session-1' } },
      { kind: 'message', message: { type: 'SESSION_FINISHED', requestId: request.requestId, exitCode: 0, signal: null } },
    ])
    expect(saturated.rejections()).toBe(3)
    expect(subject.processStarts()).toBe(1)
  })

  it('leaves a launch it cannot record to recovery instead of closing job control', async () => {
    const subject = options()
    const saturated = busyLedger(subject.value.receipts, 1, Number.POSITIVE_INFINITY)
    const launcher = createSessionLauncher({ ...subject.value, receipts: saturated.value })
    await expect(collect(launcher.handle(request))).resolves.toEqual([
      { kind: 'message', message: { type: 'SESSION_ACCEPTED', requestId: request.requestId } },
    ])
    expect(subject.held.image().receipts.map(stored => stored.state)).toEqual(['accepted'])
    expect(subject.processStarts()).toBe(0)
  })

  it('refuses at capacity when the ledger cannot take the refusal receipt', async () => {
    const subject = options()
    const saturated = busyLedger(subject.value.receipts, 0, Number.POSITIVE_INFINITY)
    const launcher = createSessionLauncher({ ...subject.value, receipts: saturated.value })
    const expired = { ...request, expiresAt: '2026-08-20T23:59:00Z' }
    await expect(collect(launcher.handle(expired))).resolves.toEqual([{
      kind: 'message', message: { type: 'SESSION_REFUSED', requestId: request.requestId, reason: 'at-capacity' },
    }])
    expect(subject.held.image().receipts).toEqual([])
  })

  it('replays nothing rather than closing job control when the recovery scan finds the ledger busy', async () => {
    const subject = options({
      receipts: {
        lookup: async () => ({ status: 'missing' }),
        claim: async () => ({ status: 'storage-unavailable' }),
        replace: async () => ({ status: 'storage-unavailable' }),
        recover: async () => { throw new SessionReceiptBusyError() },
        compact: async () => undefined,
      },
    })
    await expect(collect(createSessionLauncher(subject.value).recover())).resolves.toEqual([])
  })

  it('declines a replacement claim the ledger is too busy to take, leaving the receipt untouched', async () => {
    const held = recoveryReceipts(recoveryReceipt())
    const saturated = busyLedger(held.value, 0, Number.POSITIVE_INFINITY)
    const subject = options({ receipts: saturated.value })
    await expect(collect(createSessionLauncher(subject.value).recover())).resolves.toEqual([])
    expect(held.current()).toEqual(recoveryReceipt())
    expect(subject.processStarts()).toBe(0)
  })

  it('keeps the worktree of a receipt back-pressure left unadopted, admitting every other worktree', async () => {
    const subject = options({}, [recoveryReceipt()])
    const saturated = busyLedger(subject.value.receipts, 0, REFUSALS_PAST_THE_LEDGER_WAIT)
    const launcher = createSessionLauncher({ ...subject.value, receipts: saturated.value })
    await expect(collect(launcher.recover())).resolves.toEqual([])
    expect(saturated.rejections()).toBe(REFUSALS_PAST_THE_LEDGER_WAIT)
    expect(subject.held.image().receipts).toEqual([recoveryReceipt()])
    await expect(collect(launcher.handle(sameWorktree))).resolves.toEqual([
      { kind: 'message', message: { type: 'SESSION_ACCEPTED', requestId: sameWorktree.requestId } },
      { kind: 'message', message: { type: 'SESSION_FAILED', requestId: sameWorktree.requestId, reason: 'launch-timeout' } },
    ])
    expect(subject.processStarts()).toBe(0)
    await expect(collect(launcher.handle(otherWorktree))).resolves.toEqual([
      { kind: 'message', message: { type: 'SESSION_ACCEPTED', requestId: otherWorktree.requestId } },
      { kind: 'message', message: { type: 'SESSION_STARTED', requestId: otherWorktree.requestId, channelId: 'channel-1', sessionId: 'session-1' } },
      { kind: 'message', message: { type: 'SESSION_FINISHED', requestId: otherWorktree.requestId, exitCode: 0, signal: null } },
    ])
    expect(subject.processStarts()).toBe(1)
  })

  it('admits the worktree again once a later pass adopts the receipt that kept it', async () => {
    const subject = options({}, [recoveryReceipt()])
    const saturated = busyLedger(subject.value.receipts, 0, REFUSALS_PAST_THE_LEDGER_WAIT)
    const launcher = createSessionLauncher({ ...subject.value, receipts: saturated.value })
    await expect(collect(launcher.recover())).resolves.toEqual([])
    await expect(collect(launcher.recover())).resolves.toEqual([
      { kind: 'message', message: { type: 'SESSION_STARTED', requestId: request.requestId, channelId: 'channel-1', sessionId: 'session-stable' } },
      { kind: 'message', message: { type: 'SESSION_FINISHED', requestId: request.requestId, exitCode: 0, signal: null } },
    ])
    await expect(collect(launcher.handle(sameWorktree))).resolves.toEqual([
      { kind: 'message', message: { type: 'SESSION_ACCEPTED', requestId: sameWorktree.requestId } },
      { kind: 'message', message: { type: 'SESSION_STARTED', requestId: sameWorktree.requestId, channelId: 'channel-1', sessionId: 'session-1' } },
      { kind: 'message', message: { type: 'SESSION_FINISHED', requestId: sameWorktree.requestId, exitCode: 0, signal: null } },
    ])
    expect(subject.processStarts()).toBe(1)
  })

  it('gives the worktree back when a later scan no longer names the receipt that kept it', async () => {
    const subject = options({}, [recoveryReceipt()])
    const saturated = busyLedger(subject.value.receipts, 0, REFUSALS_PAST_THE_LEDGER_WAIT)
    const launcher = createSessionLauncher({ ...subject.value, receipts: saturated.value })
    await expect(collect(launcher.recover())).resolves.toEqual([])
    await expect(collect(launcher.recover('323e4567-e89b-42d3-a456-426614174002'))).resolves.toEqual([])
    expect(subject.held.image().receipts.map(stored => stored.state)).toEqual(['uncertain'])
    await expect(collect(launcher.recover())).resolves.toEqual([])
    await expect(collect(launcher.handle(sameWorktree))).resolves.toEqual([
      { kind: 'message', message: { type: 'SESSION_ACCEPTED', requestId: sameWorktree.requestId } },
      { kind: 'message', message: { type: 'SESSION_STARTED', requestId: sameWorktree.requestId, channelId: 'channel-1', sessionId: 'session-1' } },
      { kind: 'message', message: { type: 'SESSION_FINISHED', requestId: sameWorktree.requestId, exitCode: 0, signal: null } },
    ])
    expect(subject.processStarts()).toBe(1)
  })

  it('keeps the worktree of a receipt whose settlement the ledger deferred', async () => {
    const subject = options({}, [recoveryReceipt()])
    const saturated = busyLedger(subject.value.receipts, 0, REFUSALS_PAST_THE_LEDGER_WAIT)
    const launcher = createSessionLauncher({
      ...subject.value,
      receipts: saturated.value,
      // A channel host that cannot say whether the prior channel ended leaves the process it
      // belonged to possibly live, which is the case a settlement nothing recorded must not free
      // the worktree for.
      recoveryChannels: { ...recoveryChannelPorts(subject.value.channels), status: async () => 'unknown' as const },
    })
    await expect(collect(launcher.recover())).resolves.toEqual([])
    expect(saturated.rejections()).toBe(REFUSALS_PAST_THE_LEDGER_WAIT)
    expect(subject.held.image().receipts).toEqual([recoveryReceipt()])
    await expect(collect(launcher.handle(sameWorktree))).resolves.toEqual([
      { kind: 'message', message: { type: 'SESSION_ACCEPTED', requestId: sameWorktree.requestId } },
      { kind: 'message', message: { type: 'SESSION_FAILED', requestId: sameWorktree.requestId, reason: 'launch-timeout' } },
    ])
    expect(subject.processStarts()).toBe(0)
  })

  it('acquires the lane afresh for a pass whose predecessor had already handed it back', async () => {
    // The re-verify journal and the spawn-intent transition, after which provisioning is done and
    // the lane is already back, so the deferral that follows has no hold left to keep.
    const writesBeforeTheChannelOpens = 2
    const subject = options({}, [provisionedReceipt()])
    const saturated = busyLedger(subject.value.receipts, writesBeforeTheChannelOpens, REFUSALS_PAST_THE_LEDGER_WAIT)
    let opens = 0
    let inspections = 0
    let admitTheSecondPass!: () => void
    let announceTheSecondPass!: () => void
    const secondPassInspecting = new Promise<void>(resolve => { announceTheSecondPass = resolve })
    const secondPassResumes = new Promise<void>(resolve => { admitTheSecondPass = resolve })
    const launcher = createSessionLauncher({
      ...subject.value,
      receipts: saturated.value,
      channels: {
        ...subject.value.channels,
        open: async () => {
          opens += 1
          return opens === 1 ? { status: 'failed', reason: 'channel-unavailable' } : { status: 'opened', channelId: 'channel-1' }
        },
      },
      worktrees: {
        ...subject.value.worktrees,
        inspect: async snapshot => {
          inspections += 1
          if (inspections === 2) {
            announceTheSecondPass()
            await secondPassResumes
          }
          return await subject.value.worktrees.inspect(snapshot)
        },
      },
    })
    await expect(collect(launcher.recover())).resolves.toEqual([])
    expect(saturated.rejections()).toBe(REFUSALS_PAST_THE_LEDGER_WAIT)
    expect(subject.held.image().receipts.map(stored => stored.state)).toEqual(['spawn-intent'])
    const secondPass = collect(launcher.recover())
    await secondPassInspecting
    await expect(collect(launcher.handle(sameWorktree))).resolves.toEqual([
      { kind: 'message', message: { type: 'SESSION_ACCEPTED', requestId: sameWorktree.requestId } },
      { kind: 'message', message: { type: 'SESSION_FAILED', requestId: sameWorktree.requestId, reason: 'launch-timeout' } },
    ])
    admitTheSecondPass()
    await expect(secondPass).resolves.toEqual([
      { kind: 'message', message: { type: 'SESSION_FAILED', requestId: request.requestId, reason: 'recovery-uncertain' } },
    ])
    expect(subject.processStarts()).toBe(0)
  })

  it('settles stale-binding recovery locally without disclosing its request id', async () => {
    const held = recoveryReceipts(recoveryReceipt())
    const subject = options({ receipts: held.value })
    const otherBinding = '323e4567-e89b-42d3-a456-426614174002'
    await expect(collect(createSessionLauncher(subject.value).recover(otherBinding))).resolves.toEqual([])
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

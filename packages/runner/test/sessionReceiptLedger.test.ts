import { describe, expect, it } from 'vitest'
import {
  MAX_FULL_SESSION_RECEIPT_BYTES,
  MAX_FULL_SESSION_RECEIPTS,
  MAX_IN_FLIGHT_SESSION_RECEIPTS,
  MAX_PENDING_SESSION_LEDGER_OPERATIONS,
  MAX_SESSION_LEDGER_JSON_DEPTH,
  MAX_SESSION_LEDGER_JSON_NODES,
  MAX_SESSION_RECEIPT_JSON_NODES,
  MAX_SESSION_RECEIPT_RECORD_BYTES,
  SessionReceiptStorageUnavailableError,
  createSessionReceiptLedger,
  type SessionReceipt,
  type SessionReceiptLedgerImage,
  type SessionReceiptStorage,
} from '../src/index.js'

const now = Date.parse('2026-08-21T00:00:00Z')
const clock = { now: () => now, sleep: async () => undefined }

function emptyImage(): SessionReceiptLedgerImage {
  return { schemaVersion: 1, revision: 1, capacityBlockedUntil: null, receipts: [], tombstones: [] }
}

function memoryStorage(initial = emptyImage()): { storage: SessionReceiptStorage; image: () => SessionReceiptLedgerImage } {
  let image = structuredClone(initial)
  return {
    image: () => structuredClone(image),
    storage: {
      async load() {
        return { status: 'loaded', image: structuredClone(image) }
      },
      async replace(expectedRevision, next) {
        if (expectedRevision !== image.revision) return { status: 'conflict', current: structuredClone(image) }
        image = { ...structuredClone(next), revision: expectedRevision + 1 }
        return { status: 'updated', image: structuredClone(image) }
      },
    },
  }
}

function storageWithFirstConflict(
  initial: SessionReceiptLedgerImage,
  winner: (current: SessionReceiptLedgerImage) => SessionReceiptLedgerImage,
): { storage: SessionReceiptStorage; image: () => SessionReceiptLedgerImage; writes: () => number } {
  let image = structuredClone(initial)
  let writes = 0
  return {
    image: () => structuredClone(image),
    writes: () => writes,
    storage: {
      load: async () => ({ status: 'loaded', image: structuredClone(image) }),
      replace: async (expectedRevision, next) => {
        writes += 1
        if (expectedRevision !== image.revision) return { status: 'conflict', current: structuredClone(image) }
        if (writes === 1) {
          image = { ...structuredClone(winner(image)), revision: image.revision + 1 }
          return { status: 'conflict', current: structuredClone(image) }
        }
        image = { ...structuredClone(next), revision: expectedRevision + 1 }
        return { status: 'updated', image: structuredClone(image) }
      },
    },
  }
}

function request(index = 0) {
  return {
    type: 'SESSION_START' as const,
    bindingId: '123e4567-e89b-42d3-a456-426614174000',
    requestId: `223e4567-e89b-42d3-a456-${index.toString(16).padStart(12, '0')}`,
    expiresAt: '2026-08-21T00:10:00Z',
    terminalProfile: 'coder',
    modelProfileId: 'daily',
    target: {
      projectId: 'modulastack',
      worktreeName: 'lane-01',
      branch: 'feat/lane-01',
      baseBranch: 'main',
      relativeCwd: '.',
    },
  }
}

function receipt(index: number, state: SessionReceipt['state'], at: string): SessionReceipt {
  const value = request(index)
  const terminal = state === 'finished'
  return {
    schemaVersion: 1,
    revision: 1,
    key: { bindingId: value.bindingId, requestId: value.requestId },
    fingerprint: String(index).padStart(64, 'a').slice(-64),
    request: value,
    state,
    phaseTimestamps: { [state]: at },
    worktree: state === 'started' || state === 'finished' ? verifiedWorktree() : { phase: 'none' },
    ...(state === 'started' || state === 'finished' ? {
      sessionId: 'session-stable',
      channelId: 'channel-stable',
      channel: {
        generation: 1,
        lifecycle: terminal ? 'closed' as const : 'live' as const,
        channelId: 'channel-stable',
        connectionEpoch: 'connection-epoch-1',
      },
    } : {}),
    ...(terminal ? { result: { type: 'SESSION_FINISHED' as const, requestId: value.requestId, exitCode: 0, signal: null } } : {}),
  }
}

function verifiedWorktree() {
  return {
    phase: 'verified' as const,
    ownership: 'created' as const,
    branch: 'feat/lane-01',
    branchRef: 'refs/heads/feat/lane-01',
    baseBranch: 'main',
    headCommit: 'a'.repeat(40),
    expectedBaseCommit: 'a'.repeat(40),
    gitCommonDir: '/repos/modulastack/.git',
    worktreePath: '/worktrees/lane-01',
    worktreeIdentity: { device: '8', inode: '101' },
    worktreeGitDir: '/repos/modulastack/.git/worktrees/lane-01',
    gitEntryIdentity: { device: '8', inode: '102' },
    relativeCwd: '.',
    resolvedCwdPath: '/worktrees/lane-01',
    resolvedCwdIdentity: { device: '8', inode: '101' },
    clean: true as const,
  }
}

function validPersistedImage(): SessionReceiptLedgerImage {
  const finished = {
    ...receipt(1, 'finished', '2026-08-19T00:00:00Z'),
    project: { projectId: 'modulastack', repoPath: '/repos/modulastack', worktreesRoot: '/worktrees', revision: 1 },
  }
  const tombstoneRequest = request(2)
  return {
    schemaVersion: 1,
    revision: 1,
    capacityBlockedUntil: null,
    receipts: [finished],
    tombstones: [{
      key: { bindingId: tombstoneRequest.bindingId, requestId: tombstoneRequest.requestId },
      fingerprint: 'b'.repeat(64),
      result: { type: 'SESSION_FAILED', requestId: tombstoneRequest.requestId, reason: 'project-unknown' },
      sessionId: 'session-retired',
      terminalAt: '2026-08-19T00:00:00Z',
      deleteAfter: '2026-09-18T00:00:00Z',
    }],
  }
}

function invalidPersistedImages(): Array<readonly [string, unknown]> {
  const mutations: Array<readonly [string, readonly (string | number)[], unknown]> = [
    ['image schema', ['schemaVersion'], 2],
    ['image revision', ['revision'], null],
    ['capacity timestamp', ['capacityBlockedUntil'], {}],
    ['unknown root padding', ['padding'], 'x'.repeat(1024)],
    ['receipts array', ['receipts'], {}],
    ['tombstones array', ['tombstones'], null],
    ['receipt object', ['receipts', 0], null],
    ['receipt revision', ['receipts', 0, 'revision'], '1'],
    ['receipt key', ['receipts', 0, 'key'], null],
    ['receipt binding', ['receipts', 0, 'key', 'bindingId'], []],
    ['receipt request id', ['receipts', 0, 'key', 'requestId'], null],
    ['receipt fingerprint', ['receipts', 0, 'fingerprint'], {}],
    ['receipt request', ['receipts', 0, 'request'], null],
    ['request binding id', ['receipts', 0, 'request', 'bindingId'], null],
    ['request id', ['receipts', 0, 'request', 'requestId'], []],
    ['request expiry', ['receipts', 0, 'request', 'expiresAt'], {}],
    ['request terminal profile', ['receipts', 0, 'request', 'terminalProfile'], null],
    ['request model profile', ['receipts', 0, 'request', 'modelProfileId'], []],
    ['request target', ['receipts', 0, 'request', 'target'], []],
    ['request project id', ['receipts', 0, 'request', 'target', 'projectId'], null],
    ['request worktree name', ['receipts', 0, 'request', 'target', 'worktreeName'], {}],
    ['request branch', ['receipts', 0, 'request', 'target', 'branch'], []],
    ['request base branch', ['receipts', 0, 'request', 'target', 'baseBranch'], null],
    ['request relative cwd', ['receipts', 0, 'request', 'target', 'relativeCwd'], {}],
    ['receipt state', ['receipts', 0, 'state'], 'bogus'],
    ['phase timestamps', ['receipts', 0, 'phaseTimestamps'], null],
    ['terminal timestamp', ['receipts', 0, 'phaseTimestamps', 'finished'], {}],
    ['project object', ['receipts', 0, 'project'], null],
    ['project id', ['receipts', 0, 'project', 'projectId'], []],
    ['project id mismatch', ['receipts', 0, 'project', 'projectId'], 'other-project'],
    ['project repo path', ['receipts', 0, 'project', 'repoPath'], null],
    ['project worktrees root', ['receipts', 0, 'project', 'worktreesRoot'], {}],
    ['project revision', ['receipts', 0, 'project', 'revision'], '1'],
    ['worktree object', ['receipts', 0, 'worktree'], null],
    ['worktree phase', ['receipts', 0, 'worktree', 'phase'], 'bogus'],
    ['worktree ownership', ['receipts', 0, 'worktree', 'ownership'], null],
    ['worktree branch', ['receipts', 0, 'worktree', 'branch'], []],
    ['worktree branch ref', ['receipts', 0, 'worktree', 'branchRef'], {}],
    ['worktree base branch', ['receipts', 0, 'worktree', 'baseBranch'], null],
    ['worktree head commit', ['receipts', 0, 'worktree', 'headCommit'], ['a'.repeat(40)]],
    ['worktree expected base commit', ['receipts', 0, 'worktree', 'expectedBaseCommit'], 42],
    ['git common dir', ['receipts', 0, 'worktree', 'gitCommonDir'], null],
    ['worktree path', ['receipts', 0, 'worktree', 'worktreePath'], []],
    ['worktree identity', ['receipts', 0, 'worktree', 'worktreeIdentity'], null],
    ['worktree identity device', ['receipts', 0, 'worktree', 'worktreeIdentity', 'device'], {}],
    ['worktree identity inode', ['receipts', 0, 'worktree', 'worktreeIdentity', 'inode'], []],
    ['worktree git dir', ['receipts', 0, 'worktree', 'worktreeGitDir'], null],
    ['git entry identity', ['receipts', 0, 'worktree', 'gitEntryIdentity'], []],
    ['git entry inode', ['receipts', 0, 'worktree', 'gitEntryIdentity', 'inode'], {}],
    ['worktree relative cwd', ['receipts', 0, 'worktree', 'relativeCwd'], null],
    ['resolved cwd path', ['receipts', 0, 'worktree', 'resolvedCwdPath'], null],
    ['resolved cwd identity', ['receipts', 0, 'worktree', 'resolvedCwdIdentity'], null],
    ['verified clean marker', ['receipts', 0, 'worktree', 'clean'], false],
    ['session id', ['receipts', 0, 'sessionId'], null],
    ['channel id', ['receipts', 0, 'channelId'], {}],
    ['channel object', ['receipts', 0, 'channel'], []],
    ['channel generation', ['receipts', 0, 'channel', 'generation'], 0],
    ['channel lifecycle', ['receipts', 0, 'channel', 'lifecycle'], 'bogus'],
    ['channel connection epoch', ['receipts', 0, 'channel', 'connectionEpoch'], {}],
    ['channel current id', ['receipts', 0, 'channel', 'channelId'], {}],
    ['channel id mismatch', ['receipts', 0, 'channel', 'channelId'], 'channel-other'],
    ['terminal result', ['receipts', 0, 'result'], null],
    ['terminal result request id', ['receipts', 0, 'result', 'requestId'], []],
    ['terminal exit code', ['receipts', 0, 'result', 'exitCode'], '0'],
    ['tombstone object', ['tombstones', 0], null],
    ['tombstone key', ['tombstones', 0, 'key'], []],
    ['tombstone binding id', ['tombstones', 0, 'key', 'bindingId'], null],
    ['tombstone request id', ['tombstones', 0, 'key', 'requestId'], {}],
    ['tombstone fingerprint', ['tombstones', 0, 'fingerprint'], null],
    ['tombstone result', ['tombstones', 0, 'result'], {}],
    ['tombstone result request id', ['tombstones', 0, 'result', 'requestId'], []],
    ['tombstone terminal time', ['tombstones', 0, 'terminalAt'], null],
    ['tombstone delete time', ['tombstones', 0, 'deleteAfter'], []],
    ['tombstone session id', ['tombstones', 0, 'sessionId'], null],
  ]
  return [
    ['root null', null],
    ['root array', []],
    ...mutations.map(([name, path, value]) => [name, mutateJson(validPersistedImage(), path, value)] as const),
  ]
}

function mutateJson(source: unknown, path: readonly (string | number)[], value: unknown): unknown {
  const copy = structuredClone(source) as Record<string | number, unknown>
  let parent = copy
  for (const segment of path.slice(0, -1)) parent = parent[segment] as Record<string | number, unknown>
  parent[path.at(-1)!] = value
  return copy
}

function nestedJsonValue(objectDepth: number): unknown {
  let value: unknown = 'leaf'
  for (let depth = 0; depth < objectDepth; depth += 1) value = { child: value }
  return value
}

function imageWithReceiptAddition(value: unknown): SessionReceiptLedgerImage {
  const image = validPersistedImage()
  return {
    ...image,
    receipts: [{ ...image.receipts[0]!, additive: value } as SessionReceipt, ...image.receipts.slice(1)],
  }
}

describe('production session receipt ledger', () => {
  it('serializes concurrent exact claims into one receipt and one known replay', async () => {
    const held = memoryStorage()
    const ledger = createSessionReceiptLedger({ storage: held.storage, clock })
    const candidate = request()
    const outcomes = await Promise.all([
      ledger.claim(candidate, 'f'.repeat(64), '2026-08-21T00:00:00Z'),
      ledger.claim(candidate, 'f'.repeat(64), '2026-08-21T00:00:00Z'),
    ])
    expect(outcomes.map(outcome => outcome.status).sort()).toEqual(['claimed', 'known'])
    expect(held.image().receipts).toHaveLength(1)
  })

  it('classifies a cross-instance compare-and-set winner as known instead of unavailable', async () => {
    const held = memoryStorage()
    const first = createSessionReceiptLedger({ storage: held.storage, clock })
    const second = createSessionReceiptLedger({ storage: held.storage, clock })
    const outcomes = await Promise.all([
      first.claim(request(), 'f'.repeat(64), '2026-08-21T00:00:00Z'),
      second.claim(request(), 'f'.repeat(64), '2026-08-21T00:00:00Z'),
    ])
    expect(outcomes.map(outcome => outcome.status).sort()).toEqual(['claimed', 'known'])
    expect(held.image().receipts).toHaveLength(1)
  })

  it('retries an unrelated cross-instance compare-and-set winner', async () => {
    const held = memoryStorage()
    const first = createSessionReceiptLedger({ storage: held.storage, clock })
    const second = createSessionReceiptLedger({ storage: held.storage, clock })
    const outcomes = await Promise.all([
      first.claim(request(1), 'a'.repeat(64), '2026-08-21T00:00:00Z'),
      second.claim(request(2), 'b'.repeat(64), '2026-08-21T00:00:00Z'),
    ])
    expect(outcomes.map(outcome => outcome.status)).toEqual(['claimed', 'claimed'])
    expect(held.image().receipts).toHaveLength(2)
  })

  it('rechecks expiry with the runner clock after an unrelated compare-and-set conflict', async () => {
    let currentTime = Date.parse('2026-08-21T00:00:00Z')
    let image = { ...emptyImage(), revision: 1 }
    const storage: SessionReceiptStorage = {
      load: async () => ({ status: 'loaded', image: structuredClone(image) }),
      replace: async () => {
        currentTime = Date.parse('2026-08-21T00:00:02Z')
        image = { ...image, revision: image.revision + 1 }
        return { status: 'conflict', current: structuredClone(image) }
      },
    }
    const ledger = createSessionReceiptLedger({ storage, clock: { now: () => currentTime, sleep: async () => undefined } })
    const expiring = { ...request(), expiresAt: '2026-08-21T00:00:01Z' }
    await expect(ledger.claim(expiring, 'a'.repeat(64), '2026-08-21T00:00:00Z'))
      .resolves.toEqual({ status: 'storage-unavailable' })
    expect(image.receipts).toEqual([])
  })

  it('keeps the first fingerprint immutable across a conflicting duplicate', async () => {
    const held = memoryStorage()
    const ledger = createSessionReceiptLedger({ storage: held.storage, clock })
    await expect(ledger.claim(request(), 'a'.repeat(64), '2026-08-21T00:00:00Z')).resolves.toMatchObject({ status: 'claimed' })
    await expect(ledger.claim(request(), 'b'.repeat(64), '2026-08-21T00:00:00Z')).resolves.toEqual({ status: 'conflict' })
    expect(held.image().receipts[0]?.fingerprint).toBe('a'.repeat(64))
  })

  it('durably raises the capacity block before returning at-capacity', async () => {
    const initial = emptyImage()
    initial.receipts = Array.from({ length: MAX_IN_FLIGHT_SESSION_RECEIPTS }, (_, index) => receipt(index + 1, 'accepted', '2026-08-21T00:00:00Z'))
    const held = memoryStorage(initial)
    const ledger = createSessionReceiptLedger({ storage: held.storage, clock })
    await expect(ledger.claim(request(), 'f'.repeat(64), '2026-08-21T00:00:00Z')).resolves.toEqual({
      status: 'at-capacity',
      blockedUntil: '2026-08-21T00:10:00Z',
    })
    expect(held.image().capacityBlockedUntil).toBe('2026-08-21T00:10:00Z')
    expect(held.image().receipts).toHaveLength(MAX_IN_FLIGHT_SESSION_RECEIPTS)
  })

  it('rejects an unknown request whose expiry exceeds the trusted 24-hour window', async () => {
    const held = memoryStorage()
    const ledger = createSessionReceiptLedger({ storage: held.storage, clock })
    const untrusted = { ...request(), expiresAt: '2026-09-21T00:00:00Z' }
    await expect(ledger.claim(untrusted, 'f'.repeat(64), '2026-08-21T00:00:00Z'))
      .resolves.toEqual({ status: 'storage-unavailable' })
    expect(held.image()).toEqual(emptyImage())
  })

  it('classifies concurrent capacity-block compare-and-set losers as at-capacity', async () => {
    const initial = emptyImage()
    initial.receipts = Array.from({ length: MAX_IN_FLIGHT_SESSION_RECEIPTS }, (_, index) => receipt(index + 1, 'accepted', '2026-08-21T00:00:00Z'))
    const held = memoryStorage(initial)
    const first = createSessionReceiptLedger({ storage: held.storage, clock })
    const second = createSessionReceiptLedger({ storage: held.storage, clock })
    const outcomes = await Promise.all([
      first.claim(request(100), 'a'.repeat(64), '2026-08-21T00:00:00Z'),
      second.claim(request(101), 'b'.repeat(64), '2026-08-21T00:00:00Z'),
    ])
    expect(outcomes.every(outcome => outcome.status === 'at-capacity')).toBe(true)
    expect(held.image().capacityBlockedUntil).toBe('2026-08-21T00:10:00Z')
  })

  it('restarts the complete claim after a capacity-block conflict frees an in-flight slot', async () => {
    const initial = emptyImage()
    initial.receipts = Array.from({ length: MAX_IN_FLIGHT_SESSION_RECEIPTS }, (_, index) => receipt(index + 1, 'accepted', '2026-08-21T00:00:00Z'))
    const raced = storageWithFirstConflict(initial, current => ({
      ...current,
      receipts: [
        receipt(1, 'finished', '2026-08-19T00:00:00Z'),
        receipt(2, 'finished', '2026-08-19T00:00:00Z'),
        ...current.receipts.slice(2),
        receipt(101, 'accepted', '2026-08-21T00:00:00Z'),
      ],
    }))
    await expect(createSessionReceiptLedger({ storage: raced.storage, clock })
      .claim(request(100), 'f'.repeat(64), '2026-08-21T00:00:00Z'))
      .resolves.toMatchObject({ status: 'claimed', receipt: { key: { requestId: request(100).requestId } } })
    expect(raced.writes()).toBe(2)
    expect(raced.image()).toMatchObject({ capacityBlockedUntil: null })
  })

  it('replays a same-key winner after a capacity-block conflict', async () => {
    const initial = emptyImage()
    initial.receipts = Array.from({ length: MAX_IN_FLIGHT_SESSION_RECEIPTS }, (_, index) => receipt(index + 1, 'accepted', '2026-08-21T00:00:00Z'))
    const winner = { ...receipt(100, 'accepted', '2026-08-21T00:00:00Z'), fingerprint: 'f'.repeat(64) }
    const raced = storageWithFirstConflict(initial, current => ({
      ...current,
      receipts: [receipt(1, 'finished', '2026-08-19T00:00:00Z'), ...current.receipts.slice(1), winner],
    }))
    await expect(createSessionReceiptLedger({ storage: raced.storage, clock })
      .claim(request(100), winner.fingerprint, '2026-08-21T00:00:00Z'))
      .resolves.toMatchObject({ status: 'known', value: { key: winner.key } })
    expect(raced.writes()).toBe(1)
    expect(raced.image().capacityBlockedUntil).toBeNull()
  })

  it('restarts the complete claim after compaction frees full-record capacity', async () => {
    const terminalAt = '2026-08-19T00:00:00Z'
    const initial = emptyImage()
    initial.receipts = Array.from({ length: MAX_FULL_SESSION_RECEIPTS }, (_, index) => receipt(index + 1, 'finished', terminalAt))
    const retired = initial.receipts[0]!
    const raced = storageWithFirstConflict(initial, current => ({
      ...current,
      receipts: current.receipts.slice(1),
      tombstones: [{
        key: retired.key,
        fingerprint: retired.fingerprint,
        result: { type: 'SESSION_FINISHED', requestId: retired.key.requestId, exitCode: 0, signal: null },
        ...(retired.sessionId ? { sessionId: retired.sessionId } : {}),
        terminalAt,
        deleteAfter: '2026-09-18T00:00:00.000Z',
      }],
    }))
    await expect(createSessionReceiptLedger({ storage: raced.storage, clock })
      .claim(request(5_000), 'e'.repeat(64), '2026-08-21T00:00:00Z'))
      .resolves.toMatchObject({ status: 'claimed' })
    expect(raced.writes()).toBe(2)
    expect(raced.image()).toMatchObject({ capacityBlockedUntil: null })
  })

  it('uses one bounded retry budget for repeated capacity-block conflicts', async () => {
    const initial = emptyImage()
    initial.receipts = Array.from({ length: MAX_IN_FLIGHT_SESSION_RECEIPTS }, (_, index) => receipt(index + 1, 'accepted', '2026-08-21T00:00:00Z'))
    let image = structuredClone(initial)
    let writes = 0
    const storage: SessionReceiptStorage = {
      load: async () => ({ status: 'loaded', image: structuredClone(image) }),
      replace: async () => {
        writes += 1
        image = { ...image, revision: image.revision + 1 }
        return { status: 'conflict', current: structuredClone(image) }
      },
    }
    await expect(createSessionReceiptLedger({ storage, clock })
      .claim(request(100), 'f'.repeat(64), '2026-08-21T00:00:00Z'))
      .resolves.toEqual({ status: 'storage-unavailable' })
    expect(writes).toBe(8)
    expect(image.capacityBlockedUntil).toBeNull()
  })

  it('extends an active capacity block to every later unknown request deadline', async () => {
    const initial = emptyImage()
    initial.capacityBlockedUntil = '2026-08-21T00:05:00Z'
    const held = memoryStorage(initial)
    const ledger = createSessionReceiptLedger({ storage: held.storage, clock })
    const later = { ...request(1), expiresAt: '2026-08-21T00:12:00Z' }
    await expect(ledger.claim(later, 'f'.repeat(64), '2026-08-21T00:00:00Z')).resolves.toEqual({
      status: 'at-capacity',
      blockedUntil: later.expiresAt,
    })
    expect(held.image()).toMatchObject({ revision: 2, capacityBlockedUntil: later.expiresAt })

    const earlier = { ...request(2), expiresAt: '2026-08-21T00:11:00Z' }
    await expect(ledger.claim(earlier, 'e'.repeat(64), '2026-08-21T00:00:00Z')).resolves.toEqual({
      status: 'at-capacity',
      blockedUntil: later.expiresAt,
    })
    expect(held.image()).toMatchObject({ revision: 2, capacityBlockedUntil: later.expiresAt })
  })

  it('compacts only old terminal receipts and preserves live receipts', async () => {
    const initial = emptyImage()
    initial.receipts = [
      receipt(1, 'finished', '2026-08-19T00:00:00Z'),
      receipt(2, 'started', '2026-08-20T23:59:00Z'),
    ]
    const held = memoryStorage(initial)
    const ledger = createSessionReceiptLedger({ storage: held.storage, clock })
    await ledger.compact('2026-08-21T00:00:00Z')
    expect(held.image().receipts.map(value => value.key.requestId)).toEqual([request(2).requestId])
    expect(held.image().tombstones[0]).toMatchObject({ key: { requestId: request(1).requestId } })
  })

  it('rejects terminal regression and malformed persisted receipt states', async () => {
    const initial = emptyImage()
    initial.receipts = [receipt(1, 'finished', '2026-08-19T00:00:00Z')]
    const held = memoryStorage(initial)
    const ledger = createSessionReceiptLedger({ storage: held.storage, clock })
    await expect(ledger.replace(1, receipt(1, 'finished', '2026-08-19T00:00:00Z'))).resolves.toMatchObject({ status: 'updated' })
    const mutated = {
      ...receipt(1, 'finished', '2026-08-19T00:00:00Z'),
      result: { type: 'SESSION_FINISHED' as const, requestId: request(1).requestId, exitCode: 9, signal: null },
    }
    await expect(ledger.replace(1, mutated)).resolves.toMatchObject({ status: 'conflict' })
    const regressed = { ...receipt(1, 'accepted', '2026-08-21T00:00:00Z'), revision: 1 }
    await expect(ledger.replace(1, regressed)).resolves.toMatchObject({ status: 'conflict' })

    const corrupt = emptyImage()
    corrupt.receipts = [{ ...receipt(2, 'accepted', '2026-08-21T00:00:00Z'), state: 'bogus' as SessionReceipt['state'] }]
    const corruptLedger = createSessionReceiptLedger({ storage: memoryStorage(corrupt).storage, clock })
    await expect(corruptLedger.recover()).rejects.toBeInstanceOf(SessionReceiptStorageUnavailableError)
  })

  it('replays an exact terminal replace retry before checking its stale expected revision', async () => {
    const initial = emptyImage()
    initial.receipts = [receipt(1, 'accepted', '2026-08-21T00:00:00Z')]
    const held = memoryStorage(initial)
    const ledger = createSessionReceiptLedger({ storage: held.storage, clock })
    const failed: SessionReceipt = {
      ...initial.receipts[0]!,
      state: 'failed',
      phaseTimestamps: { accepted: '2026-08-21T00:00:00Z', failed: '2026-08-21T00:01:00Z' },
      result: { type: 'SESSION_FAILED', requestId: request(1).requestId, reason: 'project-unknown' },
    }
    const first = await ledger.replace(1, failed)
    expect(first).toMatchObject({ status: 'updated', receipt: { revision: 2 } })
    await expect(ledger.replace(1, failed)).resolves.toEqual(first)
  })

  it('rejects a phase timestamp that rewrites history or predates the current phase', async () => {
    const initial = emptyImage()
    initial.receipts = [receipt(1, 'started', '2026-08-21T00:05:00Z')]
    const held = memoryStorage(initial)
    const ledger = createSessionReceiptLedger({ storage: held.storage, clock })
    const current = initial.receipts[0]!
    const regressed: SessionReceipt = {
      ...current,
      state: 'finished',
      phaseTimestamps: { ...current.phaseTimestamps, finished: '1970-01-01T00:00:00Z' },
      result: { type: 'SESSION_FINISHED', requestId: current.key.requestId, exitCode: 0, signal: null },
    }
    await expect(ledger.replace(1, regressed)).resolves.toMatchObject({ status: 'storage-unavailable' })
    const rewritten = { ...current, phaseTimestamps: { started: '2026-08-21T00:06:00Z' } }
    await expect(ledger.replace(1, rewritten)).resolves.toMatchObject({ status: 'conflict' })
  })

  it('keeps assigned session and channel identities immutable outside generation replacement', async () => {
    const initial = emptyImage()
    initial.receipts = [receipt(1, 'started', '2026-08-21T00:05:00Z')]
    const held = memoryStorage(initial)
    const ledger = createSessionReceiptLedger({ storage: held.storage, clock })
    const current = initial.receipts[0]!
    const terminal = {
      ...current,
      state: 'finished' as const,
      phaseTimestamps: { ...current.phaseTimestamps, finished: '2026-08-21T00:06:00Z' },
      result: { type: 'SESSION_FINISHED' as const, requestId: current.key.requestId, exitCode: 0, signal: null },
    }
    await expect(ledger.replace(1, { ...terminal, sessionId: 'different-session' }))
      .resolves.toMatchObject({ status: 'conflict' })
    await expect(ledger.replace(1, {
      ...terminal,
      channelId: 'different-channel',
      channel: {
        generation: terminal.channel!.generation,
        lifecycle: 'live',
        channelId: 'different-channel',
        ...(terminal.channel!.connectionEpoch ? { connectionEpoch: terminal.channel!.connectionEpoch } : {}),
      },
    })).resolves.toMatchObject({ status: 'conflict' })
  })

  it('preserves assigned project and worktree evidence across later transitions', async () => {
    const initial = emptyImage()
    const started = {
      ...receipt(1, 'started', '2026-08-21T00:05:00Z'),
      project: { projectId: 'modulastack', repoPath: '/repos/modulastack', worktreesRoot: '/worktrees', revision: 1 },
    }
    initial.receipts = [started]
    const held = memoryStorage(initial)
    const ledger = createSessionReceiptLedger({ storage: held.storage, clock })
    const terminal = {
      ...started,
      state: 'finished' as const,
      phaseTimestamps: { ...started.phaseTimestamps, finished: '2026-08-21T00:06:00Z' },
      result: { type: 'SESSION_FINISHED' as const, requestId: started.key.requestId, exitCode: 0, signal: null },
    }
    await expect(ledger.replace(1, {
      ...terminal,
      project: { ...started.project, repoPath: '/repos/other' },
    })).resolves.toMatchObject({ status: 'conflict' })
    await expect(ledger.replace(1, {
      ...terminal,
      worktree: { ...started.worktree, resolvedCwdPath: '/worktrees/other' },
    } as SessionReceipt)).resolves.toMatchObject({ status: 'conflict' })
  })

  it('bounds queued operations before a stalled storage call can retain an unbounded burst', async () => {
    let release!: () => void
    const stalled = new Promise<void>(resolve => { release = resolve })
    const storage: SessionReceiptStorage = {
      load: async () => {
        await stalled
        return { status: 'loaded', image: emptyImage() }
      },
      replace: async () => ({ status: 'storage-unavailable' }),
    }
    const ledger = createSessionReceiptLedger({ storage, clock })
    const queued = Array.from({ length: MAX_PENDING_SESSION_LEDGER_OPERATIONS }, () => ledger.lookup({
      bindingId: request().bindingId,
      requestId: request().requestId,
    }))
    await expect(ledger.lookup({ bindingId: request().bindingId, requestId: request().requestId }))
      .rejects.toBeInstanceOf(SessionReceiptStorageUnavailableError)
    release()
    await expect(Promise.all(queued)).resolves.toHaveLength(MAX_PENDING_SESSION_LEDGER_OPERATIONS)
  })

  it('reserves the proved maximum nonterminal record before admission', async () => {
    const initial = emptyImage()
    const held: SessionReceipt[] = []
    for (let index = 1; index < 500; index += 1) {
      const candidate = { ...receipt(index, 'finished', '2026-08-19T00:00:00Z'), padding: 'x'.repeat(48_000) } as SessionReceipt
      const nextBytes = Buffer.byteLength(JSON.stringify([...held, candidate]))
      if (nextBytes > MAX_FULL_SESSION_RECEIPT_BYTES) break
      held.push(candidate)
      if (nextBytes + MAX_SESSION_RECEIPT_RECORD_BYTES > MAX_FULL_SESSION_RECEIPT_BYTES) break
    }
    initial.receipts = held
    expect(Buffer.byteLength(JSON.stringify(initial.receipts)) + MAX_SESSION_RECEIPT_RECORD_BYTES).toBeGreaterThan(MAX_FULL_SESSION_RECEIPT_BYTES)
    const storage = memoryStorage(initial)
    const ledger = createSessionReceiptLedger({ storage: storage.storage, clock })
    await expect(ledger.claim(request(), 'f'.repeat(64), '2026-08-21T00:00:00Z')).resolves.toMatchObject({ status: 'at-capacity' })
  })

  it('accepts the valid baseline used by the malformed mutation matrix', async () => {
    const held = memoryStorage(validPersistedImage())
    const ledger = createSessionReceiptLedger({ storage: held.storage, clock })
    await expect(ledger.lookup({ bindingId: request(1).bindingId, requestId: request(1).requestId })).resolves.toMatchObject({ status: 'receipt' })
    await expect(ledger.recover()).resolves.toEqual([])
    await expect(ledger.claim(request(), 'f'.repeat(64), '2026-08-21T00:00:00Z')).resolves.toMatchObject({ status: 'claimed' })
  })

  it('accepts the maximum JSON depth and publishes the ruled complexity limits', async () => {
    expect(MAX_SESSION_LEDGER_JSON_DEPTH).toBe(64)
    expect(MAX_SESSION_RECEIPT_JSON_NODES).toBe(8_192)
    expect(MAX_SESSION_LEDGER_JSON_NODES).toBe(1_000_000)
    const valueDepthAtImageRoot = MAX_SESSION_LEDGER_JSON_DEPTH - 3
    const held = memoryStorage(imageWithReceiptAddition(nestedJsonValue(valueDepthAtImageRoot)))
    const ledger = createSessionReceiptLedger({ storage: held.storage, clock })
    await expect(ledger.lookup({ bindingId: request(1).bindingId, requestId: request(1).requestId })).resolves.toMatchObject({ status: 'receipt' })
  })

  it('rejects over-depth, over-complex, cyclic, and non-JSON values before writing', async () => {
    const overDepth = imageWithReceiptAddition(nestedJsonValue(MAX_SESSION_LEDGER_JSON_DEPTH - 2))
    const veryDeep = imageWithReceiptAddition(nestedJsonValue(5_000))
    const cyclic = imageWithReceiptAddition({})
    const cycle = (cyclic.receipts[0] as SessionReceipt & { additive: Record<string, unknown> }).additive
    cycle.self = cycle
    const accessor = Object.create(null) as Record<string, unknown>
    Object.defineProperty(accessor, 'child', { enumerable: true, get: () => 'not JSON data' })
    const symbolProperty = { child: 'value' }
    Object.defineProperty(symbolProperty, Symbol('hidden'), { value: 'not JSON data', enumerable: true })
    const cases: Array<readonly [string, SessionReceiptLedgerImage]> = [
      ['depth 65', overDepth],
      ['depth 5000', veryDeep],
      ['receipt node limit', imageWithReceiptAddition(Array.from({ length: MAX_SESSION_RECEIPT_JSON_NODES }, () => null))],
      ['cyclic value', cyclic],
      ['non-finite number', imageWithReceiptAddition(Number.NaN)],
      ['undefined value', imageWithReceiptAddition(undefined)],
      ['bigint value', imageWithReceiptAddition(1n)],
      ['function value', imageWithReceiptAddition(() => undefined)],
      ['symbol value', imageWithReceiptAddition(Symbol('value'))],
      ['accessor value', imageWithReceiptAddition(accessor)],
      ['symbol property', imageWithReceiptAddition(symbolProperty)],
      ['sparse array', imageWithReceiptAddition(new Array(1))],
      ['non-ordinary object', imageWithReceiptAddition(new Date(0))],
    ]
    for (const [name, image] of cases) {
      let writes = 0
      const ledger = createSessionReceiptLedger({
        clock,
        storage: {
          load: async () => ({ status: 'loaded', image }),
          replace: async () => {
            writes += 1
            return { status: 'storage-unavailable' }
          },
        },
      })
      await expect(ledger.recover(), name).rejects.toBeInstanceOf(SessionReceiptStorageUnavailableError)
      await expect(ledger.claim(request(), 'f'.repeat(64), '2026-08-21T00:00:00Z'), name).resolves.toEqual({ status: 'storage-unavailable' })
      expect(writes, name).toBe(0)
    }
  })

  it('preflights the complete candidate image before a standalone-valid receipt mutation', async () => {
    const candidate = {
      ...receipt(1, 'finished', '2026-08-19T00:00:00Z'),
      additive: nestedJsonValue(MAX_SESSION_LEDGER_JSON_DEPTH - 1),
    } as SessionReceipt
    let writes = 0
    const ledger = createSessionReceiptLedger({
      clock,
      storage: {
        load: async () => ({ status: 'loaded', image: emptyImage() }),
        replace: async () => {
          writes += 1
          return { status: 'storage-unavailable' }
        },
      },
    })
    await expect(ledger.replace(1, candidate)).resolves.toEqual({ status: 'storage-unavailable' })
    expect(writes).toBe(0)
  })

  it('classifies every malformed nested JSON shape as storage unavailable without writing', async () => {
    for (const [name, image] of invalidPersistedImages()) {
      let writes = 0
      const storage: SessionReceiptStorage = {
        load: async () => ({ status: 'loaded', image: image as SessionReceiptLedgerImage }),
        replace: async () => {
          writes += 1
          return { status: 'storage-unavailable' }
        },
      }
      const ledger = createSessionReceiptLedger({ storage, clock })
      const key = { bindingId: request().bindingId, requestId: request().requestId }
      await expect(ledger.lookup(key), name).rejects.toBeInstanceOf(SessionReceiptStorageUnavailableError)
      await expect(ledger.recover(), name).rejects.toBeInstanceOf(SessionReceiptStorageUnavailableError)
      await expect(ledger.compact('2026-08-21T00:00:00Z'), name).rejects.toBeInstanceOf(SessionReceiptStorageUnavailableError)
      await expect(ledger.claim(request(), 'f'.repeat(64), '2026-08-21T00:00:00Z'), name).resolves.toEqual({ status: 'storage-unavailable' })
      await expect(ledger.replace(1, receipt(1, 'finished', '2026-08-19T00:00:00Z')), name).resolves.toEqual({ status: 'storage-unavailable' })
      expect(writes, name).toBe(0)
    }
  })

  it('fails closed on unreadable storage or duplicate persisted keys', async () => {
    const unavailable = createSessionReceiptLedger({
      clock,
      storage: {
        load: async () => ({ status: 'storage-unavailable' }),
        replace: async () => ({ status: 'storage-unavailable' }),
      },
    })
    await expect(unavailable.lookup({ bindingId: request().bindingId, requestId: request().requestId })).rejects.toBeInstanceOf(
      SessionReceiptStorageUnavailableError,
    )

    const duplicate = emptyImage()
    duplicate.receipts = [receipt(1, 'accepted', '2026-08-21T00:00:00Z'), receipt(1, 'accepted', '2026-08-21T00:00:00Z')]
    const corrupt = createSessionReceiptLedger({ storage: memoryStorage(duplicate).storage, clock })
    await expect(corrupt.recover()).rejects.toBeInstanceOf(SessionReceiptStorageUnavailableError)

    const overCap = emptyImage()
    overCap.receipts = Array.from({ length: MAX_IN_FLIGHT_SESSION_RECEIPTS + 1 }, (_, index) => receipt(index + 1, 'accepted', '2026-08-21T00:00:00Z'))
    const overCapLedger = createSessionReceiptLedger({ storage: memoryStorage(overCap).storage, clock })
    await expect(overCapLedger.recover()).rejects.toBeInstanceOf(SessionReceiptStorageUnavailableError)
  })
})

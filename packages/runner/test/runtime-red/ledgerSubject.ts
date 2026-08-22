import type { SessionStartMessage } from '@modulastack/runner-protocol'
import { isDeepStrictEqual } from 'node:util'
import {
  MAX_FULL_SESSION_RECEIPTS,
  MAX_FULL_SESSION_RECEIPT_BYTES,
  MAX_IN_FLIGHT_SESSION_RECEIPTS,
  MAX_SESSION_TOMBSTONES,
  MAX_SESSION_TOMBSTONE_BYTES,
  SessionReceiptLedgerNotImplementedError,
  createSessionReceiptLedger,
  type SessionLaunchAction,
  type SessionReceipt,
  type SessionReceiptLedgerImage,
  type SessionReceiptStorageReplace,
  type SessionReceiptTombstone,
  type SessionWorktreeVerifiedSnapshot,
} from '../../src/index.js'
import { terminalReplayMatchesStored } from './launcherEvidence.js'
import { createRecorder, type RuntimeRecorder } from './recorder.js'
import { requestIdFor } from './scenarioIdentity.js'
import type { RuntimeObservation, RuntimeScenario } from './scenarioTypes.js'

const bindingId = '123e4567-e89b-42d3-a456-426614174000'
const emptyImage: SessionReceiptLedgerImage = {
  schemaVersion: 1,
  revision: 1,
  capacityBlockedUntil: null,
  receipts: [],
  tombstones: [],
}

export async function observeLedgerScenario(scenario: RuntimeScenario): Promise<RuntimeObservation> {
  if (scenario.fixture === 'global-capacity-matrix') return observeCapacityMatrix(scenario)
  return observeLedgerCase(scenario)
}

async function observeLedgerCase(scenario: RuntimeScenario): Promise<RuntimeObservation> {
  const recorder = createRecorder()
  let image = imageFor(scenario)
  const ledger = createSessionReceiptLedger({
    clock: {
      now() {
        if (scenario.fixture === 'compact-after-24h') recorder.record('clock:24h')
        else recorder.record('clock.now')
        return clockFor(scenario.fixture)
      },
      async sleep(milliseconds) {
        recorder.record(`clock.sleep:${milliseconds}`)
      },
    },
    storage: {
      async load() {
        recorder.record(`storage.fixture:${scenario.fixture}`)
        recorder.record(`storage.load:${image.receipts.length}-receipts`)
        recorder.record(`storage.load:${image.tombstones.length}-tombstones`)
        recorder.record(`storage.load:receipt-bytes:${jsonArrayBytes(image.receipts)}`)
        recorder.record(`storage.load:tombstone-bytes:${jsonArrayBytes(image.tombstones)}`)
        if (scenario.fixture === 'tombstone-retention') recorder.record('storage.load:tombstone-before-expiry')
        return { status: 'loaded', image }
      },
      async replace(expectedRevision, next): Promise<SessionReceiptStorageReplace> {
        recorder.record(`storage.replace:revision:${expectedRevision}`)
        if (next.capacityBlockedUntil) recorder.record('storage.replace:capacityBlockedUntil')
        for (const event of classifyLedgerImageChange(image, next, scenario.fixture)) recorder.record(event)
        image = { ...next, revision: expectedRevision + 1 }
        return { status: 'updated', image }
      },
    },
  })
  try {
    const result = await invokeLedger(scenario, ledger, recorder)
    recordCapacityEvidence(recorder.record, scenario.fixture, result, image)
    return { status: 'observed', subject: 'ledger', result, events: recorder.events, output: recorder.output }
  } catch (error) {
    if (error instanceof SessionReceiptLedgerNotImplementedError) {
      return { status: 'missing-production-runtime', subject: 'ledger', error: error.name }
    }
    throw error
  }
}

async function observeCapacityMatrix(scenario: RuntimeScenario): Promise<RuntimeObservation> {
  const recorder = createRecorder()
  recorder.record(`storage.fixture:${scenario.fixture}`)
  const cases = [
    ['capacity-receipt-count', 'capacity.receipts-count:blocked'],
    ['capacity-receipt-bytes', 'capacity.receipts-bytes:blocked'],
    ['capacity-inflight', 'capacity.inflight:blocked'],
    ['capacity-tombstone-count', 'capacity.tombstones-count:preserved'],
    ['capacity-tombstone-bytes', 'capacity.tombstones-bytes:preserved'],
  ] as const
  let complete = true
  for (const [fixture, expectedEvent] of cases) {
    const observation = await observeLedgerCase({ ...scenario, fixture, stimulus: `${scenario.stimulus}:${fixture}` })
    if (observation.status === 'missing-production-runtime') return observation
    for (const event of observation.events) recorder.record(event.slice(event.indexOf(':') + 1))
    complete &&= observation.events.some(event => event.includes(expectedEvent))
  }
  if (complete) recorder.record('capacity.matrix:complete')
  return { status: 'observed', subject: 'ledger', result: 'ledger:capacity-matrix:complete', events: recorder.events, output: recorder.output }
}

async function invokeLedger(
  scenario: RuntimeScenario,
  ledger: ReturnType<typeof createSessionReceiptLedger>,
  recorder: RuntimeRecorder,
): Promise<string> {
  const request = requestFor(scenario.obligationId, scenario.fixture)
  if (scenario.fixture === 'persist-schema-v1') {
    const result = await ledger.replace(1, receiptFor(request, 'finished'))
    return `ledger:replace:${result.status}`
  }
  if (isClaimCapacityFixture(scenario.fixture)) {
    const result = await ledger.claim(request, 'f'.repeat(64), '2026-08-21T00:00:00Z')
    return `ledger:claim:${result.status}`
  }
  if (isCompactionFixture(scenario.fixture)) {
    await ledger.compact(new Date(clockFor(scenario.fixture)).toISOString())
    return 'ledger:compact:complete'
  }
  const result = await ledger.lookup({ bindingId: request.bindingId, requestId: request.requestId })
  if (scenario.fixture === 'tombstone-retention' && result.status === 'tombstone') {
    const expected = tombstoneFor(request)
    if (JSON.stringify(result.tombstone) === JSON.stringify(expected)) recorder.record('ledger.lookup:tombstone-terminal')
    return 'ledger:lookup:known-terminal'
  }
  return `ledger:lookup:${result.status}`
}

function imageFor(scenario: RuntimeScenario): SessionReceiptLedgerImage {
  const request = requestFor(scenario.obligationId, scenario.fixture)
  if (scenario.fixture === 'global-capacity-full' || scenario.fixture === 'capacity-receipt-count') {
    const receipt = receiptFor(request, 'finished')
    return { ...emptyImage, receipts: indexedReceipts(receipt, MAX_FULL_SESSION_RECEIPTS) }
  }
  if (scenario.fixture === 'capacity-receipt-bytes') return receiptByteBoundaryImage(request)
  if (scenario.fixture === 'capacity-inflight') {
    const receipt = receiptFor(request, 'accepted')
    return { ...emptyImage, receipts: indexedReceipts(receipt, MAX_IN_FLIGHT_SESSION_RECEIPTS) }
  }
  if (scenario.fixture === 'capacity-tombstone-count') {
    return {
      ...emptyImage,
      receipts: [receiptFor(request, 'finished', '2026-08-18T00:00:00Z')],
      tombstones: indexedTombstones(tombstoneFor(request), MAX_SESSION_TOMBSTONES),
    }
  }
  if (scenario.fixture === 'capacity-tombstone-bytes') return tombstoneByteBoundaryImage(request)
  if (scenario.fixture === 'compact-after-24h') return { ...emptyImage, receipts: [receiptFor(request, 'finished', '2026-08-19T00:00:00Z')] }
  if (scenario.fixture === 'compact-oldest-first') return compactionImage(request)
  if (scenario.fixture === 'tombstone-retention') return { ...emptyImage, tombstones: [tombstoneFor(request)] }
  return emptyImage
}

function compactionImage(request: SessionStartMessage): SessionReceiptLedgerImage {
  return {
    ...emptyImage,
    receipts: [
      receiptFor(request, 'finished', '2026-08-18T00:00:00Z'),
      receiptFor(withRequestId(request, indexedRequestId(2)), 'finished', '2026-08-21T12:00:00Z'),
      receiptFor(withRequestId(request, indexedRequestId(3)), 'accepted'),
      { ...receiptFor(withRequestId(request, indexedRequestId(4)), 'started'), sessionId: 'session-live', channelId: 'channel-live' },
    ],
  }
}

export async function ledgerTerminalReplayMutationEvidence() {
  const request = requestFor('G1-R07', 'verifier-terminal-replay')
  let image: SessionReceiptLedgerImage = { ...emptyImage, tombstones: [tombstoneFor(request)] }
  const ledger = createSessionReceiptLedger({
    clock: { now: () => Date.parse('2026-08-21T00:00:00Z'), sleep: async () => undefined },
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
  })
  const lookup = await ledger.lookup({ bindingId: request.bindingId, requestId: request.requestId })
  if (lookup.status !== 'tombstone') throw new Error('terminal replay fixture did not retrieve its tombstone')
  const key = `${request.bindingId}:${request.requestId}`
  const replay: SessionLaunchAction = { kind: 'message', message: lookup.tombstone.result }
  const stored = new Map<string, SessionReceipt | SessionReceiptTombstone>([[key, lookup.tombstone]])
  const matching = terminalReplayMatchesStored([replay], stored, request)
  const wrongResponse = {
    kind: 'message',
    message: { ...lookup.tombstone.result, requestId: alternateRequestId(request.requestId) },
  } satisfies SessionLaunchAction
  const wrongResponseId = terminalReplayMatchesStored([wrongResponse], stored, request)
  const doubleTerminal = terminalReplayMatchesStored([replay, replay], stored, request)
  const wrongRetained: SessionReceiptTombstone = {
    ...lookup.tombstone,
    result: { type: 'SESSION_FAILED', requestId: request.requestId, reason: 'spawn-failed' },
  }
  stored.set(key, wrongRetained)
  const wrongRetainedResult = terminalReplayMatchesStored([replay], stored, request)
  return { matching, wrongResponseId, doubleTerminal, wrongRetainedResult }
}

export function ledgerCapacityFixtureEvidence() {
  const scenario = (fixture: string) => ({ obligationId: 'G1-R16', fixture } as unknown as RuntimeScenario)
  const count = imageFor(scenario('capacity-receipt-count'))
  const bytes = imageFor(scenario('capacity-receipt-bytes'))
  const inflight = imageFor(scenario('capacity-inflight'))
  const tombstoneCount = imageFor(scenario('capacity-tombstone-count'))
  const tombstoneBytes = imageFor(scenario('capacity-tombstone-bytes'))
  const request = requestFor('G1-R16', 'global-capacity-matrix')
  return {
    fullReceiptCount: count.receipts.length,
    receiptBytes: jsonArrayBytes(bytes.receipts),
    receiptBytesWithNext: jsonArrayBytesWith(bytes.receipts, receiptFor(request, 'accepted')),
    inFlightCount: inflight.receipts.filter(receipt => !isTerminal(receipt)).length,
    tombstoneCount: tombstoneCount.tombstones.length,
    tombstoneCountSourceRetained: tombstoneCount.receipts.some(receipt => receipt.state === 'finished'),
    tombstoneBytes: jsonArrayBytes(tombstoneBytes.tombstones),
    tombstoneBytesWithNext: jsonArrayBytesWith(tombstoneBytes.tombstones, tombstoneFor(request)),
    tombstoneByteSourceRetained: tombstoneBytes.receipts.some(receipt => receipt.state === 'finished'),
  }
}

export function ledgerCompactionMutationEvents(mutant: 'live-eviction' | 'inflight-eviction' | 'unexpired-eviction'): string[] {
  const previous = compactionImage(requestFor('G1-R18', 'compact-oldest-first'))
  const removedRequestId = mutant === 'live-eviction' ? indexedRequestId(4) : mutant === 'inflight-eviction' ? indexedRequestId(3) : indexedRequestId(2)
  const oldest = previous.receipts[0]!
  const next: SessionReceiptLedgerImage = {
    ...previous,
    revision: previous.revision + 1,
    receipts: previous.receipts.slice(1).filter(receipt => receipt.key.requestId !== removedRequestId),
    tombstones: [tombstoneFor(oldest.request)],
  }
  return classifyLedgerImageChange(previous, next, 'compact-oldest-first')
}

type PersistenceMutant =
  | 'revision'
  | 'project-evidence'
  | 'worktree-evidence'
  | 'result-request-id'
  | 'result-type'
  | 'result-payload'
  | 'inject-secret'

type MutatedSessionReceipt = SessionReceipt & { secrets?: { ANTHROPIC_API_KEY: string } }

export function ledgerPersistenceMutationEvents(mutant: PersistenceMutant): string[] {
  const receipt = persistenceMutantReceipt(expectedPersistedReceipt(), mutant)
  return classifyLedgerImageChange(emptyImage, { ...emptyImage, receipts: [receipt] }, 'persist-schema-v1')
}

function persistenceMutantReceipt(expected: SessionReceipt, mutant: PersistenceMutant): MutatedSessionReceipt {
  const requestId = expected.request.requestId
  const mutations = {
    revision: () => ({ ...expected, revision: expected.revision - 1 }),
    'project-evidence': () => ({ ...expected, project: { projectId: 'modulastack', repoPath: '/repos/other', worktreesRoot: '/worktrees', revision: 1 } }),
    'worktree-evidence': () => ({ ...expected, worktree: { ...verifiedWorktree(), branch: 'feat/lane-02' } }),
    'result-request-id': () => ({ ...expected, result: { type: 'SESSION_FINISHED' as const, requestId: alternateRequestId(requestId), exitCode: 0, signal: null } }),
    'result-type': () => ({ ...expected, result: { type: 'SESSION_FAILED' as const, requestId, reason: 'spawn-failed' as const } }),
    'result-payload': () => ({ ...expected, result: { type: 'SESSION_FINISHED' as const, requestId, exitCode: 1, signal: null } }),
    'inject-secret': () => ({ ...expected, secrets: { ANTHROPIC_API_KEY: 'mutant-secret' } }),
  } satisfies Record<PersistenceMutant, () => MutatedSessionReceipt>
  return mutations[mutant]()
}

export function classifyLedgerImageChange(
  previous: SessionReceiptLedgerImage,
  next: SessionReceiptLedgerImage,
  fixture: string,
): string[] {
  const events: string[] = []
  if (fixture === 'persist-schema-v1') classifyPersistedReceipt(next, events)
  if (fixture === 'compact-after-24h' && next.receipts.length < previous.receipts.length && next.tombstones.length > previous.tombstones.length) {
    events.push('storage.replace:receipt-to-tombstone')
  }
  if (fixture === 'compact-oldest-first') classifyCompaction(previous, next, events)
  return events
}

function classifyPersistedReceipt(next: SessionReceiptLedgerImage, events: string[]) {
  const receipt = next.receipts[0]
  if (!receipt) return
  if (isDeepStrictEqual(receipt, expectedPersistedReceipt())) events.push('storage.replace:receipt-fields-complete')
  const serialized = JSON.stringify(receipt)
  const hasSecret = /ANTHROPIC_API_KEY|bearer|attachToken|"secrets"|"token"/i.test(serialized)
  const hasPlan = /\/usr\/bin\/claude|"plan"|"args"|"env"|"endpoint"/i.test(serialized)
  if (hasSecret) events.push('storage.replace:secret')
  if (hasPlan) events.push('storage.replace:launch-plan')
  if (!hasSecret && !hasPlan) events.push('storage.replace:sensitive-fields-absent')
}

function classifyCompaction(previous: SessionReceiptLedgerImage, next: SessionReceiptLedgerImage, events: string[]) {
  const oldestKey = previous.receipts[0]?.key
  if (oldestKey && !containsReceipt(next, oldestKey) && containsTombstone(next, oldestKey)) events.push('storage.replace:oldest-expired-first')
  classifyPreservation(previous, next, indexedRequestId(2), 'unexpired', events)
  classifyPreservation(previous, next, indexedRequestId(3), 'inflight', events)
  classifyPreservation(previous, next, indexedRequestId(4), 'live', events)
}

function classifyPreservation(
  previous: SessionReceiptLedgerImage,
  next: SessionReceiptLedgerImage,
  requestId: string,
  label: 'live' | 'inflight' | 'unexpired',
  events: string[],
) {
  const existed = previous.receipts.some(receipt => receipt.key.requestId === requestId)
  const preserved = next.receipts.some(receipt => receipt.key.requestId === requestId)
  if (existed && preserved) events.push(`storage.replace:${label}-preserved`)
  if (existed && !preserved) events.push(`storage.replace:${label}-evicted`)
}

function recordCapacityEvidence(
  record: (event: string) => void,
  fixture: string,
  result: string,
  image: SessionReceiptLedgerImage,
) {
  const blocked = result === 'ledger:claim:at-capacity' && image.capacityBlockedUntil !== null
  if (fixture === 'capacity-receipt-count' && blocked && image.receipts.length === MAX_FULL_SESSION_RECEIPTS) record('capacity.receipts-count:blocked')
  if (fixture === 'capacity-receipt-bytes' && blocked && !receiptFits(image)) record('capacity.receipts-bytes:blocked')
  if (fixture === 'capacity-inflight' && blocked && image.receipts.filter(receipt => !isTerminal(receipt)).length === MAX_IN_FLIGHT_SESSION_RECEIPTS) record('capacity.inflight:blocked')
  if (fixture === 'capacity-tombstone-count' && tombstoneCapacityPreserved(image, MAX_SESSION_TOMBSTONES)) {
    record('capacity.tombstones-count:preserved')
  }
  if (fixture === 'capacity-tombstone-bytes' && tombstoneByteCapacityPreserved(image)) record('capacity.tombstones-bytes:preserved')
}

function tombstoneCapacityPreserved(image: SessionReceiptLedgerImage, expectedTombstones: number): boolean {
  return image.tombstones.length === expectedTombstones && image.receipts.some(receipt => receipt.state === 'finished')
}

function tombstoneByteCapacityPreserved(image: SessionReceiptLedgerImage): boolean {
  const source = image.receipts.find(receipt => receipt.state === 'finished')
  if (!source) return false
  const next = tombstoneFor(source.request)
  return jsonArrayBytes(image.tombstones) <= MAX_SESSION_TOMBSTONE_BYTES
    && jsonArrayBytesWith(image.tombstones, next) > MAX_SESSION_TOMBSTONE_BYTES
}

function receiptByteBoundaryImage(request: SessionStartMessage): SessionReceiptLedgerImage {
  const receipts: SessionReceipt[] = []
  fillWithinByteLimit(receipts, receiptFor(largeRequest(request), 'finished'), MAX_FULL_SESSION_RECEIPTS - 1, MAX_FULL_SESSION_RECEIPT_BYTES, withReceiptRequestId)
  fillWithinByteLimit(receipts, receiptFor(request, 'accepted'), MAX_FULL_SESSION_RECEIPTS - 1, MAX_FULL_SESSION_RECEIPT_BYTES, withReceiptRequestId)
  return { ...emptyImage, receipts }
}

function tombstoneByteBoundaryImage(request: SessionStartMessage): SessionReceiptLedgerImage {
  const receipt = receiptFor(request, 'finished', '2026-08-18T00:00:00Z')
  const tombstones: SessionReceiptTombstone[] = []
  fillWithinByteLimit(tombstones, { ...tombstoneFor(request), sessionId: 's'.repeat(128) }, MAX_SESSION_TOMBSTONES - 1, MAX_SESSION_TOMBSTONE_BYTES, withTombstoneRequestId)
  fillWithinByteLimit(tombstones, tombstoneFor(request), MAX_SESSION_TOMBSTONES - 1, MAX_SESSION_TOMBSTONE_BYTES, withTombstoneRequestId)
  return { ...emptyImage, receipts: [receipt], tombstones }
}

function largeRequest(request: SessionStartMessage): SessionStartMessage {
  const segment = 'a'.repeat(200)
  return {
    ...request,
    target: {
      ...request.target,
      branch: `feature/${'b'.repeat(240)}`,
      baseBranch: `base/${'c'.repeat(240)}`,
      relativeCwd: `${segment}/${segment}/${segment}/${segment}/${'d'.repeat(190)}`,
    },
  }
}

function expectedPersistedReceipt(): SessionReceipt {
  const receipt = receiptFor(requestFor('G1-R14', 'persist-schema-v1'), 'finished')
  return { ...receipt, revision: receipt.revision + 1 }
}

function receiptFor(request: SessionStartMessage, state: SessionReceipt['state'], terminalAt = '2026-08-21T00:01:00Z'): SessionReceipt {
  const terminal = state === 'finished'
  return {
    schemaVersion: 1,
    revision: 1,
    key: { bindingId: request.bindingId, requestId: request.requestId },
    fingerprint: 'f'.repeat(64),
    request,
    state,
    phaseTimestamps: { [state]: terminalAt },
    project: { projectId: 'modulastack', repoPath: '/repos/modulastack', worktreesRoot: '/worktrees', revision: 1 },
    worktree: verifiedWorktree(),
    sessionId: 'session-stable',
    channelId: 'channel-stable',
    ...(terminal ? { result: { type: 'SESSION_FINISHED' as const, requestId: request.requestId, exitCode: 0, signal: null } } : {}),
  }
}

function verifiedWorktree(): SessionWorktreeVerifiedSnapshot {
  return {
    phase: 'verified', ownership: 'created', branch: 'feat/lane-01', branchRef: 'refs/heads/feat/lane-01', baseBranch: 'main',
    headCommit: 'a'.repeat(40), expectedBaseCommit: 'a'.repeat(40), gitCommonDir: '/repos/modulastack/.git',
    worktreePath: '/worktrees/lane-01', worktreeIdentity: { device: '8', inode: '101' },
    worktreeGitDir: '/repos/modulastack/.git/worktrees/lane-01', gitEntryIdentity: { device: '8', inode: '102' },
    relativeCwd: '.', resolvedCwdPath: '/worktrees/lane-01', resolvedCwdIdentity: { device: '8', inode: '101' }, clean: true,
  }
}

function tombstoneFor(request: SessionStartMessage): SessionReceiptTombstone {
  return {
    key: { bindingId: request.bindingId, requestId: request.requestId },
    fingerprint: 'f'.repeat(64),
    result: { type: 'SESSION_FINISHED', requestId: request.requestId, exitCode: 0, signal: null },
    sessionId: 'session-stable',
    terminalAt: '2026-08-21T00:01:00Z',
    deleteAfter: '2026-09-20T00:01:00Z',
  }
}

function requestFor(obligationId: string, fixture = 'ordinary'): SessionStartMessage {
  return {
    type: 'SESSION_START', bindingId, requestId: requestIdFor(obligationId), expiresAt: expiryFor(fixture),
    terminalProfile: 'coder', modelProfileId: 'daily',
    target: { projectId: 'modulastack', worktreeName: 'lane-01', branch: 'feat/lane-01', baseBranch: 'main', relativeCwd: '.' },
  }
}

function receiptFits(image: SessionReceiptLedgerImage): boolean {
  const candidate = receiptFor(requestFor('G1-R16', 'capacity-receipt-bytes'), 'accepted')
  return jsonArrayBytesWith(image.receipts, candidate) <= MAX_FULL_SESSION_RECEIPT_BYTES
}

function isTerminal(receipt: SessionReceipt): boolean {
  return receipt.state === 'finished' || receipt.state === 'failed' || receipt.state === 'refused' || receipt.state === 'uncertain'
}

function isClaimCapacityFixture(fixture: string): boolean {
  return fixture === 'global-capacity-full' || fixture === 'capacity-receipt-count'
    || fixture === 'capacity-receipt-bytes' || fixture === 'capacity-inflight'
}

function isCompactionFixture(fixture: string): boolean {
  return fixture === 'compact-after-24h' || fixture === 'compact-oldest-first'
    || fixture === 'capacity-tombstone-count' || fixture === 'capacity-tombstone-bytes'
}

function clockFor(fixture: string): number {
  if (isCompactionFixture(fixture)) return Date.parse('2026-08-22T00:00:01Z')
  return Date.parse('2026-08-21T00:00:00Z')
}

function expiryFor(fixture: string): string {
  return new Date(clockFor(fixture) + 9 * 60 * 1000).toISOString()
}

function indexedReceipts(receipt: SessionReceipt, count: number): SessionReceipt[] {
  return Array.from({ length: count }, (_, index) => withReceiptRequestId(receipt, indexedRequestId(index)))
}

function indexedTombstones(tombstone: SessionReceiptTombstone, count: number): SessionReceiptTombstone[] {
  return Array.from({ length: count }, (_, index) => withTombstoneRequestId(tombstone, indexedRequestId(index)))
}

function withReceiptRequestId(receipt: SessionReceipt, requestId: string): SessionReceipt {
  return {
    ...receipt,
    key: { ...receipt.key, requestId },
    request: { ...receipt.request, requestId },
    ...(receipt.result ? { result: { ...receipt.result, requestId } } : {}),
  }
}

function withTombstoneRequestId(tombstone: SessionReceiptTombstone, requestId: string): SessionReceiptTombstone {
  return { ...tombstone, key: { ...tombstone.key, requestId }, result: { ...tombstone.result, requestId } }
}

function withRequestId(request: SessionStartMessage, requestId: string): SessionStartMessage {
  return { ...request, requestId }
}

function containsReceipt(image: SessionReceiptLedgerImage, key: SessionReceipt['key']): boolean {
  return image.receipts.some(receipt => receipt.key.bindingId === key.bindingId && receipt.key.requestId === key.requestId)
}

function containsTombstone(image: SessionReceiptLedgerImage, key: SessionReceipt['key']): boolean {
  return image.tombstones.some(tombstone => tombstone.key.bindingId === key.bindingId && tombstone.key.requestId === key.requestId)
}

function fillWithinByteLimit<T>(
  values: T[],
  prototype: T,
  maxCount: number,
  maxBytes: number,
  withRequestId: (value: T, requestId: string) => T,
) {
  let bytes = jsonArrayBytes(values)
  while (values.length < maxCount) {
    const candidate = withRequestId(prototype, indexedRequestId(values.length))
    const candidateBytes = Buffer.byteLength(JSON.stringify(candidate)) + (values.length === 0 ? 0 : 1)
    if (bytes + candidateBytes > maxBytes) return
    values.push(candidate)
    bytes += candidateBytes
  }
}

function jsonArrayBytes(values: readonly unknown[]): number {
  return Buffer.byteLength(JSON.stringify(values))
}

function jsonArrayBytesWith(values: readonly unknown[], next: unknown): number {
  const current = jsonArrayBytes(values)
  const nextBytes = Buffer.byteLength(JSON.stringify(next))
  return current + nextBytes + (values.length === 0 ? 0 : 1)
}

function alternateRequestId(requestId: string): string {
  const final = requestId.slice(-1)
  return `${requestId.slice(0, -1)}${final === 'f' ? 'e' : 'f'}`
}

function indexedRequestId(index: number): string {
  return `223e4567-e89b-42d3-a456-${index.toString(16).padStart(12, '0')}`
}

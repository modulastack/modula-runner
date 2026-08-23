import {
  SESSION_LAUNCH_PROTOCOL_VERSION,
  canonicalSessionStart,
  hasControlCharacter,
  isSafeIdentifier,
  parseSessionLaunchClientMessage,
  parseSessionLaunchServerMessage,
  sessionStartDeadline,
} from '@modulastack/runner-protocol'
import { isAbsolute } from 'node:path'
import {
  MAX_FULL_SESSION_RECEIPT_BYTES,
  MAX_FULL_SESSION_RECEIPTS,
  MAX_IN_FLIGHT_SESSION_RECEIPTS,
  MAX_SESSION_LEDGER_JSON_DEPTH,
  MAX_SESSION_LEDGER_JSON_NODES,
  MAX_SESSION_LOCAL_PATH_LENGTH,
  MAX_SESSION_RECEIPT_JSON_NODES,
  MAX_SESSION_RECEIPT_RECORD_BYTES,
  MAX_SESSION_TOMBSTONE_BYTES,
  MAX_SESSION_TOMBSTONES,
  SESSION_CHANNEL_LIFECYCLES,
  SESSION_RECEIPT_RETENTION_MS,
  SESSION_RECEIPT_SCHEMA_VERSION,
  SESSION_TOMBSTONE_RETENTION_MS,
  SessionReceiptStorageUnavailableError,
  type SessionReceipt,
  type SessionReceiptClaim,
  type SessionReceiptKey,
  type SessionReceiptLedger,
  type SessionReceiptLedgerImage,
  type SessionReceiptLedgerOptions,
  type SessionReceiptLookup,
  type SessionReceiptReplace,
  type SessionReceiptState,
  type SessionReceiptTombstone,
  type SessionWorktreeSnapshot,
} from './sessionLaunch.js'

export const MAX_PENDING_SESSION_LEDGER_OPERATIONS = 64
const MAX_CLAIM_CAS_ATTEMPTS = 8
const TERMINAL_STATES = new Set(['finished', 'refused', 'failed', 'uncertain'])
const RECEIPT_STATES = new Set(['accepted', 'provisioned', 'spawn-intent', 'started', ...TERMINAL_STATES])
const WORKTREE_PHASES = new Set(['none', 'branch-created', 'worktree-registered', 'verified'])
const PHASE_RANK: Readonly<Record<SessionReceiptState, number>> = {
  accepted: 0,
  provisioned: 1,
  'spawn-intent': 2,
  started: 3,
  finished: 4,
  refused: 4,
  failed: 4,
  uncertain: 4,
}
const TERMINAL_PHASES = new Set<SessionReceiptState>(['finished', 'refused', 'failed', 'uncertain'])

export function createSessionReceiptLedger(options: SessionReceiptLedgerOptions): SessionReceiptLedger {
  return new DurableSessionReceiptLedger(options)
}

export function decodeSessionReceiptLedgerImage(value: unknown): SessionReceiptLedgerImage | null {
  return isValidImage(value) ? jsonClone(value) : null
}

class DurableSessionReceiptLedger implements SessionReceiptLedger {
  private queue: Promise<unknown> = Promise.resolve()
  private pendingOperations = 0

  constructor(private readonly options: SessionReceiptLedgerOptions) {}

  lookup(key: SessionReceiptKey): Promise<SessionReceiptLookup> {
    return this.serialize(async () => lookupIn(await this.loadOrThrow(), key))
  }

  claim(request: SessionReceipt['request'], fingerprint: string, now: string): Promise<SessionReceiptClaim> {
    return this.serialize(async () => {
      if (!validRequest(request) || typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint) || !validTimestamp(now)) {
        return { status: 'storage-unavailable' }
      }
      let image = await this.loadForMutation()
      if (!image) return { status: 'storage-unavailable' }
      const known = knownClaim(image, request, fingerprint)
      if (known) return known
      for (let attempt = 0; attempt < MAX_CLAIM_CAS_ATTEMPTS; attempt += 1) {
        const raced = knownClaim(image, request, fingerprint)
        if (raced) return raced
        const currentTime = this.currentTime(now)
        if (sessionStartDeadline(request.expiresAt, Date.parse(currentTime)) !== 'admissible') {
          return { status: 'storage-unavailable' }
        }
        const receipt = initialReceipt(request, fingerprint, currentTime)
        if (!isValidReceipt(receipt)) return { status: 'storage-unavailable' }
        if (isActiveBlock(image.capacityBlockedUntil, currentTime) || !hasReceiptCapacity(image, receipt)) {
          const blockedUntil = laterTimestamp(image.capacityBlockedUntil, request.expiresAt)
          if (blockedUntil === image.capacityBlockedUntil) return { status: 'at-capacity', blockedUntil }
          const blocked = nextImage(image, { capacityBlockedUntil: blockedUntil })
          if (!blocked) return { status: 'storage-unavailable' }
          const stored = await this.options.storage.replace(image.revision, blocked)
          if (stored.status === 'storage-unavailable') return { status: 'storage-unavailable' }
          if (stored.status === 'conflict') {
            if (!isValidImage(stored.current)) return { status: 'storage-unavailable' }
            image = stored.current
            continue
          }
          return { status: 'at-capacity', blockedUntil }
        }
        const next = nextImage(image, { capacityBlockedUntil: null, receipts: [...image.receipts, receipt] })
        if (!next) return { status: 'storage-unavailable' }
        const stored = await this.options.storage.replace(image.revision, next)
        if (stored.status === 'storage-unavailable') return { status: 'storage-unavailable' }
        if (stored.status === 'conflict') {
          if (!isValidImage(stored.current)) return { status: 'storage-unavailable' }
          image = stored.current
          continue
        }
        const persisted = findReceipt(stored.image, receipt.key)
        return persisted ? { status: 'claimed', receipt: persisted } : { status: 'storage-unavailable' }
      }
      return { status: 'storage-unavailable' }
    })
  }

  replace(expectedRevision: number, receipt: SessionReceipt): Promise<SessionReceiptReplace> {
    return this.serialize(async () => {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !isValidReceipt(receipt)) {
        return { status: 'storage-unavailable' }
      }
      const image = await this.loadForMutation()
      if (!image) return { status: 'storage-unavailable' }
      const current = findReceipt(image, receipt.key)
      if (current && isTerminal(current) && terminalReceiptEqual(current, receipt)) {
        return { status: 'updated', receipt: jsonClone(current) }
      }
      if (current && current.revision !== expectedRevision) return { status: 'conflict', current }
      if (!current && (expectedRevision !== 1 || !isTerminal(receipt))) return { status: 'conflict', current: null }
      if (current && isTerminal(current)) return { status: 'conflict', current }
      if (current && (!sameImmutableReceiptIdentity(current, receipt)
        || !validStateTransition(current.state, receipt.state)
        || !validPhaseTransition(current, receipt)
        || !validChannelTransition(current, receipt))) {
        return { status: 'conflict', current }
      }
      const persisted = jsonClone({ ...receipt, revision: expectedRevision + 1 })
      const receipts = current
        ? image.receipts.map(candidate => sameKey(candidate.key, receipt.key) ? persisted : candidate)
        : [...image.receipts, persisted]
      if (!fullReceiptBudgetsHold(receipts)) return { status: 'storage-unavailable' }
      const next = nextImage(image, { receipts })
      if (!next) return { status: 'storage-unavailable' }
      const stored = await this.options.storage.replace(image.revision, next)
      if (stored.status === 'storage-unavailable') return { status: 'storage-unavailable' }
      if (stored.status === 'conflict') return { status: 'conflict', current: findReceipt(stored.current, receipt.key) }
      const updated = findReceipt(stored.image, receipt.key)
      return updated ? { status: 'updated', receipt: updated } : { status: 'storage-unavailable' }
    })
  }

  recover(): Promise<readonly SessionReceipt[]> {
    return this.serialize(async () => {
      const image = await this.loadOrThrow()
      return image.receipts.filter(receipt => !isTerminal(receipt)).map(jsonClone)
    })
  }

  compact(now: string): Promise<void> {
    return this.serialize(async () => {
      const image = await this.loadOrThrow()
      const currentTime = this.currentTime(now)
      const compacted = compactedImage(image, currentTime)
      if (!compacted) throw new SessionReceiptStorageUnavailableError()
      if (sameImageContents(image, compacted)) return
      const stored = await this.options.storage.replace(image.revision, compacted)
      if (stored.status !== 'updated') throw new SessionReceiptStorageUnavailableError()
    })
  }

  private currentTime(candidate: string): string {
    const clockTime = new Date(this.options.clock.now())
    if (!Number.isFinite(clockTime.getTime())) throw new SessionReceiptStorageUnavailableError()
    const supplied = Date.parse(candidate)
    return Number.isFinite(supplied) && supplied === clockTime.getTime() ? candidate : clockTime.toISOString()
  }

  private async loadForMutation(): Promise<SessionReceiptLedgerImage | null> {
    const loaded = await this.options.storage.load()
    if (loaded.status !== 'loaded' || !isValidImage(loaded.image)) return null
    return jsonClone(loaded.image)
  }

  private async loadOrThrow(): Promise<SessionReceiptLedgerImage> {
    const image = await this.loadForMutation()
    if (!image) throw new SessionReceiptStorageUnavailableError()
    return image
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pendingOperations >= MAX_PENDING_SESSION_LEDGER_OPERATIONS) {
      return Promise.reject(new SessionReceiptStorageUnavailableError())
    }
    this.pendingOperations += 1
    const result = this.queue.then(operation, operation).then(
      value => {
        this.pendingOperations -= 1
        return value
      },
      error => {
        this.pendingOperations -= 1
        throw error
      },
    )
    // The caller observes its failure; the ordering queue must remain usable for recovery.
    this.queue = result.catch(() => undefined)
    return result
  }
}

function knownClaim(
  image: SessionReceiptLedgerImage,
  request: SessionReceipt['request'],
  fingerprint: string,
): SessionReceiptClaim | null {
  const known = lookupIn(image, { bindingId: request.bindingId, requestId: request.requestId })
  if (known.status === 'missing') return null
  const value = known.status === 'receipt' ? known.receipt : known.tombstone
  return value.fingerprint === fingerprint ? { status: 'known', value } : { status: 'conflict' }
}

function initialReceipt(request: SessionReceipt['request'], fingerprint: string, now: string): SessionReceipt {
  return {
    schemaVersion: SESSION_RECEIPT_SCHEMA_VERSION,
    revision: 1,
    key: { bindingId: request.bindingId, requestId: request.requestId },
    fingerprint,
    request: jsonClone(request),
    state: 'accepted',
    phaseTimestamps: { accepted: now },
    worktree: { phase: 'none' },
  }
}

function compactedImage(image: SessionReceiptLedgerImage, now: string): SessionReceiptLedgerImage | null {
  const nowMs = Date.parse(now)
  if (!Number.isFinite(nowMs)) throw new SessionReceiptStorageUnavailableError()
  let tombstones = image.tombstones
    .filter(tombstone => Date.parse(tombstone.deleteAfter) > nowMs)
    .sort((left, right) => Date.parse(left.terminalAt) - Date.parse(right.terminalAt))
  let tombstoneBytes = jsonBytes(tombstones)
  const retained: SessionReceipt[] = []
  const candidates = [...image.receipts].sort((left, right) => terminalTime(left) - terminalTime(right))
  for (const receipt of candidates) {
    const tombstone = compactableTombstone(receipt, nowMs)
    if (!tombstone) {
      retained.push(receipt)
      continue
    }
    const addedBytes = jsonBytes(tombstone) + (tombstones.length === 0 ? 0 : 1)
    if (tombstones.length >= MAX_SESSION_TOMBSTONES
      || tombstoneBytes + addedBytes > MAX_SESSION_TOMBSTONE_BYTES) {
      retained.push(receipt)
      continue
    }
    tombstones.push(tombstone)
    tombstoneBytes += addedBytes
  }
  return nextImage(image, { receipts: retained, tombstones })
}

function compactableTombstone(receipt: SessionReceipt, nowMs: number): SessionReceiptTombstone | null {
  if (!isTerminal(receipt) || !receipt.result) return null
  const terminalAt = receipt.phaseTimestamps[receipt.state]
  if (!terminalAt) return null
  const terminalMs = Date.parse(terminalAt)
  if (!Number.isFinite(terminalMs) || nowMs - terminalMs < SESSION_RECEIPT_RETENTION_MS) return null
  return {
    key: jsonClone(receipt.key),
    fingerprint: receipt.fingerprint,
    result: jsonClone(receipt.result),
    ...(receipt.sessionId ? { sessionId: receipt.sessionId } : {}),
    terminalAt,
    deleteAfter: new Date(terminalMs + SESSION_TOMBSTONE_RETENTION_MS).toISOString(),
  }
}

function hasReceiptCapacity(image: SessionReceiptLedgerImage, receipt: SessionReceipt): boolean {
  if (image.receipts.length >= MAX_FULL_SESSION_RECEIPTS) return false
  const receipts = [...image.receipts, receipt]
  if (receipts.filter(candidate => !isTerminal(candidate)).length > MAX_IN_FLIGHT_SESSION_RECEIPTS) return false
  return reservedReceiptBytes(receipts) <= MAX_FULL_SESSION_RECEIPT_BYTES
}

function reservedReceiptBytes(receipts: readonly SessionReceipt[]): number {
  const growthReserve = receipts
    .filter(receipt => !isTerminal(receipt))
    .reduce((total, receipt) => total + Math.max(0, MAX_SESSION_RECEIPT_RECORD_BYTES - jsonBytes(receipt)), 0)
  return jsonBytes(receipts) + growthReserve
}

function fullReceiptBudgetsHold(receipts: readonly SessionReceipt[]): boolean {
  if (receipts.length > MAX_FULL_SESSION_RECEIPTS) return false
  if (receipts.filter(receipt => !isTerminal(receipt)).length > MAX_IN_FLIGHT_SESSION_RECEIPTS) return false
  if (receipts.some(receipt => jsonBytes(receipt) > MAX_SESSION_RECEIPT_RECORD_BYTES)) return false
  return reservedReceiptBytes(receipts) <= MAX_FULL_SESSION_RECEIPT_BYTES
}

function lookupIn(image: SessionReceiptLedgerImage, key: SessionReceiptKey): SessionReceiptLookup {
  const receipt = findReceipt(image, key)
  if (receipt) return { status: 'receipt', receipt: jsonClone(receipt) }
  const tombstone = image.tombstones.find(candidate => sameKey(candidate.key, key))
  return tombstone ? { status: 'tombstone', tombstone: jsonClone(tombstone) } : { status: 'missing' }
}

function findReceipt(image: SessionReceiptLedgerImage, key: SessionReceiptKey): SessionReceipt | null {
  return image.receipts.find(candidate => sameKey(candidate.key, key)) ?? null
}

function sameImmutableReceiptIdentity(left: SessionReceipt, right: SessionReceipt): boolean {
  return left.schemaVersion === right.schemaVersion
    && sameKey(left.key, right.key)
    && left.fingerprint === right.fingerprint
    && canonicalSessionStart(left.request) === canonicalSessionStart(right.request)
    && (left.sessionId === undefined || left.sessionId === right.sessionId)
    && (left.project === undefined || canonicalJson(left.project) === canonicalJson(right.project))
    && worktreeEvidencePreserved(left.worktree, right.worktree)
}

function worktreeEvidencePreserved(left: SessionWorktreeSnapshot, right: SessionWorktreeSnapshot): boolean {
  const phases = ['none', 'branch-created', 'worktree-registered', 'verified'] as const
  if (phases.indexOf(right.phase) < phases.indexOf(left.phase)) return false
  if (left.phase === 'none') return true
  const leftEvidence = { ...left } as Record<string, unknown>
  const rightEvidence = { ...right } as Record<string, unknown>
  delete leftEvidence.phase
  delete rightEvidence.phase
  return Object.entries(leftEvidence).every(([key, value]) => canonicalJson(rightEvidence[key]) === canonicalJson(value))
}

function validChannelTransition(left: SessionReceipt, right: SessionReceipt): boolean {
  if (!left.channel) {
    if (!right.channel) return left.channelId === undefined || left.channelId === right.channelId
    if (right.channel.generation !== 1) return false
    return left.channelId === undefined
      || (right.channel.channelId === left.channelId && right.channelId === left.channelId)
  }
  if (!right.channel) return false
  if (right.channel.generation === left.channel.generation + 1) {
    return right.channel.lifecycle === 'replacement-intent'
      && right.channel.channelId === null
      && right.channelId === left.channelId
  }
  if (right.channel.generation !== left.channel.generation) return false
  if (left.channel.lifecycle === 'replacement-intent') {
    return right.channel.lifecycle === 'live'
      && right.channel.channelId !== null
      && right.channelId === right.channel.channelId
  }
  const lifecycleAllowed = left.channel.lifecycle === 'live'
    ? right.channel.lifecycle === 'live' || right.channel.lifecycle === 'closed' || right.channel.lifecycle === 'lost'
    : right.channel.lifecycle === left.channel.lifecycle
  return lifecycleAllowed
    && right.channel.channelId === left.channel.channelId
    && right.channelId === left.channelId
    && right.channel.connectionEpoch === left.channel.connectionEpoch
}

function terminalReceiptEqual(left: SessionReceipt, right: SessionReceipt): boolean {
  return canonicalJson({ ...left, revision: 0 }) === canonicalJson({ ...right, revision: 0 })
}

function validStateTransition(current: SessionReceipt['state'], next: SessionReceipt['state']): boolean {
  if (current === next) return true
  if (current === 'accepted') return next === 'provisioned' || next === 'failed' || next === 'uncertain'
  if (current === 'provisioned') return next === 'spawn-intent' || next === 'failed' || next === 'uncertain'
  if (current === 'spawn-intent') return next === 'started' || next === 'failed' || next === 'uncertain'
  if (current === 'started') return next === 'finished' || next === 'uncertain'
  return false
}

function sameKey(left: SessionReceiptKey, right: SessionReceiptKey): boolean {
  return left.bindingId === right.bindingId && left.requestId === right.requestId
}

function nextImage(
  image: SessionReceiptLedgerImage,
  changes: Partial<Omit<SessionReceiptLedgerImage, 'schemaVersion' | 'revision'>>,
): SessionReceiptLedgerImage | null {
  const candidate = { ...image, ...changes, schemaVersion: SESSION_RECEIPT_SCHEMA_VERSION, revision: image.revision + 1 }
  return isValidImage(candidate) ? jsonClone(candidate) : null
}

function sameImageContents(left: SessionReceiptLedgerImage, right: SessionReceiptLedgerImage): boolean {
  return JSON.stringify({ ...left, revision: 0 }) === JSON.stringify({ ...right, revision: 0 })
}

function isTerminal(receipt: SessionReceipt): boolean {
  return TERMINAL_STATES.has(receipt.state)
}

function terminalTime(receipt: SessionReceipt): number {
  const value = receipt.phaseTimestamps[receipt.state]
  const parsed = value ? Date.parse(value) : Number.POSITIVE_INFINITY
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
}

function isActiveBlock(blockedUntil: string | null, now: string): boolean {
  return blockedUntil !== null && Date.parse(blockedUntil) >= Date.parse(now)
}

function laterTimestamp(current: string | null, candidate: string): string {
  return current && Date.parse(current) >= Date.parse(candidate) ? current : candidate
}

function jsonBytes(value: unknown): number {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new SessionReceiptStorageUnavailableError()
  return Buffer.byteLength(serialized)
}

function isValidImage(value: unknown): value is SessionReceiptLedgerImage {
  if (!jsonValueWithin(value, MAX_SESSION_LEDGER_JSON_NODES) || !isRecord(value)
    || !exactObjectKeys(value, ['schemaVersion', 'revision', 'capacityBlockedUntil', 'receipts', 'tombstones'])) return false
  const { schemaVersion, revision, capacityBlockedUntil, receipts, tombstones } = value
  if (schemaVersion !== SESSION_RECEIPT_SCHEMA_VERSION || !Number.isSafeInteger(revision) || (revision as number) < 0) return false
  if (capacityBlockedUntil !== null && !validTimestamp(capacityBlockedUntil)) return false
  if (!Array.isArray(receipts) || !Array.isArray(tombstones)) return false
  if (!receipts.every(isValidReceipt) || !tombstones.every(isValidTombstone)) return false
  const image = value as SessionReceiptLedgerImage
  if (!loadedImageBudgetsHold(image)) return false
  const keys = [...image.receipts.map(receipt => receipt.key), ...image.tombstones.map(tombstone => tombstone.key)]
  return new Set(keys.map(key => `${key.bindingId}\u0000${key.requestId}`)).size === keys.length
}

function isValidReceipt(value: unknown): value is SessionReceipt {
  if (!jsonValueWithin(value, MAX_SESSION_RECEIPT_JSON_NODES) || !isRecord(value)) return false
  const receipt = value as SessionReceipt
  if (receipt.schemaVersion !== SESSION_RECEIPT_SCHEMA_VERSION || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1) return false
  if (!validRequest(receipt.request) || !validKey(receipt.key) || !sameKey(receipt.key, receipt.request)) return false
  if (typeof receipt.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.fingerprint)) return false
  if (typeof receipt.state !== 'string' || !RECEIPT_STATES.has(receipt.state) || !validPhaseTimestamps(receipt)) return false
  if (receipt.project !== undefined
    && (!validProject(receipt.project) || receipt.project.projectId !== receipt.request.target.projectId)) return false
  if (!validWorktree(receipt.worktree)) return false
  if (receipt.sessionId !== undefined && !isSafeIdentifier(receipt.sessionId)) return false
  if (receipt.channelId !== undefined && !isSafeIdentifier(receipt.channelId)) return false
  if (!validChannel(receipt) || !validStateEvidence(receipt) || !validReceiptResult(receipt)) return false
  return jsonBytes(receipt) <= MAX_SESSION_RECEIPT_RECORD_BYTES
}

function isValidTombstone(value: unknown): value is SessionReceiptTombstone {
  if (!jsonValueWithin(value, MAX_SESSION_RECEIPT_JSON_NODES) || !isRecord(value)) return false
  const tombstone = value as SessionReceiptTombstone
  if (!validKey(tombstone.key) || typeof tombstone.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(tombstone.fingerprint)) return false
  const result = parseSessionLaunchServerMessage(tombstone.result, SESSION_LAUNCH_PROTOCOL_VERSION)
  if (!result || !['SESSION_REFUSED', 'SESSION_FAILED', 'SESSION_FINISHED'].includes(result.type)) return false
  if (result.requestId !== tombstone.key.requestId || !validTimestamp(tombstone.terminalAt) || !validTimestamp(tombstone.deleteAfter)) return false
  if (Date.parse(tombstone.deleteAfter) < Date.parse(tombstone.terminalAt) + SESSION_TOMBSTONE_RETENTION_MS) return false
  return tombstone.sessionId === undefined || isSafeIdentifier(tombstone.sessionId)
}

function validRequest(value: unknown): value is SessionReceipt['request'] {
  if (!jsonValueWithin(value, MAX_SESSION_RECEIPT_JSON_NODES)) return false
  const parsed = parseSessionLaunchClientMessage(value, SESSION_LAUNCH_PROTOCOL_VERSION)
  return parsed !== null && canonicalSessionStart(parsed) === canonicalSessionStart(value as SessionReceipt['request'])
}

function validChannel(receipt: SessionReceipt): boolean {
  const channel = receipt.channel
  if (!channel) return true
  if (!Number.isSafeInteger(channel.generation) || channel.generation < 1) return false
  if (!(SESSION_CHANNEL_LIFECYCLES as readonly unknown[]).includes(channel.lifecycle)) return false
  if (channel.connectionEpoch !== undefined && !isSafeIdentifier(channel.connectionEpoch)) return false
  if (channel.lifecycle === 'replacement-intent') return channel.channelId === null
  if (!isSafeIdentifier(channel.channelId)) return false
  return receipt.channelId === undefined || receipt.channelId === channel.channelId
}

function validStateEvidence(receipt: SessionReceipt): boolean {
  if (receipt.state === 'accepted' || receipt.state === 'refused') return true
  if (receipt.state === 'provisioned') return receipt.worktree.phase === 'verified'
  if (receipt.state === 'spawn-intent') return receipt.worktree.phase === 'verified' && receipt.sessionId !== undefined
  if (receipt.state === 'started' || receipt.state === 'finished') {
    return receipt.worktree.phase === 'verified' && receipt.sessionId !== undefined && receipt.channelId !== undefined
  }
  return true
}

function validReceiptResult(receipt: SessionReceipt): boolean {
  if (!isTerminal(receipt)) return receipt.result === undefined
  const result = parseSessionLaunchServerMessage(receipt.result, SESSION_LAUNCH_PROTOCOL_VERSION)
  if (!result || result.requestId !== receipt.key.requestId) return false
  if (receipt.state === 'refused') return result.type === 'SESSION_REFUSED'
  if (receipt.state === 'finished') return result.type === 'SESSION_FINISHED'
  return result.type === 'SESSION_FAILED'
}

function validPhaseTimestamps(receipt: SessionReceipt): boolean {
  if (!receipt.phaseTimestamps || typeof receipt.phaseTimestamps !== 'object') return false
  const entries = Object.entries(receipt.phaseTimestamps) as Array<[SessionReceiptState, string]>
  for (const [state, timestamp] of entries) {
    if (!RECEIPT_STATES.has(state) || !validTimestamp(timestamp)) return false
    if (!TERMINAL_PHASES.has(receipt.state) && PHASE_RANK[state] > PHASE_RANK[receipt.state]) return false
  }
  if (entries.filter(([state]) => TERMINAL_PHASES.has(state)).length > 1) return false
  const ordered = [...entries].sort(([left], [right]) => PHASE_RANK[left] - PHASE_RANK[right])
  if (ordered.some(([, timestamp], index) => index > 0 && Date.parse(timestamp) < Date.parse(ordered[index - 1]![1]))) return false
  return validTimestamp(receipt.phaseTimestamps[receipt.state])
}

function validPhaseTransition(current: SessionReceipt, next: SessionReceipt): boolean {
  const currentEntries = Object.entries(current.phaseTimestamps) as Array<[SessionReceiptState, string]>
  for (const [state, timestamp] of currentEntries) {
    if (next.phaseTimestamps[state] !== timestamp) return false
  }
  const added = Object.keys(next.phaseTimestamps).filter(state => !Object.hasOwn(current.phaseTimestamps, state))
  if (current.state === next.state) return added.length === 0
  if (added.some(state => state !== next.state)) return false
  const nextTimestamp = next.phaseTimestamps[next.state]
  const latestCurrent = Math.max(...currentEntries.map(([, timestamp]) => Date.parse(timestamp)))
  return nextTimestamp !== undefined && Date.parse(nextTimestamp) >= latestCurrent
}

function validProject(value: unknown): value is NonNullable<SessionReceipt['project']> {
  if (!isRecord(value)) return false
  const project = value as NonNullable<SessionReceipt['project']>
  return isSafeIdentifier(project.projectId)
    && Number.isSafeInteger(project.revision) && project.revision >= 1
    && validLocalPath(project.repoPath) && validLocalPath(project.worktreesRoot)
}

function validWorktree(value: unknown): value is SessionReceipt['worktree'] {
  if (!isRecord(value) || typeof value.phase !== 'string' || !WORKTREE_PHASES.has(value.phase)) return false
  const worktree = value as SessionReceipt['worktree']
  if (worktree.phase === 'none') return true
  if (!bounded(worktree.branch, 255) || !bounded(worktree.branchRef, 512) || !bounded(worktree.baseBranch, 255)) return false
  if (!validCommit(worktree.headCommit) || !validCommit(worktree.expectedBaseCommit)) return false
  if (!validLocalPath(worktree.gitCommonDir)) return false
  if (worktree.phase === 'branch-created') return worktree.ownership === 'created'
  if (worktree.ownership !== 'created' && worktree.ownership !== 'reused') return false
  if (!validLocalPath(worktree.worktreePath) || !validLocalPath(worktree.worktreeGitDir)) return false
  if (!validFileIdentity(worktree.worktreeIdentity) || !validFileIdentity(worktree.gitEntryIdentity)) return false
  if (worktree.phase === 'worktree-registered') return true
  return bounded(worktree.relativeCwd, 1_024)
    && validLocalPath(worktree.resolvedCwdPath)
    && validFileIdentity(worktree.resolvedCwdIdentity)
    && worktree.clean === true
}

function validCommit(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40,64}$/.test(value)
}

function validFileIdentity(value: unknown): value is { device: string; inode: string } {
  if (!isRecord(value)) return false
  return typeof value.device === 'string' && typeof value.inode === 'string'
    && /^\d{1,32}$/.test(value.device) && /^\d{1,32}$/.test(value.inode)
}

function validLocalPath(value: unknown): value is string {
  return bounded(value, MAX_SESSION_LOCAL_PATH_LENGTH) && !hasControlCharacter(value) && isAbsolute(value)
}

function validKey(value: unknown): value is SessionReceiptKey {
  if (!isRecord(value) || typeof value.bindingId !== 'string' || typeof value.requestId !== 'string') return false
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.bindingId)
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.requestId)
}

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jsonValueWithin(value: unknown, maxNodes: number): boolean {
  const pending: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 0 }]
  const ancestors = new WeakSet<object>()
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()!
    if (current.exit) {
      ancestors.delete(current.value as object)
      continue
    }
    nodes += 1
    if (nodes > maxNodes || current.depth > MAX_SESSION_LEDGER_JSON_DEPTH) return false
    if (current.value === null || typeof current.value === 'string' || typeof current.value === 'boolean') continue
    if (typeof current.value === 'number') {
      if (!Number.isFinite(current.value)) return false
      continue
    }
    if (typeof current.value !== 'object' || ancestors.has(current.value)) return false
    ancestors.add(current.value)
    pending.push({ value: current.value, depth: current.depth, exit: true })
    if (Object.getOwnPropertySymbols(current.value).length > 0) return false
    const descriptors = Object.getOwnPropertyDescriptors(current.value)
    if (Array.isArray(current.value)) {
      const entries = Object.entries(descriptors).filter(([key]) => key !== 'length')
      const length = descriptors.length?.value
      if (!Number.isSafeInteger(length) || length < 0 || entries.length !== length) return false
      for (const [key, descriptor] of entries) {
        if (!/^(0|[1-9]\d*)$/.test(key) || !descriptor.enumerable || !('value' in descriptor)) return false
        pending.push({ value: descriptor.value, depth: current.depth + 1 })
      }
      continue
    }
    const prototype = Object.getPrototypeOf(current.value)
    if (prototype !== Object.prototype && prototype !== null) return false
    for (const descriptor of Object.values(descriptors)) {
      if (!descriptor.enumerable || !('value' in descriptor)) return false
      pending.push({ value: descriptor.value, depth: current.depth + 1 })
    }
  }
  return true
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function bounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function loadedImageBudgetsHold(image: SessionReceiptLedgerImage): boolean {
  return image.receipts.length <= MAX_FULL_SESSION_RECEIPTS
    && image.receipts.filter(receipt => !isTerminal(receipt)).length <= MAX_IN_FLIGHT_SESSION_RECEIPTS
    && jsonBytes(image.receipts) <= MAX_FULL_SESSION_RECEIPT_BYTES
    && image.tombstones.length <= MAX_SESSION_TOMBSTONES
    && jsonBytes(image.tombstones) <= MAX_SESSION_TOMBSTONE_BYTES
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

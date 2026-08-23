import type {
  SessionFailedMessage,
  SessionFinishedMessage,
  SessionLaunchServerMessage,
  SessionRefusedMessage,
  SessionStartMessage,
  SessionFailureReason,
  SessionLaunchTarget,
} from '@modulastack/runner-protocol'
import type { AccessResolution, LaunchPlan } from './accessProfiles.js'
import type { AuditLog } from './auditLog.js'
import type { RunnerClock } from './runtimeClock.js'

export const SESSION_RECEIPT_SCHEMA_VERSION = 1
export const MAX_IN_FLIGHT_SESSION_RECEIPTS = 32
export const MAX_FULL_SESSION_RECEIPTS = 4_096
export const MAX_FULL_SESSION_RECEIPT_BYTES = 8 * 1024 * 1024
export const MAX_SESSION_TOMBSTONES = 32_768
export const MAX_SESSION_TOMBSTONE_BYTES = 16 * 1024 * 1024
export const MAX_SESSION_LOCAL_PATH_LENGTH = 4_096
export const MAX_SESSION_RECEIPT_RECORD_BYTES = 64 * 1024
export const MAX_SESSION_LEDGER_JSON_DEPTH = 64
export const MAX_SESSION_RECEIPT_JSON_NODES = 8_192
export const MAX_SESSION_LEDGER_JSON_NODES = 1_000_000
export const SESSION_RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000
export const SESSION_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export const SESSION_RECEIPT_STATES = [
  'accepted',
  'provisioned',
  'spawn-intent',
  'started',
  'finished',
  'refused',
  'failed',
  'uncertain',
] as const
export type SessionReceiptState = (typeof SESSION_RECEIPT_STATES)[number]

export const WORKTREE_OWNERSHIP_PHASES = [
  'none',
  'branch-created',
  'worktree-registered',
  'verified',
] as const
export type WorktreeOwnershipPhase = (typeof WORKTREE_OWNERSHIP_PHASES)[number]

export type LocalProjectRecord = {
  projectId: string
  repoPath: string
  worktreesRoot: string
  revision: number
}

export type NewLocalProject = Omit<LocalProjectRecord, 'revision'>

export interface LocalProjectRegistry {
  create(project: NewLocalProject): Promise<LocalProjectRecord>
  list(): Promise<readonly LocalProjectRecord[]>
  get(projectId: string): Promise<LocalProjectRecord | null>
  remove(projectId: string, expectedRevision?: number): Promise<'removed' | 'missing' | 'conflict'>
}

export type SessionReceiptKey = {
  bindingId: string
  requestId: string
}

export type SessionProjectSnapshot = LocalProjectRecord

export type LocalFileIdentity = {
  device: string
  inode: string
}

export type SessionBranchEvidence = {
  branch: string
  branchRef: string
  baseBranch: string
  headCommit: string
  expectedBaseCommit: string
  gitCommonDir: string
}

export type SessionRegistrationEvidence = {
  ownership: 'created' | 'reused'
  worktreePath: string
  worktreeIdentity: LocalFileIdentity
  worktreeGitDir: string
  gitEntryIdentity: LocalFileIdentity
}

export type SessionVerificationEvidence = {
  relativeCwd: string
  resolvedCwdPath: string
  resolvedCwdIdentity: LocalFileIdentity
  clean: true
}

export type SessionNoWorktreeSnapshot = { phase: 'none' }
export type SessionBranchCreatedSnapshot = { phase: 'branch-created'; ownership: 'created' } & SessionBranchEvidence
export type SessionWorktreeRegisteredSnapshot = { phase: 'worktree-registered' } & SessionBranchEvidence & SessionRegistrationEvidence
export type SessionWorktreeVerifiedSnapshot = { phase: 'verified' } & SessionBranchEvidence & SessionRegistrationEvidence & SessionVerificationEvidence

export type SessionWorktreeSnapshot =
  | SessionNoWorktreeSnapshot
  | SessionBranchCreatedSnapshot
  | SessionWorktreeRegisteredSnapshot
  | SessionWorktreeVerifiedSnapshot

export type SessionTerminalResult = SessionRefusedMessage | SessionFailedMessage | SessionFinishedMessage

export const SESSION_CHANNEL_LIFECYCLES = ['live', 'closed', 'lost', 'replacement-intent'] as const
export type SessionChannelLifecycle = (typeof SESSION_CHANNEL_LIFECYCLES)[number]

export type SessionChannelSnapshot = {
  generation: number
  connectionEpoch?: string
} & (
  | { lifecycle: 'live' | 'closed' | 'lost'; channelId: string }
  | { lifecycle: 'replacement-intent'; channelId: null }
)

export type SessionReceipt = {
  schemaVersion: typeof SESSION_RECEIPT_SCHEMA_VERSION
  revision: number
  key: SessionReceiptKey
  fingerprint: string
  request: SessionStartMessage
  state: SessionReceiptState
  phaseTimestamps: Partial<Record<SessionReceiptState, string>>
  project?: SessionProjectSnapshot
  worktree: SessionWorktreeSnapshot
  sessionId?: string
  // Optional for additive schema-v1 reads; new recovery writes this before replacing the legacy
  // channelId field so an older receipt never becomes an empty recovery guess.
  channel?: SessionChannelSnapshot
  channelId?: string
  result?: SessionTerminalResult
}

export type SessionLaunchAuditRecord = {
  kind: 'session-launch'
  key: SessionReceiptKey
  state: SessionReceiptState
  at: string
  sessionId?: string
  result?: SessionTerminalResult
}

export type SessionReceiptTombstone = {
  key: SessionReceiptKey
  fingerprint: string
  result: SessionTerminalResult
  sessionId?: string
  terminalAt: string
  deleteAfter: string
}

export type SessionReceiptLookup =
  | { status: 'missing' }
  | { status: 'receipt'; receipt: SessionReceipt }
  | { status: 'tombstone'; tombstone: SessionReceiptTombstone }

export type SessionReceiptClaim =
  | { status: 'claimed'; receipt: SessionReceipt }
  | { status: 'known'; value: SessionReceipt | SessionReceiptTombstone }
  | { status: 'conflict' }
  | { status: 'at-capacity'; blockedUntil: string }
  | { status: 'storage-unavailable' }

export type SessionReceiptReplace =
  | { status: 'updated'; receipt: SessionReceipt }
  | { status: 'conflict'; current: SessionReceipt | null }
  | { status: 'storage-unavailable' }

export interface SessionReceiptLedger {
  lookup(key: SessionReceiptKey): Promise<SessionReceiptLookup>
  // Claim is the single admission CAS. An at-capacity result is valid only after the
  // fixed capacity block is durable; otherwise this returns storage-unavailable.
  claim(request: SessionStartMessage, fingerprint: string, now: string): Promise<SessionReceiptClaim>
  replace(expectedRevision: number, receipt: SessionReceipt): Promise<SessionReceiptReplace>
  recover(): Promise<readonly SessionReceipt[]>
  compact(now: string): Promise<void>
}

export type SessionReceiptLedgerImage = {
  schemaVersion: typeof SESSION_RECEIPT_SCHEMA_VERSION
  revision: number
  capacityBlockedUntil: string | null
  receipts: readonly SessionReceipt[]
  tombstones: readonly SessionReceiptTombstone[]
}

export type SessionReceiptStorageLoad =
  | { status: 'loaded'; image: SessionReceiptLedgerImage }
  | { status: 'storage-unavailable' }

export type SessionReceiptStorageReplace =
  | { status: 'updated'; image: SessionReceiptLedgerImage }
  | { status: 'conflict'; current: SessionReceiptLedgerImage }
  | { status: 'storage-unavailable' }

export interface SessionReceiptStorage {
  load(): Promise<SessionReceiptStorageLoad>
  replace(expectedRevision: number, image: SessionReceiptLedgerImage): Promise<SessionReceiptStorageReplace>
}

export type SessionReceiptLedgerOptions = {
  storage: SessionReceiptStorage
  clock: RunnerClock
}

export class SessionReceiptLedgerNotImplementedError extends Error {
  constructor() {
    super('the session receipt ledger is interface-only and is not active')
    this.name = 'SessionReceiptLedgerNotImplementedError'
  }
}

export class SessionReceiptStorageUnavailableError extends Error {
  constructor() {
    super('the session receipt ledger is unavailable')
    this.name = 'SessionReceiptStorageUnavailableError'
  }
}

export type SessionWorktreeFailure = Extract<
  SessionFailureReason,
  'path-not-granted' | 'worktree-invalid' | 'worktree-conflict' | 'provision-failed'
>

export type SessionWorktreeStep<T> =
  | { status: 'ready'; snapshot: T }
  | { status: 'failed'; reason: SessionWorktreeFailure }

export interface SessionWorktreePort {
  prepare(
    project: SessionProjectSnapshot,
    target: SessionLaunchTarget,
    signal: AbortSignal,
  ): Promise<SessionWorktreeStep<SessionBranchCreatedSnapshot | SessionWorktreeRegisteredSnapshot>>
  register(
    snapshot: SessionBranchCreatedSnapshot,
    project: SessionProjectSnapshot,
    target: SessionLaunchTarget,
    signal: AbortSignal,
  ): Promise<SessionWorktreeStep<SessionWorktreeRegisteredSnapshot>>
  verify(
    snapshot: SessionWorktreeRegisteredSnapshot,
    relativeCwd: string,
    signal: AbortSignal,
  ): Promise<SessionWorktreeStep<SessionWorktreeVerifiedSnapshot>>
  inspect(snapshot: SessionWorktreeSnapshot): Promise<'exact' | 'missing' | 'mismatch'>
  rollback(snapshot: SessionWorktreeSnapshot): Promise<'rolled-back' | 'not-owned' | 'uncertain'>
}

export interface SessionAccessPort {
  resolve(modelProfileId: string, signal: AbortSignal): Promise<AccessResolution>
}

export type SessionTerminalRequest = {
  requestId: string
  sessionId: string
  terminalProfile: string
  cwd: string
  plan: LaunchPlan
}

export type SessionChannelOpen =
  | { status: 'opened'; channelId: string; connectionEpoch?: string }
  | { status: 'failed'; reason: 'channel-unavailable' }

export interface SessionChannelPort {
  open(requestId: string, sessionId: string, signal: AbortSignal): Promise<SessionChannelOpen>
  close(channelId: string, reason: string): Promise<void>
}

export type SessionChannelStatus = 'live' | 'closed' | 'lost' | 'unknown'
export type SessionChannelCloseResult = 'closed' | 'lost' | 'unknown'

export interface SessionRecoveryChannelPort extends SessionChannelPort {
  status(channelId: string, generation: number, connectionEpoch?: string): Promise<SessionChannelStatus>
  closeExact(channelId: string, generation: number, reason: string, connectionEpoch?: string): Promise<SessionChannelCloseResult>
}

export type SessionChannelEvent = {
  key: SessionReceiptKey
  sessionId: string
  channelId: string
  generation: number
} & (
  | { kind: 'closed' | 'lost' }
  | { kind: 'terminal'; exitCode: number | null; signal: number | null }
)

export type SessionChannelEventResult =
  | { status: 'applied'; receipt: SessionReceipt; action: SessionLaunchAction | null }
  | { status: 'retired' | 'unknown' | 'storage-unavailable' }

export interface SessionChannelEventCoordinator {
  handle(event: SessionChannelEvent): Promise<SessionChannelEventResult>
}

export type SessionChannelEventCoordinatorOptions = {
  receipts: SessionReceiptLedger
  audit: Pick<AuditLog, 'append'>
  clock: RunnerClock
}

export type SessionProcessRequest = SessionTerminalRequest & { channelId: string; channelGeneration?: number }
export type SessionProcessIdentity = Pick<SessionProcessRequest, 'sessionId' | 'cwd'>

export type SessionProcessHandle = {
  sessionId: string
  channelId?: string
  channelGeneration?: number
  finished: Promise<Pick<SessionFinishedMessage, 'exitCode' | 'signal'>>
}

export type SessionProcessStart =
  | { status: 'started'; handle: SessionProcessHandle }
  | { status: 'failed'; reason: 'spawn-failed' }

export interface SessionProcessPort {
  start(request: SessionProcessRequest, signal: AbortSignal): Promise<SessionProcessStart>
  adopt(request: SessionProcessRequest, signal: AbortSignal): Promise<SessionProcessStart>
  inspect(identity: SessionProcessIdentity): Promise<'exact' | 'missing' | 'mismatch'>
  terminate(identity: SessionProcessIdentity): Promise<'terminated' | 'missing' | 'uncertain'>
}

export interface SessionIdentifierPort {
  nextSessionId(): string
}

export type SessionLauncherOptions = {
  bindingId: () => string | null
  projects: LocalProjectRegistry
  receipts: SessionReceiptLedger
  access: SessionAccessPort
  worktrees: SessionWorktreePort
  channels: SessionChannelPort
  // Optional only for additive legacy composition; recovery treats omission as uncertainty rather
  // than inferring closure from reconnect or elapsed time.
  recoveryChannels?: SessionRecoveryChannelPort
  channelEvents?: SessionChannelEventCoordinator
  processes: SessionProcessPort
  identifiers: SessionIdentifierPort
  audit: Pick<AuditLog, 'append'>
  clock: RunnerClock
}

export const SESSION_LAUNCH_STORAGE_UNAVAILABLE = 'storage-unavailable'

export type SessionLaunchAction =
  | { kind: 'message'; message: SessionLaunchServerMessage }
  | { kind: 'close-job-control'; error: typeof SESSION_LAUNCH_STORAGE_UNAVAILABLE }

export interface SessionLauncher {
  // Each stream is ordered and emits a message only after its receipt/audit state is
  // durable. It may remain open until an indefinitely running session finishes.
  handle(request: SessionStartMessage): AsyncIterable<SessionLaunchAction>
  recover(): AsyncIterable<SessionLaunchAction>
}

export class SessionLaunchNotImplementedError extends Error {
  constructor() {
    super('session launch is an interface-only checkpoint and is not active')
    this.name = 'SessionLaunchNotImplementedError'
  }
}

export function createUnimplementedSessionLauncher(): SessionLauncher {
  const unavailable = async function* (): AsyncGenerator<never> {
    throw new SessionLaunchNotImplementedError()
  }
  return { handle: unavailable, recover: unavailable }
}

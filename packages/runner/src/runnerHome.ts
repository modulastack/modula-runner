import type { ApiKeyStore } from './apiKeys.js'
import type { LocalModelProfile } from './accessProfiles.js'
import type { AuditLog } from './auditLog.js'
import type { CommandPolicy, SignedAllowlist, TrustAnchor } from './allowlist.js'
import type { Grants } from './consent.js'
import type { LocalEndpointConfig } from './localEndpoints.js'
import type { PairingContractStore } from './pairingContract.js'
import { openRunnerHomeRecords } from './runnerHomeRecords.js'
import type { RunnerClock } from './runtimeClock.js'
import type { LocalProjectRegistry, SessionReceiptLedger } from './sessionLaunch.js'

export const RUNNER_HOME_FAILURES = [
  'policy-missing',
  'policy-malformed',
  'policy-unknown-key',
  'policy-bad-signature',
  'state-wrong-owner',
  'state-insecure-mode',
  'state-not-regular',
  'state-linked',
  'state-io-failed',
  'config-invalid',
  'config-duplicate',
  'audit-unavailable',
] as const
export type RunnerHomeFailure = (typeof RUNNER_HOME_FAILURES)[number]

export type RunnerLocalConfiguration = {
  revision: number
  profiles: readonly LocalModelProfile[]
  endpoints: readonly LocalEndpointConfig[]
}

export type RunnerConfigurationReplace =
  | { status: 'updated'; configuration: RunnerLocalConfiguration }
  | { status: 'conflict'; current: RunnerLocalConfiguration }
  | { status: 'storage-unavailable' }

export interface RunnerConfigurationStore {
  snapshot(): Promise<RunnerLocalConfiguration>
  replace(expectedRevision: number, configuration: Omit<RunnerLocalConfiguration, 'revision'>): Promise<RunnerConfigurationReplace>
}

export type RunnerPolicySnapshot = {
  revision: number
  allowlist: SignedAllowlist
  trustAnchors: readonly TrustAnchor[]
}

export type RunnerPolicyReplace =
  | { status: 'updated'; policy: RunnerPolicySnapshot }
  | { status: 'conflict'; current: RunnerPolicySnapshot }
  | { status: 'storage-unavailable' }

export interface RunnerPolicyStore {
  snapshot(): Promise<RunnerPolicySnapshot>
  replace(expectedRevision: number, policy: Omit<RunnerPolicySnapshot, 'revision'>): Promise<RunnerPolicyReplace>
}

export type RunnerHomeState = {
  pairing: PairingContractStore
  keys: ApiKeyStore
  grants: Grants
  configuration: RunnerConfigurationStore
  policyStore: RunnerPolicyStore
  policy: CommandPolicy
  projects: LocalProjectRegistry
  receipts: SessionReceiptLedger
  audit: AuditLog
}

export type RunnerHomeOpen =
  | { status: 'ready'; home: RunnerHomeState }
  | { status: 'failed'; code: RunnerHomeFailure; detail?: string }

export type RunnerHomeSelection = {
  override?: string
}

export interface RunnerHome {
  open(selection: RunnerHomeSelection): Promise<RunnerHomeOpen>
}

export const RUNNER_HOME_STATE_RECORDS = [
  'pairing',
  'keys',
  'grants',
  'configuration',
  'policy',
  'projects',
  'receipts',
] as const
export const RUNNER_HOME_RECORDS = [...RUNNER_HOME_STATE_RECORDS, 'audit'] as const
export type RunnerHomeStateRecord = (typeof RUNNER_HOME_STATE_RECORDS)[number]
export type RunnerHomeRecord = (typeof RUNNER_HOME_RECORDS)[number]

export type RunnerHomeEntryInspection = {
  record: RunnerHomeRecord
  kind: 'missing' | 'regular' | 'directory' | 'symlink' | 'other'
  owner: 'current-user' | 'other'
  mode: number
  links: number
}

export type RunnerHomeInspection = {
  rootKind: 'missing' | 'directory' | 'symlink' | 'other'
  rootOwner: 'current-user' | 'other'
  rootMode: number
  entries: readonly RunnerHomeEntryInspection[]
}

export type RunnerHomeStorageRead =
  | { status: 'found'; bytes: Uint8Array; sha256: string }
  | { status: 'missing' }
  | { status: 'storage-unavailable' }

export type RunnerHomeStorageWrite =
  | { status: 'written'; sha256: string }
  | { status: 'conflict'; currentSha256: string | null }
  | { status: 'storage-unavailable' }

export interface RunnerHomeStorage {
  // A successful inspection binds this storage instance to that exact root until close. A different
  // selection is rejected; reinspection may refresh only that bound root's metadata. Read/replace
  // never consult ambient or later mutable selection state.
  inspect(selection: RunnerHomeSelection): Promise<RunnerHomeInspection>
  acquire?(): Promise<'acquired' | 'busy' | 'storage-unavailable'>
  release?(): Promise<void>
  read(record: RunnerHomeStateRecord): Promise<RunnerHomeStorageRead>
  replace(record: RunnerHomeStateRecord, expectedSha256: string | null, bytes: Uint8Array): Promise<RunnerHomeStorageWrite>
  append(record: 'audit', bytes: Uint8Array): Promise<'appended' | 'storage-unavailable'>
}

export type RunnerHomeOptions = {
  storage: RunnerHomeStorage
  clock: RunnerClock
  pairing?: PairingContractStore
  keys?: ApiKeyStore
}

export class RunnerHomeNotImplementedError extends Error {
  constructor() {
    super('the runner home is interface-only and is not active')
    this.name = 'RunnerHomeNotImplementedError'
  }
}

export function createRunnerHome(options: RunnerHomeOptions): RunnerHome {
  return {
    async open(selection): Promise<RunnerHomeOpen> {
      const inspection = await inspectHome(options.storage, selection)
      if ('failure' in inspection) return { status: 'failed', code: inspection.failure }
      if (!options.storage.acquire || !options.storage.release) return { status: 'failed', code: 'state-io-failed' }
      let acquired: 'acquired' | 'busy' | 'storage-unavailable'
      try {
        acquired = await options.storage.acquire()
      } catch {
        return { status: 'failed', code: 'state-io-failed' }
      }
      if (acquired !== 'acquired') return { status: 'failed', code: 'state-io-failed' }
      if (!options.pairing || !options.keys) {
        try {
          await options.storage.release()
        } catch {
          return { status: 'failed', code: 'state-io-failed' }
        }
        return { status: 'failed', code: 'state-io-failed' }
      }
      const opened = await openRunnerHomeRecords({ ...options, pairing: options.pairing, keys: options.keys })
      if (opened.status === 'ready') return opened
      try {
        await options.storage.release()
      } catch {
        return { status: 'failed', code: 'state-io-failed' }
      }
      return opened
    },
  }
}

async function inspectHome(
  storage: RunnerHomeStorage,
  selection: RunnerHomeSelection,
): Promise<RunnerHomeInspection | { failure: RunnerHomeFailure }> {
  let inspection: RunnerHomeInspection
  try {
    inspection = await storage.inspect(selection)
  } catch {
    return { failure: 'state-io-failed' }
  }
  const failure = inspectionFailure(inspection)
  return failure ? { failure } : inspection
}

function inspectionFailure(inspection: RunnerHomeInspection): RunnerHomeFailure | null {
  if (inspection.rootKind === 'symlink') return 'state-linked'
  if (inspection.rootKind !== 'directory') return 'state-not-regular'
  if (inspection.rootOwner !== 'current-user') return 'state-wrong-owner'
  if (inspection.rootMode !== 0o700) return 'state-insecure-mode'
  for (const entry of inspection.entries) {
    if (entry.kind === 'missing') continue
    if (entry.kind === 'symlink' || entry.links !== 1) return 'state-linked'
    if (entry.kind !== 'regular') return 'state-not-regular'
    if (entry.owner !== 'current-user') return 'state-wrong-owner'
    if (entry.mode !== 0o600) return 'state-insecure-mode'
  }
  return null
}

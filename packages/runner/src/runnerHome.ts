import type { ApiKeyStore } from './apiKeys.js'
import type { LocalModelProfile } from './accessProfiles.js'
import type { AuditLog } from './auditLog.js'
import type { CommandPolicy, SignedAllowlist, TrustAnchor } from './allowlist.js'
import type { Grants } from './consent.js'
import type { LocalEndpointConfig } from './localEndpoints.js'
import type { PairingContractStore } from './pairingContract.js'
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
  read(record: RunnerHomeStateRecord): Promise<RunnerHomeStorageRead>
  replace(record: RunnerHomeStateRecord, expectedSha256: string | null, bytes: Uint8Array): Promise<RunnerHomeStorageWrite>
}

export type RunnerHomeOptions = {
  storage: RunnerHomeStorage
  clock: RunnerClock
}

export class RunnerHomeNotImplementedError extends Error {
  constructor() {
    super('the runner home is interface-only and is not active')
    this.name = 'RunnerHomeNotImplementedError'
  }
}

export function createRunnerHome(_options: RunnerHomeOptions): RunnerHome {
  return {
    async open(): Promise<never> {
      throw new RunnerHomeNotImplementedError()
    },
  }
}

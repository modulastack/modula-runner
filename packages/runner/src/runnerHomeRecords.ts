import { hasControlCharacter, isSafeIdentifier } from '@modulastack/runner-protocol'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { AccessResolver, isCompleteLocalModelProfile, type LocalModelProfile } from './accessProfiles.js'
import type { ApiKeyStore } from './apiKeys.js'
import type { AuditRecordInputV2, RunnerAuditLifecycle } from './auditLifecycle.js'
import type { AuditLog, AuditRecord } from './auditLog.js'
import {
  decodeSignedAllowlist,
  trustSignedAllowlist,
  type CommandPolicy,
  type SignedAllowlist,
  type TrustAnchor,
} from './allowlist.js'
import { createGrants, type GrantRecord, type GrantStore } from './consent.js'
import { DEFAULT_LOCAL_ENDPOINTS, LocalEndpointRegistry, type LocalEndpointConfig } from './localEndpoints.js'
import type { PairingContractStore } from './pairingContract.js'
import type {
  RunnerConfigurationStore,
  RunnerHomeFailure,
  RunnerHomeOpen,
  RunnerHomeState,
  RunnerHomeStorage,
  RunnerLocalConfiguration,
  RunnerPolicySnapshot,
  RunnerPolicyStore,
} from './runnerHome.js'
import type { RunnerClock } from './runtimeClock.js'
import {
  createSessionReceiptLedger,
  decodeSessionReceiptLedgerImage,
} from './sessionReceiptLedger.js'
import type {
  LocalProjectRecord,
  LocalProjectRegistry,
  NewLocalProject,
  SessionReceiptLedgerImage,
  SessionReceiptStorage,
} from './sessionLaunch.js'

export type RunnerPolicyRecordInitialization =
  | { status: 'initialized'; policy: RunnerPolicySnapshot }
  | { status: 'exists' }
  | { status: 'failed'; code: RunnerHomeFailure }

export type RunnerHomeRecordComponents = {
  pairing: PairingContractStore
  keys: ApiKeyStore
}

export type RunnerHomeRecordsOptions = RunnerHomeRecordComponents & {
  storage: RunnerHomeStorage
  clock: RunnerClock
}

export async function initializeRunnerPolicyRecord(
  storage: RunnerHomeStorage,
  candidate: RunnerPolicySnapshot,
): Promise<RunnerPolicyRecordInitialization> {
  let policy: RunnerPolicySnapshot
  try {
    policy = validateRunnerPolicySnapshot(candidate)
  } catch (error) {
    return { status: 'failed', code: error instanceof HomeRecordError ? error.failure : 'policy-malformed' }
  }
  try {
    const held = await storage.read('policy')
    if (held.status === 'found') return { status: 'exists' }
    if (held.status === 'storage-unavailable') return { status: 'failed', code: 'state-io-failed' }
    const stored = await storage.replace('policy', null, encodeJson(policy))
    if (stored.status === 'written') return { status: 'initialized', policy }
    return stored.status === 'conflict' ? { status: 'exists' } : { status: 'failed', code: 'state-io-failed' }
  } catch {
    return { status: 'failed', code: 'state-io-failed' }
  }
}

export function validateRunnerPolicySnapshot(value: unknown): RunnerPolicySnapshot {
  const policy = decodePolicy(value)
  trustedPolicy(policy)
  return policy
}

export async function openRunnerHomeRecords(options: RunnerHomeRecordsOptions): Promise<RunnerHomeOpen> {
  try {
    await options.pairing.snapshot()
    await options.keys.list()
    const configuration = configurationStore(options.storage, options.keys)
    await configuration.snapshot()
    const policyStore = runnerPolicyStore(options.storage)
    const policySnapshot = await policyStore.snapshot()
    const policy = trustedPolicy(policySnapshot)
    const projects = projectRegistry(options.storage)
    await projects.list()
    const grants = grantStore(options.storage)
    await grants.read()
    const receipts = createSessionReceiptLedger({ storage: receiptStorage(options.storage), clock: options.clock })
    await receipts.recover()
    const auditLifecycle = await options.storage.openAuditLifecycle?.()
    if (!auditLifecycle || auditLifecycle.status !== 'ready') throw new HomeRecordError('audit-unavailable')
    return {
      status: 'ready',
      home: {
        pairing: options.pairing,
        keys: options.keys,
        grants: createGrants({ store: grants }),
        configuration,
        policyStore,
        policy,
        projects,
        receipts,
        audit: auditLog(auditLifecycle.audit),
      },
    }
  } catch (error) {
    return { status: 'failed', code: error instanceof HomeRecordError ? error.failure : 'state-io-failed' }
  }
}

class HomeRecordError extends Error {
  constructor(readonly failure: RunnerHomeFailure) {
    super(failure)
    this.name = 'HomeRecordError'
  }
}

function configurationStore(storage: RunnerHomeStorage, keys: ApiKeyStore): RunnerConfigurationStore {
  const initial: RunnerLocalConfiguration = { revision: 1, profiles: [], endpoints: DEFAULT_LOCAL_ENDPOINTS }
  return {
    snapshot: async () => (await readConfiguration(storage, keys, initial)).value,
    replace: async (expectedRevision, candidate) => {
      const current = await readConfiguration(storage, keys, initial)
      if (current.value.revision !== expectedRevision) return { status: 'conflict', current: current.value }
      const next = validateConfiguration({ ...candidate, revision: expectedRevision + 1 }, keys)
      const stored = await storage.replace('configuration', current.sha256, encodeJson(next))
      if (stored.status === 'written') return { status: 'updated', configuration: next }
      if (stored.status === 'storage-unavailable') return { status: 'storage-unavailable' }
      const latest = await readConfiguration(storage, keys, initial)
      return { status: 'conflict', current: latest.value }
    },
  }
}

async function readConfiguration(
  storage: RunnerHomeStorage,
  keys: ApiKeyStore,
  initial: RunnerLocalConfiguration,
): Promise<{ value: RunnerLocalConfiguration; sha256: string | null }> {
  const held = await readJsonWithFailure(storage, 'configuration', 'config-invalid')
  if (held.status === 'missing') return { value: structuredClone(initial), sha256: null }
  return { value: validateConfiguration(held.value, keys), sha256: held.sha256 }
}

function validateConfiguration(value: unknown, keys: ApiKeyStore): RunnerLocalConfiguration {
  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1) invalidConfiguration()
  if (!Array.isArray(value.profiles) || !Array.isArray(value.endpoints)) invalidConfiguration()
  if (!value.profiles.every(isRecord) || !value.endpoints.every(isRecord)) invalidConfiguration()
  const profiles = value.profiles as LocalModelProfile[]
  const endpoints = value.endpoints as LocalEndpointConfig[]
  const profileIds = profiles.map(profile => profile.modelProfileId)
  const endpointIds = endpoints.map(endpoint => endpoint.endpointId)
  if (!profileIds.every(id => typeof id === 'string') || !endpointIds.every(id => typeof id === 'string')) invalidConfiguration()
  if (!profiles.every(isCompleteLocalModelProfile)) invalidConfiguration()
  if (duplicated(profileIds) || duplicated(endpointIds)) {
    throw new HomeRecordError('config-duplicate')
  }
  if (!profiles.every(isCompleteLocalModelProfile)) invalidConfiguration()
  try {
    const registry = new LocalEndpointRegistry(endpoints)
    new AccessResolver({ profiles, runtimes: [], keys, endpoints: registry, capabilities: () => null })
    return { revision: value.revision as number, profiles: structuredClone(profiles), endpoints: structuredClone(endpoints) }
  } catch {
    invalidConfiguration()
  }
}

function invalidConfiguration(): never {
  throw new HomeRecordError('config-invalid')
}

function runnerPolicyStore(storage: RunnerHomeStorage): RunnerPolicyStore {
  return {
    snapshot: async () => (await readPolicy(storage)).value,
    replace: async (expectedRevision, candidate) => {
      const current = await readPolicy(storage)
      if (current.value.revision !== expectedRevision) return { status: 'conflict', current: current.value }
      const next = decodePolicy({ ...candidate, revision: expectedRevision + 1 })
      trustedPolicy(next)
      const stored = await storage.replace('policy', current.sha256, encodeJson(next))
      if (stored.status === 'written') return { status: 'updated', policy: next }
      if (stored.status === 'storage-unavailable') return { status: 'storage-unavailable' }
      return { status: 'conflict', current: (await readPolicy(storage)).value }
    },
  }
}

async function readPolicy(storage: RunnerHomeStorage): Promise<{ value: RunnerPolicySnapshot; sha256: string }> {
  const held = await readJsonWithFailure(storage, 'policy', 'policy-malformed')
  if (held.status === 'missing') throw new HomeRecordError('policy-missing')
  return { value: decodePolicy(held.value), sha256: held.sha256 }
}

function decodePolicy(value: unknown): RunnerPolicySnapshot {
  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
    throw new HomeRecordError('policy-malformed')
  }
  const allowlist = decodeSignedAllowlist(JSON.stringify(value.allowlist))
  if (!allowlist || !Array.isArray(value.trustAnchors)) throw new HomeRecordError('policy-malformed')
  const trustAnchors = value.trustAnchors.map(decodeTrustAnchor)
  if (duplicated(trustAnchors.map(anchor => anchor.keyId))) throw new HomeRecordError('policy-malformed')
  return { revision: value.revision as number, allowlist, trustAnchors }
}

function decodeTrustAnchor(value: unknown): TrustAnchor {
  if (!isRecord(value) || !isSafeIdentifier(value.keyId) || typeof value.publicKey !== 'string' || value.publicKey.length > 16_384) {
    throw new HomeRecordError('policy-malformed')
  }
  return { keyId: value.keyId, publicKey: value.publicKey }
}

function trustedPolicy(snapshot: RunnerPolicySnapshot): CommandPolicy {
  const trusted = trustSignedAllowlist(snapshot.allowlist, snapshot.trustAnchors)
  if (trusted.status === 'trusted') return trusted.policy
  const failure: Record<typeof trusted.reason, RunnerHomeFailure> = {
    missing: 'policy-missing',
    malformed: 'policy-malformed',
    'unknown-key': 'policy-unknown-key',
    'bad-signature': 'policy-bad-signature',
  }
  throw new HomeRecordError(failure[trusted.reason])
}

function projectRegistry(storage: RunnerHomeStorage): LocalProjectRegistry {
  let queue: Promise<unknown> = Promise.resolve()
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation)
    // The caller receives the failure; later project operations must still be able to recover.
    queue = result.catch(() => undefined)
    return result
  }
  return {
    create: project => serialize(async () => await createProject(storage, project)),
    list: () => serialize(async () => (await readProjects(storage)).value.projects),
    get: projectId => serialize(async () => (await readProjects(storage)).value.projects.find(project => project.projectId === projectId) ?? null),
    remove: (projectId, expectedRevision) => serialize(async () => await removeProject(storage, projectId, expectedRevision)),
  }
}

const MAX_PROJECT_CAS_ATTEMPTS = 8

type ProjectImage = { revision: number; projects: LocalProjectRecord[] }

async function createProject(storage: RunnerHomeStorage, project: NewLocalProject): Promise<LocalProjectRecord> {
  validateNewProject(project)
  for (let attempt = 0; attempt < MAX_PROJECT_CAS_ATTEMPTS; attempt += 1) {
    const held = await readProjects(storage)
    if (held.value.projects.some(candidate => candidate.projectId === project.projectId)) throw new Error('project id already exists')
    const revision = held.value.revision + 1
    const created = { ...project, revision }
    const status = await writeProjectImage(storage, held, { revision, projects: [...held.value.projects, created] })
    if (status === 'written') return created
  }
  stateFailure()
}

async function removeProject(storage: RunnerHomeStorage, projectId: string, expectedRevision?: number): Promise<'removed' | 'missing' | 'conflict'> {
  if (!isSafeIdentifier(projectId)) return 'missing'
  for (let attempt = 0; attempt < MAX_PROJECT_CAS_ATTEMPTS; attempt += 1) {
    const held = await readProjects(storage)
    const found = held.value.projects.find(project => project.projectId === projectId)
    if (!found) return 'missing'
    if (expectedRevision !== undefined && found.revision !== expectedRevision) return 'conflict'
    const status = await writeProjectImage(storage, held, {
      revision: held.value.revision + 1,
      projects: held.value.projects.filter(project => project.projectId !== projectId),
    })
    if (status === 'written') return 'removed'
  }
  return 'conflict'
}

async function readProjects(storage: RunnerHomeStorage): Promise<{ value: ProjectImage; sha256: string | null }> {
  const held = await readJson(storage, 'projects')
  if (held.status === 'missing') return { value: { revision: 0, projects: [] }, sha256: null }
  if (!isRecord(held.value) || !Number.isSafeInteger(held.value.revision) || (held.value.revision as number) < 0 || !Array.isArray(held.value.projects)) stateFailure()
  const projects = held.value.projects.map(decodeProject)
  if (duplicated(projects.map(project => project.projectId))) stateFailure()
  return { value: { revision: held.value.revision as number, projects }, sha256: held.sha256 }
}

function decodeProject(value: unknown): LocalProjectRecord {
  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1) stateFailure()
  const project = value as LocalProjectRecord
  validateNewProject(project)
  return { projectId: project.projectId, repoPath: project.repoPath, worktreesRoot: project.worktreesRoot, revision: project.revision }
}

function validateNewProject(project: NewLocalProject): void {
  if (!isSafeIdentifier(project.projectId) || !localPath(project.repoPath) || !localPath(project.worktreesRoot)) stateFailure()
}

async function writeProjectImage(
  storage: RunnerHomeStorage,
  held: { value: ProjectImage; sha256: string | null },
  next: ProjectImage,
): Promise<'written' | 'conflict'> {
  const result = await storage.replace('projects', held.sha256, encodeJson(next))
  if (result.status === 'storage-unavailable') stateFailure()
  return result.status
}

function grantStore(storage: RunnerHomeStorage): GrantStore {
  let queue: Promise<unknown> = Promise.resolve()
  let base: { revision: number; sha256: string | null } | null = null
  return {
    serialize: operation => {
      const result = queue.then(operation, operation)
      // The caller observes failure; keep the record queue usable after it.
      queue = result.catch(() => undefined)
      return result
    },
    read: async () => {
      const held = await readGrantImage(storage)
      base = { revision: held.value.revision, sha256: held.sha256 }
      return held.value.records
    },
    write: async records => {
      if (!base) stateFailure()
      const validated = validateGrantRecords(records)
      const result = await storage.replace('grants', base.sha256, encodeJson({ revision: base.revision + 1, records: validated }))
      if (result.status !== 'written') stateFailure()
      base = { revision: base.revision + 1, sha256: result.sha256 }
    },
  }
}

async function readGrantImage(storage: RunnerHomeStorage): Promise<{ value: { revision: number; records: GrantRecord[] }; sha256: string | null }> {
  const held = await readJson(storage, 'grants')
  if (held.status === 'missing') return { value: { revision: 0, records: [] }, sha256: null }
  if (!isRecord(held.value) || !Number.isSafeInteger(held.value.revision) || (held.value.revision as number) < 0 || !Array.isArray(held.value.records)) stateFailure()
  const records = validateGrantRecords(held.value.records)
  return { value: { revision: held.value.revision as number, records }, sha256: held.sha256 }
}

function validateGrantRecords(values: readonly unknown[]): GrantRecord[] {
  const records = values.map(decodeGrant)
  const live = records.filter(record => record.revokedAt === undefined)
  const liveAliases = live.flatMap(record => record.alias === undefined ? [] : [record.alias])
  if (duplicated(live.map(record => record.path)) || duplicated(liveAliases)) stateFailure()
  if (duplicated(records.map(record => `${record.path}\u0000${record.grantedAt}`))) stateFailure()
  return records
}

function decodeGrant(value: unknown): GrantRecord {
  if (!isRecord(value) || !localPath(value.path) || !timestamp(value.grantedAt)) stateFailure()
  if (value.alias !== undefined && !localPath(value.alias)) stateFailure()
  if (value.revokedAt !== undefined && (!timestamp(value.revokedAt) || Date.parse(value.revokedAt) < Date.parse(value.grantedAt))) stateFailure()
  return value as GrantRecord
}

function receiptStorage(storage: RunnerHomeStorage): SessionReceiptStorage {
  return {
    load: async () => {
      try {
        const held = await readJson(storage, 'receipts')
        if (held.status === 'missing') return { status: 'loaded', image: emptyReceiptImage() }
        const image = decodeSessionReceiptLedgerImage(held.value)
        return image ? { status: 'loaded', image } : { status: 'storage-unavailable' }
      } catch {
        return { status: 'storage-unavailable' }
      }
    },
    replace: async (expectedRevision, image) => {
      try {
        const held = await readJson(storage, 'receipts')
        const current = held.status === 'missing' ? emptyReceiptImage() : decodeSessionReceiptLedgerImage(held.value)
        if (!current) return { status: 'storage-unavailable' }
        if (current.revision !== expectedRevision) return { status: 'conflict', current }
        const stored = await storage.replace('receipts', held.status === 'missing' ? null : held.sha256, encodeJson(image))
        if (stored.status === 'written') return { status: 'updated', image }
        if (stored.status !== 'conflict') return { status: 'storage-unavailable' }
        const latest = await readJson(storage, 'receipts')
        if (latest.status === 'missing') return { status: 'storage-unavailable' }
        const winner = decodeSessionReceiptLedgerImage(latest.value)
        return winner ? { status: 'conflict', current: winner } : { status: 'storage-unavailable' }
      } catch {
        return { status: 'storage-unavailable' }
      }
    },
  }
}

function emptyReceiptImage(): SessionReceiptLedgerImage {
  return { schemaVersion: 1, revision: 0, capacityBlockedUntil: null, receipts: [], tombstones: [] }
}

function auditLog(lifecycle: RunnerAuditLifecycle): AuditLog {
  return { append: async record => await lifecycle.append(auditRecordV2(record)) }
}

function auditRecordV2(record: AuditRecord): AuditRecordInputV2 {
  const base = { schemaVersion: 2 as const, eventId: randomUUID(), at: record.at }
  if (record.kind === 'spawn-admitted') {
    return {
      ...base,
      kind: record.kind,
      spawnId: record.spawnId,
      spawnKind: record.spawnKind,
      subjectId: record.recipeId,
      requestId: record.requestId,
    }
  }
  if (record.kind === 'spawn-outcome') return { ...base, kind: record.kind, spawnId: record.spawnId, outcome: record.outcome }
  if (record.kind === 'refused') {
    return {
      ...base,
      kind: record.kind,
      spawnKind: record.spawnKind,
      subjectId: record.recipeId,
      requestId: record.requestId,
      reason: record.reason,
    }
  }
  if (record.kind === 'kill') {
    return {
      ...base,
      kind: record.kind,
      confirmed: record.confirmed,
      targetCount: 0,
      targetsSha256: createHash('sha256').update(record.details).digest('hex'),
    }
  }
  if (record.kind === 'session-connection-refusal') {
    return {
      ...base,
      kind: record.kind,
      connectionId: record.connectionId,
      channelId: record.channelId,
      requestId: record.requestId,
      reason: record.reason,
      selectedProtocolVersion: record.selectedProtocolVersion,
      phase: record.phase,
    }
  }
  return {
    ...base,
    kind: record.kind,
    key: record.key,
    state: record.state,
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    ...(record.result ? { result: record.result } : {}),
  }
}

type JsonRead = { status: 'missing' } | { status: 'found'; value: unknown; sha256: string }

async function readJson(storage: RunnerHomeStorage, record: Parameters<RunnerHomeStorage['read']>[0]): Promise<JsonRead> {
  return await readJsonWithFailure(storage, record, 'state-io-failed')
}

async function readJsonWithFailure(
  storage: RunnerHomeStorage,
  record: Parameters<RunnerHomeStorage['read']>[0],
  malformed: RunnerHomeFailure,
): Promise<JsonRead> {
  const held = await storage.read(record)
  if (held.status === 'storage-unavailable') stateFailure()
  if (held.status === 'missing') return held
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(held.bytes)
    return { status: 'found', value: JSON.parse(text), sha256: held.sha256 }
  } catch {
    throw new HomeRecordError(malformed)
  }
}

function encodeJson(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value))
}

function stateFailure(): never {
  throw new HomeRecordError('state-io-failed')
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function localPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4_096 && path.isAbsolute(value) && !hasControlCharacter(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function duplicated(values: readonly string[]): boolean {
  return new Set(values).size !== values.length
}

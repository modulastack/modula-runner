import { hasControlCharacter, isSafeIdentifier } from '@modulastack/runner-protocol'
import path from 'node:path'
import { AccessResolver, isCompleteLocalModelProfile, type LocalModelProfile } from './accessProfiles.js'
import type { ApiKeyStore } from './apiKeys.js'
import type { RunnerAuditLifecycle } from './auditLifecycle.js'
import { adaptAuditLog } from './auditLogAdapter.js'
import {
  decodeSignedAllowlist,
  trustSignedAllowlist,
  type CommandPolicy,
  type SignedAllowlist,
  type TrustAnchor,
} from './allowlist.js'
import { createGrants, type GrantRecord, type GrantStore } from './consent.js'
import { DEFAULT_LOCAL_ENDPOINTS, LocalEndpointRegistry, type LocalEndpointConfig } from './localEndpoints.js'
import { decodeGrantImage, decodeGrantRecords, grantIdentity } from './runnerGrantRecords.js'
import type { PairingContractStore } from './pairingContract.js'
import type {
  RunnerConfigurationStore,
  RunnerHomeFailure,
  RunnerHomeOpen,
  RunnerHomeState,
  RunnerHomeStorage,
  RunnerLocalConfiguration,
  RunnerPolicySnapshot,
} from './runnerHome.js'
import type { RunnerClock } from './runtimeClock.js'
import {
  createRunnerTrustStore,
  initializeRunnerTrust,
  openRunnerTrust,
  RunnerTrustError,
} from './runnerTrustStore.js'
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
  audit: RunnerAuditLifecycle
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
    const result = await initializeRunnerTrust(storage, policy)
    if (result === 'conflict') return { status: 'exists' }
    return { status: 'initialized', policy: await createRunnerTrustStore(storage).snapshot() }
  } catch (error) {
    return { status: 'failed', code: trustFailure(error) }
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
    const policyStore = await openRunnerTrust(options.storage)
    const policySnapshot = await policyStore.snapshot()
    const policy = trustedPolicy(policySnapshot)
    const projects = projectRegistry(options.storage)
    await projects.list()
    const grants = grantStore(options.storage)
    await grants.read()
    const receipts = createSessionReceiptLedger({ storage: receiptStorage(options.storage), clock: options.clock })
    await receipts.recover()
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
        audit: adaptAuditLog(options.audit),
      },
    }
  } catch (error) {
    return { status: 'failed', code: trustFailure(error) }
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
  if (!exactRecord(value, ['endpoints', 'profiles', 'revision'])) invalidConfiguration()
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) invalidConfiguration()
  const rawProfiles = value.profiles
  const rawEndpoints = value.endpoints
  if (!Array.isArray(rawProfiles) || !Array.isArray(rawEndpoints)) invalidConfiguration()
  const profileCount = rawProfiles.length
  const endpointCount = rawEndpoints.length
  if (!Number.isSafeInteger(profileCount) || profileCount < 0 || profileCount > 256
    || !Number.isSafeInteger(endpointCount) || endpointCount < 0 || endpointCount > 256) invalidConfiguration()
  const profiles: LocalModelProfile[] = []
  for (let index = 0; index < profileCount; index += 1) profiles.push(decodeProfile(rawProfiles[index]))
  const endpoints: LocalEndpointConfig[] = []
  for (let index = 0; index < endpointCount; index += 1) endpoints.push(decodeEndpoint(rawEndpoints[index]))
  if (duplicated(profiles.map(profile => profile.modelProfileId)) || duplicated(endpoints.map(endpoint => endpoint.endpointId))) {
    throw new HomeRecordError('config-duplicate')
  }
  try {
    const registry = new LocalEndpointRegistry(endpoints)
    new AccessResolver({ profiles, runtimes: [], keys, endpoints: registry, capabilities: () => null })
    return { revision: value.revision as number, profiles, endpoints }
  } catch {
    invalidConfiguration()
  }
}

function decodeProfile(value: unknown): LocalModelProfile {
  if (!exactRecord(value, ['access', 'modelProfileId', 'runtime'], ['endpointId', 'keyLabel', 'model', 'provider'])) invalidConfiguration()
  const canonical = {
    access: value.access,
    modelProfileId: value.modelProfileId,
    runtime: value.runtime,
    endpointId: value.endpointId,
    keyLabel: value.keyLabel,
    model: value.model,
    provider: value.provider,
  }
  if (typeof canonical.modelProfileId !== 'string' || !isSafeIdentifier(canonical.modelProfileId)) invalidConfiguration()
  if (typeof canonical.runtime !== 'string' || !isSafeIdentifier(canonical.runtime)) invalidConfiguration()
  if (canonical.access !== 'subscription' && canonical.access !== 'api-key' && canonical.access !== 'local') invalidConfiguration()
  for (const field of ['endpointId', 'keyLabel', 'provider'] as const) {
    if (canonical[field] !== undefined && (typeof canonical[field] !== 'string' || !isSafeIdentifier(canonical[field]))) invalidConfiguration()
  }
  if (canonical.model !== undefined && !boundedText(canonical.model, 128)) invalidConfiguration()
  const profile: LocalModelProfile = {
    modelProfileId: canonical.modelProfileId,
    runtime: canonical.runtime,
    access: canonical.access,
    ...(typeof canonical.provider === 'string' ? { provider: canonical.provider } : {}),
    ...(typeof canonical.model === 'string' ? { model: canonical.model } : {}),
    ...(typeof canonical.keyLabel === 'string' ? { keyLabel: canonical.keyLabel } : {}),
    ...(typeof canonical.endpointId === 'string' ? { endpointId: canonical.endpointId } : {}),
  }
  if (!isCompleteLocalModelProfile(profile)) invalidConfiguration()
  return profile
}

function decodeEndpoint(value: unknown): LocalEndpointConfig {
  if (!exactRecord(value, ['baseUrl', 'endpointId', 'kind'])) invalidConfiguration()
  const canonical = { endpointId: value.endpointId, kind: value.kind, baseUrl: value.baseUrl }
  const { endpointId, kind, baseUrl } = canonical
  if (typeof endpointId !== 'string' || !isSafeIdentifier(endpointId)
    || typeof baseUrl !== 'string' || !boundedText(baseUrl, 2_048)) invalidConfiguration()
  if (kind !== 'ollama' && kind !== 'openai-compatible') invalidConfiguration()
  return { endpointId, kind, baseUrl }
}

function invalidConfiguration(): never {
  throw new HomeRecordError('config-invalid')
}

function trustFailure(error: unknown): RunnerHomeFailure {
  if (error instanceof HomeRecordError || error instanceof RunnerTrustError) return error.failure
  return 'state-io-failed'
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
  const canonical = canonicalProject(project)
  for (let attempt = 0; attempt < MAX_PROJECT_CAS_ATTEMPTS; attempt += 1) {
    const held = await readProjects(storage)
    if (held.value.projects.some(candidate => candidate.projectId === canonical.projectId)) throw new Error('project id already exists')
    const revision = held.value.revision + 1
    const created = { ...canonical, revision }
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
  if (!exactRecord(held.value, ['projects', 'revision'])) stateFailure()
  if (!Number.isSafeInteger(held.value.revision) || (held.value.revision as number) < 0 || !Array.isArray(held.value.projects)) stateFailure()
  const projects = held.value.projects.map(decodeProject)
  if (duplicated(projects.map(project => project.projectId))) stateFailure()
  return { value: { revision: held.value.revision as number, projects }, sha256: held.sha256 }
}

function decodeProject(value: unknown): LocalProjectRecord {
  if (!exactRecord(value, ['projectId', 'repoPath', 'revision', 'worktreesRoot'])) stateFailure()
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) stateFailure()
  if (typeof value.projectId !== 'string' || typeof value.repoPath !== 'string' || typeof value.worktreesRoot !== 'string') stateFailure()
  const project: LocalProjectRecord = {
    projectId: value.projectId,
    repoPath: value.repoPath,
    worktreesRoot: value.worktreesRoot,
    revision: value.revision as number,
  }
  if (!isSafeIdentifier(project.projectId) || !localPath(project.repoPath) || !localPath(project.worktreesRoot)) stateFailure()
  return project
}

function canonicalProject(project: NewLocalProject): NewLocalProject {
  if (!exactRecord(project, ['projectId', 'repoPath', 'worktreesRoot'])) stateFailure()
  const canonical = { projectId: project.projectId, repoPath: project.repoPath, worktreesRoot: project.worktreesRoot }
  if (!isSafeIdentifier(canonical.projectId) || !localPath(canonical.repoPath) || !localPath(canonical.worktreesRoot)) stateFailure()
  return canonical
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

type HeldGrantImage = { value: { revision: number; records: GrantRecord[] }; sha256: string | null }
type GrantMutation = { additions: GrantRecord[]; revocations: { identity: string; revokedAt: string }[] }

const MAX_GRANT_CAS_ATTEMPTS = 8

function grantStore(storage: RunnerHomeStorage): GrantStore {
  let queue: Promise<unknown> = Promise.resolve()
  let base: HeldGrantImage | null = null
  return {
    serialize: operation => {
      const result = queue.then(operation, operation)
      // The caller observes failure; keep the record queue usable after it.
      queue = result.catch(() => undefined)
      return result
    },
    read: async () => {
      base = await readGrantImage(storage)
      return base.value.records.map(record => ({ ...record }))
    },
    write: async records => {
      if (!base) stateFailure()
      const mutation = grantMutation(base.value.records, requireGrantRecords(records))
      for (let attempt = 0; attempt < MAX_GRANT_CAS_ATTEMPTS; attempt += 1) {
        const held = attempt === 0 ? base : await readGrantImage(storage)
        const nextRecords = applyGrantMutation(held.value.records, mutation)
        const result = await storage.replace('grants', held.sha256, encodeJson({ revision: held.value.revision + 1, records: nextRecords }))
        if (result.status === 'written') {
          base = { value: { revision: held.value.revision + 1, records: nextRecords }, sha256: result.sha256 }
          return
        }
        if (result.status === 'storage-unavailable') stateFailure()
      }
      stateFailure()
    },
  }
}

async function readGrantImage(storage: RunnerHomeStorage): Promise<HeldGrantImage> {
  const held = await readJson(storage, 'grants')
  if (held.status === 'missing') return { value: { revision: 0, records: [] }, sha256: null }
  const value = decodeGrantImage(held.value)
  if (!value) stateFailure()
  return { value, sha256: held.sha256 }
}

function grantMutation(base: readonly GrantRecord[], candidate: readonly GrantRecord[]): GrantMutation {
  const baseByIdentity = new Map(base.map(record => [grantIdentity(record), record]))
  const candidateByIdentity = new Map(candidate.map(record => [grantIdentity(record), record]))
  const additions = candidate.filter(record => !baseByIdentity.has(grantIdentity(record)))
  if (additions.some(record => record.revokedAt !== undefined)) stateFailure()
  const revocations: GrantMutation['revocations'] = []
  for (const held of base) {
    const next = candidateByIdentity.get(grantIdentity(held))
    if (!next || next.alias !== held.alias) stateFailure()
    if (held.revokedAt !== undefined && next.revokedAt !== held.revokedAt) stateFailure()
    if (held.revokedAt === undefined && next.revokedAt !== undefined) {
      revocations.push({ identity: grantIdentity(held), revokedAt: next.revokedAt })
    }
  }
  return { additions, revocations }
}

function applyGrantMutation(current: readonly GrantRecord[], mutation: GrantMutation): GrantRecord[] {
  const revoked = new Map(mutation.revocations.map(change => [change.identity, change.revokedAt]))
  const merged = current.map(record => {
    const revokedAt = record.revokedAt === undefined ? revoked.get(grantIdentity(record)) : undefined
    return revokedAt === undefined ? record : { ...record, revokedAt }
  })
  for (const added of mutation.additions) {
    const held = merged.find(record => grantIdentity(record) === grantIdentity(added))
    const live = merged.find(record => record.revokedAt === undefined && record.path === added.path)
    if ((held && (held.revokedAt !== undefined || held.alias !== added.alias)) || (live && live.alias !== added.alias)) stateFailure()
    if (!held && !live) merged.push(added)
  }
  return requireGrantRecords(merged)
}

function requireGrantRecords(values: readonly unknown[]): GrantRecord[] {
  const records = decodeGrantRecords(values)
  if (!records) stateFailure()
  return records
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

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !hasControlCharacter(value)
}

function localPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4_096 && path.isAbsolute(value) && !hasControlCharacter(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const allowed = new Set([...required, ...optional])
  return required.every(key => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every(key => allowed.has(key))
}

function duplicated(values: readonly string[]): boolean {
  return new Set(values).size !== values.length
}

import { spawnSync } from 'node:child_process'
import { sessionStartFingerprint, type SessionStartMessage } from '@modulastack/runner-protocol'
import {
  SecretEnv,
  SessionLaunchNotImplementedError,
  createSessionLauncher,
  createSessionReceiptLedger,
  type LocalProjectRecord,
  type SessionBranchCreatedSnapshot,
  type SessionLauncher,
  type SessionLauncherOptions,
  type SessionLaunchAction,
  type SessionReceipt,
  type SessionReceiptLedgerImage,
  type SessionReceiptTombstone,
  type SessionWorktreeRegisteredSnapshot,
  type SessionWorktreeVerifiedSnapshot,
} from '../../src/index.js'
import { observeCapacityDurabilityScenario } from './capacityDurabilitySubject.js'
import {
  runtimeRedFixtureApiKey,
  runtimeRedFixtureCommand,
  runtimeRedFixtureEndpoint,
  runtimeRedSensitiveValues,
} from './fixtureMaterial.js'
import {
  collectLaunchStimuli,
  collectRecoveryStimulus,
  recordLaunchScenarioEvidence,
  terminalReplayMatchesStored,
  type StartedSessionEvidence,
} from './launcherEvidence.js'
import { createRecorder } from './recorder.js'
import { requestIdFor } from './scenarioIdentity.js'
import type { RuntimeObservation, RuntimeScenario } from './scenarioTypes.js'

const bindingId = '123e4567-e89b-42d3-a456-426614174000'
export const LAUNCHER_FIXTURE_NOW = '2026-08-21T00:00:00Z'
export const RECEIPT_OUTCOME_EXPIRED_AT = '2026-08-20T23:59:59Z'
const project: LocalProjectRecord = {
  projectId: 'modulastack',
  repoPath: '/repos/modulastack',
  worktreesRoot: '/worktrees',
  revision: 1,
}
const receiptOutcomeRequestIds = {
  expiry: requestIdFor('G1-R251'),
  retained: requestIdFor('G1-R252'),
  capacity: requestIdFor('G1-R253'),
} as const

export async function observeLauncherScenario(scenario: RuntimeScenario): Promise<RuntimeObservation> {
  if (scenario.fixture === 'capacity-durability-matrix') return observeCapacityDurabilityScenario(scenario)
  const recorder = createRecorder()
  const primary = launcherRequestFor(scenario)
  if (scenario.fixture === 'git-invalid-branch' && gitRejectsBranch(primary.target.branch)) recorder.record('stimulus.branch:git-invalid')
  const stored = new Map<string, SessionReceipt | SessionReceiptTombstone>()
  const openedChannels: StartedSessionEvidence[] = []
  const durableStarts: StartedSessionEvidence[] = []
  seedKnownReceipt(stored, scenario, primary)
  rememberDurableStarts(stored, durableStarts)
  let processStarts = 0
  let channelOpens = 0
  let claimCalls = 0
  let successfulClaims = 0
  let registerCalls = 0
  let settledWorktree: SessionWorktreeRegisteredSnapshot | null = null
  let settledTarget: SessionStartMessage['target'] | null = null
  let currentTime = Date.parse(LAUNCHER_FIXTURE_NOW)
  let activeWorktreePrepares = 0
  let maxActiveWorktreePrepares = 0
  let releaseConcurrentProgressTimeout: (() => void) | undefined
  const concurrentProgressTimeout = scenario.fixture === 'concurrent-same-lane'
    ? new Promise<void>(resolve => { releaseConcurrentProgressTimeout = resolve })
    : undefined

  const options: SessionLauncherOptions = {
    bindingId() {
      const current = scenario.fixture === 'binding-mismatch' ? '323e4567-e89b-42d3-a456-426614174003' : bindingId
      recorder.record(`binding.compare:${current === primary.bindingId ? 'match' : 'mismatch'}`)
      return current
    },
    projects: {
      async create(next) {
        recorder.record('projects.create')
        return { ...next, revision: 1 }
      },
      async list() {
        recorder.record('projects.list')
        return [project]
      },
      async get(projectId) {
        recorder.record(`projects.get:${projectId}`)
        recorder.record('projects.get')
        recorder.record('projects.get:project-id')
        return scenario.fixture === 'project-unknown' ? null : project
      },
      async remove() {
        recorder.record('projects.remove')
        return 'missing'
      },
    },
    receipts: {
      async lookup(key) {
        recorder.record(`receipts.lookup:${key.requestId}`)
        const value = stored.get(receiptKey(key.bindingId, key.requestId))
        const status = value ? ('request' in value ? 'receipt' : 'tombstone') : 'missing'
        recorder.record(`receipts.lookup:${status}`)
        if (value) recorder.record('receipts.lookup:known')
        if (!value) return { status: 'missing' }
        return 'request' in value ? { status: 'receipt', receipt: value } : { status: 'tombstone', tombstone: value }
      },
      async claim(request, fingerprint) {
        claimCalls += 1
        recorder.record('receipts.claim.call')
        recorder.record(`receipts.claim:${request.requestId}`)
        const key = receiptKey(request.bindingId, request.requestId)
        const existing = stored.get(key)
        if (existing) {
          const status = existing.fingerprint === fingerprint ? 'known' : 'conflict'
          recorder.record(`receipts.claim:${status}`)
          return status === 'known' ? { status, value: existing } : { status }
        }
        if (isCapacityFixtureRequest(scenario, request)) {
          recorder.record('receipts.claim:at-capacity')
          return { status: 'at-capacity', blockedUntil: request.expiresAt }
        }
        const receipt = receiptFor(request, fingerprint)
        stored.set(key, receipt)
        recordReceiptSensitivity(recorder.record, stored.get(key))
        successfulClaims += 1
        recorder.record('receipts.claim:claimed')
        recorder.record(`receipts.fingerprint:${fingerprint}`)
        return { status: 'claimed', receipt }
      },
      async replace(_expectedRevision, receipt) {
        recorder.record(`receipts.replace:${receipt.state}`)
        recorder.record(`receipt.${receipt.state}`)
        if (receipt.state === 'failed' && receipt.result?.type === 'SESSION_FAILED') {
          recorder.record(`receipt.failed:${receipt.result.reason}`)
        }
        const updated = { ...receipt, revision: receipt.revision + 1 }
        const key = receiptKey(receipt.key.bindingId, receipt.key.requestId)
        stored.set(key, updated)
        const persisted = stored.get(key)
        recordReceiptSensitivity(recorder.record, persisted)
        const serialized = JSON.stringify(persisted) ?? ''
        if (/127\.0\.0\.1|ANTHROPIC_BASE_URL/.test(serialized)) recorder.record('receipt.endpoint-address')
        if (/ANTHROPIC_API_KEY|secret|attachToken/.test(serialized)) recorder.record('receipt.secret')
        rememberDurableStart(updated, durableStarts)
        return { status: 'updated', receipt: updated }
      },
      async recover() {
        recorder.record('receipts.recover')
        return recoveryReceipts(scenario, primary)
      },
      async compact() {
        recorder.record('receipts.compact')
      },
    },
    access: {
      async resolve(modelProfileId) {
        recorder.record(`access.resolve:${modelProfileId}`)
        recorder.record('access.resolve')
        if (modelProfileId === primary.modelProfileId) {
          recorder.record('access.resolve:exact-model-profile')
          recorder.record('access.resolve:model-profile')
        }
        const reason = accessReason(scenario.fixture)
        if (reason) return { status: 'refused', reason }
        return {
          status: 'resolved',
          plan: {
            modelProfileId,
            access: scenario.fixture.includes('local-endpoint') ? 'local' : scenario.fixture.includes('subscription') ? 'subscription' : 'api-key',
            runtime: 'claude',
            command: runtimeRedFixtureCommand,
            args: ['--model', 'approved'],
            env: { RUNNER_MODE: '1' },
            secrets: scenario.fixture.includes('local-endpoint')
              ? SecretEnv.of({ ANTHROPIC_BASE_URL: runtimeRedFixtureEndpoint })
              : scenario.fixture.includes('subscription') ? SecretEnv.empty() : SecretEnv.of({ ANTHROPIC_API_KEY: runtimeRedFixtureApiKey }),
          },
        }
      },
    },
    worktrees: {
      async prepare(selectedProject, target) {
        const tracksConcurrentPreparation = scenario.fixture === 'concurrent-same-lane'
        if (tracksConcurrentPreparation) {
          activeWorktreePrepares += 1
          maxActiveWorktreePrepares = Math.max(maxActiveWorktreePrepares, activeWorktreePrepares)
        }
        try {
          if (tracksConcurrentPreparation) await Promise.resolve()
          recorder.record('worktree.prepare.call')
          recorder.record(`worktree.prepare:${target.branch}+${target.baseBranch}+${target.worktreeName}+${target.relativeCwd}`)
          if (selectedProject.repoPath !== project.repoPath || selectedProject.worktreesRoot !== project.worktreesRoot) recorder.record('worktree.prepare:remote-path')
          if (target.relativeCwd.startsWith('/')) recorder.record('worktree.prepare:absolute-wire-path')
          recorder.record('worktree.prepare:branch+base+name+cwd')
          recorder.record('worktree.prepare:local-repo-root')
          recorder.record('worktree.prepare:local-mapping')
          recorder.record('worktree.prepare:deterministic-path')
          if (gitRejectsBranch(target.branch)) recorder.record('worktree.prepare:git-invalid')
          if (scenario.fixture === 'worktree-conflict') return { status: 'failed', reason: 'worktree-conflict' }
          if (scenario.fixture === 'git-invalid-branch' && gitRejectsBranch(target.branch)) return { status: 'failed', reason: 'worktree-invalid' }
          if (scenario.fixture === 'same-target-distinct-requests' && settledWorktree && settledTarget) {
            const reused = registeredSnapshot('reused')
            recorder.record('worktree.prepare:reused')
            if (sameTarget(settledTarget, target) && sameWorktreeEvidence(settledWorktree, reused)) recorder.record('worktree.prepare:same-target-evidence')
            return { status: 'ready', snapshot: reused }
          }
          settledTarget = { ...target }
          return { status: 'ready', snapshot: branchSnapshot() }
        } finally {
          if (tracksConcurrentPreparation) activeWorktreePrepares -= 1
        }
      },
      async register() {
        registerCalls += 1
        recorder.record('worktree.register.call')
        recorder.record(`worktree.register:${registerCalls}`)
        if (scenario.fixture.startsWith('provision-failure')) return { status: 'failed', reason: 'provision-failed' }
        settledWorktree = registeredSnapshot('created')
        return { status: 'ready', snapshot: settledWorktree }
      },
      async verify(snapshot) {
        if (scenario.fixture === 'grant-revoked-before-spawn') {
          recorder.record('worktree.verify:path-not-granted')
          return { status: 'failed', reason: 'path-not-granted' }
        }
        recorder.record('worktree.verify:clean')
        return { status: 'ready', snapshot: verifiedSnapshot(snapshot.ownership) }
      },
      async inspect() {
        const result = scenario.fixture.includes('mismatch') ? 'mismatch' : 'exact'
        recorder.record(`worktree.inspect:${result}`)
        return result
      },
      async rollback() {
        const result = scenario.fixture === 'provision-failure-unowned' ? 'not-owned' : scenario.fixture.includes('mismatch') ? 'uncertain' : 'rolled-back'
        recorder.record(`worktree.rollback:${result}`)
        if (result === 'rolled-back') recorder.record('worktree.rollback:owned')
        return result
      },
    },
    channels: {
      async open(requestId, sessionId) {
        channelOpens += 1
        recorder.record(`channel.open:${requestId}:${sessionId}`)
        recorder.record(`channel.open:${channelOpens === 1 ? 'once' : channelOpens}`)
        recorder.record('channel.open:runner-id')
        if (scenario.fixture === 'channel-failure') return { status: 'failed', reason: 'channel-unavailable' }
        const channelId = `channel-${scenario.obligationId.toLowerCase()}-${channelOpens}`
        openedChannels.push({ requestId, sessionId, channelId })
        return { status: 'opened', channelId }
      },
      async close() {
        recorder.record('channel.close')
      },
    },
    processes: {
      async start(request) {
        processStarts += 1
        recorder.record('process.start.call')
        if (request.plan.command !== runtimeRedFixtureCommand) recorder.record('process.start:wire-command')
        const secretNames = request.plan.secrets.names
        if (scenario.fixture.includes('api-key') && !secretNames.includes('ANTHROPIC_API_KEY')) recorder.record('process.start:alternate-key')
        recorder.record(`process.start:${request.requestId}:${request.sessionId}`)
        recorder.record(`process.start:${processStarts === 1 ? 'once' : processStarts}`)
        recorder.record('process.start:catalog-command')
        recorder.record('process.session-bound')
        recorder.record(`process.request:${request.terminalProfile}`)
        recorder.record('process.request:terminal-profile')
        recorder.record('process.request:bound-terminal-profile')
        if (scenario.fixture.includes('api-key')) recorder.record('process.start:profile-key')
        if (scenario.fixture.includes('local-endpoint')) recorder.record('process.start:endpoint-secret-env')
        if (scenario.fixture.includes('subscription')) recorder.record('process.start:subscription-login')
        if (scenario.fixture === 'process-failure-after-channel') return { status: 'failed', reason: 'spawn-failed' }
        return { status: 'started', handle: processHandle(request.sessionId) }
      },
      async adopt(request) {
        recorder.record('process.adopt')
        return { status: 'started', handle: processHandle(request.sessionId) }
      },
      async inspect() {
        const result = scenario.fixture.includes('mismatch') ? 'mismatch' : 'exact'
        recorder.record(`process.inspect:${result}`)
        return result
      },
      async terminate() {
        recorder.record('process.terminate')
        return 'terminated'
      },
    },
    identifiers: {
      nextSessionId() {
        recorder.record('identifier.nextSessionId')
        return `session-${scenario.obligationId.toLowerCase()}`
      },
    },
    audit: {
      async append(record) {
        const state = record.kind === 'session-launch' ? record.state : record.kind
        recorder.record(`audit.${state}`)
        if (scenario.fixture === 'audit-storage-failure') throw new Error('audit unavailable')
      },
    },
    clock: {
      now() {
        recorder.record('clock.now')
        return currentTime
      },
      async sleep(milliseconds) {
        recorder.record(`clock.sleep:${milliseconds}`)
        if (milliseconds <= 5_000) recorder.record('clock.initial<=5000')
        if (milliseconds <= 180_000) recorder.record('clock.progress<=180000')
        if (milliseconds === 180_000 && concurrentProgressTimeout) await concurrentProgressTimeout
      },
    },
  }

  const launcher = launcherForFixture(createSessionLauncher(options), scenario.fixture)
  const expireTombstone = async () => {
    currentTime = Date.parse('2026-09-21T00:00:00Z')
    return await deleteExpiredTombstone(stored, primary, currentTime)
  }
  try {
    if (scenario.fixture === 'receipt-outcomes-observable') {
      await recordReceiptOutcomeEvidence(launcher, scenario, primary, stored, recorder.record)
      return { status: 'observed', subject: 'launcher', result: 'launcher:actions', events: recorder.events, output: recorder.output }
    }
    const observed = scenario.fixture.startsWith('recover-')
      ? await collectRecoveryStimulus(launcher.recover(), primary.requestId, recorder.record)
      : await collectLaunchStimuli(
        launcher.handle.bind(launcher),
        scenario,
        primary,
        stored,
        recorder.record,
        scenario.fixture === 'tombstone-retention-retry' ? expireTombstone : undefined,
      )
    if (scenario.fixture === 'concurrent-same-lane') {
      recorder.record(`worktree.prepare:max-active:${maxActiveWorktreePrepares}`)
    }
    if (scenario.fixture.includes('verifier-wrong-retained-result')) {
      replaceRetainedTerminalResult(stored, primary)
    }
    recordLaunchScenarioEvidence(recorder.record, scenario, observed, primary, claimCalls, successfulClaims, {
      stored,
      openedChannels,
      durableStarts,
    })
    return { status: 'observed', subject: 'launcher', result: 'launcher:actions', events: recorder.events, output: recorder.output }
  } catch (error) {
    if (error instanceof SessionLaunchNotImplementedError) {
      return { status: 'missing-production-runtime', subject: 'launcher', error: error.name }
    }
    throw error
  } finally {
    releaseConcurrentProgressTimeout?.()
  }
}

function launcherForFixture(launcher: SessionLauncher, fixture: string): SessionLauncher {
  if (!fixture.includes('verifier-wrong-response-id') && !fixture.includes('verifier-double-terminal')) return launcher
  return {
    async *handle(request) {
      for await (const action of launcher.handle(request)) yield* mutateLauncherActions(action, fixture)
    },
    async *recover() {
      for await (const action of launcher.recover()) yield* mutateLauncherActions(action, fixture)
    },
  }
}

function* mutateLauncherActions(action: SessionLaunchAction, fixture: string): Generator<SessionLaunchAction> {
  const mutated = fixture.includes('verifier-wrong-response-id') ? alternateActionRequestId(action) : action
  yield mutated
  if (fixture.includes('verifier-double-terminal') && isTerminalAction(mutated)) yield mutated
}

function alternateActionRequestId(action: SessionLaunchAction): SessionLaunchAction {
  if (action.kind === 'close-job-control') return action
  const requestId = action.message.requestId
  const final = requestId.slice(-1)
  return {
    kind: 'message',
    message: { ...action.message, requestId: `${requestId.slice(0, -1)}${final === 'f' ? 'e' : 'f'}` },
  }
}

function isTerminalAction(action: SessionLaunchAction): boolean {
  return action.kind === 'message' && (action.message.type === 'SESSION_REFUSED'
    || action.message.type === 'SESSION_FAILED' || action.message.type === 'SESSION_FINISHED')
}

function replaceRetainedTerminalResult(
  stored: Map<string, SessionReceipt | SessionReceiptTombstone>,
  request: SessionStartMessage,
) {
  const key = receiptKey(request.bindingId, request.requestId)
  const retained = stored.get(key)
  if (!retained) return
  const result: NonNullable<SessionReceipt['result']> = {
    type: 'SESSION_FAILED',
    requestId: request.requestId,
    reason: 'spawn-failed',
  }
  if ('request' in retained) {
    const receipt: SessionReceipt = { ...retained, result }
    stored.set(key, receipt)
    return
  }
  const tombstone: SessionReceiptTombstone = { ...retained, result }
  stored.set(key, tombstone)
}

export function launcherRequestFor(scenario: RuntimeScenario): SessionStartMessage {
  return {
    type: 'SESSION_START',
    bindingId,
    requestId: requestIdFor(scenario.obligationId),
    expiresAt: '2026-08-21T00:10:00Z',
    terminalProfile: 'coder',
    modelProfileId: 'daily',
    target: {
      projectId: 'modulastack',
      worktreeName: 'lane-01',
      branch: scenario.fixture === 'git-invalid-branch' ? 'feat..invalid' : 'feat/lane-01',
      baseBranch: 'main',
      relativeCwd: '.',
    },
  }
}

function receiptFor(request: SessionStartMessage, fingerprint = sessionStartFingerprint(request)): SessionReceipt {
  return {
    schemaVersion: 1,
    revision: 1,
    key: { bindingId: request.bindingId, requestId: request.requestId },
    fingerprint,
    request,
    state: 'accepted',
    phaseTimestamps: { accepted: '2026-08-21T00:00:00Z' },
    project,
    worktree: { phase: 'none' },
  }
}

function seedKnownReceipt(store: Map<string, SessionReceipt | SessionReceiptTombstone>, scenario: RuntimeScenario, request: SessionStartMessage) {
  const key = receiptKey(request.bindingId, request.requestId)
  if (scenario.fixture.includes('known-started')) {
    store.set(key, {
      ...receiptFor(request),
      state: 'started',
      phaseTimestamps: { accepted: '2026-08-21T00:00:00Z', provisioned: '2026-08-21T00:00:01Z', 'spawn-intent': '2026-08-21T00:00:02Z', started: '2026-08-21T00:00:03Z' },
      worktree: verifiedSnapshot('created'),
      sessionId: 'session-stable',
      channelId: 'channel-stable',
    })
  }
  if (scenario.fixture.includes('known-terminal') || scenario.fixture === 'tombstone-retention-retry') {
    store.set(key, tombstoneFor(request))
  }
}

function rememberDurableStarts(
  stored: ReadonlyMap<string, SessionReceipt | SessionReceiptTombstone>,
  durableStarts: StartedSessionEvidence[],
) {
  for (const value of stored.values()) {
    if ('request' in value) rememberDurableStart(value, durableStarts)
  }
}

function rememberDurableStart(receipt: SessionReceipt, durableStarts: StartedSessionEvidence[]) {
  if (receipt.state !== 'started' || !receipt.sessionId || !receipt.channelId) return
  durableStarts.push({
    requestId: receipt.request.requestId,
    channelId: receipt.channelId,
    sessionId: receipt.sessionId,
  })
}

function isTombstone(value: SessionReceipt | SessionReceiptTombstone | undefined): value is SessionReceiptTombstone {
  return value !== undefined && !('request' in value)
}

async function deleteExpiredTombstone(
  stored: Map<string, SessionReceipt | SessionReceiptTombstone>,
  request: SessionStartMessage,
  now: number,
): Promise<boolean> {
  const key = receiptKey(request.bindingId, request.requestId)
  const retained = stored.get(key)
  if (!isTombstone(retained) || Date.parse(retained.deleteAfter) > now) return false
  let image: SessionReceiptLedgerImage = {
    schemaVersion: 1,
    revision: 1,
    capacityBlockedUntil: null,
    receipts: [],
    tombstones: [retained],
  }
  const ledger = createSessionReceiptLedger({
    clock: { now: () => now, sleep: async () => undefined },
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
  await ledger.compact(new Date(now).toISOString())
  if (image.tombstones.some(tombstone => tombstone.key.requestId === request.requestId)) return false
  stored.delete(key)
  return true
}

function tombstoneFor(request: SessionStartMessage): SessionReceiptTombstone {
  return {
    key: { bindingId: request.bindingId, requestId: request.requestId },
    fingerprint: sessionStartFingerprint(request),
    result: { type: 'SESSION_FINISHED', requestId: request.requestId, exitCode: 0, signal: null },
    sessionId: 'session-stable',
    terminalAt: '2026-08-21T00:01:00Z',
    deleteAfter: '2026-09-20T00:01:00Z',
  }
}

function recoveryReceipts(scenario: RuntimeScenario, request: SessionStartMessage): SessionReceipt[] {
  if (!scenario.fixture.startsWith('recover-')) return []
  return [{
    ...receiptFor(request),
    state: 'spawn-intent',
    phaseTimestamps: { accepted: '2026-08-21T00:00:00Z', provisioned: '2026-08-21T00:00:01Z', 'spawn-intent': '2026-08-21T00:00:02Z' },
    sessionId: 'session-stable',
    channelId: 'channel-old',
    worktree: verifiedSnapshot('created'),
  }]
}

function accessReason(fixture: string) {
  const prefix = 'access-refusal-'
  return fixture.startsWith(prefix) ? fixture.slice(prefix.length) as Parameters<typeof accessRefusal>[0] : null
}

function accessRefusal(reason: 'unknown-profile' | 'runtime-unknown' | 'runtime-unavailable' | 'runtime-unauthenticated' | 'access-unsupported' | 'unknown-key' | 'key-provider-mismatch' | 'unknown-endpoint' | 'endpoint-unavailable' | 'model-unavailable' | 'profile-incomplete') {
  return reason
}

function branchSnapshot(): SessionBranchCreatedSnapshot {
  return {
    phase: 'branch-created', ownership: 'created', branch: 'feat/lane-01', branchRef: 'refs/heads/feat/lane-01',
    baseBranch: 'main', headCommit: 'a'.repeat(40), expectedBaseCommit: 'a'.repeat(40), gitCommonDir: '/repos/modulastack/.git',
  }
}

function registeredSnapshot(ownership: 'created' | 'reused'): SessionWorktreeRegisteredSnapshot {
  return {
    ...branchSnapshot(), phase: 'worktree-registered', ownership, worktreePath: '/worktrees/lane-01',
    worktreeIdentity: { device: '8', inode: '101' }, worktreeGitDir: '/repos/modulastack/.git/worktrees/lane-01',
    gitEntryIdentity: { device: '8', inode: '102' },
  }
}

function verifiedSnapshot(ownership: 'created' | 'reused'): SessionWorktreeVerifiedSnapshot {
  return {
    ...registeredSnapshot(ownership), phase: 'verified', relativeCwd: '.', resolvedCwdPath: '/worktrees/lane-01',
    resolvedCwdIdentity: { device: '8', inode: '101' }, clean: true,
  }
}

function processHandle(sessionId: string) {
  return { sessionId, finished: Promise.resolve({ exitCode: 0, signal: null }) }
}

function gitRejectsBranch(branch: string): boolean {
  return spawnSync('git', ['check-ref-format', '--branch', branch], { stdio: 'ignore' }).status !== 0
}

function sameTarget(first: SessionStartMessage['target'], second: SessionStartMessage['target']): boolean {
  return JSON.stringify(first) === JSON.stringify(second)
}

function sameWorktreeEvidence(first: SessionWorktreeRegisteredSnapshot, second: SessionWorktreeRegisteredSnapshot): boolean {
  return first.branch === second.branch && first.headCommit === second.headCommit && first.worktreePath === second.worktreePath
}

function receiptKey(receiptBindingId: string, requestId: string): string {
  return `${receiptBindingId}:${requestId}`
}

function isCapacityFixtureRequest(scenario: RuntimeScenario, request: SessionStartMessage): boolean {
  return scenario.fixture === 'capacity-conflict-expiry-observable'
    || scenario.fixture === 'refusal-vocabulary'
    || (scenario.fixture === 'receipt-outcomes-observable' && request.requestId === receiptOutcomeRequestIds.capacity)
}

async function recordReceiptOutcomeEvidence(
  launcher: SessionLauncher,
  scenario: RuntimeScenario,
  primary: SessionStartMessage,
  stored: Map<string, SessionReceipt | SessionReceiptTombstone>,
  record: (event: string) => void,
) {
  const conflict = await collectLaunchStimuli(
    launcher.handle.bind(launcher),
    { ...scenario, fixture: 'duplicate-different-body' },
    primary,
    stored,
    record,
  )
  const expiry = { ...primary, requestId: receiptOutcomeRequestIds.expiry, expiresAt: RECEIPT_OUTCOME_EXPIRED_AT }
  const expired = await collectLaunchStimuli(launcher.handle.bind(launcher), { ...scenario, fixture: 'receipt-outcome-expiry' }, expiry, stored, record)
  const retained = { ...primary, requestId: receiptOutcomeRequestIds.retained }
  const completed = await collectLaunchStimuli(launcher.handle.bind(launcher), { ...scenario, fixture: 'receipt-outcome-retained' }, retained, stored, record)
  const replayed = await collectLaunchStimuli(launcher.handle.bind(launcher), { ...scenario, fixture: 'receipt-outcome-replay' }, retained, stored, record)
  const capacity = { ...primary, requestId: receiptOutcomeRequestIds.capacity }
  const saturated = await collectLaunchStimuli(launcher.handle.bind(launcher), { ...scenario, fixture: 'receipt-outcome-capacity' }, capacity, stored, record)

  if (hasCorrelatedRefusal(conflict.batches[1] ?? [], primary, 'request-conflict')) record('receipt.outcome:conflict:correlated')
  if (hasCorrelatedRefusal(expired.actions, expiry, 'request-expired')) record('receipt.outcome:expiry:correlated')
  if (terminalReplayMatchesStored(completed.actions, stored, retained)) record('receipt.outcome:retained-completion')
  if (terminalReplayMatchesStored(replayed.actions, stored, retained)) record('receipt.outcome:retained-replay')
  if (hasCorrelatedRefusal(saturated.actions, capacity, 'at-capacity')) record('receipt.outcome:capacity:correlated')
}

function hasCorrelatedRefusal(
  actions: readonly SessionLaunchAction[],
  request: SessionStartMessage,
  reason: 'request-conflict' | 'request-expired' | 'at-capacity',
): boolean {
  return actions.length === 1 && actions[0]?.kind === 'message'
    && actions[0].message.type === 'SESSION_REFUSED'
    && actions[0].message.requestId === request.requestId
    && actions[0].message.reason === reason
}

const forbiddenReceiptFields = new Set([
  'accesstoken', 'apikey', 'args', 'argtemplate', 'argv', 'attachtoken', 'authorization', 'bearer',
  'bearertoken', 'command', 'credential', 'credentials', 'endpoint', 'endpointaddress', 'endpointid',
  'endpointurl', 'env', 'environment', 'executable', 'keyfingerprint', 'keylabel', 'password',
  'privatekey', 'secret', 'secretkey', 'secrets', 'sessiontoken', 'signature', 'signingkey',
  'signingmaterial', 'token', 'tokenproof', 'trustanchor', 'url',
])

function recordReceiptSensitivity(record: (event: string) => void, receipt: unknown) {
  record('receipt.sensitivity:checked')
  if (receiptContainsSensitiveData(receipt)) record('receipt.sensitive-field')
}

export function receiptContainsSensitiveData(value: unknown): boolean {
  if (typeof value === 'string') return runtimeRedSensitiveValues.some(sensitive => value.includes(sensitive))
  if (Array.isArray(value)) return value.some(receiptContainsSensitiveData)
  if (!isRecord(value)) return false
  return Object.entries(value).some(([field, child]) => {
    return forbiddenReceiptFields.has(normalizeReceiptField(field)) || receiptContainsSensitiveData(child)
  })
}

function normalizeReceiptField(field: string): string {
  return field.replaceAll(/[-_]/g, '').toLowerCase()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

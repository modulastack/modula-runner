import { sessionStartFingerprint, type SessionStartMessage } from '@modulastack/runner-protocol'
import {
  MAX_IN_FLIGHT_SESSION_RECEIPTS,
  SecretEnv,
  createSessionLauncher,
  type AuditRecord,
  createSessionReceiptLedger,
  type LocalProjectRecord,
  type SessionLaunchAction,
  type SessionLauncherOptions,
  type SessionReceipt,
  type SessionReceiptLedgerImage,
  type SessionReceiptStorage,
} from '../../src/index.js'
import { runtimeRedFixtureCommand } from './fixtureMaterial.js'
import { collectLaunchStimuli } from './launcherEvidence.js'
import { createRecorder } from './recorder.js'
import { requestIdFor } from './scenarioIdentity.js'
import type { RuntimeObservation, RuntimeScenario } from './scenarioTypes.js'

const bindingId = '123e4567-e89b-42d3-a456-426614174000'
const now = '2026-08-21T00:00:00Z'
const project: LocalProjectRecord = {
  projectId: 'modulastack',
  repoPath: '/repos/modulastack',
  worktreesRoot: '/worktrees',
  revision: 1,
}

type CapacityCaseMode = 'success' | 'header-failure' | 'audit-failure'

type CapacityCase = {
  actions: readonly SessionLaunchAction[]
  auditAttempts: number
  image: SessionReceiptLedgerImage
  processStarts: number
}

export async function observeCapacityDurabilityScenario(scenario: RuntimeScenario): Promise<RuntimeObservation> {
  const recorder = createRecorder()
  const request = capacityRequest(scenario)
  const success = await runCapacityCase('success', scenario, request, recorder)
  const headerFailure = await runCapacityCase('header-failure', scenario, request, recorder)
  const auditFailure = await runCapacityCase('audit-failure', scenario, request, recorder)
  recordCapacityEvidence(recorder.record, request, success, headerFailure, auditFailure)
  return {
    status: 'observed',
    subject: 'launcher',
    result: 'launcher:capacity-durability',
    events: recorder.events,
    output: recorder.output,
  }
}

async function runCapacityCase(
  mode: CapacityCaseMode,
  scenario: RuntimeScenario,
  request: SessionStartMessage,
  recorder: ReturnType<typeof createRecorder>,
): Promise<CapacityCase> {
  const fixture = createCapacityFixture(mode, request, recorder)
  const observed = await collectLaunchStimuli(
    fixture.launcher.handle.bind(fixture.launcher),
    scenario,
    request,
    new Map(),
    recorder.record,
  )
  return {
    actions: observed.actions,
    auditAttempts: fixture.auditAttempts(),
    image: fixture.image(),
    processStarts: fixture.processStarts(),
  }
}

function createCapacityFixture(
  mode: CapacityCaseMode,
  request: SessionStartMessage,
  recorder: ReturnType<typeof createRecorder>,
) {
  let image = fullCapacityImage(request)
  let auditAttempts = 0
  let processStarts = 0
  const storage: SessionReceiptStorage = {
    async load() {
      return { status: 'loaded', image: structuredClone(image) }
    },
    async replace(expectedRevision, next) {
      if (expectedRevision !== image.revision) return { status: 'conflict', current: structuredClone(image) }
      if (next.capacityBlockedUntil !== null && mode === 'header-failure') {
        recorder.record('capacity.header:mutation-failed')
        return { status: 'storage-unavailable' }
      }
      image = { ...structuredClone(next), revision: expectedRevision + 1 }
      if (image.capacityBlockedUntil !== null) recorder.record('capacity.header:durable')
      return { status: 'updated', image: structuredClone(image) }
    },
  }
  const receipts = createSessionReceiptLedger({
    storage,
    clock: { now: () => Date.parse(now), sleep: async () => undefined },
  })
  const options: SessionLauncherOptions = {
    bindingId: () => bindingId,
    projects: {
      async create(next) { return { ...next, revision: 1 } },
      async list() { return [project] },
      async get() { return project },
      async remove() { return 'missing' },
    },
    receipts,
    access: {
      async resolve(modelProfileId) {
        return {
          status: 'resolved',
          plan: {
            modelProfileId,
            access: 'subscription',
            runtime: 'claude',
            command: runtimeRedFixtureCommand,
            args: [],
            env: {},
            secrets: SecretEnv.empty(),
          },
        }
      },
    },
    worktrees: unreachableWorktrees,
    channels: unreachableChannels,
    processes: {
      async start() {
        processStarts += 1
        throw new Error('capacity fixture started a process')
      },
      async adopt() { throw new Error('capacity fixture adopted a process') },
      async inspect() { throw new Error('capacity fixture inspected a process') },
      async terminate() { throw new Error('capacity fixture terminated a process') },
    },
    identifiers: { nextSessionId: () => 'unexpected-session' },
    audit: {
      async append(record) {
        auditAttempts += 1
        if (!capacityAuditMatchesRequest(record, request)) {
          throw new Error('capacity fixture received an unexpected audit')
        }
        if (mode === 'audit-failure') {
          recorder.record('capacity.audit:mutation-failed')
          throw new Error('capacity audit unavailable')
        }
        recorder.record('capacity.audit:refused')
        recorder.record('capacity.audit:correlated')
      },
    },
    clock: { now: () => Date.parse(now), sleep: async () => undefined },
  }
  return {
    launcher: createSessionLauncher(options),
    auditAttempts: () => auditAttempts,
    image: () => structuredClone(image),
    processStarts: () => processStarts,
  }
}

export function capacityAuditMatchesRequest(record: AuditRecord, request: SessionStartMessage): boolean {
  return record.kind === 'session-launch'
    && record.key.bindingId === request.bindingId
    && record.key.requestId === request.requestId
    && record.state === 'refused'
    && record.result?.type === 'SESSION_REFUSED'
    && record.result.reason === 'at-capacity'
}

const unreachableWorktrees: SessionLauncherOptions['worktrees'] = {
  async prepare() { throw new Error('capacity fixture prepared a worktree') },
  async register() { throw new Error('capacity fixture registered a worktree') },
  async verify() { throw new Error('capacity fixture verified a worktree') },
  async inspect() { throw new Error('capacity fixture inspected a worktree') },
  async rollback() { throw new Error('capacity fixture rolled back a worktree') },
}

const unreachableChannels: SessionLauncherOptions['channels'] = {
  async open() { throw new Error('capacity fixture opened a channel') },
  async close() { throw new Error('capacity fixture closed a channel') },
}

function fullCapacityImage(request: SessionStartMessage): SessionReceiptLedgerImage {
  return {
    schemaVersion: 1,
    revision: 1,
    capacityBlockedUntil: null,
    receipts: Array.from({ length: MAX_IN_FLIGHT_SESSION_RECEIPTS }, (_, index) => receiptFor(capacityOccupant(request, index))),
    tombstones: [],
  }
}

function capacityRequest(scenario: RuntimeScenario): SessionStartMessage {
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
      branch: 'feat/lane-01',
      baseBranch: 'main',
      relativeCwd: '.',
    },
  }
}

function capacityOccupant(request: SessionStartMessage, index: number): SessionStartMessage {
  return {
    ...request,
    requestId: `223e4567-e89b-42d3-a456-${(index + 100).toString(16).padStart(12, '0')}`,
    target: { ...request.target },
  }
}

function receiptFor(request: SessionStartMessage): SessionReceipt {
  return {
    schemaVersion: 1,
    revision: 1,
    key: { bindingId: request.bindingId, requestId: request.requestId },
    fingerprint: sessionStartFingerprint(request),
    request,
    state: 'accepted',
    phaseTimestamps: { accepted: now },
    project,
    worktree: { phase: 'none' },
  }
}

function recordCapacityEvidence(
  record: (event: string) => void,
  request: SessionStartMessage,
  success: CapacityCase,
  headerFailure: CapacityCase,
  auditFailure: CapacityCase,
) {
  if (success.image.capacityBlockedUntil === request.expiresAt && success.auditAttempts === 1
    && atCapacityRefusal(success.actions, request)) record('capacity.action:at-capacity:correlated')
  if (headerFailure.auditAttempts === 0 && storageClose(headerFailure.actions)) record('capacity.close:header-mutation')
  if (auditFailure.auditAttempts === 1 && storageClose(auditFailure.actions)) record('capacity.close:audit-mutation')
  if ([success, headerFailure, auditFailure].every(caseEvidence => caseEvidence.processStarts === 0)) {
    record('capacity.process-starts:0')
  }
}

function atCapacityRefusal(actions: readonly SessionLaunchAction[], request: SessionStartMessage): boolean {
  return actions.length === 1 && actions[0]?.kind === 'message' && actions[0].message.type === 'SESSION_REFUSED'
    && actions[0].message.requestId === request.requestId && actions[0].message.reason === 'at-capacity'
}

function storageClose(actions: readonly SessionLaunchAction[]): boolean {
  return actions.length === 1 && actions[0]?.kind === 'close-job-control' && actions[0].error === 'storage-unavailable'
}

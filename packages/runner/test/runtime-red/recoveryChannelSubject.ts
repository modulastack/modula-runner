import { type SessionStartMessage } from '@modulastack/runner-protocol'
import {
  SecretEnv,
  createSessionLauncher,
  type SessionBranchCreatedSnapshot,
  type SessionLaunchAction,
  type SessionLauncher,
  type SessionLauncherOptions,
  type SessionReceipt,
  type SessionWorktreeRegisteredSnapshot,
  type SessionWorktreeVerifiedSnapshot,
} from '../../src/index.js'
import { createRecorder } from './recorder.js'

const bindingId = '123e4567-e89b-42d3-a456-426614174000'
const requestId = '223e4567-e89b-42d3-a456-426614174000'
const sessionId = 'session-recovery-stable'
const priorChannelId = 'channel-prior'
const replacementChannelId = 'channel-replacement-1'

export type RecoveryChannelScenario = 'CH-01' | 'CH-02' | 'CH-02-mismatch' | 'CH-03' | 'CH-04' | 'CH-05'

export type RecoveryChannelObservation = {
  actions: readonly SessionLaunchAction[]
  events: readonly string[]
  receipt: SessionReceipt
}

type RecoveryFixture = {
  launcher: SessionLauncher
  receipt(): SessionReceipt
  record(event: string): void
  events: readonly string[]
}

type ReceiptState = { current: SessionReceipt }

export async function observeRecoveryChannelScenario(scenario: RecoveryChannelScenario): Promise<RecoveryChannelObservation> {
  const fixture = createRecoveryFixture(scenario)
  const batches = scenario === 'CH-05'
    ? await Promise.all([collectRecovery(fixture.launcher, fixture.record), collectRecovery(fixture.launcher, fixture.record)])
    : [await collectRecovery(fixture.launcher, fixture.record)]
  return { actions: batches.flat(), events: fixture.events, receipt: fixture.receipt() }
}

function createRecoveryFixture(scenario: RecoveryChannelScenario): RecoveryFixture {
  const recorder = createRecorder()
  const state = { current: recoveryReceipt(scenario) }
  const channelPorts = createChannelPorts(recorder.record, scenario)
  const options: SessionLauncherOptions = {
    bindingId: () => bindingId,
    projects: projectPort(recorder.record),
    receipts: receiptPort(recorder.record, state, scenario),
    access: accessPort(),
    worktrees: worktreePort(recorder.record, scenario),
    ...channelPorts,
    processes: processPort(recorder.record, scenario),
    identifiers: { nextSessionId: () => 'unexpected-recovery-session' },
    audit: { append: async () => undefined },
    clock: { now: () => Date.parse('2026-08-22T00:00:00Z'), sleep: async () => undefined },
  }
  return {
    launcher: createSessionLauncher(options),
    receipt: () => copyReceipt(state.current),
    record: recorder.record,
    events: recorder.events,
  }
}

function projectPort(record: (event: string) => void): SessionLauncherOptions['projects'] {
  return {
    async create(project) {
      return { ...project, revision: 1 }
    },
    async list() {
      return [project]
    },
    async get(projectId) {
      record(`projects.get:${projectId}`)
      return projectId === project.projectId ? project : null
    },
    async remove() {
      return 'missing'
    },
  }
}

function accessPort(): SessionLauncherOptions['access'] {
  return {
    async resolve(modelProfileId) {
      return {
        status: 'resolved',
        plan: {
          modelProfileId,
          access: 'api-key',
          runtime: 'claude',
          command: '/usr/bin/claude',
          args: ['--model', 'approved'],
          env: { RUNNER_MODE: '1' },
          secrets: SecretEnv.of({ ANTHROPIC_API_KEY: 'secret' }),
        },
      }
    },
  }
}

function worktreePort(record: (event: string) => void, scenario: RecoveryChannelScenario): SessionLauncherOptions['worktrees'] {
  return {
    async prepare() {
      return { status: 'ready', snapshot: branchSnapshot() }
    },
    async register() {
      return { status: 'ready', snapshot: registeredSnapshot() }
    },
    async verify() {
      return { status: 'ready', snapshot: verifiedSnapshot() }
    },
    async inspect() {
      const result = scenario === 'CH-02-mismatch' ? 'mismatch' : 'exact'
      record(`worktree.inspect:${result}`)
      return result
    },
    async rollback() {
      record('worktree.rollback')
      return 'uncertain'
    },
  }
}

function createChannelPorts(record: (event: string) => void, scenario: RecoveryChannelScenario): Pick<SessionLauncherOptions, 'channels' | 'recoveryChannels'> {
  let opens = 0
  const channels: SessionLauncherOptions['channels'] = {
    async open(currentRequestId, currentSessionId) {
      opens += 1
      const channelId = opens === 1 ? replacementChannelId : `channel-replacement-${opens}`
      record(`channels.open:${currentRequestId}:${currentSessionId}:${channelId}`)
      return { status: 'opened', channelId }
    },
    async close(channelId, reason) {
      record(`channels.close:${channelId}:${reason}`)
    },
  }
  return {
    channels,
    recoveryChannels: {
      ...channels,
      async status(channelId, generation) {
        const result = channelId === priorChannelId && generation === 1 ? priorStatus(scenario) : 'unknown'
        record(`recoveryChannels.status:${channelId}:g${generation}:${result}`)
        return result
      },
      async closeExact(channelId, generation, reason) {
        const result = exactCloseResult(scenario, channelId, generation)
        record(`recoveryChannels.closeExact:${channelId}:g${generation}:${reason}:${result}`)
        return result
      },
    },
  }
}

function processPort(record: (event: string) => void, scenario: RecoveryChannelScenario): SessionLauncherOptions['processes'] {
  return {
    async start(request) {
      record(`process.start:${request.sessionId}:${request.channelId}`)
      return { status: 'failed', reason: 'spawn-failed' }
    },
    async adopt(request) {
      const generation = request.channelGeneration === undefined ? 'absent' : `g${request.channelGeneration}`
      record(`process.adopt.request:${request.sessionId}:${request.channelId}:${generation}`)
      if (scenario === 'CH-04') {
        record('process.adopt:failed')
        return { status: 'failed', reason: 'spawn-failed' }
      }
      record(`process.adopt.handle:${request.sessionId}:${request.channelId}:${generation}`)
      return {
        status: 'started',
        handle: {
          sessionId: request.sessionId,
          channelId: request.channelId,
          ...(request.channelGeneration === undefined ? {} : { channelGeneration: request.channelGeneration }),
          finished: new Promise<{ exitCode: number; signal: null }>(() => undefined),
        },
      }
    },
    async inspect(identity) {
      const result = scenario === 'CH-02-mismatch' ? 'mismatch' : 'exact'
      record(`process.inspect:${identity.sessionId}:${identity.cwd}:${result}`)
      return result
    },
    async terminate(identity) {
      record(`process.terminate:${identity.sessionId}:${identity.cwd}`)
      return 'uncertain'
    },
  }
}

function receiptPort(record: (event: string) => void, state: ReceiptState, scenario: RecoveryChannelScenario): SessionLauncherOptions['receipts'] {
  let recoveryCalls = 0
  let releaseFirstRecovery: (() => void) | null = null
  return {
    async lookup() {
      return { status: 'receipt', receipt: copyReceipt(state.current) }
    },
    async claim() {
      return { status: 'storage-unavailable' }
    },
    async replace(expectedRevision, receipt) {
      record(`receipts.replace.attempt:${expectedRevision}:${channelDescription(receipt.channel)}`)
      if (expectedRevision !== state.current.revision) {
        record(`receipts.replace.conflict:${expectedRevision}:${state.current.revision}`)
        return { status: 'conflict', current: copyReceipt(state.current) }
      }
      state.current = copyReceipt({ ...receipt, revision: expectedRevision + 1 })
      record(`receipts.replace.updated:${state.current.revision}:${channelDescription(state.current.channel)}`)
      return { status: 'updated', receipt: copyReceipt(state.current) }
    },
    async recover() {
      const snapshot = copyReceipt(state.current)
      recoveryCalls += 1
      record(`receipts.recover:${snapshot.state}:r${snapshot.revision}`)
      if (scenario === 'CH-05' && recoveryCalls === 1) {
        await new Promise<void>(resolve => { releaseFirstRecovery = resolve })
      }
      if (scenario === 'CH-05' && recoveryCalls === 2) {
        releaseFirstRecovery?.()
        record('receipts.recover.concurrent-ready')
      }
      return [snapshot]
    },
    async compact() {
      return undefined
    },
  }
}

function recoveryReceipt(scenario: RecoveryChannelScenario): SessionReceipt {
  const state = scenario === 'CH-01' || scenario === 'CH-02-mismatch' || scenario === 'CH-05' ? 'started' : 'spawn-intent'
  return {
    schemaVersion: 1,
    revision: 7,
    key: { bindingId, requestId },
    fingerprint: 'recovery-fingerprint',
    request: recoveryRequest(),
    state,
    phaseTimestamps: phaseTimestamps(state),
    project,
    worktree: verifiedSnapshot(),
    sessionId,
    channel: { generation: 1, lifecycle: priorStatus(scenario), channelId: priorChannelId },
    channelId: priorChannelId,
  }
}

function recoveryRequest(): SessionStartMessage {
  return {
    type: 'SESSION_START',
    bindingId,
    requestId,
    expiresAt: '2026-08-22T00:10:00Z',
    terminalProfile: 'coder',
    modelProfileId: 'daily',
    target: { projectId: project.projectId, worktreeName: 'lane-recovery', branch: 'feat/lane-recovery', baseBranch: 'main', relativeCwd: '.' },
  }
}

function phaseTimestamps(state: 'spawn-intent' | 'started'): SessionReceipt['phaseTimestamps'] {
  const base = { accepted: '2026-08-22T00:00:00Z', provisioned: '2026-08-22T00:00:01Z', 'spawn-intent': '2026-08-22T00:00:02Z' }
  return state === 'started' ? { ...base, started: '2026-08-22T00:00:03Z' } : base
}

function priorStatus(scenario: RecoveryChannelScenario): 'closed' | 'lost' {
  return scenario === 'CH-03' || scenario === 'CH-04' ? 'lost' : 'closed'
}

function exactCloseResult(scenario: RecoveryChannelScenario, channelId: string, generation: number): 'closed' | 'lost' | 'unknown' {
  if (channelId === priorChannelId && generation === 1) return priorStatus(scenario)
  if (scenario === 'CH-04' && channelId === replacementChannelId && generation === 2) return 'unknown'
  return 'unknown'
}

async function collectRecovery(launcher: SessionLauncher, record: (event: string) => void): Promise<SessionLaunchAction[]> {
  const actions: SessionLaunchAction[] = []
  for await (const action of launcher.recover()) {
    actions.push(action)
    recordAction(record, action)
    if (isRecoveryOutcome(action)) break
  }
  return actions
}

function isRecoveryOutcome(action: SessionLaunchAction): boolean {
  return action.kind === 'close-job-control' || action.message.type === 'SESSION_STARTED' || action.message.type === 'SESSION_FAILED'
    || action.message.type === 'SESSION_FINISHED' || action.message.type === 'SESSION_REFUSED'
}

function recordAction(record: (event: string) => void, action: SessionLaunchAction) {
  if (action.kind === 'close-job-control') {
    record(`action.close:${action.error}`)
    return
  }
  const { message } = action
  if (message.type === 'SESSION_STARTED') record(`action.started:${message.sessionId}:${message.channelId}:${message.requestId}`)
  if (message.type === 'SESSION_FAILED') record(`action.failed:${message.reason}:${message.requestId}`)
  if (message.type === 'SESSION_FINISHED') record(`action.finished:${message.requestId}`)
  if (message.type === 'SESSION_REFUSED') record(`action.refused:${message.reason}:${message.requestId}`)
}

function channelDescription(channel: SessionReceipt['channel']): string {
  if (!channel) return 'legacy'
  return `g${channel.generation}:${channel.lifecycle}:${channel.channelId ?? 'none'}`
}

function copyReceipt(receipt: SessionReceipt): SessionReceipt {
  return {
    ...receipt,
    phaseTimestamps: { ...receipt.phaseTimestamps },
    ...(receipt.channel ? { channel: { ...receipt.channel } } : {}),
  }
}

const project = {
  projectId: 'modulastack',
  repoPath: '/repos/modulastack',
  worktreesRoot: '/worktrees',
  revision: 1,
}

function branchSnapshot(): SessionBranchCreatedSnapshot {
  return {
    phase: 'branch-created',
    ownership: 'created',
    branch: 'feat/lane-recovery',
    branchRef: 'refs/heads/feat/lane-recovery',
    baseBranch: 'main',
    headCommit: 'a'.repeat(40),
    expectedBaseCommit: 'a'.repeat(40),
    gitCommonDir: '/repos/modulastack/.git',
  }
}

function registeredSnapshot(): SessionWorktreeRegisteredSnapshot {
  return {
    ...branchSnapshot(),
    phase: 'worktree-registered',
    worktreePath: '/worktrees/lane-recovery',
    worktreeIdentity: { device: '8', inode: '101' },
    worktreeGitDir: '/repos/modulastack/.git/worktrees/lane-recovery',
    gitEntryIdentity: { device: '8', inode: '102' },
  }
}

function verifiedSnapshot(): SessionWorktreeVerifiedSnapshot {
  return {
    ...registeredSnapshot(),
    phase: 'verified',
    relativeCwd: '.',
    resolvedCwdPath: '/worktrees/lane-recovery',
    resolvedCwdIdentity: { device: '8', inode: '101' },
    clean: true,
  }
}

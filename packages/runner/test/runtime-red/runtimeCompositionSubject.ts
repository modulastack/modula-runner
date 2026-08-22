import { sessionLaunchPayload, type Payload } from '@modulastack/runner-protocol'
import {
  RunnerRuntimeNotImplementedError,
  createRunnerRuntime,
  type ContractPairingRecord,
  type RunnerRuntimeHandle,
  type SessionJobControl,
} from '../../src/index.js'
import { StubControlPlane } from '../stubControlPlane.js'
import { createTestHomeState } from './applicationSubject.js'
import { pairingFixtureBearer, pairingFixtureNonce, runtimeRedRejectedCredential } from './fixtureMaterial.js'
import { createRecorder } from './recorder.js'
import type { RuntimeObservation, RuntimeScenario } from './scenarioTypes.js'

const WAIT_TIMEOUT_MS = 2_000
const WAIT_INTERVAL_MS = 5
const RECONNECT_OBSERVATION_MS = 100

type RuntimeRecovery = {
  connectionCount: number
  protocol: number
}

type RuntimeConnectionEvidence = {
  observedConnectionCount: number
  recoveredProtocols: number[]
  recoveries: RuntimeRecovery[]
}

type RuntimeEvidence = {
  connectionCount: number
  dispatchCount: number
  helloRanges: readonly string[]
  jobControlOpened: boolean
  pairingRevocations: number
  recoveredProtocols: readonly number[]
  recoveries: readonly RuntimeRecovery[]
  sentSessionStarts: number
  shutdownStatus: 'confirmed' | 'unconfirmed'
}

class ObservedStubControlPlane extends StubControlPlane {
  readonly outboundPayloads: Payload[] = []

  sendToRunner(channel: string, payload: Payload) {
    this.outboundPayloads.push(payload)
    super.sendToRunner(channel, payload)
  }
}

export async function observeRuntimeCompositionScenario(scenario: RuntimeScenario): Promise<RuntimeObservation> {
  const recorder = createRecorder()
  const stub = await runtimeStub(scenario).start()
  const home = createTestHomeState(recorder.record)
  let pairingRevocations = 0
  const connectionEvidence: RuntimeConnectionEvidence = {
    observedConnectionCount: 0,
    recoveredProtocols: [],
    recoveries: [],
  }
  let dispatchCount = 0
  let handle: RunnerRuntimeHandle | null = null
  let stopped = false
  home.pairing.snapshot = async () => {
    recorder.record(`runtime.fixture:${scenario.fixture}`)
    recorder.record('pairing.snapshot:paired')
    return { state: 'paired', record: pairingRecord(stub.url) }
  }
  home.pairing.revoke = async () => {
    pairingRevocations += 1
    recorder.record('pairing.revoke')
    return 'updated'
  }
  const jobControl: SessionJobControl = {
    async *dispatch(input) {
      dispatchCount += 1
      if (stub.hellos.length === 0) recorder.record('runtime.launch-before-welcome')
      recorder.record(`runtime.job-control.dispatch:${input.context.selectedProtocolVersion}`)
      if (scenario.fixture === 'ambiguous-job-control-loss') {
        yield {
          kind: 'send',
          channelId: input.context.channelId,
          payload: sessionLaunchPayload({ type: 'SESSION_ACCEPTED', requestId: requestIdFromPayload(input.payload) }),
        }
      }
    },
    async *recover(context) {
      recordObservedConnections(recorder.record, stub, connectionEvidence)
      const connectionCount = connectionEvidence.observedConnectionCount
      if (context.selectedProtocolVersion !== null) {
        connectionEvidence.recoveredProtocols.push(context.selectedProtocolVersion)
        connectionEvidence.recoveries.push({ connectionCount, protocol: context.selectedProtocolVersion })
        recorder.record(`runtime.protocol-recovery:${context.selectedProtocolVersion}:connection:[${connectionCount}]`)
        recorder.record(`runtime.job-control-recovery:connection:[${connectionCount}]`)
        if (connectionCount >= 2) recorder.record('runtime.job-control-recovery:connection:>=2')
      }
      recorder.record(`runtime.job-control.recover:${context.selectedProtocolVersion}`)
    },
  }
  const runtime = createRunnerRuntime({
    clock: {
      now() {
        recorder.record('runtime.clock.now')
        return Date.parse('2026-08-21T00:00:00Z')
      },
      async sleep(milliseconds) {
        recorder.record(`runtime.clock.sleep:${milliseconds}`)
        await Promise.resolve()
      },
    },
  })
  try {
    handle = await runtime.start(home, jobControl)
    recorder.record('runtime.start:returned')
    await waitForRuntimeMilestone(stub, scenario.fixture, () => pairingRevocations, connectionEvidence)
    if (scenario.fixture === 'ambiguous-job-control-loss') {
      await driveAmbiguousLoss(stub, dispatchCount, () => dispatchCount, connectionEvidence, recorder.record)
    }
    recordStubEvidence(recorder.record, stub, scenario.fixture, pairingRevocations, dispatchCount)
    if (scenario.fixture === 'runner-paused-offline') recorder.record('runtime.stop:requested')
    const shutdown = await handle.stop('SIGTERM')
    stopped = true
    recorder.record(`runtime.stop:${shutdown.status}`)
    const evidence = runtimeEvidence(stub, pairingRevocations, connectionEvidence, dispatchCount, shutdown.status)
    return {
      status: 'observed',
      subject: 'runtime',
      result: runtimeResult(scenario.fixture, evidence),
      events: recorder.events,
      output: recorder.output,
    }
  } catch (error) {
    if (error instanceof RunnerRuntimeNotImplementedError) {
      return { status: 'missing-production-runtime', subject: 'runtime', error: error.name }
    }
    throw error
  } finally {
    if (handle && !stopped) {
      try {
        handle.forceStop()
      } catch {
        recorder.record('runtime.force-stop:failed')
      }
    }
    await stub.stop()
  }
}

function runtimeStub(scenario: RuntimeScenario): ObservedStubControlPlane {
  const fixture = scenario.fixture
  if (fixture === 'websocket-auth-revoked') return new ObservedStubControlPlane({ token: runtimeRedRejectedCredential })
  if (fixture === 'negotiate-no-overlap') return new ObservedStubControlPlane({ token: pairingFixtureBearer, supportedVersions: [3] })
  if (fixture === 'selected-v1-no-launch') return new ObservedStubControlPlane({ token: pairingFixtureBearer, supportedVersions: [1] })
  if (fixture === 'reconnect-negotiate-before-session') {
    return new ObservedStubControlPlane({ token: pairingFixtureBearer, supportedVersions: [1, 2], dropAfterWelcomeMs: 5 })
  }
  if (fixture === 'runner-paused-offline') return new ObservedStubControlPlane({ token: pairingFixtureBearer, muteWelcome: true })
  return new ObservedStubControlPlane({ token: pairingFixtureBearer, supportedVersions: [1, 2] })
}

function pairingRecord(websocketUrl: string): ContractPairingRecord {
  return {
    bindingId: '123e4567-e89b-42d3-a456-426614174000',
    runnerId: 'runner-01',
    token: pairingFixtureBearer,
    confirmationNonce: pairingFixtureNonce,
    confirmationExpiresAt: '2099-08-22T12:00:00Z',
    controlPlaneOrigin: websocketUrl,
    pendingSince: '2026-08-21T00:00:00Z',
    pairedAt: '2026-08-21T00:00:01Z',
  }
}

async function waitForRuntimeMilestone(
  stub: ObservedStubControlPlane,
  fixture: string,
  pairingRevocations: () => number,
  connectionEvidence: RuntimeConnectionEvidence,
): Promise<void> {
  if (fixture === 'websocket-auth-revoked') return await waitFor('pairing revocation', () => pairingRevocations() === 1)
  if (fixture === 'negotiate-no-overlap') {
    await waitFor('no-overlap hello', () => stub.hellos.length === 1)
    return await waitWithoutReconnect(stub)
  }
  if (fixture === 'runner-paused-offline') return await waitFor('offline handshake attempt', () => stub.hellos.length === 1)
  const expectedProtocol = fixture === 'selected-v1-no-launch' ? 1 : 2
  if (fixture === 'reconnect-negotiate-before-session') {
    await waitFor('reconnection', () => stub.connectionCount >= 2)
    await waitFor('reconnected job-control recovery', () => connectionEvidence.recoveries.some(recovery => {
      return recovery.connectionCount >= 2 && recovery.protocol === expectedProtocol
    }))
    return
  }
  await waitFor(`protocol ${expectedProtocol} recovery`, () => connectionEvidence.recoveredProtocols.includes(expectedProtocol))
  await waitFor('job-control recovery', () => connectionEvidence.recoveries.some(recovery => recovery.protocol === expectedProtocol))
}

function recordObservedConnections(
  record: (event: string) => void,
  stub: ObservedStubControlPlane,
  connectionEvidence: RuntimeConnectionEvidence,
) {
  while (connectionEvidence.observedConnectionCount < stub.connectionCount) {
    connectionEvidence.observedConnectionCount += 1
    record(`runtime.connection-count:[${connectionEvidence.observedConnectionCount}]`)
  }
}

async function driveAmbiguousLoss(
  stub: ObservedStubControlPlane,
  dispatchCount: number,
  currentDispatchCount: () => number,
  connectionEvidence: RuntimeConnectionEvidence,
  record: (event: string) => void,
): Promise<void> {
  const channelId = jobControlChannelId(stub)
  if (!channelId) throw new Error('ambiguous-loss fixture did not open job-control')
  stub.sendToRunner(channelId, sessionLaunchPayload({
    type: 'SESSION_START',
    bindingId: '123e4567-e89b-42d3-a456-426614174000',
    requestId: '223e4567-e89b-42d3-a456-426614174001',
    expiresAt: '2099-08-22T12:00:00Z',
    terminalProfile: 'coder',
    modelProfileId: 'daily',
    target: { projectId: 'modulastack', worktreeName: 'lane-01', branch: 'feat/lane-01', baseBranch: 'main', relativeCwd: '.' },
  }))
  await waitFor('job-control dispatch', () => currentDispatchCount() > dispatchCount)
  stub.dropConnections()
  record('runtime.channel-loss:nonterminal')
  await waitFor('reconnection after channel loss', () => stub.connectionCount > 1)
  record('runtime.reconnect')
  await waitFor('second-connection job-control recovery', () => connectionEvidence.recoveries.some(recovery => recovery.connectionCount >= 2))
  const recovery = connectionEvidence.recoveries.find(candidate => candidate.connectionCount >= 2)
  if (!recovery) throw new Error('ambiguous-loss fixture did not recover job control on connection two')
  const dispatched = currentDispatchCount()
  record(`runtime.ambiguous-loss:quiet-window:begin:connection:[${recovery.connectionCount}]`)
  record('runtime.ambiguous-loss:quiet-window:begin:connection:>=2')
  await sleep(RECONNECT_OBSERVATION_MS)
  record(`runtime.ambiguous-loss:quiet-window:end:connection:[${recovery.connectionCount}]`)
  record('runtime.ambiguous-loss:quiet-window:end:connection:>=2')
  if (currentDispatchCount() !== dispatched) throw new Error('ambiguous-loss fixture redrove a nonterminal request')
  record('runtime.redrive:stopped')
}

function recordStubEvidence(
  record: (event: string) => void,
  stub: ObservedStubControlPlane,
  fixture: string,
  pairingRevocations: number,
  dispatchCount: number,
) {
  for (const hello of stub.hellos) record(`runtime.hello:${hello.protocol.min}-${hello.protocol.max}`)
  if (fixture === 'websocket-auth-revoked' && pairingRevocations === 1) record('runtime.auth-failed:401')
  if (fixture === 'negotiate-no-overlap' && stub.hellos.length === 1) record('runtime.reject:supported-versions')
  if (fixture === 'selected-v1-no-launch' && stub.hellos.length > 0) record('runtime.welcome:1')
  if ((fixture === 'negotiate-highest-v2' || fixture === 'reconnect-negotiate-before-session') && stub.hellos.length > 0) {
    record('runtime.welcome:2')
  }
  record(`runtime.connection-count:${stub.connectionCount}`)
  if (stub.connectionCount > 1 && fixture !== 'ambiguous-job-control-loss') record('runtime.reconnect')
  if (hasJobControlChannel(stub)) record('runtime.job-control-open')
  if (sessionStarts(stub).length > 0) record('runtime.send:SESSION_START')
  else record('runtime.unsent:not-accepted')
}

function runtimeEvidence(
  stub: ObservedStubControlPlane,
  pairingRevocations: number,
  connectionEvidence: RuntimeConnectionEvidence,
  dispatchCount: number,
  shutdownStatus: RuntimeEvidence['shutdownStatus'],
): RuntimeEvidence {
  return {
    connectionCount: stub.connectionCount,
    dispatchCount,
    helloRanges: stub.hellos.map(hello => `${hello.protocol.min}-${hello.protocol.max}`),
    jobControlOpened: hasJobControlChannel(stub),
    pairingRevocations,
    recoveredProtocols: connectionEvidence.recoveredProtocols,
    recoveries: connectionEvidence.recoveries,
    sentSessionStarts: sessionStarts(stub).length,
    shutdownStatus,
  }
}

function runtimeResult(fixture: string, evidence: RuntimeEvidence): string {
  if (fixture === 'websocket-auth-revoked') {
    requireEvidence(evidence.pairingRevocations === 1 && evidence.connectionCount === 0, fixture)
    return 'runtime:auth-revoked'
  }
  if (fixture === 'negotiate-highest-v2') {
    requireEvidence(
      hasHelloRange(evidence, '1-2') && evidence.recoveredProtocols.includes(2)
        && evidence.jobControlOpened && evidence.shutdownStatus === 'confirmed',
      fixture,
    )
    return 'runtime:connected:v2'
  }
  if (fixture === 'negotiate-no-overlap') {
    requireEvidence(hasHelloRange(evidence, '1-2') && evidence.connectionCount === 1 && !evidence.jobControlOpened, fixture)
    return 'runtime:rejected'
  }
  if (fixture === 'selected-v1-no-launch') {
    requireEvidence(
      evidence.recoveredProtocols.includes(1) && evidence.jobControlOpened
        && evidence.sentSessionStarts === 0 && evidence.shutdownStatus === 'confirmed',
      fixture,
    )
    return 'runtime:connected:v1'
  }
  if (fixture === 'reconnect-negotiate-before-session') {
    requireEvidence(
      evidence.connectionCount > 1
        && evidence.recoveries.some(recovery => recovery.connectionCount >= 2 && recovery.protocol === 2)
        && evidence.shutdownStatus === 'confirmed',
      fixture,
    )
    return 'runtime:connected:v2'
  }
  if (fixture === 'runner-paused-offline') {
    requireEvidence(evidence.helloRanges.length === 1 && !evidence.jobControlOpened && evidence.sentSessionStarts === 0, fixture)
    return 'runtime:offline-visible'
  }
  requireEvidence(evidence.sentSessionStarts === 1 && evidence.dispatchCount === 1 && evidence.connectionCount > 1, fixture)
  return 'runtime:storage-uncertain'
}

function requireEvidence(condition: boolean, fixture: string) {
  if (!condition) throw new Error(`runtime fixture did not reach its required evidence: ${fixture}`)
}

function hasHelloRange(evidence: RuntimeEvidence, range: string): boolean {
  return evidence.helloRanges.includes(range)
}

function sessionStarts(stub: ObservedStubControlPlane): readonly Payload[] {
  return stub.outboundPayloads.filter(isSessionStart)
}

function isSessionStart(payload: Payload): boolean {
  return payload.codec === 'json' && isRecord(payload.body) && payload.body.type === 'SESSION_START'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requestIdFromPayload(payload: Payload): string {
  if (payload.codec === 'json' && isRecord(payload.body) && typeof payload.body.requestId === 'string') return payload.body.requestId
  return '223e4567-e89b-42d3-a456-426614174001'
}

function hasJobControlChannel(stub: ObservedStubControlPlane): boolean {
  return [...stub.channels.values()].some(channel => channel.kind === 'job-control')
}

function jobControlChannelId(stub: ObservedStubControlPlane): string | null {
  return [...stub.channels].find(([, channel]) => channel.kind === 'job-control')?.[0] ?? null
}

async function waitFor(label: string, condition: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`runtime fixture timed out waiting for ${label}`)
    await sleep(WAIT_INTERVAL_MS)
  }
}

async function waitWithoutReconnect(stub: ObservedStubControlPlane): Promise<void> {
  const initialConnections = stub.connectionCount
  await sleep(RECONNECT_OBSERVATION_MS)
  if (stub.connectionCount !== initialConnections) throw new Error('no-overlap fixture reconnected')
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

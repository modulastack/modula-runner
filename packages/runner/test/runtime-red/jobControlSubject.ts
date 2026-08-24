import type { Payload, SessionStartMessage } from '@modulastack/runner-protocol'
import {
  SessionJobControlNotImplementedError,
  createSessionJobControl,
  type SessionJobControlEffect,
  type SessionJobControlPhase,
  type SessionLaunchAction,
  type SessionLauncher,
} from '../../src/index.js'
import { runtimeRedBindingId, runtimeRedFixtureForbiddenEnv } from './fixtureMaterial.js'
import { createRecorder } from './recorder.js'
import { requestIdFor } from './scenarioIdentity.js'
import type { RuntimeObservation, RuntimeScenario } from './scenarioTypes.js'

export async function observeJobControlScenario(scenario: RuntimeScenario): Promise<RuntimeObservation> {
  const recorder = createRecorder()
  let launcherCalls = 0
  const launcher: SessionLauncher = {
    async *handle(request) {
      launcherCalls += 1
      recorder.record('launcher.handle')
      recorder.record('launcher.handle.call')
      recorder.record(`launcher.handle:request:${request.requestId}`)
      recorder.record('launcher.handle:declared-fields-only')
      recorder.record('launcher.target:project+worktree+branch+base+cwd')
      const received = request as unknown as Record<string, unknown>
      const target = request.target as unknown as Record<string, unknown>
      const forbidden = ['unknown', 'command', 'executable', 'argv', 'args', 'env', 'key', 'credential', 'endpoint', 'allowlist', 'recipe']
      if (forbidden.some(field => field in received || field in target)) recorder.record('launcher.handle:forbidden-field')
      yield launcherAction(scenario, request.requestId)
    },
    async *recover() {
      recorder.record('launcher.recover')
    },
  }
  const subject = createSessionJobControl({ launcher })
  const input = jobControlInput(scenario)
  try {
    const first = await collectJobControlEffects(subject.dispatch(input))
    const batches = scenario.fixture === 'v2-frame-replay'
      ? [first, await collectJobControlEffects(subject.dispatch(input))]
      : [first]
    for (const effects of batches) for (const effect of effects) recordEffect(recorder.record, effect)
    if (launcherCalls === 1) recorder.record('launcher.handle:once')
    if (batches.length === 2 && JSON.stringify(batches[0]) === JSON.stringify(batches[1])) recorder.record('effect.replay:same-outcome')
    return { status: 'observed', subject: 'job-control', result: 'job-control:effects', events: recorder.events, output: recorder.output }
  } catch (error) {
    if (error instanceof SessionJobControlNotImplementedError) {
      return { status: 'missing-production-runtime', subject: 'job-control', error: error.name }
    }
    throw error
  }
}

function jobControlInput(scenario: RuntimeScenario) {
  const channelId = `job-control-${scenario.obligationId.toLowerCase()}`
  const phase: SessionJobControlPhase = scenario.fixture === 'pre-welcome-session'
    ? 'pre-welcome'
    : scenario.fixture.includes('reconnect') ? 'reconnecting' : 'active'
  const selectedProtocolVersion = scenario.fixture.startsWith('v1-') ? 1 : 2
  return {
    context: {
      connectionId: `connection-${scenario.obligationId.toLowerCase()}`,
      channelId,
      phase,
      selectedProtocolVersion,
    },
    payload: jobControlPayloadForScenario(scenario),
  }
}

export function jobControlPayloadForScenario(scenario: RuntimeScenario): Payload {
  const request = validRequest(scenario.obligationId)
  if (scenario.fixture === 'v2-invalid-request-id') return json({ ...request, requestId: 'not-a-uuid' })
  if (scenario.fixture === 'v2-non-uuid-request-id') return json({ ...request, requestId: 'UPPERCASE' })
  if (scenario.fixture === 'v2-unknown-closed-enum') return json({ type: 'SESSION_UNKNOWN', requestId: request.requestId })
  if (scenario.fixture === 'v2-oversized-payload') return json({ ...request, oversized: 'x'.repeat(1024 * 1024) })
  if (scenario.fixture === 'v2-unsafe-identifier') return json({ ...request, modelProfileId: '__proto__' })
  if (scenario.fixture === 'v2-malformed-safe-id') return json({ type: 'SESSION_START', requestId: request.requestId })
  if (scenario.fixture === 'v2-forbidden-field') {
    return json({ ...request, command: '/bin/sh', env: { RUNTIME_RED_FORBIDDEN_ENV: runtimeRedFixtureForbiddenEnv } })
  }
  if (scenario.fixture === 'v2-extra-fields') return json({ ...request, unknown: 'discard-me', target: { ...request.target, unknown: 'discard-me' } })
  return json(request)
}

function validRequest(obligationId: string): SessionStartMessage {
  return {
    type: 'SESSION_START',
    bindingId: runtimeRedBindingId,
    requestId: requestIdFor(obligationId),
    expiresAt: '2099-08-22T12:00:00Z',
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

function launcherAction(scenario: RuntimeScenario, requestId: string): SessionLaunchAction {
  if (scenario.fixture === 'v2-launcher-refusal') {
    return { kind: 'message', message: { type: 'SESSION_REFUSED', requestId, reason: 'unknown-profile' } }
  }
  return { kind: 'message', message: { type: 'SESSION_ACCEPTED', requestId } }
}

function recordEffect(record: (event: string) => void, effect: SessionJobControlEffect) {
  if (effect.kind === 'not-session') {
    record('effect.not-session')
    return
  }
  record(`effect.channel:${effect.channelId}`)
  if (effect.kind === 'close-job-control') {
    record(`effect.close:${effect.error}`)
    return
  }
  const body = effect.payload.body as { type?: string; requestId?: string; reason?: string }
  if (body.type === 'SESSION_ACCEPTED') record('effect.send:SESSION_ACCEPTED')
  else if (body.type === 'SESSION_REFUSED') {
    record('effect.send:SESSION_REFUSED')
    if (body.reason) record(`effect.send:SESSION_REFUSED:${body.reason}`)
  } else record(`effect.send:${body.type ?? 'unknown'}`)
  if (body.requestId) record(`effect.requestId:${body.requestId}`)
}

export async function collectJobControlEffects(
  values: AsyncIterable<SessionJobControlEffect>,
): Promise<SessionJobControlEffect[]> {
  const effects: SessionJobControlEffect[] = []
  for await (const effect of values) {
    if (effects.length === 8) {
      throw new Error(`session job-control emitted ${effects.length + 1} effects; maximum is 8`)
    }
    effects.push(effect)
  }
  return effects
}

function json(body: unknown): Payload {
  return { codec: 'json', body }
}

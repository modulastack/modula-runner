import type { SessionStartMessage } from '@modulastack/runner-protocol'
import { describe, expect, it } from 'vitest'
import { SessionLaunchNotImplementedError } from '../../src/index.js'
import type {
  AuditRecord,
  SessionJobControlEffect,
  SessionLaunchAction,
  SessionLauncher,
  SessionReceipt,
  SessionReceiptTombstone,
} from '../../src/index.js'
import { capacityAuditMatchesRequest, observeCapacityDurabilityScenario } from './capacityDurabilitySubject.js'
import {
  collectLaunchStimuli,
  collectRecoveryStimulus,
  recordLaunchScenarioEvidence,
  terminalReplayMatchesStored,
  type LaunchEvidence,
  type LaunchStimulusResult,
} from './launcherEvidence.js'
import { collectJobControlEffects } from './jobControlSubject.js'
import { RUNTIME_RED_OBLIGATIONS } from './obligationMatrix.js'
import { scenarioFor } from './runtimeScenarios.js'
import { observationMatches, type RuntimeObservation, type RuntimeScenario } from './scenarioTypes.js'
import { observeTerminalScenario, terminalResumeAdvances } from './terminalSubject.js'

const request: SessionStartMessage = {
  type: 'SESSION_START',
  bindingId: '123e4567-e89b-42d3-a456-426614174000',
  requestId: '223e4567-e89b-42d3-a456-426614174000',
  expiresAt: '2026-08-21T00:10:00Z',
  terminalProfile: 'coder',
  modelProfileId: 'daily',
  target: { projectId: 'modulastack', worktreeName: 'lane-01', branch: 'feat/lane-01', baseBranch: 'main', relativeCwd: '.' },
}

const wrongRequestId = '223e4567-e89b-42d3-a456-426614174001'
type SessionLaunchAuditRecord = Extract<AuditRecord, { kind: 'session-launch' }>
const singleLauncherScenario: RuntimeScenario = {
  obligationId: 'G1-R01',
  assertion: 'cap repair probe',
  subject: 'launcher',
  fixture: 'cap-repair-single',
  stimulus: 'cap-repair-single',
  oracle: { result: 'launcher:actions', require: [], forbid: [] },
}

describe('fresh verifier oracle cap repairs #44-#47', () => {
  it('#44 accepts only a fully correlated capacity refusal and translates only the launcher sentinel', async () => {
    const matching = capacityAuditRecord(request, request.requestId)
    expect(capacityAuditMatchesRequest(matching, request)).toBe(true)
    expect(capacityAuditMatchesRequest(capacityAuditRecord(request, wrongRequestId), request)).toBe(false)
    expect(capacityAuditMatchesRequest({ ...matching, key: { ...matching.key, bindingId: wrongRequestId } }, request)).toBe(false)
    expect(capacityAuditMatchesRequest({ ...matching, key: { ...matching.key, requestId: wrongRequestId } }, request)).toBe(false)
    expect(capacityAuditMatchesRequest({
      ...matching,
      result: { type: 'SESSION_REFUSED', requestId: request.requestId, reason: 'request-conflict' },
    }, request)).toBe(false)
    expect(capacityAuditMatchesRequest({
      ...matching,
      state: 'failed',
      result: { type: 'SESSION_FAILED', requestId: request.requestId, reason: 'spawn-failed' },
    }, request)).toBe(false)

    const scenario = runtimeScenario('G1-R21')
    const capacity = await observeCapacityDurabilityScenario(scenario)
    expect(capacity.status).toBe('observed')
    expect(observationMatches(capacity, scenario.oracle)).toBe(true)

    const sentinel = await observeCapacityDurabilityScenario(scenario, sentinelLauncher)
    expect(sentinel).toEqual({ status: 'missing-production-runtime', subject: 'launcher', error: 'SessionLaunchNotImplementedError' })
    await expect(observeCapacityDurabilityScenario(scenario, nonSentinelLauncher)).rejects.toThrow('capacity non-sentinel')
  })

  it('#45 correlates only exact stimulus responses and rejects ambiguous terminal batches', async () => {
    const exactEvents: string[] = []
    await collectLaunchStimuli(
      () => actionStream([refused(request.requestId, 'at-capacity')]),
      singleLauncherScenario,
      request,
      new Map<string, SessionReceipt | SessionReceiptTombstone>(),
      event => exactEvents.push(event),
    )
    expect(exactEvents).toEqual(expect.arrayContaining([
      `action.requestId:${request.requestId}`,
      `input.request:${request.requestId}`,
    ]))

    const wrongEvents: string[] = []
    await collectLaunchStimuli(
      () => actionStream([refused(wrongRequestId, 'at-capacity')]),
      singleLauncherScenario,
      request,
      new Map<string, SessionReceipt | SessionReceiptTombstone>(),
      event => wrongEvents.push(event),
    )
    expect(wrongEvents).not.toContain(`action.requestId:${request.requestId}`)
    expect(wrongEvents).not.toContain(`input.request:${request.requestId}`)

    const recoveryEvents: string[] = []
    await collectRecoveryStimulus(
      actionStream([refused(wrongRequestId, 'at-capacity')]),
      request.requestId,
      event => recoveryEvents.push(event),
    )
    expect(recoveryEvents).not.toContain(`action.requestId:${request.requestId}`)
    expect(recoveryEvents).not.toContain(`input.request:${request.requestId}`)

    const terminal = refused(request.requestId, 'at-capacity')
    const replayEvents: string[] = []
    recordLaunchScenarioEvidence(
      event => replayEvents.push(event),
      { ...singleLauncherScenario, fixture: 'duplicate-exact' },
      stimulusResult([[terminal], [terminal]]),
      request,
      0,
      0,
      emptyLaunchEvidence(),
    )
    expect(replayEvents).toContain('action.replay:same-outcome')

    const doubleTerminalEvents: string[] = []
    recordLaunchScenarioEvidence(
      event => doubleTerminalEvents.push(event),
      { ...singleLauncherScenario, fixture: 'duplicate-exact' },
      stimulusResult([[terminal], [terminal, terminal]]),
      request,
      0,
      0,
      emptyLaunchEvidence(),
    )
    expect(doubleTerminalEvents).not.toContain('action.replay:same-outcome')
  })

  it('#45 requires one exact receipt or tombstone terminal result', () => {
    const terminal = refused(request.requestId, 'at-capacity')
    for (const storedValue of [storedReceipt('at-capacity'), storedTombstone('at-capacity')]) {
      const stored = new Map<string, SessionReceipt | SessionReceiptTombstone>([
        [`${request.bindingId}:${request.requestId}`, storedValue],
      ])
      expect(terminalReplayMatchesStored([terminal], stored, request)).toBe(true)
      expect(terminalReplayMatchesStored([refused(wrongRequestId, 'at-capacity')], stored, request)).toBe(false)
      expect(terminalReplayMatchesStored([terminal, terminal], stored, request)).toBe(false)
    }
    const wrongRetained = new Map<string, SessionReceipt | SessionReceiptTombstone>([
      [`${request.bindingId}:${request.requestId}`, storedReceipt('request-conflict')],
    ])
    expect(terminalReplayMatchesStored([terminal], wrongRetained, request)).toBe(false)
  })

  it('#46 returns eight effects and rejects the ninth while closing finite and unbounded producers', async () => {
    let validClosed = false
    await expect(collectJobControlEffects(effectStream(8, () => { validClosed = true }))).resolves.toHaveLength(8)
    expect(validClosed).toBe(true)

    let finiteClosed = false
    await expect(collectJobControlEffects(effectStream(9, () => { finiteClosed = true }))).rejects.toThrow('maximum is 8')
    expect(finiteClosed).toBe(true)

    let unboundedClosed = false
    let yielded = 0
    async function* unboundedEffects(): AsyncGenerator<SessionJobControlEffect> {
      try {
        while (true) {
          yielded += 1
          yield { kind: 'not-session' }
        }
      } finally {
        unboundedClosed = true
      }
    }
    await expect(within(collectJobControlEffects(unboundedEffects()))).rejects.toThrow('maximum is 8')
    expect(yielded).toBe(9)
    expect(unboundedClosed).toBe(true)
  })

  it('#47 accepts only contiguous post-reconnect advancement', () => {
    expect(terminalResumeAdvances(7, [8, 9], [])).toBe(true)
    expect(terminalResumeAdvances(7, [9, 10], [9])).toBe(true)
    expect(terminalResumeAdvances(7, [], [])).toBe(false)
    expect(terminalResumeAdvances(7, [8], [7])).toBe(false)
    expect(terminalResumeAdvances(7, [7], [])).toBe(false)
    expect(terminalResumeAdvances(7, [8, 8], [])).toBe(false)
    expect(terminalResumeAdvances(7, [9], [])).toBe(false)
    expect(terminalResumeAdvances(7, [10], [9])).toBe(false)
  })

  it('#47 observes bounded resume teardown while retaining EXIT replay and RESET watermark evidence', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const resume = await within(observeTerminalScenario(runtimeScenario('G1-C12')), 15_000)
      expectObserved(resume, 'terminal:resumed', [
        'terminal.sequence:pre-disconnect-high-water:',
        'terminal.sequence:post-reconnect:',
        'terminal.resume:same-channel+token+sequence',
      ])
    }

    const exit = await within(observeTerminalScenario(runtimeScenario('G1-C11')), 15_000)
    expectObserved(exit, 'terminal:finished', ['terminal.exit:replayed:same-sequence', 'channel.close:after-exit-replay'])
    expect(eventIndex(exit, 'terminal.exit:replayed:same-sequence')).toBeGreaterThan(eventIndex(exit, 'terminal.disconnect:before-exit-ack'))
    expect(eventIndex(exit, 'channel.close:after-exit-replay')).toBeGreaterThan(eventIndex(exit, 'terminal.exit:replayed:same-sequence'))

    const reset = await within(observeTerminalScenario(runtimeScenario('G1-C13')), 15_000)
    expectObserved(reset, 'terminal:reset', [
      'terminal.sequence:pre-disconnect-high-water:',
      'terminal.reset:watermark-advances-pre-disconnect',
      'terminal.post-reset:all-advance',
    ])
  }, 60_000)
})

function capacityAuditRecord(expected: SessionStartMessage, resultRequestId: string): SessionLaunchAuditRecord {
  return {
    kind: 'session-launch',
    key: { bindingId: expected.bindingId, requestId: expected.requestId },
    state: 'refused',
    at: '2026-08-21T00:00:00Z',
    result: { type: 'SESSION_REFUSED', requestId: resultRequestId, reason: 'at-capacity' },
  }
}

function sentinelLauncher(): SessionLauncher {
  return {
    async *handle() {
      throw new SessionLaunchNotImplementedError()
    },
    async *recover() {},
  }
}

function nonSentinelLauncher(): SessionLauncher {
  return {
    handle: async function* () {
      throw new Error('capacity non-sentinel')
    },
    recover: async function* () {},
  }
}

async function* actionStream(actions: readonly SessionLaunchAction[]): AsyncGenerator<SessionLaunchAction> {
  yield* actions
}

function refused(requestId: string, reason: 'at-capacity' | 'request-conflict'): SessionLaunchAction {
  return { kind: 'message', message: { type: 'SESSION_REFUSED', requestId, reason } }
}

function stimulusResult(batches: SessionLaunchAction[][]): LaunchStimulusResult {
  return { actions: batches.flat(), batches, firstReceiptStable: true }
}

function emptyLaunchEvidence(): LaunchEvidence {
  return {
    stored: new Map<string, SessionReceipt | SessionReceiptTombstone>(),
    openedChannels: [],
    durableStarts: [],
  }
}

function storedReceipt(reason: 'at-capacity' | 'request-conflict'): SessionReceipt {
  return {
    schemaVersion: 1,
    revision: 1,
    key: { bindingId: request.bindingId, requestId: request.requestId },
    fingerprint: 'f'.repeat(64),
    request,
    state: 'refused',
    phaseTimestamps: { refused: '2026-08-21T00:00:00Z' },
    worktree: { phase: 'none' },
    result: { type: 'SESSION_REFUSED', requestId: request.requestId, reason },
  }
}

function storedTombstone(reason: 'at-capacity' | 'request-conflict'): SessionReceiptTombstone {
  return {
    key: { bindingId: request.bindingId, requestId: request.requestId },
    fingerprint: 'f'.repeat(64),
    result: { type: 'SESSION_REFUSED', requestId: request.requestId, reason },
    terminalAt: '2026-08-21T00:00:00Z',
    deleteAfter: '2026-09-20T00:00:00Z',
  }
}

async function* effectStream(
  count: number,
  onClose: () => void,
): AsyncGenerator<SessionJobControlEffect> {
  try {
    for (let index = 0; index < count; index += 1) yield { kind: 'not-session' }
  } finally {
    onClose()
  }
}

async function within<T>(value: Promise<T>, milliseconds = 1_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`probe exceeded ${milliseconds}ms`)), milliseconds)
  })
  try {
    return await Promise.race([value, deadline])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function runtimeScenario(id: RuntimeScenario['obligationId']): RuntimeScenario {
  const obligation = RUNTIME_RED_OBLIGATIONS.find(candidate => candidate.id === id)
  if (!obligation) throw new Error(`missing runtime-red obligation ${id}`)
  return scenarioFor(obligation)
}

function expectObserved(observation: RuntimeObservation, result: string, requiredEvents: readonly string[]) {
  expect(observation.status).toBe('observed')
  if (observation.status !== 'observed') return
  expect(observation.result).toBe(result)
  for (const required of requiredEvents) {
    expect(observation.events.some(event => event.includes(required)), required).toBe(true)
  }
}

function eventIndex(observation: RuntimeObservation, fragment: string): number {
  if (observation.status !== 'observed') return -1
  return observation.events.findIndex(event => event.includes(fragment))
}

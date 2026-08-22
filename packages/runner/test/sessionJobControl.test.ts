import { PROTOCOL_VERSION, SESSION_LAUNCH_PROTOCOL_VERSION, type SessionStartMessage } from '@modulastack/runner-protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  createSessionJobControl,
  type AuditRecord,
  type SessionJobControlEffect,
  type SessionLauncher,
} from '../src/index.js'

const clock = { now: () => Date.parse('2026-08-22T00:00:00Z'), sleep: async () => undefined }
const request: SessionStartMessage = {
  type: 'SESSION_START',
  bindingId: '123e4567-e89b-42d3-a456-426614174000',
  requestId: '223e4567-e89b-42d3-a456-426614174001',
  expiresAt: '2026-08-22T12:00:00Z',
  terminalProfile: 'coder',
  modelProfileId: 'daily',
  target: { projectId: 'modulastack', worktreeName: 'lane-01', branch: 'feat/lane-01', baseBranch: 'main', relativeCwd: '.' },
}

function context(version = SESSION_LAUNCH_PROTOCOL_VERSION) {
  return {
    connectionId: 'connection-1',
    channelId: 'job-control-1',
    phase: 'active' as const,
    selectedProtocolVersion: version,
    authenticatedBindingId: request.bindingId,
  }
}

function launcher(onHandle: (received: SessionStartMessage) => void = () => undefined): SessionLauncher {
  return {
    async *handle(received) {
      onHandle(received)
      yield { kind: 'message', message: { type: 'SESSION_ACCEPTED', requestId: received.requestId } }
    },
    async *recover() {
      yield { kind: 'message', message: { type: 'SESSION_FINISHED', requestId: request.requestId, exitCode: 0, signal: null } }
    },
  }
}

async function collect(values: AsyncIterable<SessionJobControlEffect>) {
  const effects: SessionJobControlEffect[] = []
  for await (const value of values) effects.push(value)
  return effects
}

describe('session job-control dispatch', () => {
  it('keeps active protocol v1 while exercising the inactive v2 composition with declared fields only', async () => {
    expect(PROTOCOL_VERSION).toBe(1)
    const received: SessionStartMessage[] = []
    const audit = vi.fn(async (_record: AuditRecord) => undefined)
    const subject = createSessionJobControl({ launcher: launcher(value => received.push(value)), audit: { append: audit }, clock })
    const body = { ...request, command: '/bin/sh', target: { ...request.target, unknown: 'discard' } }
    await expect(collect(subject.dispatch({ context: context(), payload: { codec: 'json', body } }))).resolves.toEqual([{
      kind: 'send',
      channelId: 'job-control-1',
      payload: { codec: 'json', body: { type: 'SESSION_ACCEPTED', requestId: request.requestId } },
    }])
    expect(received).toEqual([request])
    expect(audit).not.toHaveBeenCalled()
  })

  it('durably audits sanitized unnegotiated traffic before closing without launching', async () => {
    const events: string[] = []
    const records: AuditRecord[] = []
    const handle = vi.fn(async function* () {
      events.push('launch')
    })
    const subject = createSessionJobControl({
      launcher: { handle, recover: async function* () {} },
      audit: { append: async record => { records.push(record); events.push(`audit:${record.kind}`) } },
      clock,
    })
    const effects = await collect(subject.dispatch({
      context: { ...context(1), connectionId: 'unsafe\nconnection', channelId: 'unsafe\nchannel' },
      payload: { codec: 'json', body: request },
    }))
    expect(events).toEqual(['audit:session-connection-refusal'])
    expect(records).toEqual([{
      kind: 'session-connection-refusal',
      connectionId: 'unknown',
      channelId: 'unknown',
      requestId: null,
      reason: 'unsupported-session-launch',
      selectedProtocolVersion: 1,
      phase: 'active',
      at: '2026-08-22T00:00:00.000Z',
    }])
    expect(effects).toEqual([{ kind: 'close-job-control', channelId: 'unsafe\nchannel', error: 'unsupported-session-launch' }])
    expect(handle).not.toHaveBeenCalled()
  })

  it('sends a correlated invalid-request refusal only after its connection audit is durable', async () => {
    const events: string[] = []
    const subject = createSessionJobControl({
      launcher: launcher(),
      audit: { append: async record => { events.push(`audit:${record.kind}:${'requestId' in record ? record.requestId : null}`) } },
      clock,
    })
    const effects = await collect(subject.dispatch({
      context: context(),
      payload: { codec: 'json', body: { type: 'SESSION_START', requestId: request.requestId } },
    }))
    expect(events).toEqual([`audit:session-connection-refusal:${request.requestId}`])
    expect(effects).toEqual([{
      kind: 'send',
      channelId: 'job-control-1',
      payload: { codec: 'json', body: { type: 'SESSION_REFUSED', requestId: request.requestId, reason: 'invalid-request' } },
    }])
  })

  it('audits and refuses an authenticated binding mismatch before launcher entry', async () => {
    const records: AuditRecord[] = []
    const handle = vi.fn(async function* () {})
    const subject = createSessionJobControl({
      launcher: { handle, recover: async function* () {} },
      audit: { append: async record => { records.push(record) } },
      clock,
    })
    const effects = await collect(subject.dispatch({
      context: { ...context(), authenticatedBindingId: '323e4567-e89b-42d3-a456-426614174002' },
      payload: { codec: 'json', body: request },
    }))
    expect(records).toMatchObject([{ kind: 'session-connection-refusal', reason: 'binding-mismatch', requestId: request.requestId }])
    expect(effects).toEqual([{
      kind: 'send',
      channelId: 'job-control-1',
      payload: { codec: 'json', body: { type: 'SESSION_REFUSED', requestId: request.requestId, reason: 'binding-mismatch' } },
    }])
    expect(handle).not.toHaveBeenCalled()
  })

  it('maps an audit failure to storage-unavailable without a correlated refusal or launcher call', async () => {
    const handle = vi.fn(async function* () {})
    const subject = createSessionJobControl({
      launcher: { handle, recover: async function* () {} },
      audit: { append: async () => { throw new Error('disk full') } },
      clock,
    })
    await expect(collect(subject.dispatch({
      context: context(),
      payload: { codec: 'json', body: { type: 'SESSION_START', requestId: request.requestId } },
    }))).resolves.toEqual([{ kind: 'close-job-control', channelId: 'job-control-1', error: 'storage-unavailable' }])
    expect(handle).not.toHaveBeenCalled()
  })

  it('audits and closes malformed or oversized session traffic while ignoring other messages', async () => {
    const records: AuditRecord[] = []
    const subject = createSessionJobControl({ launcher: launcher(), audit: { append: async record => { records.push(record) } }, clock })
    const invalid = await collect(subject.dispatch({
      context: context(),
      payload: { codec: 'json', body: { type: 'SESSION_UNKNOWN' } },
    }))
    const oversized = await collect(subject.dispatch({
      context: context(),
      payload: { codec: 'json', body: { ...request, padding: 'x'.repeat(1024 * 1024) } },
    }))
    const unsafeIdentifier = await collect(subject.dispatch({
      context: context(),
      payload: { codec: 'json', body: { ...request, modelProfileId: '__proto__' } },
    }))
    const unrelated = await collect(subject.dispatch({
      context: context(),
      payload: { codec: 'json', body: { type: 'CAPABILITIES' } },
    }))
    expect(invalid).toEqual([{ kind: 'close-job-control', channelId: 'job-control-1', error: 'invalid-session-launch' }])
    expect(oversized).toEqual([{ kind: 'close-job-control', channelId: 'job-control-1', error: 'invalid-session-launch' }])
    expect(unsafeIdentifier).toEqual([{ kind: 'close-job-control', channelId: 'job-control-1', error: 'invalid-session-launch' }])
    expect(unrelated).toEqual([{ kind: 'not-session' }])
    expect(records).toHaveLength(3)
    expect(records.at(-1)).toMatchObject({ kind: 'session-connection-refusal', requestId: null })
    expect(records.every(record => !JSON.stringify(record).includes('padding'))).toBe(true)
  })

  it('replays an exact duplicate without re-entering the launcher', async () => {
    let calls = 0
    const subject = createSessionJobControl({ launcher: launcher(() => { calls += 1 }) })
    const input = { context: context(), payload: { codec: 'json' as const, body: request } }
    const first = await collect(subject.dispatch(input))
    const replayed = await collect(subject.dispatch(input))
    expect(replayed).toEqual(first)
    expect(calls).toBe(1)
  })

  it('recovers only after active v2 negotiation and preserves launcher action order', async () => {
    const subject = createSessionJobControl({ launcher: launcher() })
    await expect(collect(subject.recover(context(1)))).resolves.toEqual([])
    await expect(collect(subject.recover(context()))).resolves.toEqual([{
      kind: 'send',
      channelId: 'job-control-1',
      payload: { codec: 'json', body: { type: 'SESSION_FINISHED', requestId: request.requestId, exitCode: 0, signal: null } },
    }])
  })
})

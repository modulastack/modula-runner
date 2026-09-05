import { describe, expect, it } from 'vitest'
import {
  PROTOCOL_VERSION,
  SESSION_FAILURE_REASONS,
  SESSION_LAUNCH_PROTOCOL_VERSION,
  SESSION_REFUSAL_REASONS,
  canonicalSessionStart,
  decodeSessionLaunchClientMessage,
  parseJobControlClientMessage,
  parseSessionLaunchClientMessage,
  parseSessionLaunchServerMessage,
  sessionLaunchPayload,
  sessionStartDeadline,
  sessionStartFingerprint,
  sessionStartIdentity,
  type SessionStartMessage,
} from '@modulastack/runner-protocol'

const bindingId = '123e4567-e89b-42d3-a456-426614174000'
const requestId = '223e4567-e89b-42d3-a456-426614174001'
const start = {
  type: 'SESSION_START',
  bindingId,
  requestId,
  expiresAt: '2026-08-22T12:00:00Z',
  terminalProfile: 'coder',
  modelProfileId: 'daily',
  target: {
    projectId: 'modulastack',
    worktreeName: 'lane-01',
    branch: 'feat/lane-01',
    baseBranch: 'main',
    relativeCwd: 'packages/app',
    repoPath: '/must/not/cross',
  },
  command: 'sh',
  argv: ['-c', 'id'],
  env: { SECRET: 'must-not-cross' },
}

describe('session-launch version-2 interface', () => {
  it('activates the reviewed v2 interface without widening v1', () => {
    expect(PROTOCOL_VERSION).toBe(2)
    expect(SESSION_LAUNCH_PROTOCOL_VERSION).toBe(PROTOCOL_VERSION)
    expect(parseSessionLaunchClientMessage(start, 1)).toBeNull()
    expect(decodeSessionLaunchClientMessage(sessionLaunchPayload(start as SessionStartMessage), 1)).toBeNull()
    expect(parseSessionLaunchClientMessage(start, PROTOCOL_VERSION)).not.toBeNull()
    expect(decodeSessionLaunchClientMessage(sessionLaunchPayload(start as SessionStartMessage), PROTOCOL_VERSION)).not.toBeNull()
    expect(parseJobControlClientMessage(start)).toBeNull()
  })

  it('copies only declared launch fields under version 2', () => {
    const parsed = parseSessionLaunchClientMessage(start, SESSION_LAUNCH_PROTOCOL_VERSION)
    expect(parsed).toEqual({
      type: 'SESSION_START',
      bindingId,
      requestId,
      expiresAt: '2026-08-22T12:00:00Z',
      terminalProfile: 'coder',
      modelProfileId: 'daily',
      target: {
        projectId: 'modulastack',
        worktreeName: 'lane-01',
        branch: 'feat/lane-01',
        baseBranch: 'main',
        relativeCwd: 'packages/app',
      },
    })
    expect(parsed).not.toHaveProperty('command')
    expect(parsed?.target).not.toHaveProperty('repoPath')
    expect(sessionLaunchPayload(start as SessionStartMessage)).toEqual({ codec: 'json', body: parsed })
  })

  it('extracts correlation before full request validation', () => {
    expect(sessionStartIdentity({ ...start, target: null })).toEqual({ bindingId, requestId })
    expect(sessionStartIdentity({ ...start, requestId: requestId.toUpperCase() })).toBeNull()
  })

  it('rejects noncanonical ids, timestamps, and relative paths', () => {
    expect(parseSessionLaunchClientMessage({ ...start, bindingId: bindingId.toUpperCase() }, 2)).toBeNull()
    expect(parseSessionLaunchClientMessage({ ...start, expiresAt: '2026-02-30T00:00:00Z' }, 2)).toBeNull()
    expect(parseSessionLaunchClientMessage({ ...start, target: { ...start.target, relativeCwd: '../escape' } }, 2)).toBeNull()
    expect(parseSessionLaunchClientMessage({ ...start, target: { ...start.target, relativeCwd: 'a//b' } }, 2)).toBeNull()
    expect(parseSessionLaunchClientMessage({ ...start, target: { ...start.target, relativeCwd: 'a\\b' } }, 2)).toBeNull()
    expect(parseSessionLaunchClientMessage({ ...start, target: { ...start.target, relativeCwd: 'C:/Windows/System32' } }, 2)).toBeNull()
    expect(parseSessionLaunchClientMessage({ ...start, target: { ...start.target, relativeCwd: 'D:../escape' } }, 2)).toBeNull()
    expect(parseSessionLaunchClientMessage({ ...start, target: { ...start.target, branch: 'bad\nbranch' } }, 2)).toBeNull()
  })

  it('checks first-admission time without using it as identity', () => {
    const now = Date.parse('2026-08-21T12:00:00Z')
    expect(sessionStartDeadline('2026-08-21T12:00:01Z', now)).toBe('admissible')
    expect(sessionStartDeadline('2026-08-21T12:00:00Z', now)).toBe('expired')
    expect(sessionStartDeadline('2026-08-22T12:00:00.001Z', now)).toBe('too-far')
    expect(sessionStartDeadline('not-a-date', now)).toBe('invalid')
  })

  it('fingerprints the validated semantic object with stable nested key order', () => {
    const parsed = parseSessionLaunchClientMessage(start, 2)!
    const reordered = { ...parsed, target: { ...parsed.target } }
    expect(sessionStartFingerprint(reordered)).toBe(sessionStartFingerprint(parsed))
    expect(canonicalSessionStart(parsed)).toBe(
      `{"bindingId":"${bindingId}","expiresAt":"2026-08-22T12:00:00Z","modelProfileId":"daily","requestId":"${requestId}","target":{"baseBranch":"main","branch":"feat/lane-01","projectId":"modulastack","relativeCwd":"packages/app","worktreeName":"lane-01"},"terminalProfile":"coder","type":"SESSION_START"}`,
    )
  })

  it('validates every finite server result and exactly one exit outcome', () => {
    expect(parseSessionLaunchServerMessage({ type: 'SESSION_ACCEPTED', requestId, ignored: true }, 2))
      .toEqual({ type: 'SESSION_ACCEPTED', requestId })
    expect(parseSessionLaunchServerMessage({ type: 'SESSION_STARTED', requestId, channelId: 'channel-1', sessionId: 'session-1' }, 2))
      .toEqual({ type: 'SESSION_STARTED', requestId, channelId: 'channel-1', sessionId: 'session-1' })
    for (const reason of SESSION_REFUSAL_REASONS) {
      expect(parseSessionLaunchServerMessage({ type: 'SESSION_REFUSED', requestId, reason }, 2)).not.toBeNull()
    }
    for (const reason of SESSION_FAILURE_REASONS) {
      expect(parseSessionLaunchServerMessage({ type: 'SESSION_FAILED', requestId, reason }, 2)).not.toBeNull()
    }
    expect(parseSessionLaunchServerMessage({ type: 'SESSION_FINISHED', requestId, exitCode: 0, signal: null }, 2)).not.toBeNull()
    expect(parseSessionLaunchServerMessage({ type: 'SESSION_FINISHED', requestId, exitCode: null, signal: 15 }, 2)).not.toBeNull()
    expect(parseSessionLaunchServerMessage({ type: 'SESSION_FINISHED', requestId, exitCode: 0, signal: 15 }, 2)).toBeNull()
    expect(parseSessionLaunchServerMessage({ type: 'SESSION_FINISHED', requestId, exitCode: null, signal: null }, 2)).toBeNull()
  })
})

import {
  PROTOCOL_VERSION,
  SESSION_LAUNCH_PROTOCOL_VERSION,
  decodeJobControlClientMessage,
  decodeSessionLaunchClientMessage,
  parseJobControlClientMessage,
  parseSessionLaunchClientMessage,
} from '@modulastack/runner-protocol'
import { describe, expect, it } from 'vitest'

const sessionStart = {
  type: 'SESSION_START',
  bindingId: '123e4567-e89b-42d3-a456-426614174000',
  requestId: '123e4567-e89b-42d3-a456-426614174001',
  expiresAt: '2026-08-22T12:00:00Z',
  terminalProfile: 'coder',
  modelProfileId: 'daily',
  target: {
    projectId: 'modulastack',
    worktreeName: 'as-08',
    branch: 'feat/as-08',
    baseBranch: 'main',
    relativeCwd: '.',
  },
} as const

const sessionStartPayload = { codec: 'json', body: sessionStart } as const

describe('CP-5 active wire invariance acceptance', () => {
  it('AS-08 activates session launch only under the approved version-2 interface', () => {
    expect(PROTOCOL_VERSION).toBe(2)
    expect(SESSION_LAUNCH_PROTOCOL_VERSION).toBe(PROTOCOL_VERSION)

    expect(parseJobControlClientMessage(sessionStart)).toBeNull()
    expect(decodeJobControlClientMessage(sessionStartPayload)).toBeNull()
    expect(parseSessionLaunchClientMessage(sessionStart, 1)).toBeNull()
    expect(decodeSessionLaunchClientMessage(sessionStartPayload, 1)).toBeNull()

    expect(parseSessionLaunchClientMessage(sessionStart, PROTOCOL_VERSION)).toEqual(sessionStart)
    expect(decodeSessionLaunchClientMessage(sessionStartPayload, PROTOCOL_VERSION)).toEqual(sessionStart)
    expect(parseSessionLaunchClientMessage(sessionStart, PROTOCOL_VERSION + 1)).toBeNull()
  })
})

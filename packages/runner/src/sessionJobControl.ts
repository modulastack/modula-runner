import type { Payload } from '@modulastack/runner-protocol'
import type { SessionLauncher } from './sessionLaunch.js'

export const SESSION_JOB_CONTROL_ERRORS = [
  'unsupported-session-launch',
  'invalid-session-launch',
  'storage-unavailable',
] as const
export type SessionJobControlError = (typeof SESSION_JOB_CONTROL_ERRORS)[number]

export type SessionJobControlPhase = 'pre-welcome' | 'active' | 'reconnecting'

export type SessionJobControlContext = {
  connectionId: string
  channelId: string
  phase: SessionJobControlPhase
  selectedProtocolVersion: number | null
}

export type SessionJobControlInput = {
  context: SessionJobControlContext
  payload: Payload
}

export type SessionJobControlEffect =
  | { kind: 'send'; channelId: string; payload: Payload }
  | { kind: 'close-job-control'; channelId: string; error: SessionJobControlError }
  | { kind: 'not-session' }

export interface SessionJobControl {
  dispatch(input: SessionJobControlInput): AsyncIterable<SessionJobControlEffect>
  recover(context: SessionJobControlContext): AsyncIterable<SessionJobControlEffect>
}

export type SessionJobControlOptions = {
  launcher: SessionLauncher
}

export class SessionJobControlNotImplementedError extends Error {
  constructor() {
    super('session job-control composition is interface-only and is not active')
    this.name = 'SessionJobControlNotImplementedError'
  }
}

export function createSessionJobControl(_options: SessionJobControlOptions): SessionJobControl {
  const unavailable = async function* (): AsyncGenerator<never> {
    throw new SessionJobControlNotImplementedError()
  }
  return { dispatch: unavailable, recover: unavailable }
}

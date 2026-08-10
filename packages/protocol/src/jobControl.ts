import { isSafeIdentifier, type Payload } from './frames.js'

// Job-control channel payload semantics. `job-control` has been a wire-valid channel
// kind since version 1 with its semantics deferred, so specifying them here adds no
// frame type and changes no existing field: the set of wire-valid frames is unchanged
// and the version does not bump, exactly as the terminal payloads did.

export const MAX_PORT = 65_535
const MAX_PATH_LENGTH = 1024

// Every refusal names its cause. A runner that cannot start what it was asked to start
// answers instead of holding the request, so "paused" is a state a surface can render
// rather than an absence of activity that reads identically to work in progress.
export const REFUSAL_REASONS = [
  'not-allowlisted',
  'path-not-granted',
  'runner-paused',
  'non-loopback-bind',
  'already-running',
  'unknown-preview',
  'spawn-failed',
  'ambiguous-listener',
  'at-capacity',
] as const
export type RefusalReason = (typeof REFUSAL_REASONS)[number]

export type JobControlClientMessage =
  | { type: 'PREVIEW_START'; previewId: string; recipe: string; cwd: string }
  | { type: 'PREVIEW_STOP'; previewId: string }

export type JobControlServerMessage =
  | { type: 'PREVIEW_READY'; previewId: string; port: number }
  | { type: 'PREVIEW_EXIT'; previewId: string; exitCode: number | null; signal: number | null }
  | { type: 'REFUSED'; requestId: string; reason: RefusalReason }

export function jobControlPayload(message: JobControlClientMessage | JobControlServerMessage): Payload {
  return { codec: 'json', body: message }
}

export function decodeJobControlClientMessage(payload: Payload): JobControlClientMessage | null {
  return payload.codec === 'json' ? parseJobControlClientMessage(payload.body) : null
}

export function decodeJobControlServerMessage(payload: Payload): JobControlServerMessage | null {
  return payload.codec === 'json' ? parseJobControlServerMessage(payload.body) : null
}

export function parseJobControlClientMessage(value: unknown): JobControlClientMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null
  if (value.type === 'PREVIEW_START') return previewStart(value)
  if (value.type === 'PREVIEW_STOP') return isSafeIdentifier(value.previewId) ? { type: 'PREVIEW_STOP', previewId: value.previewId } : null
  return null
}

export function parseJobControlServerMessage(value: unknown): JobControlServerMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null
  if (value.type === 'PREVIEW_READY') return previewReady(value)
  if (value.type === 'PREVIEW_EXIT') return previewExit(value)
  if (value.type === 'REFUSED') return refused(value)
  return null
}

// The control plane names WHAT to run, never HOW. An argument vector crossing the seam
// would make an allowlisted interpreter into arbitrary execution — `node -e`, `sh -c` —
// under the runner user's privileges, so the wire has no field for one. The runner holds
// the command and arguments locally against this name.
function previewStart(value: Record<string, unknown>): JobControlClientMessage | null {
  if (!isSafeIdentifier(value.previewId) || !isSafeIdentifier(value.recipe)) return null
  if (!isBoundedString(value.cwd, MAX_PATH_LENGTH)) return null
  return { type: 'PREVIEW_START', previewId: value.previewId, recipe: value.recipe, cwd: value.cwd }
}

function previewReady(value: Record<string, unknown>): JobControlServerMessage | null {
  if (!isSafeIdentifier(value.previewId) || !isPort(value.port)) return null
  return { type: 'PREVIEW_READY', previewId: value.previewId, port: value.port }
}

function previewExit(value: Record<string, unknown>): JobControlServerMessage | null {
  if (!isSafeIdentifier(value.previewId)) return null
  if (!isExitValue(value.exitCode) || !isExitValue(value.signal)) return null
  return { type: 'PREVIEW_EXIT', previewId: value.previewId, exitCode: value.exitCode, signal: value.signal }
}

function refused(value: Record<string, unknown>): JobControlServerMessage | null {
  if (!isSafeIdentifier(value.requestId) || !isRefusalReason(value.reason)) return null
  return { type: 'REFUSED', requestId: value.requestId, reason: value.reason }
}

export function isRefusalReason(value: unknown): value is RefusalReason {
  return typeof value === 'string' && (REFUSAL_REASONS as readonly string[]).includes(value)
}

// A port is the one piece of preview state the seam deliberately carries: the operator's
// browser is on the runner's own machine, so the number is all it needs to reach a server
// that never left loopback. No host and no URL cross — those would be an endpoint.
function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_PORT
}

// Control characters are rejected at the wire, not at the process boundary. A NUL in a
// command or path reaches spawn as a synchronous throw rather than a refusal value, and
// CR and LF are header-injection shapes; none of them are anything a real command line
// contains, so the protocol has no reason to carry them.
function isBoundedString(value: unknown, max: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return false
  return !hasControlCharacter(value)
}

export function hasControlCharacter(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function isExitValue(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

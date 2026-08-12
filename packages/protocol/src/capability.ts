import { hasControlCharacter, isSafeIdentifier } from './frames.js'

// What a runner can actually do, as the control plane is allowed to know it.
//
// Two rules shape every field here, and both come from the seam contract rather than from
// convenience. First, a capability advertisement is not an endpoint disclosure: the wire
// carries the *fact* of a local model endpoint — an opaque local id, its kind, its health,
// its model inventory — and never its URL, host, port or scheme, because
// "local-model endpoint URLs" are on the never-crosses list. Second, an unreachable
// endpoint reports an enumerated reason and not an error string: a transport error message
// carries the address it failed to reach, so free text here would leak the very endpoint
// the first rule keeps off the wire.
//
// OS and architecture are already on `hello.runner`; FR-10's advertisement is the two
// fields together, and restating them here would be a wider interface saying the same thing.

export const ACCESS_MODES = ['subscription', 'api-key', 'local'] as const
export type AccessMode = (typeof ACCESS_MODES)[number]

// 'unknown' is a real answer, not a placeholder: a runtime that offers no way to ask
// about its own login state must not be reported as logged out, which would render as
// "sign in" guidance for a CLI that is already signed in.
export const CLI_AUTH_STATES = ['authenticated', 'unauthenticated', 'unknown'] as const
export type CliAuthState = (typeof CLI_AUTH_STATES)[number]

export const LOCAL_ENDPOINT_KINDS = ['ollama', 'openai-compatible'] as const
export type LocalEndpointKind = (typeof LOCAL_ENDPOINT_KINDS)[number]

export const ENDPOINT_UNREACHABLE_REASONS = ['not-running', 'refused', 'timed-out', 'unauthorized', 'unreadable-response'] as const
export type EndpointUnreachableReason = (typeof ENDPOINT_UNREACHABLE_REASONS)[number]

// A snapshot is one frame, and the frame cap is 1 MiB, so an operator-sized model library
// has to fit in it or the advertisement is undeliverable. Every collection here is
// therefore bounded, and truncation is visible rather than silent (`modelCount`).
//
// This bound is also why the snapshot rides a channel rather than `hello`: a hello shares
// its frame with a resume roster of up to 1024 channels, budgeted so the hello always fits,
// and an oversized hello is terminal for the connection — a large model library would have
// made a runner unable to connect at all.
export const MAX_RUNTIME_CAPABILITIES = 32
export const MAX_ENDPOINT_CAPABILITIES = 8
export const MAX_ENDPOINT_MODELS = 64
export const MAX_MODEL_NAME_LENGTH = 128
export const MAX_RUNTIME_VERSION_LENGTH = 64

export type RuntimeCapability = {
  runtime: string
  // null when the runtime is present but would not say which version it is. Absent and
  // unversioned are different facts, and collapsing them hides a broken install.
  version: string | null
  auth: CliAuthState
  // The access modes this runtime can serve on this machine. Claude Code is
  // subscription/api-key only — a runtime property, not an architecture one.
  access: AccessMode[]
}

export type LocalEndpointCapability = {
  endpointId: string
  kind: LocalEndpointKind
  reachable: boolean
  // Up to MAX_ENDPOINT_MODELS, in the order the endpoint reported them. An endpoint with
  // nothing installed is a reachable endpoint with an empty inventory, not a failure.
  models: string[]
  // How many the endpoint actually holds. Greater than `models.length` means the list was
  // truncated to fit the frame, which the surface can then say out loud.
  modelCount: number
  // Present only when `reachable` is false.
  reason?: EndpointUnreachableReason
}

// Only detected runtimes are listed. Absence is how a missing runtime is expressed, so the
// protocol never has to carry a vocabulary of every CLI that might exist — the same reason
// `profile` is an opaque label rather than an enumerated role list.
export type RunnerCapabilities = {
  runtimes: RuntimeCapability[]
  endpoints: LocalEndpointCapability[]
}

export function isAccessMode(value: unknown): value is AccessMode {
  return typeof value === 'string' && (ACCESS_MODES as readonly string[]).includes(value)
}

export function isCliAuthState(value: unknown): value is CliAuthState {
  return typeof value === 'string' && (CLI_AUTH_STATES as readonly string[]).includes(value)
}

export function isLocalEndpointKind(value: unknown): value is LocalEndpointKind {
  return typeof value === 'string' && (LOCAL_ENDPOINT_KINDS as readonly string[]).includes(value)
}

export function isEndpointUnreachableReason(value: unknown): value is EndpointUnreachableReason {
  return typeof value === 'string' && (ENDPOINT_UNREACHABLE_REASONS as readonly string[]).includes(value)
}

export function parseRunnerCapabilities(value: unknown): RunnerCapabilities | null {
  if (!isRecord(value)) return null
  const runtimes = parseBoundedList(value.runtimes, MAX_RUNTIME_CAPABILITIES, parseRuntimeCapability)
  const endpoints = parseBoundedList(value.endpoints, MAX_ENDPOINT_CAPABILITIES, parseLocalEndpointCapability)
  if (!runtimes || !endpoints) return null
  // Duplicate ids are contradictory the same way a duplicated channel in a resume roster
  // is: two answers for one thing, and no rule that says which wins.
  if (!uniqueBy(runtimes, entry => entry.runtime) || !uniqueBy(endpoints, entry => entry.endpointId)) return null
  return { runtimes, endpoints }
}

function parseRuntimeCapability(value: unknown): RuntimeCapability | null {
  if (!isRecord(value) || !isSafeIdentifier(value.runtime)) return null
  if (!isCliAuthState(value.auth)) return null
  const version = value.version
  if (version !== null && !isBoundedText(version, MAX_RUNTIME_VERSION_LENGTH)) return null
  const access = parseAccessModes(value.access)
  if (!access) return null
  return { runtime: value.runtime, version, auth: value.auth, access }
}

function parseAccessModes(value: unknown): AccessMode[] | null {
  if (!Array.isArray(value) || value.length > ACCESS_MODES.length || !value.every(isAccessMode)) return null
  return new Set(value).size === value.length ? [...value] : null
}

function parseLocalEndpointCapability(value: unknown): LocalEndpointCapability | null {
  if (!isRecord(value) || !isSafeIdentifier(value.endpointId) || !isLocalEndpointKind(value.kind)) return null
  if (typeof value.reachable !== 'boolean') return null
  const models = parseBoundedList(value.models, MAX_ENDPOINT_MODELS, model => (isBoundedText(model, MAX_MODEL_NAME_LENGTH) ? model : null))
  if (!models) return null
  // A count below what was actually sent describes nothing: truncation only ever hides
  // models, so the total can equal or exceed the list, never fall short of it.
  if (!Number.isSafeInteger(value.modelCount) || (value.modelCount as number) < models.length) return null
  // A reason belongs to an unreachable endpoint. One attached to a reachable endpoint, or
  // an unreachable endpoint with none, is a contradiction a surface would have to guess at.
  if (value.reachable) {
    if (value.reason !== undefined) return null
    return { endpointId: value.endpointId, kind: value.kind, reachable: true, models, modelCount: value.modelCount as number }
  }
  if (!isEndpointUnreachableReason(value.reason)) return null
  return { endpointId: value.endpointId, kind: value.kind, reachable: false, models, modelCount: value.modelCount as number, reason: value.reason }
}

function parseBoundedList<T>(value: unknown, max: number, parse: (entry: unknown) => T | null): T[] | null {
  if (!Array.isArray(value) || value.length > max) return null
  const parsed = value.map(parse)
  return parsed.every(entry => entry !== null) ? (parsed as T[]) : null
}

function uniqueBy<T>(entries: T[], key: (entry: T) => string) {
  return new Set(entries.map(key)).size === entries.length
}

// Model names come from an external service and runtime versions from a subprocess's
// stdout, so both are bounded and stripped of control characters at the wire — the same
// rule the job-control paths already apply to anything that crossed a process boundary.
function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !hasControlCharacter(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

import { isSafeIdentifier, type Payload } from './frames.js'

// Terminal channel payload semantics: the message set the localhost terminal UI
// already speaks, carried as `json` payloads on `terminal` channels. The relay
// stays payload-blind; these validators run at the endpoints only.

export const MAX_TERMINAL_DIMENSION = 1000
export const MAX_ACK_BYTES = 10_000_000
const MAX_LABEL_LENGTH = 128
const MAX_PATH_LENGTH = 1024
const MAX_ERROR_LENGTH = 500

export type TerminalClientMessage =
  | { type: 'INIT'; cols: number; rows: number; profile?: string }
  | { type: 'INPUT'; data: string }
  | { type: 'RESIZE'; cols: number; rows: number }
  | { type: 'ACK'; bytes: number }
  | { type: 'KILL' }
  | { type: 'SCROLL_RESET' }

export type TerminalServerMessage =
  | { type: 'READY'; sessionId: string; profile: string; cwd: string; shell: string; pid: number }
  | { type: 'OUTPUT'; data: string; replay?: boolean }
  | { type: 'EXIT'; exitCode: number | null; signal: number | null }
  | { type: 'ERROR'; message: string }
  | { type: 'SCROLL_STATE'; held: boolean; newOutput: boolean }

export function terminalPayload(message: TerminalClientMessage | TerminalServerMessage): Payload {
  return { codec: 'json', body: message }
}

export function decodeTerminalClientMessage(payload: Payload): TerminalClientMessage | null {
  return payload.codec === 'json' ? parseTerminalClientMessage(payload.body) : null
}

export function decodeTerminalServerMessage(payload: Payload): TerminalServerMessage | null {
  return payload.codec === 'json' ? parseTerminalServerMessage(payload.body) : null
}

export function parseTerminalClientMessage(value: unknown): TerminalClientMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null
  if (value.type === 'INIT') return init(value)
  if (value.type === 'INPUT') return typeof value.data === 'string' ? { type: 'INPUT', data: value.data } : null
  if (value.type === 'RESIZE') return dimensions(value)
  if (value.type === 'ACK') return ack(value)
  if (value.type === 'KILL') return { type: 'KILL' }
  if (value.type === 'SCROLL_RESET') return { type: 'SCROLL_RESET' }
  return null
}

export function parseTerminalServerMessage(value: unknown): TerminalServerMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null
  if (value.type === 'READY') return ready(value)
  if (value.type === 'OUTPUT') return output(value)
  if (value.type === 'EXIT') return exit(value)
  if (value.type === 'ERROR') return errorMessage(value)
  if (value.type === 'SCROLL_STATE') return scrollState(value)
  return null
}

function init(value: Record<string, unknown>): TerminalClientMessage | null {
  const size = dimensions(value)
  if (!size) return null
  if (value.profile !== undefined && !isTerminalProfile(value.profile)) return null
  return { type: 'INIT', cols: size.cols, rows: size.rows, ...(value.profile !== undefined ? { profile: value.profile as string } : {}) }
}

function dimensions(value: Record<string, unknown>): { type: 'RESIZE'; cols: number; rows: number } | null {
  const cols = safeDimension(value.cols)
  const rows = safeDimension(value.rows)
  return cols !== null && rows !== null ? { type: 'RESIZE', cols, rows } : null
}

function ack(value: Record<string, unknown>): TerminalClientMessage | null {
  if (typeof value.bytes !== 'number' || !Number.isInteger(value.bytes)) return null
  return value.bytes >= 0 && value.bytes <= MAX_ACK_BYTES ? { type: 'ACK', bytes: value.bytes } : null
}

function ready(value: Record<string, unknown>): TerminalServerMessage | null {
  if (!isSafeIdentifier(value.sessionId) || !isTerminalProfile(value.profile)) return null
  if (!isBoundedString(value.cwd, MAX_PATH_LENGTH) || !isBoundedString(value.shell, MAX_PATH_LENGTH)) return null
  if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid < 1) return null
  return { type: 'READY', sessionId: value.sessionId, profile: value.profile as string, cwd: value.cwd, shell: value.shell, pid: value.pid }
}

function output(value: Record<string, unknown>): TerminalServerMessage | null {
  if (typeof value.data !== 'string') return null
  if (value.replay !== undefined && typeof value.replay !== 'boolean') return null
  return { type: 'OUTPUT', data: value.data, ...(value.replay === true ? { replay: true } : {}) }
}

function exit(value: Record<string, unknown>): TerminalServerMessage | null {
  if (!isExitValue(value.exitCode) || !isExitValue(value.signal)) return null
  return { type: 'EXIT', exitCode: value.exitCode, signal: value.signal }
}

function errorMessage(value: Record<string, unknown>): TerminalServerMessage | null {
  if (!isBoundedString(value.message, MAX_ERROR_LENGTH)) return null
  return { type: 'ERROR', message: value.message }
}

function scrollState(value: Record<string, unknown>): TerminalServerMessage | null {
  if (typeof value.held !== 'boolean' || typeof value.newOutput !== 'boolean') return null
  return { type: 'SCROLL_STATE', held: value.held, newOutput: value.newOutput }
}

// Profiles are opaque control-plane vocabulary to the protocol: a bounded label,
// never an enum this package would have to chase product releases to keep
// current. Exported so an endpoint can validate its own metadata against the
// same rule the codec enforces, instead of minting messages its peer will drop.
export function isTerminalProfile(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_LABEL_LENGTH && isSafeIdentifier(value)
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function isExitValue(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
}

function safeDimension(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  return value >= 1 && value <= MAX_TERMINAL_DIMENSION ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

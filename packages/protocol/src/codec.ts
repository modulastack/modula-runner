import { isChannelKind, isSafeIdentifier, type ChannelResumeResult, type ChannelResumeState, type Frame, type Payload } from './frames.js'
import { isValidRange, isValidVersion } from './version.js'

export const MAX_FRAME_BYTES = 1024 * 1024

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame)
}

export function decodeFrame(raw: string): Frame | null {
  if (Buffer.byteLength(raw, 'utf8') > MAX_FRAME_BYTES) return null
  try {
    return normalize(JSON.parse(raw))
  } catch {
    return null
  }
}

function normalize(value: unknown): Frame | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null
  const frame = frameParsers[value.type]
  return frame ? frame(value) : null
}

const frameParsers: Record<string, (value: Record<string, unknown>) => Frame | null> = {
  hello: hello,
  welcome: welcome,
  reject: reject,
  ping: value => heartbeat(value, 'ping'),
  pong: value => heartbeat(value, 'pong'),
  open: open,
  data: data,
  reset: reset,
  close: close,
  error: errorFrame,
}

function hello(value: Record<string, unknown>): Frame | null {
  const runner = value.runner
  if (!isValidRange(value.protocol) || !isRunnerInfo(runner)) return null
  const channels = resumeStates(value.channels)
  if (!channels) return null
  return { type: 'hello', protocol: value.protocol, runner, channels }
}

function welcome(value: Record<string, unknown>): Frame | null {
  if (!isValidVersion(value.protocol) || !isHeartbeat(value.heartbeat)) return null
  const channels = resumeResults(value.channels)
  if (!channels) return null
  return { type: 'welcome', protocol: value.protocol, heartbeat: value.heartbeat, channels }
}

function reject(value: Record<string, unknown>): Frame | null {
  if (typeof value.reason !== 'string' || !Array.isArray(value.supported) || !value.supported.every(isValidVersion)) return null
  return { type: 'reject', reason: value.reason, supported: value.supported }
}

function heartbeat(value: Record<string, unknown>, type: 'ping' | 'pong'): Frame | null {
  return isSafeIdentifier(value.id) ? { type, id: value.id } : null
}

function open(value: Record<string, unknown>): Frame | null {
  if (!isSafeIdentifier(value.channel) || !isChannelKind(value.kind) || !isToken(value.attachToken)) return null
  return { type: 'open', channel: value.channel, kind: value.kind, attachToken: value.attachToken }
}

function data(value: Record<string, unknown>): Frame | null {
  const payload = parsePayload(value.payload)
  if (!isSafeIdentifier(value.channel) || !isDataSeq(value.seq) || !payload) return null
  return { type: 'data', channel: value.channel, seq: value.seq, payload }
}

function reset(value: Record<string, unknown>): Frame | null {
  if (!isSafeIdentifier(value.channel) || !isDataSeq(value.seq)) return null
  return { type: 'reset', channel: value.channel, seq: value.seq }
}

function close(value: Record<string, unknown>): Frame | null {
  if (!isSafeIdentifier(value.channel)) return null
  if (value.reason !== undefined && typeof value.reason !== 'string') return null
  return { type: 'close', channel: value.channel, ...(typeof value.reason === 'string' ? { reason: value.reason } : {}) }
}

function errorFrame(value: Record<string, unknown>): Frame | null {
  if (typeof value.message !== 'string') return null
  if (value.channel !== undefined && !isSafeIdentifier(value.channel)) return null
  return { type: 'error', message: value.message, ...(typeof value.channel === 'string' ? { channel: value.channel } : {}) }
}

function parsePayload(value: unknown): Payload | null {
  if (!isRecord(value)) return null
  if (value.codec === 'json') return { codec: 'json', body: value.body }
  if (value.codec === 'text' && typeof value.body === 'string') return { codec: 'text', body: value.body }
  if (value.codec === 'sealed' && typeof value.alg === 'string' && typeof value.nonce === 'string' && typeof value.body === 'string') {
    return { codec: 'sealed', alg: value.alg, nonce: value.nonce, body: value.body }
  }
  return null
}

function resumeStates(value: unknown): ChannelResumeState[] | null {
  if (!Array.isArray(value)) return null
  const states = value.map(resumeState)
  if (!states.every(state => state !== null)) return null
  return uniqueIds(states as ChannelResumeState[]) ? (states as ChannelResumeState[]) : null
}

function resumeState(value: unknown): ChannelResumeState | null {
  if (!isRecord(value) || !isSafeIdentifier(value.id) || !isChannelKind(value.kind) || !isToken(value.attachToken)) return null
  if (!isSeq(value.sentSeq) || !isSeq(value.receivedSeq)) return null
  return { id: value.id, kind: value.kind, attachToken: value.attachToken, sentSeq: value.sentSeq, receivedSeq: value.receivedSeq }
}

function resumeResults(value: unknown): ChannelResumeResult[] | null {
  if (!Array.isArray(value)) return null
  const results = value.map(resumeResult)
  if (!results.every(result => result !== null)) return null
  return uniqueIds(results as ChannelResumeResult[]) ? (results as ChannelResumeResult[]) : null
}

// Duplicate ids in a roster are contradictory by construction (resumed-then-expired
// for the same channel would replay and then delete it) and are rejected outright.
function uniqueIds(entries: { id: string }[]): boolean {
  return new Set(entries.map(entry => entry.id)).size === entries.length
}

function resumeResult(value: unknown): ChannelResumeResult | null {
  if (!isRecord(value) || !isSafeIdentifier(value.id)) return null
  if (value.status === 'resumed' && isSeq(value.receivedSeq)) return { id: value.id, status: 'resumed', receivedSeq: value.receivedSeq }
  if (value.status === 'expired') return { id: value.id, status: 'expired' }
  return null
}

function isRunnerInfo(value: unknown): value is { name: string; version: string; os: string; arch: string } {
  if (!isRecord(value)) return false
  return [value.name, value.version, value.os, value.arch].every(field => typeof field === 'string' && field.length <= 200)
}

// Bounded so one authenticated welcome cannot dictate a busy-loop ping rate, and so
// no value overflows Node's 32-bit timer range (which coerces the delay to 1 ms).
// The timeout must leave margin past the interval: a timeout equal to the interval
// dies to ordinary timer jitter before the first ping can even be answered.
const MIN_HEARTBEAT_INTERVAL_MS = 200
const MAX_TIMER_MS = 2_147_483_647

function isHeartbeat(value: unknown): value is { intervalMs: number; timeoutMs: number } {
  if (!isRecord(value) || !isPositiveInt(value.intervalMs) || !isPositiveInt(value.timeoutMs)) return false
  return value.intervalMs >= MIN_HEARTBEAT_INTERVAL_MS && value.intervalMs <= MAX_TIMER_MS
    && value.timeoutMs >= 2 * value.intervalMs && value.timeoutMs <= MAX_TIMER_MS
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 16 && value.length <= 512
}

// Resume counters start at zero (nothing received yet); data and reset sequences
// start at one.
function isSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isDataSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

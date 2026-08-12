import type { VersionRange } from './version.js'

export const CHANNEL_KINDS = ['terminal', 'coms', 'forge-event', 'job-control'] as const
export type ChannelKind = (typeof CHANNEL_KINDS)[number]

// Payloads separate content from routing so the relay never needs to read them.
// `sealed` is reserved for end-to-end encryption: opaque to the relay from v1.
export type Payload =
  | { codec: 'json'; body: unknown }
  | { codec: 'text'; body: string }
  | { codec: 'sealed'; alg: string; nonce: string; body: string }

export type RunnerInfo = { name: string; version: string; os: string; arch: string }
export type HeartbeatPolicy = { intervalMs: number; timeoutMs: number }

export type ChannelResumeState = {
  id: string
  kind: ChannelKind
  attachToken: string
  sentSeq: number
  receivedSeq: number
}

export type ChannelResumeResult =
  | { id: string; status: 'resumed'; receivedSeq: number }
  | { id: string; status: 'expired' }

// Capabilities deliberately do NOT ride here. `hello` shares one 1 MiB frame with a resume
// roster bounded at 1024 channels precisely so the hello always fits, and an oversized hello
// is terminal for the connection — a runner with a large model library would become unable
// to handshake at all. Capability state rides the job-control channel instead, where it is
// budgeted correctly, refreshable, and sealable when end-to-end encryption ships. OS and
// architecture stay here, on `runner`, and the capability shape does not restate them.
export type HelloFrame = { type: 'hello'; protocol: VersionRange; runner: RunnerInfo; channels: ChannelResumeState[] }
export type WelcomeFrame = { type: 'welcome'; protocol: number; heartbeat: HeartbeatPolicy; channels: ChannelResumeResult[] }
export type RejectFrame = { type: 'reject'; reason: string; supported: number[] }
export type PingFrame = { type: 'ping'; id: string }
export type PongFrame = { type: 'pong'; id: string }
export type OpenFrame = { type: 'open'; channel: string; kind: ChannelKind; attachToken: string }
export type DataFrame = { type: 'data'; channel: string; seq: number; payload: Payload }
export type ResetFrame = { type: 'reset'; channel: string; seq: number }
export type CloseFrame = { type: 'close'; channel: string; reason?: string }
export type ErrorFrame = { type: 'error'; message: string; channel?: string }

export type Frame =
  | HelloFrame
  | WelcomeFrame
  | RejectFrame
  | PingFrame
  | PongFrame
  | OpenFrame
  | DataFrame
  | ResetFrame
  | CloseFrame
  | ErrorFrame

// Identifiers may reach a filesystem on the runner (worktree names, session-scoped
// paths), so the wire enforces the same safe-segment rule the runner applies locally.
export function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && value !== '.' && value !== '..'
}

export function isChannelKind(value: unknown): value is ChannelKind {
  return typeof value === 'string' && (CHANNEL_KINDS as readonly string[]).includes(value)
}

// Control characters are rejected at the wire, not at the process boundary. A NUL in a
// command or path reaches spawn as a synchronous throw rather than a refusal value, and
// CR and LF are header-injection shapes; none of them are anything a real command line,
// model name or version string contains, so the protocol has no reason to carry them.
export function hasControlCharacter(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

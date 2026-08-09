import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { validateHeaderValue } from 'node:http'
import WebSocket from 'ws'
import {
  MAX_FRAME_BYTES,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  isValidRange,
  type ChannelKind,
  type ChannelResumeResult,
  type Frame,
  type HeartbeatPolicy,
  type Payload,
  type RunnerInfo,
  type VersionRange,
  type WelcomeFrame,
} from '@modulastack/runner-protocol'
import { backoffDelay, type BackoffOptions } from './backoff.js'
import { ChannelStore } from './channels.js'
import { assertSecureUrl } from './secureUrl.js'

const DEFAULT_HIGH_WATER_BYTES = 4 * 1024 * 1024
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000
const FLUSH_INTERVAL_MS = 20

export type RunnerClientOptions = {
  url: string
  token: string
  runner: RunnerInfo
  protocol?: VersionRange
  backoff?: BackoffOptions
  bufferBytes?: number
  highWaterBytes?: number
  handshakeTimeoutMs?: number
}

export type ChannelHandle = {
  id: string
  kind: ChannelKind
  send: (payload: Payload) => void
  close: (reason?: string) => void
}

type Phase = 'idle' | 'running' | 'stopped' | 'failed'
type ClosingEntry = { reason?: string; sent: boolean }

export class RunnerClient extends EventEmitter {
  private readonly options: RunnerClientOptions
  private readonly store: ChannelStore
  private readonly closing = new Map<string, ClosingEntry>()
  private presented = new Set<string>()
  private ws?: WebSocket
  private phase: Phase = 'idle'
  private connected = false
  private attempt = 0
  private pendingBackoffReset = false
  private lastSeen = 0
  private heartbeatTimer: NodeJS.Timeout | undefined
  private reconnectTimer: NodeJS.Timeout | undefined
  private handshakeTimer: NodeJS.Timeout | undefined
  private flushTimer: NodeJS.Timeout | undefined

  constructor(options: RunnerClientOptions) {
    super()
    assertSecureUrl(options.url)
    assertImplementedRange(options.protocol)
    assertRunnerInfo(options.runner)
    assertHeaderSafeToken(options.token)
    // A private snapshot: later mutation of the caller's object must not smuggle a
    // different URL or protocol range past the checks that just ran.
    this.options = {
      ...options,
      runner: { ...options.runner },
      ...(options.protocol ? { protocol: { ...options.protocol } } : {}),
      ...(options.backoff ? { backoff: { ...options.backoff } } : {}),
    }
    this.store = new ChannelStore(options.bufferBytes)
  }

  connect() {
    if (this.phase !== 'idle') throw new Error(`client already ${this.phase}`)
    this.phase = 'running'
    this.dial()
  }

  stop() {
    this.phase = 'stopped'
    this.connected = false
    this.clearTimers()
    this.ws?.close()
    this.emit('stopped')
  }

  isConnected() {
    return this.connected
  }

  channelIds() {
    return this.store.ids()
  }

  openChannel(kind: ChannelKind): ChannelHandle {
    const state = this.store.open(kind)
    if (this.connected) this.sendRaw({ type: 'open', channel: state.id, kind, attachToken: state.attachToken })
    return {
      id: state.id,
      kind,
      send: payload => {
        if (this.closing.has(state.id)) throw new Error(`channel closing: ${state.id}`)
        this.store.record(state.id, payload)
        this.pump(state.id)
      },
      close: reason => this.closeChannel(state.id, reason),
    }
  }

  // Close is drain-then-close: the channel stays in the store (and in resume
  // snapshots) until its buffered frames and the close frame are actually written,
  // so neither a disconnect nor backpressure can orphan it or drop its tail.
  private closeChannel(id: string, reason?: string) {
    if (!this.store.get(id) || this.closing.has(id)) return
    this.closing.set(id, { sent: false, ...(reason === undefined ? {} : { reason }) })
    if (this.connected) this.finishClose(id)
  }

  private finishClose(id: string) {
    const entry = this.closing.get(id)
    if (!entry || entry.sent || !this.connected) return
    const state = this.store.get(id)
    if (!state) {
      this.closing.delete(id)
      return
    }
    this.pump(id)
    if (state.flushedSeq === state.sentSeq) this.sendClose(id, entry)
    else this.scheduleFlush()
  }

  private sendClose(id: string, entry: ClosingEntry) {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    entry.sent = true
    const frame: Frame = { type: 'close', channel: id, ...(entry.reason === undefined ? {} : { reason: entry.reason }) }
    this.ws.send(encodeFrame(frame), error => {
      if (error) {
        entry.sent = false
        return
      }
      this.store.drop(id)
      this.closing.delete(id)
    })
  }

  private dial() {
    const ws = new WebSocket(this.options.url, {
      headers: { authorization: `Bearer ${this.options.token}` },
      maxPayload: MAX_FRAME_BYTES,
      handshakeTimeout: this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    })
    this.ws = ws
    ws.on('open', () => this.startHandshake())
    ws.on('message', raw => this.handleRaw(String(raw)))
    ws.on('unexpected-response', (_request, response) => this.handleUpgradeFailure(response.statusCode))
    ws.on('error', () => undefined)
    ws.on('close', () => this.handleClose())
  }

  private startHandshake() {
    const protocol = this.options.protocol ?? { min: MIN_PROTOCOL_VERSION, max: PROTOCOL_VERSION }
    this.presented = new Set(this.store.ids())
    this.sendRaw({ type: 'hello', protocol, runner: this.options.runner, channels: this.store.resumeStates() })
    const timeoutMs = this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
    this.handshakeTimer = setTimeout(() => this.ws?.terminate(), timeoutMs)
  }

  private handleUpgradeFailure(statusCode?: number) {
    if (statusCode === 401 || statusCode === 403) {
      this.fail('auth-failed', { statusCode })
      return
    }
    this.ws?.terminate()
  }

  private handleClose() {
    if (this.phase !== 'running') return
    this.clearTimers()
    for (const entry of this.closing.values()) entry.sent = false
    if (this.connected) {
      this.connected = false
      this.emit('offline')
    }
    // An offline listener may have called stop() synchronously just above.
    if (this.phase === 'running') this.scheduleReconnect()
  }

  private scheduleReconnect() {
    const delayMs = backoffDelay(this.attempt++, this.options.backoff)
    this.emit('reconnecting', { attempt: this.attempt, delayMs })
    // A reconnecting listener may have stopped the client during the emit.
    if (this.phase !== 'running') return
    this.reconnectTimer = setTimeout(() => {
      if (this.phase === 'running') this.dial()
    }, delayMs)
  }

  private handleRaw(raw: string) {
    const frame = decodeFrame(raw)
    if (!frame) {
      // Garbage is not liveness: only valid protocol traffic refreshes the deadline,
      // or malformed spam could keep a dead session looking healthy forever.
      this.emit('protocol-error', { message: 'undecodable frame' })
      return
    }
    this.lastSeen = Date.now()
    this.handleFrame(frame)
  }

  private handleFrame(frame: Frame) {
    // Establishment frames are valid only while negotiation is pending, and nothing
    // else exists before it completes: a peer must not connect a failed client with
    // a late welcome, nor inject session frames on an unnegotiated connection.
    if (frame.type === 'welcome' || frame.type === 'reject') {
      if (this.phase !== 'running' || this.connected) {
        this.emit('protocol-error', { message: 'establishment frame outside negotiation', frame: frame.type })
        return
      }
      if (frame.type === 'welcome') return this.handleWelcome(frame)
      return this.fail('rejected', { reason: frame.reason, supported: frame.supported })
    }
    if (!this.connected) {
      this.emit('protocol-error', { message: 'frame before welcome', frame: frame.type })
      return
    }
    if (frame.type === 'ping') return this.sendRaw({ type: 'pong', id: frame.id })
    if (frame.type === 'data') return this.handleData(frame.channel, frame.seq, frame.payload)
    if (frame.type === 'reset') return this.handleReset(frame.channel, frame.seq)
    if (frame.type === 'close') return this.handleChannelClose(frame.channel, frame.reason)
    if (frame.type === 'error') this.emit('protocol-error', { message: frame.message, channel: frame.channel })
  }

  private handleWelcome(frame: WelcomeFrame) {
    this.clearHandshakeTimer()
    const offered = this.options.protocol ?? { min: MIN_PROTOCOL_VERSION, max: PROTOCOL_VERSION }
    if (frame.protocol < offered.min || frame.protocol > offered.max) {
      this.fail('protocol-error', { message: 'welcome selected an unsupported protocol version', protocol: frame.protocol })
      return
    }
    // Backoff resets only after the connection survives a heartbeat interval: a
    // welcome-then-drop control plane must not keep a fleet churning at base delay.
    this.pendingBackoffReset = true
    this.connected = true
    this.startHeartbeat(frame.heartbeat)
    this.reconcileChannels(frame.channels)
    // Reconciliation runs user listeners synchronously; one may have stopped the client.
    if (this.phase !== 'running' || !this.connected) return
    this.emit('connected', { protocol: frame.protocol })
  }

  // The welcome is reconciled against the exact hello snapshot: results for channels
  // never presented are misbehavior to surface, presented channels the welcome omits
  // are re-announced from sequence zero (never trusted to a stale flush position),
  // and channels created mid-handshake are announced now.
  private reconcileChannels(results: ChannelResumeResult[]) {
    // The mid-handshake announce set is snapshotted before any listener can run: a
    // channel opened from a synchronous event handler below announces itself once,
    // and must not be announced a second time by this loop.
    const announceIds = this.store.ids().filter(id => !this.presented.has(id))
    const unanswered = new Set(this.presented)
    for (const result of results) {
      if (!this.presented.has(result.id)) {
        this.emit('protocol-error', { message: 'resume result for unknown channel', channel: result.id })
        continue
      }
      unanswered.delete(result.id)
      this.resumeChannel(result)
    }
    for (const id of unanswered) this.reannounce(id)
    for (const id of announceIds) this.announceChannel(id)
    for (const id of [...this.closing.keys()]) this.finishClose(id)
  }

  private resumeChannel(result: ChannelResumeResult) {
    const state = this.store.get(result.id)
    if (!state) return
    if (result.status === 'expired') {
      this.store.drop(result.id)
      if (!this.closing.delete(result.id)) this.emit('channel-expired', { channel: result.id })
      return
    }
    // A peer cannot have received more than was sent. Its claim is discarded — and
    // so is the stale local watermark: replaying the whole retained buffer is the
    // only position that cannot silently lose the frames a dying socket never
    // delivered, and the receiver's contiguity rule discards the duplicates.
    if (result.receivedSeq > state.sentSeq) {
      this.emit('protocol-error', { message: 'resume beyond sent sequence', channel: result.id })
      state.flushedSeq = 0
    } else {
      state.flushedSeq = result.receivedSeq
    }
    const outcome = this.pump(result.id)
    if (!this.closing.has(result.id)) this.emit('channel-resumed', { channel: result.id, replayed: outcome.sent, reset: outcome.reset })
  }

  private reannounce(id: string) {
    const state = this.store.get(id)
    if (!state) return
    this.emit('protocol-error', { message: 'welcome omitted a presented channel', channel: id })
    // The replacement open starts both directions over: the control plane's fresh
    // stream begins at sequence one, which a stale inbound watermark would swallow.
    state.flushedSeq = 0
    state.receivedSeq = 0
    this.announceChannel(id)
  }

  private announceChannel(id: string) {
    const state = this.store.get(id)
    if (!state) return
    this.sendRaw({ type: 'open', channel: id, kind: state.kind, attachToken: state.attachToken })
    this.pump(id)
  }

  // All data transmission funnels through here: frames flow only while the socket
  // buffer is under the high-water mark, and everything else waits in the replay
  // buffer — backpressure never breaks sequence continuity, it only delays it.
  private pump(id: string): { sent: number; reset: boolean } {
    const outcome = { sent: 0, reset: false }
    const state = this.store.get(id)
    if (!state) return outcome
    while (this.connected && state.flushedSeq < state.sentSeq) {
      if ((this.ws?.bufferedAmount ?? 0) > (this.options.highWaterBytes ?? DEFAULT_HIGH_WATER_BYTES)) {
        this.scheduleFlush()
        break
      }
      const next = this.store.nextOutbound(id, state.flushedSeq)
      if (next.reset) {
        this.sendRaw(next.reset)
        state.flushedSeq = next.reset.seq - 1
        outcome.reset = true
        continue
      }
      if (!next.frame) break
      this.sendRaw(next.frame)
      state.flushedSeq = next.frame.seq
      outcome.sent++
    }
    return outcome
  }

  private scheduleFlush() {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      for (const id of this.store.ids()) {
        this.pump(id)
        if (this.closing.has(id)) this.finishClose(id)
      }
    }, FLUSH_INTERVAL_MS)
  }

  private handleData(channel: string, seq: number, payload: Payload) {
    if (!this.store.get(channel)) return
    const result = this.store.receive({ type: 'data', channel, seq, payload })
    if (result.status === 'accepted') this.emit('data', { channel, seq, payload: result.payload })
    else if (result.status === 'gap') this.emit('protocol-error', { message: 'sequence gap', channel, seq })
  }

  private handleReset(channel: string, seq: number) {
    if (!this.store.get(channel)) return
    if (this.store.receiveReset(channel, seq)) this.emit('channel-reset', { channel, seq })
    else this.emit('protocol-error', { message: 'reset would rewind the stream', channel, seq })
  }

  private handleChannelClose(channel: string, reason?: string) {
    this.store.drop(channel)
    this.closing.delete(channel)
    this.emit('channel-closed', { channel, ...(reason ? { reason } : {}) })
  }

  private startHeartbeat(policy: HeartbeatPolicy) {
    this.lastSeen = Date.now()
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => this.heartbeatTick(policy), policy.intervalMs)
  }

  private heartbeatTick(policy: HeartbeatPolicy) {
    if (Date.now() - this.lastSeen > policy.timeoutMs) {
      this.ws?.terminate()
      return
    }
    if (this.pendingBackoffReset) {
      this.attempt = 0
      this.pendingBackoffReset = false
    }
    this.sendRaw({ type: 'ping', id: randomUUID() })
  }

  private fail(event: string, detail: unknown) {
    this.phase = 'failed'
    this.connected = false
    this.clearTimers()
    this.emit(event, detail)
    this.ws?.close()
  }

  private sendRaw(frame: Frame) {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    const encoded = encodeFrame(frame)
    if (Buffer.byteLength(encoded, 'utf8') > MAX_FRAME_BYTES) {
      // An oversized hello can never handshake — retrying would loop forever.
      if (frame.type === 'hello') return this.fail('protocol-error', { message: 'outbound hello exceeds MAX_FRAME_BYTES' })
      this.emit('protocol-error', { message: 'outbound frame exceeds MAX_FRAME_BYTES', frame: frame.type })
      return
    }
    this.ws.send(encoded)
  }

  private clearHandshakeTimer() {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    this.handshakeTimer = undefined
  }

  private clearTimers() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.heartbeatTimer = undefined
    this.reconnectTimer = undefined
    this.flushTimer = undefined
    this.clearHandshakeTimer()
  }
}

// A token with header-unsafe characters (a pasted trailing newline is the classic)
// would otherwise throw synchronously mid-dial, after the phase already advanced.
function assertHeaderSafeToken(token: string) {
  try {
    validateHeaderValue('authorization', `Bearer ${token}`)
  } catch {
    throw new Error('token contains characters that are not valid in an HTTP header')
  }
}

// Mirrors the codec's bound so a misconfigured runner fails at construction instead
// of emitting hellos every compliant decoder drops.
function assertRunnerInfo(runner: RunnerInfo) {
  const fields = [runner.name, runner.version, runner.os, runner.arch]
  if (!fields.every(field => typeof field === 'string' && field.length <= 200)) {
    throw new Error('runner metadata fields must be strings of at most 200 characters')
  }
}

// A configured range wider than this build actually implements would let the client
// negotiate a version whose codec and semantics it does not have.
function assertImplementedRange(range: VersionRange | undefined) {
  if (!range) return
  if (!isValidRange(range) || range.min < MIN_PROTOCOL_VERSION || range.max > PROTOCOL_VERSION) {
    throw new Error(`protocol range outside implemented versions ${MIN_PROTOCOL_VERSION}..${PROTOCOL_VERSION}`)
  }
}

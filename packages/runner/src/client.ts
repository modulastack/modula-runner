import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import {
  MAX_FRAME_BYTES,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
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

export class RunnerClient extends EventEmitter {
  private readonly options: RunnerClientOptions
  private readonly store: ChannelStore
  private readonly pendingCloses = new Map<string, string | undefined>()
  private ws?: WebSocket
  private phase: Phase = 'idle'
  private connected = false
  private attempt = 0
  private lastSeen = 0
  private heartbeatTimer: NodeJS.Timeout | undefined
  private reconnectTimer: NodeJS.Timeout | undefined
  private handshakeTimer: NodeJS.Timeout | undefined
  private flushTimer: NodeJS.Timeout | undefined

  constructor(options: RunnerClientOptions) {
    super()
    assertSecureUrl(options.url)
    this.options = options
    this.store = new ChannelStore(options.bufferBytes)
  }

  connect() {
    if (this.phase !== 'idle') throw new Error(`client already ${this.phase}`)
    this.phase = 'running'
    this.dial()
  }

  stop() {
    this.phase = 'stopped'
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
        this.store.record(state.id, payload)
        this.pump(state.id)
      },
      close: reason => this.closeChannel(state.id, reason),
    }
  }

  // A close while offline leaves a tombstone: dropping silently would orphan the
  // channel on the control plane, since the next hello no longer presents it.
  private closeChannel(id: string, reason?: string) {
    this.store.drop(id)
    if (this.connected) this.sendRaw({ type: 'close', channel: id, ...(reason ? { reason } : {}) })
    else this.pendingCloses.set(id, reason)
  }

  private dial() {
    const ws = new WebSocket(this.options.url, {
      headers: { authorization: `Bearer ${this.options.token}` },
      maxPayload: MAX_FRAME_BYTES,
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
    if (this.connected) {
      this.connected = false
      this.emit('offline')
    }
    this.scheduleReconnect()
  }

  private scheduleReconnect() {
    const delayMs = backoffDelay(this.attempt++, this.options.backoff)
    this.emit('reconnecting', { attempt: this.attempt, delayMs })
    this.reconnectTimer = setTimeout(() => this.dial(), delayMs)
  }

  private handleRaw(raw: string) {
    const frame = decodeFrame(raw)
    this.lastSeen = Date.now()
    if (!frame) {
      this.emit('protocol-error', { message: 'undecodable frame' })
      return
    }
    this.handleFrame(frame)
  }

  private handleFrame(frame: Frame) {
    if (frame.type === 'welcome') return this.handleWelcome(frame)
    if (frame.type === 'reject') return this.fail('rejected', { reason: frame.reason, supported: frame.supported })
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
    this.attempt = 0
    this.connected = true
    this.startHeartbeat(frame.heartbeat)
    const unresumed = new Set(this.store.ids())
    for (const result of frame.channels) this.resumeChannel(result, unresumed)
    for (const id of unresumed) this.announceChannel(id)
    for (const [id, reason] of this.pendingCloses) {
      this.sendRaw({ type: 'close', channel: id, ...(reason ? { reason } : {}) })
      this.pendingCloses.delete(id)
    }
    this.emit('connected', { protocol: frame.protocol })
  }

  // A resume result for a channel this runner never presented is control-plane
  // misbehavior; it must be surfaced and skipped, never allowed to throw.
  private resumeChannel(result: ChannelResumeResult, unresumed: Set<string>) {
    const state = this.store.get(result.id)
    if (!state) {
      this.emit('protocol-error', { message: 'resume result for unknown channel', channel: result.id })
      return
    }
    unresumed.delete(result.id)
    if (result.status === 'expired') {
      this.store.drop(result.id)
      this.emit('channel-expired', { channel: result.id })
      return
    }
    state.flushedSeq = Math.min(result.receivedSeq, state.sentSeq)
    const outcome = this.pump(result.id)
    this.emit('channel-resumed', { channel: result.id, replayed: outcome.sent, reset: outcome.reset })
  }

  // A channel opened between hello and welcome was in neither the resume snapshot
  // nor the results; it is announced now so its frames have a registered target.
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
      for (const id of this.store.ids()) this.pump(id)
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
    this.store.receiveReset(channel, seq)
    this.emit('channel-reset', { channel, seq })
  }

  private handleChannelClose(channel: string, reason?: string) {
    this.store.drop(channel)
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
    this.sendRaw({ type: 'ping', id: randomUUID() })
  }

  private fail(event: string, detail: unknown) {
    this.phase = 'failed'
    this.clearTimers()
    this.emit(event, detail)
    this.ws?.close()
  }

  private sendRaw(frame: Frame) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeFrame(frame))
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

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

// No override exists on purpose: the bearer token rides the upgrade request, so
// plaintext toward anything but loopback would expose the connection credential.
function assertSecureUrl(url: string) {
  const parsed = new URL(url)
  if (parsed.protocol === 'wss:') return
  if (parsed.protocol !== 'ws:') throw new Error(`unsupported URL scheme: ${parsed.protocol}`)
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) throw new Error('plaintext ws:// is only allowed toward loopback')
}

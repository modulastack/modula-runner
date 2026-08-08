import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import {
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

export type RunnerClientOptions = {
  url: string
  token: string
  runner: RunnerInfo
  protocol?: VersionRange
  backoff?: BackoffOptions
  bufferBytes?: number
  allowInsecure?: boolean
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
  private ws?: WebSocket
  private phase: Phase = 'idle'
  private connected = false
  private attempt = 0
  private lastSeen = 0
  private heartbeatTimer: NodeJS.Timeout | undefined
  private reconnectTimer: NodeJS.Timeout | undefined

  constructor(options: RunnerClientOptions) {
    super()
    assertSecureUrl(options.url, options.allowInsecure ?? false)
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
    this.sendFrame({ type: 'open', channel: state.id, kind, attachToken: state.attachToken })
    return {
      id: state.id,
      kind,
      send: payload => this.sendFrame(this.store.record(state.id, payload)),
      close: reason => {
        this.store.drop(state.id)
        this.sendFrame({ type: 'close', channel: state.id, ...(reason ? { reason } : {}) })
      },
    }
  }

  private dial() {
    const ws = new WebSocket(this.options.url, { headers: { authorization: `Bearer ${this.options.token}` } })
    this.ws = ws
    ws.on('open', () => this.sendHello())
    ws.on('message', raw => this.handleRaw(String(raw)))
    ws.on('unexpected-response', (_request, response) => this.handleUpgradeFailure(response.statusCode))
    ws.on('error', () => undefined)
    ws.on('close', () => this.handleClose())
  }

  private sendHello() {
    const protocol = this.options.protocol ?? { min: MIN_PROTOCOL_VERSION, max: PROTOCOL_VERSION }
    this.sendRaw({ type: 'hello', protocol, runner: this.options.runner, channels: this.store.resumeStates() })
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
    this.attempt = 0
    this.connected = true
    this.startHeartbeat(frame.heartbeat)
    for (const result of frame.channels) this.resumeChannel(result)
    this.emit('connected', { protocol: frame.protocol })
  }

  private resumeChannel(result: ChannelResumeResult) {
    if (result.status === 'expired') {
      this.store.drop(result.id)
      this.emit('channel-expired', { channel: result.id })
      return
    }
    const replay = this.store.replayAfter(result.id, result.receivedSeq)
    if (replay.reset) this.sendRaw(replay.reset)
    for (const dataFrame of replay.frames) this.sendRaw(dataFrame)
    this.emit('channel-resumed', { channel: result.id, replayed: replay.frames.length, reset: Boolean(replay.reset) })
  }

  private handleData(channel: string, seq: number, payload: Payload) {
    if (!this.store.get(channel)) return
    const fresh = this.store.receive({ type: 'data', channel, seq, payload })
    if (fresh) this.emit('data', { channel, seq, payload: fresh })
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

  private sendFrame(frame: Frame) {
    if (this.connected) this.sendRaw(frame)
  }

  private sendRaw(frame: Frame) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeFrame(frame))
  }

  private clearTimers() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.heartbeatTimer = undefined
    this.reconnectTimer = undefined
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function assertSecureUrl(url: string, allowInsecure: boolean) {
  const parsed = new URL(url)
  if (parsed.protocol === 'wss:') return
  if (parsed.protocol !== 'ws:') throw new Error(`unsupported URL scheme: ${parsed.protocol}`)
  if (!LOOPBACK_HOSTS.has(parsed.hostname) && !allowInsecure) {
    throw new Error('plaintext ws:// is only allowed toward loopback')
  }
}

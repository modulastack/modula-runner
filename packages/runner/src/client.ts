import { EventEmitter } from 'node:events'
import { validateHeaderValue } from 'node:http'
import {
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  decodeFrame,
  isValidRange,
  type ChannelKind,
  type Frame,
  type Payload,
  type RunnerInfo,
  type VersionRange,
  type WelcomeFrame,
} from '@modulastack/runner-protocol'
import { backoffDelay, type BackoffOptions } from './backoff.js'
import { ChannelStore } from './channels.js'
import { Heartbeat } from './liveness.js'
import { ChannelReconciler } from './reconciliation.js'
import { Transport } from './transport.js'
import { assertSecureUrl } from './secureUrl.js'

const DEFAULT_HIGH_WATER_BYTES = 4 * 1024 * 1024
// Node's 32-bit setTimeout ceiling: anything above coerces to 1 ms.
const MAX_TIMER_MS = 2_147_483_647

export type RunnerClientOptions = {
  url: string
  token: string
  runner: RunnerInfo
  protocol?: VersionRange
  backoff?: BackoffOptions
  bufferBytes?: number
  totalBufferBytes?: number
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
  private readonly transport: Transport
  private readonly heartbeat: Heartbeat
  private readonly reconciler: ChannelReconciler
  private phase: Phase = 'idle'
  private connected = false
  private pendingBackoffReset = false

  constructor(options: RunnerClientOptions) {
    super()
    // Canonicalized to primitives before validation: an object with a shifting
    // toString must not pass the checks as one URL and dial as another.
    const url = String(options.url)
    const token = String(options.token)
    assertSecureUrl(url)
    assertImplementedRange(options.protocol)
    assertRunnerInfo(options.runner)
    assertHeaderSafeToken(token)
    // Numeric options fail here, not at the moment a reconnect or flush needs them.
    if (options.backoff) backoffDelay(0, options.backoff)
    assertBoundedInt('highWaterBytes', options.highWaterBytes, 0)
    assertBoundedInt('handshakeTimeoutMs', options.handshakeTimeoutMs, 1, MAX_TIMER_MS)
    // A private snapshot: later mutation of the caller's object must not smuggle a
    // different URL or protocol range past the checks that just ran.
    this.options = {
      ...options,
      url,
      token,
      runner: { ...options.runner },
      ...(options.protocol ? { protocol: { ...options.protocol } } : {}),
      ...(options.backoff ? { backoff: { ...options.backoff } } : {}),
    }
    this.store = new ChannelStore(options.bufferBytes, options.totalBufferBytes)
    this.transport = new Transport(this.options, {
      active: () => this.phase === 'running',
      onOpen: () => this.startHandshake(),
      onMessage: raw => this.handleRaw(raw),
      onClosed: () => this.handleClose(),
      onUpgradeFailed: statusCode => this.handleUpgradeFailure(statusCode),
      onReconnecting: detail => this.emit('reconnecting', detail),
    })
    this.heartbeat = new Heartbeat({
      onExpired: () => this.transport.terminate(),
      // Backoff resets only after the connection survives a heartbeat interval: a
      // welcome-then-drop control plane must not keep a fleet churning at base delay.
      onHealthyInterval: () => {
        if (!this.pendingBackoffReset) return
        this.transport.resetBackoff()
        this.pendingBackoffReset = false
      },
      canSend: () => this.transport.bufferedBytes() <= this.highWaterBytes(),
      send: id => this.sendRaw({ type: 'ping', id }),
    })
    this.reconciler = new ChannelReconciler({
      store: this.store,
      transport: this.transport,
      isConnected: () => this.connected,
      highWaterBytes: () => this.highWaterBytes(),
      sendFrame: frame => this.sendRaw(frame),
      onOutboundReset: channel => this.emit('channel-outbound-reset', { channel }),
    })
  }

  connect() {
    if (this.phase !== 'idle') throw new Error(`client already ${this.phase}`)
    this.phase = 'running'
    this.transport.dial()
  }

  stop() {
    this.phase = 'stopped'
    this.connected = false
    this.clearTimers()
    this.transport.close()
    this.emit('stopped')
  }

  isConnected() {
    return this.connected
  }

  channelIds() {
    return this.store.ids()
  }

  openChannel(kind: ChannelKind): ChannelHandle {
    this.assertUsable()
    const state = this.store.open(kind)
    if (this.connected) this.sendRaw({ type: 'open', channel: state.id, kind, attachToken: state.attachToken })
    return {
      id: state.id,
      kind,
      send: payload => {
        this.assertUsable()
        if (this.reconciler.isClosing(state.id)) throw new Error(`channel closing: ${state.id}`)
        this.store.record(state.id, payload)
        this.reconciler.pump(state.id)
      },
      close: reason => this.reconciler.close(state.id, reason),
    }
  }

  // A terminal client has no reconnect path: accepting a payload it can never
  // deliver would report success for data that stays buffered forever.
  private assertUsable() {
    if (this.phase === 'stopped' || this.phase === 'failed') throw new Error(`client is ${this.phase}`)
  }

  private startHandshake() {
    const protocol = this.options.protocol ?? { min: MIN_PROTOCOL_VERSION, max: PROTOCOL_VERSION }
    const states = this.reconciler.snapshotForHello()
    this.sendRaw({ type: 'hello', protocol, runner: this.options.runner, channels: states })
    this.transport.startHandshakeTimer()
  }

  private handleUpgradeFailure(statusCode?: number) {
    if (statusCode === 401 || statusCode === 403) {
      this.fail('auth-failed', { statusCode })
      return
    }
    this.transport.terminate()
  }

  private handleClose() {
    if (this.phase !== 'running') return
    this.clearTimers()
    this.reconciler.markClosesUnsent()
    if (this.connected) {
      this.connected = false
      this.emit('offline')
    }
    // An offline listener may have called stop() synchronously just above.
    if (this.phase === 'running') this.transport.scheduleReconnect()
  }

  private handleRaw(raw: string) {
    const frame = decodeFrame(raw)
    if (!frame) {
      // Garbage is not liveness: only valid protocol traffic refreshes the deadline,
      // or malformed spam could keep a dead session looking healthy forever.
      this.emit('protocol-error', { message: 'undecodable frame' })
      return
    }
    // The same rule for state-invalid frames: a stream of late welcomes must not
    // hold a dead session open, so only accepted frames count as liveness.
    if (this.handleFrame(frame)) this.heartbeat.sawTraffic()
  }

  private handleFrame(frame: Frame): boolean {
    // Establishment frames are valid only while negotiation is pending, and nothing
    // else exists before it completes: a peer must not connect a failed client with
    // a late welcome, nor inject session frames on an unnegotiated connection.
    if (frame.type === 'welcome' || frame.type === 'reject') {
      if (this.phase !== 'running' || this.connected) {
        this.emit('protocol-error', { message: 'establishment frame outside negotiation', frame: frame.type })
        return false
      }
      if (frame.type === 'welcome') this.handleWelcome(frame)
      else this.fail('rejected', { reason: frame.reason, supported: frame.supported })
      return true
    }
    if (!this.connected) {
      this.emit('protocol-error', { message: 'frame before welcome', frame: frame.type })
      return false
    }
    // hello and open only travel runner → control plane in version 1.
    if (frame.type === 'hello' || frame.type === 'open') {
      this.emit('protocol-error', { message: 'direction-invalid frame', frame: frame.type })
      return false
    }
    if (frame.type === 'ping') {
      // Pong replies respect backpressure too: a peer that pings without reading
      // must not grow the outbound queue without bound.
      if (this.transport.bufferedBytes() <= this.highWaterBytes()) {
        this.sendRaw({ type: 'pong', id: frame.id })
      }
    }
    else if (frame.type === 'pong') {
      // Only a pong answering one of this connection's own pings proves liveness;
      // fabricated or stale pongs must not hold a dead session open.
      if (!this.heartbeat.matchPong(frame.id)) return false
    }
    else if (frame.type === 'data') return this.handleData(frame.channel, frame.seq, frame.payload)
    else if (frame.type === 'reset') return this.handleReset(frame.channel, frame.seq)
    else if (frame.type === 'close') return this.handleChannelClose(frame.channel, frame.reason)
    else if (frame.type === 'error') this.emit('protocol-error', { message: frame.message, channel: frame.channel })
    return true
  }

  private handleWelcome(frame: WelcomeFrame) {
    this.transport.clearHandshakeTimer()
    const offered = this.options.protocol ?? { min: MIN_PROTOCOL_VERSION, max: PROTOCOL_VERSION }
    if (frame.protocol < offered.min || frame.protocol > offered.max) {
      this.fail('protocol-error', { message: 'welcome selected an unsupported protocol version', protocol: frame.protocol })
      return
    }
    this.pendingBackoffReset = true
    this.connected = true
    this.heartbeat.start(frame.heartbeat)
    for (const event of this.reconciler.reconcile(frame.channels)) this.emit(event.name, event.detail)
    // Reconciliation runs user listeners synchronously; one may have stopped the client.
    if (this.phase !== 'running' || !this.connected) return
    // The negotiated heartbeat travels with the event: it is the window inside which a
    // peer must see this runner go offline, so presence should not have to re-derive it.
    this.emit('connected', { protocol: frame.protocol, heartbeat: frame.heartbeat })
  }

  // Frames addressed to channels this runner does not hold are not liveness and
  // must not fabricate lifecycle events; each handler reports whether it was
  // addressed to real state.
  private handleData(channel: string, seq: number, payload: Payload): boolean {
    if (!this.store.get(channel)) return false
    const result = this.store.receive({ type: 'data', channel, seq, payload })
    if (result.status === 'accepted') this.emit('data', { channel, seq, payload: result.payload })
    else if (result.status === 'gap') this.emit('protocol-error', { message: 'sequence gap', channel, seq })
    return true
  }

  private handleReset(channel: string, seq: number): boolean {
    if (!this.store.get(channel)) return false
    if (this.store.receiveReset(channel, seq)) this.emit('channel-reset', { channel, seq })
    else this.emit('protocol-error', { message: 'reset would rewind the stream', channel, seq })
    return true
  }

  private handleChannelClose(channel: string, reason?: string): boolean {
    if (!this.store.get(channel) && !this.reconciler.isClosing(channel)) return false
    this.store.drop(channel)
    this.reconciler.dropClosing(channel)
    this.emit('channel-closed', { channel, ...(reason ? { reason } : {}) })
    return true
  }

  private fail(event: string, detail: unknown) {
    this.phase = 'failed'
    this.connected = false
    this.clearTimers()
    this.emit(event, detail)
    // One event every terminal failure shares, whatever its cause. Consumers that must
    // react to "this client will never carry traffic again" should not have to enumerate
    // the reasons, and an enumeration is a list that goes stale silently.
    this.emit('failed', { reason: event, detail })
    this.transport.close()
  }

  private sendRaw(frame: Frame) {
    const result = this.transport.send(frame)
    if (result !== 'oversized') return
    // An oversized hello can never handshake — retrying would loop forever.
    if (frame.type === 'hello') return this.fail('protocol-error', { message: 'outbound hello exceeds MAX_FRAME_BYTES' })
    this.emit('protocol-error', { message: 'outbound frame exceeds MAX_FRAME_BYTES', frame: frame.type })
  }

  private highWaterBytes() {
    return this.options.highWaterBytes ?? DEFAULT_HIGH_WATER_BYTES
  }

  private clearTimers() {
    this.heartbeat.stop()
    this.reconciler.clearTimer()
    this.transport.clearTimers()
  }
}

function assertBoundedInt(name: string, value: number | undefined, min: number, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
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

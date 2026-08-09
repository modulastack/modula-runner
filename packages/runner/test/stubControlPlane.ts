import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  negotiate,
  type ChannelResumeResult,
  type Frame,
  type HeartbeatPolicy,
  type HelloFrame,
  type Payload,
} from '@modulastack/runner-protocol'

export type StubOptions = {
  token?: string
  supportedVersions?: number[]
  heartbeat?: HeartbeatPolicy
  echo?: boolean
  mutePings?: boolean
  muteWelcome?: boolean
  welcomeVersionOverride?: number
  extraResumeIds?: string[]
  delayWelcomeMs?: number
  omitResume?: boolean
  resumeSeqOverride?: number
  dropAfterWelcomeMs?: number
}

type StubChannel = { kind: string; attachToken: string; receivedSeq: number; sentSeq: number }
export type ReceivedData = { channel: string; seq: number; payload: Payload }

export class StubControlPlane {
  readonly channels = new Map<string, StubChannel>()
  readonly received: ReceivedData[] = []
  readonly resets: { channel: string; seq: number }[] = []
  readonly closes: { channel: string; reason?: string }[] = []
  readonly opens: string[] = []
  readonly hellos: HelloFrame[] = []
  readonly runnerPings: string[] = []
  readonly runnerPongs: string[] = []
  connectionCount = 0
  options: StubOptions
  private server?: Server
  private wss?: WebSocketServer
  private readonly sockets = new Set<WebSocket>()
  private boundPort = 0

  constructor(options: StubOptions = {}) {
    this.options = options
  }

  get url() {
    return `ws://127.0.0.1:${this.boundPort}`
  }

  get port() {
    return this.boundPort
  }

  async start(port = 0) {
    this.server = createServer()
    this.wss = new WebSocketServer({ noServer: true })
    this.server.on('upgrade', (request, socket, head) => this.upgrade(request, socket, head))
    await new Promise<void>(resolve => this.server?.listen(port, '127.0.0.1', resolve))
    this.boundPort = addressPort(this.server)
    return this
  }

  async stop() {
    for (const socket of this.sockets) socket.terminate()
    this.wss?.close()
    await new Promise<void>(resolve => (this.server ? this.server.close(() => resolve()) : resolve()))
  }

  dropConnections() {
    for (const socket of this.sockets) socket.terminate()
  }

  sendToRunner(channel: string, payload: Payload) {
    const state = this.channels.get(channel)
    if (!state) throw new Error(`stub: unknown channel ${channel}`)
    const frame: Frame = { type: 'data', channel, seq: ++state.sentSeq, payload }
    for (const socket of this.sockets) socket.send(encodeFrame(frame))
  }

  pingRunner(id: string) {
    for (const socket of this.sockets) socket.send(encodeFrame({ type: 'ping', id }))
  }

  sendTextToAll(raw: string) {
    for (const socket of this.sockets) socket.send(raw)
  }

  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const expected = `Bearer ${this.options.token ?? 'stub-token'}`
    if (request.headers.authorization !== expected) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    this.wss?.handleUpgrade(request, socket, head, ws => this.accept(ws))
  }

  private accept(ws: WebSocket) {
    this.connectionCount += 1
    this.sockets.add(ws)
    ws.on('close', () => this.sockets.delete(ws))
    ws.on('message', raw => this.handleRaw(ws, String(raw)))
  }

  private handleRaw(ws: WebSocket, raw: string) {
    const frame = decodeFrame(raw)
    if (!frame) return
    if (frame.type === 'hello') return this.handleHello(ws, frame)
    if (frame.type === 'open') {
      this.opens.push(frame.channel)
      return void this.channels.set(frame.channel, { kind: frame.kind, attachToken: frame.attachToken, receivedSeq: 0, sentSeq: 0 })
    }
    if (frame.type === 'data') return this.handleData(ws, frame.channel, frame.seq, frame.payload)
    if (frame.type === 'reset') return this.handleReset(frame.channel, frame.seq)
    if (frame.type === 'ping') return this.handlePing(ws, frame.id)
    if (frame.type === 'pong') this.runnerPongs.push(frame.id)
    if (frame.type === 'close') {
      this.closes.push({ channel: frame.channel, ...(frame.reason ? { reason: frame.reason } : {}) })
      this.channels.delete(frame.channel)
    }
  }

  private handlePing(ws: WebSocket, id: string) {
    this.runnerPings.push(id)
    if (!this.options.mutePings) ws.send(encodeFrame({ type: 'pong', id }))
  }

  private handleHello(ws: WebSocket, hello: HelloFrame) {
    this.hellos.push(hello)
    if (this.options.muteWelcome) return
    // Channels the runner no longer presents are gone on its side: prune them, so a
    // close lost in transit heals at the next reconnect instead of orphaning state.
    const presented = new Set(hello.channels.map(state => state.id))
    for (const id of [...this.channels.keys()]) if (!presented.has(id)) this.channels.delete(id)
    const supported = this.options.supportedVersions ?? [PROTOCOL_VERSION]
    const version = negotiate(hello.protocol, supported)
    if (version === null) {
      ws.send(encodeFrame({ type: 'reject', reason: 'no common protocol version', supported }))
      ws.close()
      return
    }
    const heartbeat = this.options.heartbeat ?? { intervalMs: 200, timeoutMs: 1_000 }
    const channels = this.options.omitResume ? [] : hello.channels.map(state => this.resume(state.id, state.kind, state.attachToken))
    for (const ghost of this.options.extraResumeIds ?? []) channels.push({ id: ghost, status: 'resumed', receivedSeq: 0 })
    const welcome = encodeFrame({ type: 'welcome', protocol: this.options.welcomeVersionOverride ?? version, heartbeat, channels })
    const delay = this.options.delayWelcomeMs ?? 0
    if (delay > 0) setTimeout(() => { if (ws.readyState === ws.OPEN) ws.send(welcome) }, delay)
    else ws.send(welcome)
    const dropAfter = this.options.dropAfterWelcomeMs
    if (dropAfter !== undefined) setTimeout(() => ws.terminate(), delay + dropAfter)
  }

  // Unknown channels are adopted: a channel opened while the control plane was away
  // heals through resume, exactly like one it has seen before.
  private resume(id: string, kind: string, attachToken: string): ChannelResumeResult {
    const known = this.channels.get(id)
    if (!known) {
      this.channels.set(id, { kind, attachToken, receivedSeq: 0, sentSeq: 0 })
      return { id, status: 'resumed', receivedSeq: 0 }
    }
    if (known.attachToken !== attachToken) return { id, status: 'expired' }
    return { id, status: 'resumed', receivedSeq: this.options.resumeSeqOverride ?? known.receivedSeq }
  }

  private handleData(ws: WebSocket, channel: string, seq: number, payload: Payload) {
    const state = this.channels.get(channel)
    if (!state || seq <= state.receivedSeq) return
    state.receivedSeq = seq
    this.received.push({ channel, seq, payload })
    if (this.options.echo) ws.send(encodeFrame({ type: 'data', channel, seq: ++state.sentSeq, payload }))
  }

  private handleReset(channel: string, seq: number) {
    this.resets.push({ channel, seq })
    const state = this.channels.get(channel)
    if (state) state.receivedSeq = seq - 1
  }
}

function addressPort(server: Server) {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('stub: no bound port')
  return address.port
}

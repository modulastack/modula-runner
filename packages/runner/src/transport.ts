import WebSocket from 'ws'
import { MAX_FRAME_BYTES, encodeFrame, type Frame } from '@modulastack/runner-protocol'
import { backoffDelay, type BackoffOptions } from './backoff.js'

export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000

export type SendResult = 'sent' | 'not-open' | 'oversized'

export type TransportOptions = {
  url: string
  token: string
  handshakeTimeoutMs?: number
  backoff?: BackoffOptions
}

export type TransportEvents = {
  active: () => boolean
  onOpen: () => void
  onMessage: (raw: string) => void
  onClosed: () => void
  onUpgradeFailed: (statusCode?: number) => void
  onReconnecting: (detail: { attempt: number; delayMs: number }) => void
}

// Owns the socket and nothing above it: dialing, reconnect pacing, the handshake
// deadline, and the frame-size cap on every write.
export class Transport {
  private ws?: WebSocket
  private attempt = 0
  private reconnectTimer: NodeJS.Timeout | undefined
  private handshakeTimer: NodeJS.Timeout | undefined

  constructor(
    private readonly options: TransportOptions,
    private readonly events: TransportEvents,
  ) {}

  dial() {
    const ws = new WebSocket(this.options.url, {
      headers: { authorization: `Bearer ${this.options.token}` },
      maxPayload: MAX_FRAME_BYTES,
      handshakeTimeout: this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    })
    this.ws = ws
    ws.on('open', () => this.events.onOpen())
    ws.on('message', raw => this.events.onMessage(String(raw)))
    ws.on('unexpected-response', (_request, response) => this.events.onUpgradeFailed(response.statusCode))
    ws.on('error', () => undefined)
    ws.on('close', () => this.events.onClosed())
  }

  scheduleReconnect() {
    const delayMs = backoffDelay(this.attempt++, this.options.backoff)
    this.events.onReconnecting({ attempt: this.attempt, delayMs })
    // A reconnecting listener may have stopped the client during the emit.
    if (!this.events.active()) return
    this.reconnectTimer = setTimeout(() => {
      if (this.events.active()) this.dial()
    }, delayMs)
  }

  // Backoff resets are deferred to the caller's liveness policy: a welcome-then-drop
  // control plane must not keep a fleet churning at base delay.
  resetBackoff() {
    this.attempt = 0
  }

  startHandshakeTimer() {
    const timeoutMs = this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
    this.handshakeTimer = setTimeout(() => this.ws?.terminate(), timeoutMs)
  }

  clearHandshakeTimer() {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    this.handshakeTimer = undefined
  }

  send(frame: Frame): SendResult {
    if (this.ws?.readyState !== WebSocket.OPEN) return 'not-open'
    const encoded = encodeFrame(frame)
    if (Buffer.byteLength(encoded, 'utf8') > MAX_FRAME_BYTES) return 'oversized'
    this.ws.send(encoded)
    return 'sent'
  }

  // For frames whose side effects must wait for the actual write (drain-then-close).
  sendAcked(frame: Frame, onResult: (error?: Error) => void): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    this.ws.send(encodeFrame(frame), onResult)
    return true
  }

  bufferedBytes() {
    return this.ws?.bufferedAmount ?? 0
  }

  terminate() {
    this.ws?.terminate()
  }

  close() {
    this.ws?.close()
  }

  clearTimers() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.clearHandshakeTimer()
  }
}

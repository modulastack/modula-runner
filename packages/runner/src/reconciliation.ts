import type { ChannelResumeResult, ChannelResumeState, Frame } from '@modulastack/runner-protocol'
import type { ChannelStore } from './channels.js'
import type { Transport } from './transport.js'

const FLUSH_INTERVAL_MS = 20

type ClosingEntry = { reason?: string; sent: boolean }

export type ReconcileEvent = { name: string; detail: unknown }
export type PumpOutcome = { sent: number; reset: boolean }

export type ReconcilerDeps = {
  store: ChannelStore
  transport: Transport
  isConnected: () => boolean
  highWaterBytes: () => number
  sendFrame: (frame: Frame) => void
  // Fired for every outbound reset, wherever the pump ran: an application that
  // can re-emit lost content (a pty's scrollback) must hear about continuity
  // loss even when it happens mid-connection, not only at resume time.
  onOutboundReset: (channel: string) => void
}

// The channel seam: keeps the local channel store and the wire consistent —
// announcing channels, pumping replay buffers under backpressure, draining
// closes, and reconciling the welcome against the exact hello snapshot.
export class ChannelReconciler {
  private readonly closing = new Map<string, ClosingEntry>()
  private presented = new Map<string, number>()
  private flushCursor = 0
  private flushTimer: NodeJS.Timeout | undefined
  private reconciling = false
  private deferredResets: string[] = []

  constructor(private readonly deps: ReconcilerDeps) {}

  // The snapshot keeps each channel's sentSeq as presented: an acknowledgment may
  // never exceed it, even if sends during the handshake advance the live counter.
  snapshotForHello(): ChannelResumeState[] {
    const states = this.deps.store.resumeStates()
    this.presented = new Map(states.map(state => [state.id, state.sentSeq]))
    return states
  }

  // The welcome is reconciled against the exact hello snapshot: results for channels
  // never presented are misbehavior to surface, presented channels the welcome omits
  // are re-announced from sequence zero (never trusted to a stale flush position),
  // and channels created mid-handshake are announced now. Recovery is two-phase —
  // every channel is restored and replayed before any event reaches a listener, so
  // a handler for one channel can never act on another's half-recovered state.
  reconcile(results: ChannelResumeResult[]): ReconcileEvent[] {
    const events: ReconcileEvent[] = []
    // Recovery stays two-phase: a reset raised while other channels are still
    // being restored waits, so no listener can act on half-recovered state.
    this.reconciling = true
    this.deferredResets = []
    const announceIds = this.deps.store.ids().filter(id => !this.presented.has(id))
    const unanswered = new Set(this.presented.keys())
    for (const result of results) {
      if (!this.presented.has(result.id)) {
        events.push({ name: 'protocol-error', detail: { message: 'resume result for unknown channel', channel: result.id } })
        continue
      }
      unanswered.delete(result.id)
      this.resumeChannel(result, events)
    }
    for (const id of unanswered) this.reannounce(id, events)
    for (const id of announceIds) this.announce(id)
    for (const id of [...this.closing.keys()]) this.finishClose(id)
    this.reconciling = false
    const deferred = this.deferredResets
    this.deferredResets = []
    for (const id of deferred) this.deps.onOutboundReset(id)
    return events
  }

  announce(id: string) {
    const state = this.deps.store.get(id)
    if (!state) return
    this.deps.sendFrame({ type: 'open', channel: id, kind: state.kind, attachToken: state.attachToken })
    this.pump(id)
  }

  // All data transmission funnels through here: frames flow only while the socket
  // buffer is under the high-water mark, and everything else waits in the replay
  // buffer — backpressure never breaks sequence continuity, it only delays it.
  pump(id: string): PumpOutcome {
    const outcome = { sent: 0, reset: false }
    const state = this.deps.store.get(id)
    if (!state) return outcome
    while (this.deps.isConnected() && state.flushedSeq < state.sentSeq) {
      if (this.deps.transport.bufferedBytes() > this.deps.highWaterBytes()) {
        this.scheduleFlush()
        break
      }
      const next = this.deps.store.nextOutbound(id, state.flushedSeq)
      if (next.reset) {
        this.deps.sendFrame(next.reset)
        state.flushedSeq = next.reset.seq - 1
        outcome.reset = true
        if (this.reconciling) this.deferredResets.push(id)
        else this.deps.onOutboundReset(id)
        continue
      }
      if (!next.frame) break
      this.deps.sendFrame(next.frame)
      state.flushedSeq = next.frame.seq
      outcome.sent++
    }
    return outcome
  }

  scheduleFlush() {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      // Each pass starts at a rotating position so a permanently backlogged channel
      // cannot hold the head of the line and starve the others.
      const ids = this.deps.store.ids()
      if (ids.length === 0) return
      this.flushCursor = (this.flushCursor + 1) % ids.length
      for (const id of [...ids.slice(this.flushCursor), ...ids.slice(0, this.flushCursor)]) {
        this.pump(id)
        if (this.closing.has(id)) this.finishClose(id)
      }
    }, FLUSH_INTERVAL_MS)
  }

  // Close is drain-then-close: the channel stays in the store (and in resume
  // snapshots) until its buffered frames and the close frame are actually written,
  // so neither a disconnect nor backpressure can orphan it or drop its tail.
  close(id: string, reason?: string) {
    if (!this.deps.store.get(id) || this.closing.has(id)) return
    // Clamped to the schema's bound: an unbounded reason would make the close frame
    // itself undecodable and take the whole connection down with it.
    const bounded = reason === undefined ? undefined : reason.slice(0, 500)
    this.closing.set(id, { sent: false, ...(bounded === undefined ? {} : { reason: bounded }) })
    if (this.deps.isConnected()) this.finishClose(id)
  }

  finishClose(id: string) {
    const entry = this.closing.get(id)
    if (!entry || entry.sent || !this.deps.isConnected()) return
    const state = this.deps.store.get(id)
    if (!state) {
      this.closing.delete(id)
      return
    }
    this.pump(id)
    if (state.flushedSeq === state.sentSeq) this.sendClose(id, entry)
    else this.scheduleFlush()
  }

  isClosing(id: string) {
    return this.closing.has(id)
  }

  dropClosing(id: string) {
    return this.closing.delete(id)
  }

  markClosesUnsent() {
    for (const entry of this.closing.values()) entry.sent = false
  }

  clearTimer() {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
  }

  private resumeChannel(result: ChannelResumeResult, events: ReconcileEvent[]) {
    const state = this.deps.store.get(result.id)
    if (!state) return
    if (result.status === 'expired') {
      this.deps.store.drop(result.id)
      if (!this.closing.delete(result.id)) events.push({ name: 'channel-expired', detail: { channel: result.id } })
      return
    }
    // A peer cannot have received more than the hello presented — frames recorded
    // while the welcome was in flight were never on the wire, so an acknowledgment
    // covering them is a lie. Such a claim is discarded along with the stale local
    // watermark: replaying the whole retained buffer is the only position that
    // cannot silently lose frames, and the contiguity rule discards the duplicates.
    const impossibleAck = result.receivedSeq > (this.presented.get(result.id) ?? 0)
    const appReset = !impossibleAck && state.recovery === 'application-reset' && result.receivedSeq < state.sentSeq
    state.flushedSeq = impossibleAck ? 0 : result.receivedSeq
    const outcome = appReset ? this.resetForApplicationReplay(result.id, state.sentSeq) : this.pump(result.id)
    if (impossibleAck) events.push({ name: 'protocol-error', detail: { message: 'resume beyond sent sequence', channel: result.id } })
    if (!this.closing.has(result.id)) events.push({ name: 'channel-resumed', detail: { channel: result.id, replayed: outcome.sent, reset: outcome.reset } })
  }

  private resetForApplicationReplay(id: string, sentSeq: number): PumpOutcome {
    this.deps.sendFrame({ type: 'reset', channel: id, seq: sentSeq + 1 })
    const state = this.deps.store.get(id)
    if (state) state.flushedSeq = sentSeq
    if (this.reconciling) this.deferredResets.push(id)
    else this.deps.onOutboundReset(id)
    return { sent: 0, reset: true }
  }

  private reannounce(id: string, events: ReconcileEvent[]) {
    const state = this.deps.store.get(id)
    if (!state) return
    // The replacement open starts both directions over: the control plane's fresh
    // stream begins at sequence one, which a stale inbound watermark would swallow.
    state.flushedSeq = 0
    state.receivedSeq = 0
    this.announce(id)
    events.push({ name: 'protocol-error', detail: { message: 'welcome omitted a presented channel', channel: id } })
  }

  private sendClose(id: string, entry: ClosingEntry) {
    const frame: Frame = { type: 'close', channel: id, ...(entry.reason === undefined ? {} : { reason: entry.reason }) }
    entry.sent = true
    const dispatched = this.deps.transport.sendAcked(frame, error => {
      if (error) {
        entry.sent = false
        return
      }
      this.deps.store.drop(id)
      this.closing.delete(id)
    })
    if (!dispatched) entry.sent = false
  }
}

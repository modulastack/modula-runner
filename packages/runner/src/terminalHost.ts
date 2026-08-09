import { decodeTerminalClientMessage, terminalPayload, type Payload, type TerminalClientMessage, type TerminalServerMessage } from '@modulastack/runner-protocol'
import type { ChannelHandle, RunnerClient } from './client.js'
import {
  UnkillableSessionError,
  DEFAULT_FLOW,
  DEFAULT_REPLAY_LINES,
  DEFAULT_POLL_MS,
  TerminalSession,
  type FlowPolicy,
  type SessionPolicy,
  type TerminalAdoptSpec,
  type TerminalLaunchSpec,
  type TerminalSessionEvents,
} from './terminalSession.js'
import { killTmuxSession, type TmuxRef } from './tmux.js'

export type TerminalHostOptions = {
  flow?: Partial<FlowPolicy>
  replayLines?: number
  pollMs?: number
}

export type TerminalBindingInfo = {
  channelId: string
  sessionId: string
  profile: string
  cwd: string
  finished: boolean
}

type Binding = { session: TerminalSession; channel: ChannelHandle }

const MAX_EARLY_MESSAGES = 64
const MAX_EARLY_INPUT_BYTES = 256 * 1024

// Binds pty sessions to terminal channels: inbound client messages dispatch to
// the bound session, server messages ride out as json payloads, and announced
// continuity loss triggers scrollback replay and a fresh flow window.
export class TerminalHost {
  private readonly bindings = new Map<string, Binding>()
  // Channels whose session is still being created: a close arriving in that
  // window has no binding to release, so it is remembered here instead.
  private readonly pending = new Set<string>()
  private readonly released = new Set<string>()
  // A kill can be asked for before the session exists. If the channel then
  // closes, the queued message dies with it — but the intent must not.
  private readonly killIntent = new Set<string>()
  // Sessions that outlived a failed launch and could not be confirmed dead:
  // the only remaining handle to a running command, kept for retry.
  private readonly orphans = new Map<string, TmuxRef>()
  // Channels released while their session still needed supervision: the binding
  // stayed so the command kept a watcher, and is cleared once the session ends.
  private readonly pendingRelease = new Set<string>()
  // Messages that arrived for a channel whose session was still starting: the
  // peer may answer an `open` before the pty exists, and an INIT or KILL is not
  // something to drop on the floor.
  private readonly earlyMessages = new Map<string, TerminalClientMessage[]>()
  private readonly inflight = new Set<Promise<unknown>>()
  private shuttingDown = false
  private shutdown: Promise<string[]> | undefined
  private readonly policy: SessionPolicy

  constructor(private readonly client: RunnerClient, options: TerminalHostOptions = {}) {
    this.policy = {
      flow: validatedFlow({ ...DEFAULT_FLOW, ...options.flow }),
      replayLines: validatedLines(options.replayLines ?? DEFAULT_REPLAY_LINES),
      pollMs: validatedPollMs(options.pollMs ?? DEFAULT_POLL_MS),
    }
    client.on('data', detail => this.handleData(detail))
    client.on('channel-outbound-reset', detail => this.handleOutboundReset(detail))
    client.on('channel-reset', detail => this.handleInboundReset(detail))
    client.on('channel-closed', detail => this.releaseBinding(detail.channel))
    client.on('channel-expired', detail => this.releaseBinding(detail.channel))
  }

  launch(spec: TerminalLaunchSpec) {
    this.assertOpen()
    return this.track(this.bind(channel => TerminalSession.launch(spec, this.policy, this.sessionEvents(channel))))
  }

  adopt(ref: TmuxRef, spec: TerminalAdoptSpec) {
    this.assertOpen()
    return this.track(this.bind(channel => TerminalSession.adopt(ref, spec, this.policy, this.sessionEvents(channel))))
  }

  // Starting a session while the host is killing them would race the shutdown
  // it is supposed to be part of.
  private assertOpen() {
    if (this.shuttingDown) throw new Error('terminal host is shutting down')
  }

  // Sessions whose kill could not be confirmed stay bound and observed; their
  // channel ids come back so a caller can retry rather than assume silence.
  // Concurrent callers share one shutdown: independent runs would each clear
  // the gate, and the first to finish would reopen the host while another was
  // still iterating its snapshot.
  killAll(): Promise<string[]> {
    if (!this.shutdown) {
      const running = this.runShutdown()
      this.shutdown = running
      void running.catch(() => undefined).then(() => {
        if (this.shutdown === running) this.shutdown = undefined
      })
    }
    return this.shutdown
  }

  private async runShutdown(): Promise<string[]> {
    // Launches still in flight are part of the shutdown: a session that starts
    // after killAll returned would be a command nobody is watching.
    this.shuttingDown = true
    // Drained until stable, not once: a launch that was mid-flight can register
    // another await before the first snapshot settles.
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight])
    const unconfirmed: string[] = []
    for (const [channelId, binding] of [...this.bindings.entries()]) {
      if (!(await binding.session.dispose(true))) {
        unconfirmed.push(channelId)
        continue
      }
      this.bindings.delete(channelId)
      this.earlyMessages.delete(channelId)
      this.pendingRelease.delete(channelId)
      try {
        binding.channel.close('killed')
      } catch {}
    }
    for (const [name, ref] of [...this.orphans]) {
      if (await killTmuxSession(ref)) this.orphans.delete(name)
      else unconfirmed.push(name)
    }
    this.shuttingDown = false
    return unconfirmed
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    const tracked = promise.finally(() => this.inflight.delete(tracked))
    this.inflight.add(tracked)
    return tracked
  }

  sessions(): TerminalBindingInfo[] {
    return [...this.bindings.entries()].map(([channelId, binding]) => ({
      channelId,
      sessionId: binding.session.id,
      profile: binding.session.profile,
      cwd: binding.session.cwd,
      finished: binding.session.isFinished(),
    }))
  }

  // Release the viewer path without touching the session: the tmux session keeps
  // running for a later adopt, exactly like a runner restart would leave it.
  detach(channelId: string) {
    const binding = this.bindings.get(channelId)
    if (!binding) return
    // A kill in flight or unconfirmed outranks a detach: stopping the watcher
    // here would strand a possibly-live command, exactly as it would in
    // releaseBinding. Keep it observed until the session actually ends.
    if (binding.session.needsSupervision()) this.pendingRelease.add(channelId)
    else {
      this.bindings.delete(channelId)
      void binding.session.dispose(false)
    }
    try {
      binding.channel.close('detached')
    } catch {}
  }

  private async bind(create: (channel: ChannelHandle) => Promise<TerminalSession>) {
    const channel = this.client.openChannel('terminal')
    this.pending.add(channel.id)
    try {
      const session = await create(channel)
      this.pending.delete(channel.id)
      // The channel died while the session was starting: release the new
      // session the same way an established one is released, rather than
      // binding it to a channel that is already gone. A shutdown that started
      // meanwhile kills it outright — killAll asked for exactly that.
      if (this.released.delete(channel.id) || this.shuttingDown) {
        this.earlyMessages.delete(channel.id)
        const requestedKill = this.killIntent.delete(channel.id)
        const killed = await session.dispose(this.shuttingDown || requestedKill)
        // A kill that could not be confirmed stays bound so killAll reports it
        // rather than leaving a running command with nobody watching.
        if (!killed) {
          this.bindings.set(channel.id, { session, channel })
          return { channelId: channel.id, sessionId: session.id, ref: session.ref, released: false }
        }
        try {
          channel.close(this.shuttingDown ? 'killed' : 'released')
        } catch {}
        return { channelId: channel.id, sessionId: session.id, ref: session.ref, released: true }
      }
      this.bindings.set(channel.id, { session, channel })
      this.drainEarlyMessages(channel.id, session)
      return { channelId: channel.id, sessionId: session.id, ref: session.ref, released: false }
    } catch (error) {
      this.pending.delete(channel.id)
      this.released.delete(channel.id)
      this.killIntent.delete(channel.id)
      this.earlyMessages.delete(channel.id)
      // A launch can fail and still leave a command running. Losing that ref
      // here would leave nothing able to kill it later.
      if (error instanceof UnkillableSessionError) this.orphans.set(error.ref.sessionName, error.ref)
      try {
        channel.close('spawn failed')
      } catch {}
      throw error
    }
  }

  private sessionEvents(channel: ChannelHandle): TerminalSessionEvents {
    return {
      send: message => this.deliver(channel, message),
      onExited: () => this.finishBinding(channel.id),
    }
  }

  // A send can race the channel's close or the client's stop; a dying viewer
  // path must never take the session down with it.
  private deliver(channel: ChannelHandle, message: TerminalServerMessage) {
    try {
      channel.send(terminalPayload(message))
    } catch {}
  }

  // The channel outlives the session: EXIT must stay replayable until the
  // consumer has it, so the control plane closes exited channels, never this
  // side — a close racing a dying link would take the sequenced end-of-stream
  // down with it.
  private finishBinding(channelId: string) {
    const binding = this.bindings.get(channelId)
    if (!binding) return
    void binding.session.dispose(false)
    // The session has ended; if its channel already went away, the binding was
    // only being kept to watch a possibly-live command and can go now.
    if (this.pendingRelease.delete(channelId)) this.bindings.delete(channelId)
  }

  // The channel is gone (closed or expired): release the attachment so nothing
  // leaks outside the binding map, but leave the tmux session running for a
  // later adopt — exactly like a localhost session whose last browser tab closed.
  private drainEarlyMessages(channelId: string, session: TerminalSession) {
    const queued = this.earlyMessages.get(channelId)
    this.earlyMessages.delete(channelId)
    for (const message of queued ?? []) session.handle(message)
  }

  private releaseBinding(channelId: string) {
    const queued = this.earlyMessages.get(channelId) ?? []
    this.earlyMessages.delete(channelId)
    if (this.pending.has(channelId)) {
      if (queued.some(entry => entry.type === 'KILL')) this.killIntent.add(channelId)
      return void this.released.add(channelId)
    }
    const binding = this.bindings.get(channelId)
    if (!binding) return
    // A session whose kill is still in flight, or whose kill could not be
    // confirmed, stays bound and observed: disposing it here would stop the
    // watcher on a command that may still be running and remove the entry the
    // retry path depends on. The binding is cleared when the session finishes.
    if (binding.session.needsSupervision()) return void this.pendingRelease.add(channelId)
    this.bindings.delete(channelId)
    void binding.session.dispose(false)
  }

  private handleData(detail: { channel: string; payload: Payload }) {
    const binding = this.bindings.get(detail.channel)
    const pending = this.pending.has(detail.channel)
    if (!binding && !pending) return
    const message = decodeTerminalClientMessage(detail.payload)
    if (!message) {
      if (binding) this.deliver(binding.channel, { type: 'ERROR', message: 'invalid terminal message' })
      return
    }
    if (binding) return binding.session.handle(message)
    this.retainEarlyMessage(detail.channel, message)
  }

  // Bounded in count and in bytes, but a flood of input can never crowd out a
  // lifecycle message: INIT and KILL evict the oldest data message instead of
  // being dropped behind it.
  private retainEarlyMessage(channelId: string, message: TerminalClientMessage) {
    const queued = this.earlyMessages.get(channelId) ?? []
    // Only the newest INIT matters — it carries the current size, and replaying
    // older ones would just re-request replay — so a later INIT replaces the
    // earlier one *in place*: appending it would reorder the input between them
    // ahead of the initialization it depends on.
    if (message.type === 'INIT') {
      const existing = queued.findIndex(entry => entry.type === 'INIT')
      if (existing !== -1) {
        queued[existing] = message
        this.earlyMessages.set(channelId, queued)
        return
      }
    }
    const lifecycle = message.type === 'INIT' || message.type === 'KILL'
    // The arriving payload is counted before it is accepted: measuring only
    // what is already queued lets a single near-frame-sized input walk straight
    // past the cap, once per channel, across the whole roster.
    const incoming = message.type === 'INPUT' ? Buffer.byteLength(message.data) : 0
    if (!lifecycle && (queued.length >= MAX_EARLY_MESSAGES || earlyInputBytes(queued) + incoming > MAX_EARLY_INPUT_BYTES)) return
    if (lifecycle && queued.length >= MAX_EARLY_MESSAGES) {
      // A kill outranks anything still queued: it evicts data first, and an
      // INIT if data is all that is left.
      const victim = queued.findIndex(entry => entry.type !== 'INIT' && entry.type !== 'KILL')
      const fallback = queued.findIndex(entry => entry.type === 'INIT')
      const index = victim === -1 ? fallback : victim
      if (index === -1) return
      queued.splice(index, 1)
    }
    queued.push(message)
    this.earlyMessages.set(channelId, queued)
  }

  // Wherever the reset happened — resume-time or mid-connection — the pump
  // reported it, and scrollback replay is the answer.
  private handleOutboundReset(detail: { channel: string }) {
    this.bindings.get(detail.channel)?.session.replayAfterReset()
  }

  private handleInboundReset(detail: { channel: string }) {
    this.bindings.get(detail.channel)?.session.recoverWindow()
  }
}

function earlyInputBytes(queued: TerminalClientMessage[]) {
  return queued.reduce((total, entry) => total + (entry.type === 'INPUT' ? Buffer.byteLength(entry.data) : 0), 0)
}

function validatedFlow(flow: FlowPolicy): FlowPolicy {
  const positiveInts = [flow.highWaterBytes, flow.lowWaterBytes, flow.flushMs].every(value => Number.isSafeInteger(value) && value >= 1)
  if (!positiveInts || flow.lowWaterBytes >= flow.highWaterBytes) {
    throw new Error('flow policy requires positive integers with lowWaterBytes < highWaterBytes')
  }
  return flow
}

function validatedLines(lines: number) {
  if (!Number.isSafeInteger(lines) || lines < 1 || lines > 100_000) throw new Error('replayLines must be an integer between 1 and 100000')
  return lines
}

function validatedPollMs(value: number) {
  if (!Number.isSafeInteger(value) || value < 50 || value > 60_000) throw new Error('pollMs must be an integer between 50 and 60000')
  return value
}

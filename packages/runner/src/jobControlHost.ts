import {
  decodeJobControlClientMessage,
  jobControlPayload,
  type JobControlServerMessage,
  type Payload,
  type RefusalReason,
} from '@modulastack/runner-protocol'
import type { ChannelHandle, RunnerClient } from './client.js'
import type { PresenceTracker } from './presence.js'
import type { PreviewExit, PreviewHost } from './preview.js'

// Binds preview lifecycle to a job-control channel: this is where a discovered port
// becomes a reported port, and where every request the runner declines becomes a named
// refusal on the wire instead of silence the control plane would have to interpret.

export type JobControlHostOptions = {
  client: RunnerClient
  preview: PreviewHost
  presence?: PresenceTracker
}

export class JobControlHost {
  private readonly client: RunnerClient
  private readonly preview: PreviewHost
  private readonly presence: PresenceTracker | undefined
  private channel: ChannelHandle | undefined
  private generation = 0
  private readonly startedUnder = new Map<string, number>()
  private readonly starting = new Set<string>()
  private readonly exitedWhileStarting = new Map<string, PreviewExit>()

  constructor(options: JobControlHostOptions) {
    this.client = options.client
    this.preview = options.preview
    this.presence = options.presence
    this.client.on('data', detail => this.handleData(detail as { channel: string; payload: Payload }))
    // Each preview remembers the generation it was STARTED under, and its exit is reported
    // only if that is still the current one. Capturing a generation on the listener itself
    // was wrong in the worst way: it froze at the value present when the host was built, so
    // after the first channel loss every later preview went silent — a stale-state bug
    // replacing the misattribution it was meant to prevent.
    this.preview.on('exit', exit => {
      // A preview can die while its start is still settling, before the generation is
      // recorded. Suppressing that exit and then sending READY leaves the peer holding
      // something already dead, so it is held and flushed the moment readiness goes out.
      if (this.starting.has(exit.previewId)) {
        this.exitedWhileStarting.set(exit.previewId, exit)
        return
      }
      const startedUnder = this.startedUnder.get(exit.previewId)
      this.startedUnder.delete(exit.previewId)
      // An end-of-life is only meaningful for something the control plane was told began.
      // A preview refused before readiness produces a dying process too, and reporting
      // that as an exit describes a lifecycle the peer never saw start — it already has
      // its answer, which is the refusal.
      if (startedUnder === undefined || startedUnder !== this.generation) return
      this.send({ type: 'PREVIEW_EXIT', ...exit })
    })
    // A preview outliving its channel would otherwise report into a handle the client has
    // already dropped, which throws. Releasing the handle makes the late report a no-op
    // rather than an error swallowed in a catch that would also hide real ones. The
    // channel can go before the client does — a remote close, or a resume the control
    // plane declines — so those cases release it too.
    const release = (detail: unknown) => {
      if (this.channel && (detail as { channel?: string }).channel === this.channel.id) this.orphan()
    }
    this.client.on('channel-closed', release)
    // The runner mints this channel, so the control plane cannot replace one it did not
    // open. An expiry that only released the handle left a live client with no job-control
    // path and every later request silently ignored — so reconcile, then reopen.
    this.client.on('channel-expired', detail => {
      const wasOurs = this.channel && (detail as { channel?: string }).channel === this.channel.id
      release(detail)
      if (wasOurs && this.client.isConnected()) this.open()
    })
    // Every terminal client state releases the handle, not just a clean stop. A preview
    // that becomes ready after the connection failed would otherwise send into a client
    // that throws, and that rejection belongs to a promise nobody is holding.
    for (const terminal of ['stopped', 'failed']) {
      this.client.on(terminal, () => this.orphan())
    }
  }

  // Losing the channel means losing the only way to report a preview or be told to stop
  // one. Servers left running behind that would be unreachable state — a port the control
  // plane still believes in, or has never heard of, with nothing able to end it. The
  // control plane can start them again over a fresh channel; it cannot adopt strays.
  private orphan() {
    if (!this.channel) return
    this.channel = undefined
    // Advancing the generation is what makes the in-flight exits from this stopAll belong
    // to the connection that is going away rather than to whatever opens next.
    this.generation += 1
    this.startedUnder.clear()
    // Best effort by construction: what survives shutdown is reported as cleanup-failed
    // by the host itself, so there is no second answer to give here.
    this.preview.stopAll().catch(() => undefined)
  }

  open() {
    if (!this.channel) this.channel = this.client.openChannel('job-control')
    return this.channel
  }

  close(reason?: string) {
    try {
      this.channel?.close(reason)
    } finally {
      // Closing deliberately is still losing the only way to report or stop these
      // previews; the reconciliation is the same one an unexpected loss gets.
      this.orphan()
    }
  }

  private handleData(detail: { channel: string; payload: Payload }) {
    if (!this.channel || detail.channel !== this.channel.id) return
    const message = decodeJobControlClientMessage(detail.payload)
    if (!message) return
    // Nothing inbound may become an unhandled rejection: a frame from the control plane
    // must not be able to end the runner, whatever it contains. A failure that escapes
    // the host's own refusal path still leaves the wire with an answer.
    if (message.type === 'PREVIEW_STOP') {
      const askedToStop = this.channel
      // The wire gets an answer even when teardown itself fails — on the channel that
      // asked, which teardown is slow enough to outlive.
      this.stop(message.previewId, askedToStop).catch(() => {
        if (this.channel === askedToStop) this.refuse(message.previewId, 'unknown-preview')
      })
      return
    }
    const asked = this.channel
    // Same rule: a failure that escapes the host still leaves the wire with an answer.
    this.start(message).catch(() => {
      if (this.channel === asked) this.refuse(message.previewId, 'spawn-failed')
    })
  }

  private async start(message: { previewId: string; recipe: string; cwd: string }) {
    // The channel this request arrived on, captured by identity. Comparing it at every
    // completion path is what stops an answer from being delivered to a channel that
    // replaced the one which asked — a number that advances mid-request could not.
    const asked = this.channel
    // Presence gates admission: work the runner cannot start is answered now, never held
    // for a reconnect that would deliver it late and unannounced.
    if (this.presence && !this.presence.canAcceptWork()) return this.refuse(message.previewId, 'runner-paused')
    if (this.channel !== asked) return
    // A second start for the same id is refused before it can share the first's lifecycle
    // slot: they key on the identifier, so the loser's cleanup would otherwise delete the
    // winner's state and swallow its exit. The host refuses duplicates anyway; this is
    // about not corrupting the first attempt on the way to hearing that.
    if (this.starting.has(message.previewId)) return this.refuse(message.previewId, 'already-running')
    this.starting.add(message.previewId)
    let outcome
    try {
      outcome = await this.preview.start(message)
    } finally {
      this.starting.delete(message.previewId)
    }
    const earlyExit = this.exitedWhileStarting.get(message.previewId)
    this.exitedWhileStarting.delete(message.previewId)
    if (this.channel !== asked) return
    if (outcome.status === 'refused') return this.refuse(message.previewId, outcome.reason)
    // Recorded only once readiness is announced: the generation a preview belongs to is
    // the one its READY went out on, and nothing before that has a lifecycle to report.
    this.startedUnder.set(outcome.record.previewId, this.generation)
    this.send({ type: 'PREVIEW_READY', previewId: outcome.record.previewId, port: outcome.record.port })
    // Flushed right behind readiness, so the peer learns the preview ended rather than
    // waiting on one that was gone before it was announced.
    if (earlyExit) {
      this.startedUnder.delete(outcome.record.previewId)
      this.send({ type: 'PREVIEW_EXIT', ...earlyExit })
    }
  }

  // The host answers whether it knew the identifier. Inferring it from `list()` missed a
  // preview still being screened, so a stop racing its own start was told the id was
  // unknown while that start carried on and later announced readiness.
  private async stop(previewId: string, asked: ChannelHandle | undefined) {
    const outcome = await this.preview.stop(previewId)
    if (this.channel !== asked) return
    // Knowing the identifier and having ended it are different answers, and the control
    // plane needs the second. A teardown that could not finish retains the process, so
    // reporting nothing left the peer believing a preview was stopped that is still up.
    if (outcome === 'unknown') return this.refuse(previewId, 'unknown-preview')
    if (outcome === 'retained') this.refuse(previewId, 'spawn-failed')
  }

  private refuse(requestId: string, reason: RefusalReason) {
    this.send({ type: 'REFUSED', requestId, reason })
  }

  private send(message: JobControlServerMessage) {
    // A closed channel is not an error worth throwing over: the control plane learns the
    // channel is gone from the roster at reconnect, which is the contract's own healing.
    if (!this.channel) return
    this.channel.send(jobControlPayload(message))
  }
}

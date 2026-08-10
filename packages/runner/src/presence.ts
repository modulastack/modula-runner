import { EventEmitter } from 'node:events'
import type { HeartbeatPolicy } from '@modulastack/runner-protocol'
import type { RunnerClient } from './client.js'

// Runner presence is transport liveness and nothing else: it is derived from the CP-1
// connection lifecycle and the negotiated heartbeat policy, never from a second timer of
// its own. Two independent liveness systems disagree, and the one a surface happens to
// read would then be the wrong one.
//
// Agent-pane stall detection is a separate signal measured in quiet minutes. The two share
// a word and must not be collapsed: a runner whose socket died is offline within one
// heartbeat window, not after a stall threshold.
//
// Whether this runner is paired at all is the identity's question, not presence's — a
// tracker only exists for a client, and a client only exists for a binding.

export type PresenceState = 'online' | 'offline' | 'revoked'

export type PresenceSnapshot = {
  state: PresenceState
  since: number
  heartbeat: HeartbeatPolicy | null
}

export type PresenceTrackerOptions = {
  client: RunnerClient
  now?: () => number
}

export declare interface PresenceTracker {
  on(event: 'presence', listener: (snapshot: PresenceSnapshot) => void): this
}

export class PresenceTracker extends EventEmitter {
  private readonly client: RunnerClient
  private readonly now: () => number
  private readonly subscriptions: [string, (detail: unknown) => void][] = []
  private state: PresenceState
  private since: number
  private policy: HeartbeatPolicy | null = null

  constructor(options: PresenceTrackerOptions) {
    super()
    this.client = options.client
    this.now = options.now ?? (() => Date.now())
    this.state = this.client.isConnected() ? 'online' : 'offline'
    this.since = this.now()
    this.subscribe('connected', detail => this.goOnline(detail))
    this.subscribe('offline', () => this.transition('offline'))
    this.subscribe('stopped', () => this.transition('offline'))
    // Every terminal failure, whatever its cause. Without this a protocol failure left
    // presence reporting online for a client that will never carry traffic again — and the
    // revoked guard below still keeps an auth rejection reading as revoked, not offline.
    this.subscribe('failed', () => this.transition('offline'))
    // An auth rejection is the account disowning this runner, not a link problem: it is
    // terminal, so presence says revoked rather than reporting a reconnect that will
    // never come.
    this.subscribe('auth-failed', () => this.transition('revoked'))
  }

  snapshot(): PresenceSnapshot {
    return { state: this.state, since: this.since, heartbeat: this.policy }
  }

  // The admission rule behind the `runner-paused` refusal: work the runner cannot start is
  // answered, never held. A caller that queues on false here has reintroduced the silent
  // queue the contract forbids.
  canAcceptWork() {
    return this.state === 'online'
  }

  stop() {
    for (const [event, listener] of this.subscriptions) this.client.off(event, listener)
    this.subscriptions.length = 0
  }

  private goOnline(detail: unknown) {
    const heartbeat = (detail as { heartbeat?: HeartbeatPolicy } | undefined)?.heartbeat
    if (heartbeat) this.policy = heartbeat
    this.transition('online')
  }

  private transition(next: PresenceState) {
    // Revocation outranks a later close: a revoked runner that then drops its socket is
    // still revoked, and reporting plain offline would invite a reconnect attempt.
    if (this.state === 'revoked' || this.state === next) return
    this.state = next
    this.since = this.now()
    this.emit('presence', this.snapshot())
  }

  private subscribe(event: string, listener: (detail: unknown) => void) {
    this.subscriptions.push([event, listener])
    this.client.on(event, listener)
  }
}

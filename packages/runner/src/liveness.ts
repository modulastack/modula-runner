import { randomUUID } from 'node:crypto'
import type { HeartbeatPolicy } from '@modulastack/runner-protocol'

export type HeartbeatEvents = {
  onExpired: () => void
  onHealthyInterval: () => void
  canSend: () => boolean
  send: (id: string) => void
}

// Liveness bookkeeping for one negotiated connection: pings on the welcome's
// cadence, a deadline that only real traffic refreshes, and pong matching so
// fabricated or stale pongs cannot hold a dead session open.
export class Heartbeat {
  private timer: NodeJS.Timeout | undefined
  private deadlineTimer: NodeJS.Timeout | undefined
  private lastSeen = 0
  private pingOrder: string[] = []
  private readonly pingSet = new Set<string>()
  private maxOutstandingPings = 16

  constructor(private readonly events: HeartbeatEvents) {}

  start(policy: HeartbeatPolicy) {
    this.lastSeen = Date.now()
    this.pingOrder = []
    this.pingSet.clear()
    // Every ping that could still be legitimately answered inside the timeout
    // window stays outstanding — a shorter memory would reject honest late pongs —
    // but capped, so an extreme policy cannot grow an unbounded id set: a peer
    // lagging more than the cap's worth of intervals is not meaningfully alive.
    this.maxOutstandingPings = Math.min(Math.ceil(policy.timeoutMs / policy.intervalMs) + 1, 4096)
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => this.tick(policy), policy.intervalMs)
    this.armDeadline(policy)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer)
    this.timer = undefined
    this.deadlineTimer = undefined
  }

  sawTraffic() {
    this.lastSeen = Date.now()
  }

  matchPong(id: string) {
    return this.pingSet.delete(id)
  }

  // The deadline is its own timer rather than a check on the ping interval: polling can
  // only notice death at the next tick, which would let a dead connection look alive for
  // a whole interval past the timeout the two sides negotiated. Re-arming happens when
  // the timer fires rather than on every frame, so traffic volume costs nothing.
  private armDeadline(policy: HeartbeatPolicy) {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer)
    const remaining = this.lastSeen + policy.timeoutMs - Date.now()
    this.deadlineTimer = setTimeout(() => this.checkDeadline(policy), Math.max(remaining, 1))
  }

  private checkDeadline(policy: HeartbeatPolicy) {
    if (Date.now() - this.lastSeen >= policy.timeoutMs) return this.events.onExpired()
    this.armDeadline(policy)
  }

  private tick(policy: HeartbeatPolicy) {
    if (Date.now() - this.lastSeen >= policy.timeoutMs) {
      this.events.onExpired()
      return
    }
    this.events.onHealthyInterval()
    // Pings respect backpressure like every other outbound frame: a peer that
    // writes but never reads must not grow the queue one ping per interval.
    if (!this.events.canSend()) return
    const id = randomUUID()
    this.pingOrder.push(id)
    this.pingSet.add(id)
    while (this.pingSet.size > this.maxOutstandingPings) {
      const oldest = this.pingOrder.shift()
      if (oldest === undefined) break
      this.pingSet.delete(oldest)
    }
    // Answered ids linger in the order queue until shifted; compact occasionally.
    if (this.pingOrder.length > this.maxOutstandingPings * 2 + 64) {
      this.pingOrder = this.pingOrder.filter(pending => this.pingSet.has(pending))
    }
    this.events.send(id)
  }
}

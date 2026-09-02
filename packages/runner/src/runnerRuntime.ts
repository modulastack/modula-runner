import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { hostname } from 'node:os'
import {
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  hasControlCharacter,
  type Payload,
  type RunnerInfo,
} from '@modulastack/runner-protocol'
import { RunnerClient, type ChannelHandle } from './client.js'
import type {
  RunnerRuntimeHandle,
  RunnerRuntimeOptions,
  RunnerRuntimePort,
  RunnerShutdownResult,
  RunnerStopResult,
} from './runnerApplication.js'
import type { RunnerHomeState } from './runnerHome.js'
import type {
  SessionJobControl,
  SessionJobControlContext,
  SessionJobControlEffect,
} from './sessionJobControl.js'
import { websocketUrlFor } from './secureUrl.js'

const packageManifest = createRequire(import.meta.url)('../package.json') as { version?: unknown }
const packageVersion = typeof packageManifest.version === 'string' ? packageManifest.version : 'unknown'
const INTERRUPTED_CHANNEL_SETTLEMENT_MS = 10

export class RunnerRuntimeUnavailableError extends Error {
  constructor(readonly pairingState: string) {
    super(`runner binding is ${pairingState}`)
    this.name = 'RunnerRuntimeUnavailableError'
  }
}

type ProductionRunnerRuntimeOptions = RunnerRuntimeOptions & {
  runner?: RunnerInfo
  bindClient?: (home: RunnerHomeState, client: RunnerClient, bindingId: string) => Promise<void> | void
  shutdown?: () => Promise<readonly string[]>
}

export function createProductionRunnerRuntime(options: ProductionRunnerRuntimeOptions): RunnerRuntimePort {
  return { start: (home, jobControl) => startRuntime(options, home, jobControl) }
}

async function startRuntime(
  options: ProductionRunnerRuntimeOptions,
  home: RunnerHomeState,
  jobControl: SessionJobControl,
): Promise<RunnerRuntimeHandle> {
  const snapshot = await home.pairing.snapshot()
  if (snapshot.state !== 'paired') throw new RunnerRuntimeUnavailableError(snapshot.state)
  const binding = snapshot.record
  const client = new RunnerClient({
    url: websocketUrlFor(binding.controlPlaneOrigin),
    token: binding.token,
    runner: options.runner ?? systemRunnerInfo(),
    protocol: { min: MIN_PROTOCOL_VERSION, max: PROTOCOL_VERSION },
  })
  await options.bindClient?.(home, client, binding.bindingId)
  return new RuntimeHandle(client, home, jobControl, binding.bindingId, options)
}

class RuntimeHandle implements RunnerRuntimeHandle {
  readonly finished: Promise<RunnerShutdownResult>
  private readonly complete: (result: RunnerShutdownResult) => void
  private channel: ChannelHandle | undefined
  private selectedProtocol: number | null = null
  private connectionId = randomUUID()
  private channelHadActivity = false
  private settleInterruptedChannel = false
  private queue: Promise<void> = Promise.resolve()
  private readonly dispatches = new Set<Promise<void>>()
  private stopPromise: Promise<RunnerStopResult> | undefined
  private cleanupPromise: Promise<RunnerStopResult> | undefined
  private stopping = false
  private settled = false

  constructor(
    private readonly client: RunnerClient,
    private readonly home: RunnerHomeState,
    private readonly jobControl: SessionJobControl,
    private readonly bindingId: string,
    private readonly options: ProductionRunnerRuntimeOptions,
  ) {
    let complete!: (result: RunnerShutdownResult) => void
    this.finished = new Promise(resolve => { complete = resolve })
    this.complete = complete
    this.bindEvents()
    this.channel = this.client.openChannel('job-control')
    this.client.connect()
  }

  stop(_signal: 'SIGINT' | 'SIGTERM') {
    if (this.settled) return this.cleanup()
    return this.stopPromise ??= this.shutdown()
  }

  forceStop() {
    if (this.settled) return
    this.stopping = true
    this.client.stop()
    void this.cleanup()
    this.finish({ status: 'unconfirmed', detail: 'unconfirmed — forced runtime cleanup' })
  }

  private bindEvents() {
    this.client.on('connected', detail => this.connected(detail))
    this.client.on('data', detail => this.dispatch(() => this.received(detail)))
    this.client.on('offline', () => {
      this.markChannelInterrupted()
      this.selectedProtocol = null
    })
    this.client.on('channel-expired', detail => this.retireChannel(detail, true))
    this.client.on('channel-closed', detail => this.retireChannel(detail, true))
    this.client.on('auth-failed', () => this.track(() => this.revoked()))
    this.client.on('failed', detail => {
      const reason = (detail as { reason?: unknown }).reason
      if (reason !== 'auth-failed') this.track(() => this.terminalFailure(connectionFailure(reason)))
    })
  }

  private connected(detail: unknown) {
    if (this.stopping) return
    try {
      const protocol = (detail as { protocol?: unknown }).protocol
      if (typeof protocol !== 'number') throw new Error('negotiated protocol is unavailable')
      this.selectedProtocol = protocol
      this.connectionId = randomUUID()
      if (!this.channel) this.channel = this.client.openChannel('job-control')
      this.track(() => this.recoverChannel())
    } catch {
      this.track(async () => { throw new Error('job-control activation failed') })
    }
  }

  private async activateChannel() {
    if (this.stopping || !this.client.isConnected()) return
    if (!this.channel) this.channel = this.client.openChannel('job-control')
    await this.recoverChannel()
  }

  private async recoverChannel() {
    if (this.settleInterruptedChannel) {
      await new Promise(resolve => setTimeout(resolve, INTERRUPTED_CHANNEL_SETTLEMENT_MS))
    }
    if (this.stopping || !this.channel || !this.client.isConnected()) return
    for await (const effect of this.jobControl.recover(this.context())) this.apply(effect)
    this.settleInterruptedChannel = false
  }

  private async received(detail: unknown) {
    if (this.stopping) return
    const message = detail as { channel?: unknown; payload?: unknown }
    if (!this.channel || message.channel !== this.channel.id || !isPayload(message.payload)) return
    this.channelHadActivity = true
    for await (const effect of this.jobControl.dispatch({ context: this.context(), payload: message.payload })) this.apply(effect)
  }

  private apply(effect: SessionJobControlEffect) {
    if (this.stopping || effect.kind === 'not-session') return
    if (!this.channel || effect.channelId !== this.channel.id) return
    if (effect.kind === 'send') this.channel.send(effect.payload)
    else {
      const retired = this.channel
      this.channel = undefined
      retired.close(effect.error)
      throw new Error('job-control failed closed')
    }
  }

  private retireChannel(detail: unknown, reopen: boolean) {
    const channelId = (detail as { channel?: unknown }).channel
    if (!this.channel || channelId !== this.channel.id) return
    this.markChannelInterrupted()
    this.channel = undefined
    if (reopen && this.selectedProtocol !== null && this.client.isConnected()) this.track(() => this.activateChannel())
  }

  private markChannelInterrupted() {
    this.settleInterruptedChannel ||= this.channelHadActivity
    this.channelHadActivity = false
  }

  private context(): SessionJobControlContext {
    return {
      connectionId: this.connectionId,
      channelId: this.channel?.id ?? 'job-control-unavailable',
      phase: this.client.isConnected() ? 'active' : 'reconnecting',
      selectedProtocolVersion: this.selectedProtocol,
      authenticatedBindingId: this.bindingId,
    }
  }

  private async revoked() {
    let detail = 'runner-auth-failed: authorization rejected; local revocation was not confirmed'
    try {
      const result = await this.home.pairing.revoke(this.bindingId, new Date(this.options.clock.now()).toISOString())
      if (result === 'updated') detail = 'runner-auth-failed: binding revoked after authorization rejection'
      else if (result === 'superseded') detail = 'runner-auth-failed: authorization rejected after the local binding changed'
    } finally {
      await this.terminalFailure(detail)
    }
  }

  private async terminalFailure(detail: string) {
    if (this.settled) return
    this.stopping = true
    this.client.stop()
    const result = await this.cleanup()
    this.finish(result.status === 'confirmed' ? { status: 'failed', detail } : result)
  }

  private async shutdown(): Promise<RunnerStopResult> {
    if (this.settled) return await this.cleanup()
    this.stopping = true
    this.channel?.close('runner shutdown')
    this.channel = undefined
    this.client.stop()
    await this.drain()
    const result = await this.cleanup()
    this.finish(result)
    return result
  }

  private cleanup(): Promise<RunnerStopResult> {
    return this.cleanupPromise ??= this.runCleanup()
  }

  private async runCleanup(): Promise<RunnerStopResult> {
    try {
      const unconfirmed = await this.options.shutdown?.() ?? []
      return unconfirmed.length === 0
        ? { status: 'confirmed' }
        : { status: 'unconfirmed', detail: `unconfirmed — ${unconfirmed.length} child sessions remain` }
    } catch {
      return { status: 'unconfirmed', detail: 'unconfirmed — runtime cleanup failed' }
    }
  }

  private finish(result: RunnerShutdownResult) {
    if (this.settled) return
    this.settled = true
    this.complete(result)
  }

  private track(operation: () => Promise<void>) {
    this.queue = this.queue.then(() => this.failClosed(operation))
  }

  // A launch parks until its session ends, so chaining request dispatch onto the lifecycle
  // queue would let one live session block recovery, revocation, connection failure and every
  // later request on the connection. Dispatches run beside the queue; shutdown drains both.
  private dispatch(operation: () => Promise<void>) {
    const running = this.failClosed(operation).finally(() => { this.dispatches.delete(running) })
    this.dispatches.add(running)
  }

  private failClosed(operation: () => Promise<void>): Promise<void> {
    return Promise.resolve().then(operation).catch(async () => {
      if (!this.stopping) await this.terminalFailure('runner-runtime-failed: local session processing failed closed')
    })
  }

  private async drain() {
    await Promise.allSettled([this.queue, ...this.dispatches])
  }
}

function connectionFailure(reason: unknown) {
  if (reason === 'rejected') return 'runner-rejected: protocol negotiation failed'
  if (reason === 'protocol-error') return 'runner-protocol-error: connection failed closed'
  return 'runner-runtime-failed: connection ended'
}

function systemRunnerInfo(): RunnerInfo {
  const name = hostname()
  const safeName = name.length > 0 && name.length <= 200 && !hasControlCharacter(name) ? name : 'runner'
  return { name: safeName, version: packageVersion, os: process.platform, arch: process.arch }
}

function isPayload(value: unknown): value is Payload {
  return typeof value === 'object' && value !== null && 'codec' in value
}

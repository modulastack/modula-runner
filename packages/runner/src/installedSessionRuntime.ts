import { randomUUID } from 'node:crypto'
import { AccessResolver, type AccessResolution } from './accessProfiles.js'
import { CapabilityMonitor, DEFAULT_RUNTIME_CATALOG } from './capabilities.js'
import type { RunnerClient } from './client.js'
import { LocalEndpointRegistry } from './localEndpoints.js'
import type { RunnerHomeState } from './runnerHome.js'
import type { RunnerClock } from './runtimeClock.js'
import { createSessionChannelEventCoordinator } from './sessionChannelEvents.js'
import type {
  SessionChannelCloseResult,
  SessionChannelOpen,
  SessionChannelStatus,
  SessionLauncher,
  SessionProcessIdentity,
  SessionProcessRequest,
  SessionProcessStart,
} from './sessionLaunch.js'
import { createSessionJobControl, type SessionJobControl } from './sessionJobControl.js'
import { createSessionLauncher } from './sessionLauncher.js'
import { createSessionTerminalPorts, type SessionTerminalPorts } from './sessionTerminals.js'
import { createSessionWorktreePort } from './sessionWorktrees.js'
import { createSpawnSeam } from './spawnSeam.js'

export type InstalledSessionRuntime = {
  launcher: SessionLauncher
  jobControl: SessionJobControl
  bind(client: RunnerClient, bindingId: string): void
  shutdown(): Promise<readonly string[]>
}

export function createInstalledSessionRuntime(home: RunnerHomeState, clock: RunnerClock): InstalledSessionRuntime {
  const seam = createSpawnSeam({ policy: home.policy, audit: home.audit, consent: home.grants, now: clock.now })
  const terminals = new DeferredSessionTerminals()
  const capabilities = new CapabilityMonitor({ seam, runtimes: DEFAULT_RUNTIME_CATALOG })
  const launcher = createSessionLauncher({
    bindingId: () => terminals.bindingId(),
    projects: home.projects,
    receipts: home.receipts,
    access: { resolve: (modelProfileId, signal) => resolveAccess(home, capabilities, modelProfileId, signal) },
    worktrees: createSessionWorktreePort({ seam, grants: home.grants }),
    channels: terminals.channels,
    recoveryChannels: terminals.recoveryChannels,
    channelEvents: createSessionChannelEventCoordinator({ receipts: home.receipts, audit: home.audit, clock }),
    processes: terminals.processes,
    identifiers: { nextSessionId: randomUUID },
    audit: home.audit,
    clock,
  })
  return {
    launcher,
    jobControl: createSessionJobControl({ launcher, audit: home.audit, clock }),
    bind(client, bindingId) { terminals.bind(createSessionTerminalPorts({ client, seam }), bindingId) },
    shutdown: async () => {
      capabilities.stop()
      return await terminals.shutdown()
    },
  }
}

// The monitor is the long-lived one its own contract describes — the snapshot a launch reads
// is the last probed one, kept current by the cadence — so a launch neither builds one nor
// waits on a full sweep once the first has landed. The endpoint half is deliberately absent:
// resolution reads only the runtime half, and a `local` profile is answered by the resolver's
// own fresh probe. The configuration snapshot stays per launch, because removing an endpoint
// or a profile has to take effect without waiting for anything.
async function resolveAccess(
  home: RunnerHomeState,
  capabilities: CapabilityMonitor,
  modelProfileId: string,
  signal: AbortSignal,
): Promise<AccessResolution> {
  if (signal.aborted) return { status: 'refused', reason: 'runtime-unavailable' }
  const configuration = await home.configuration.snapshot()
  if (!capabilities.snapshot()) {
    capabilities.start()
    await capabilities.refresh()
  }
  if (signal.aborted) return { status: 'refused', reason: 'runtime-unavailable' }
  return new AccessResolver({
    profiles: configuration.profiles,
    runtimes: DEFAULT_RUNTIME_CATALOG,
    keys: home.keys,
    endpoints: new LocalEndpointRegistry(configuration.endpoints),
    capabilities: () => capabilities.snapshot(),
  }).resolve(modelProfileId)
}

class DeferredSessionTerminals {
  private ports: SessionTerminalPorts | undefined
  private authenticatedBindingId: string | undefined

  readonly channels = {
    open: async (requestId: string, sessionId: string, signal: AbortSignal): Promise<SessionChannelOpen> => {
      return this.current().channels.open(requestId, sessionId, signal)
    },
    close: async (channelId: string, reason: string) => this.current().channels.close(channelId, reason),
  }

  readonly recoveryChannels = {
    ...this.channels,
    status: async (channelId: string, generation: number, connectionEpoch?: string): Promise<SessionChannelStatus> => {
      return this.current().recoveryChannels.status(channelId, generation, connectionEpoch)
    },
    closeExact: async (channelId: string, generation: number, reason: string, connectionEpoch?: string): Promise<SessionChannelCloseResult> => {
      return this.current().recoveryChannels.closeExact(channelId, generation, reason, connectionEpoch)
    },
  }

  readonly processes = {
    start: async (request: SessionProcessRequest, signal: AbortSignal): Promise<SessionProcessStart> => {
      return this.current().processes.start(request, signal)
    },
    adopt: async (request: SessionProcessRequest, signal: AbortSignal): Promise<SessionProcessStart> => {
      return this.current().processes.adopt(request, signal)
    },
    inspect: async (identity: SessionProcessIdentity) => this.current().processes.inspect(identity),
    terminate: async (identity: SessionProcessIdentity) => this.current().processes.terminate(identity),
  }

  bind(ports: SessionTerminalPorts, bindingId: string) {
    if (this.ports) throw new Error('installed session runtime is already bound')
    this.ports = ports
    this.authenticatedBindingId = bindingId
  }

  bindingId() {
    if (!this.authenticatedBindingId) throw new Error('installed session runtime is not bound')
    return this.authenticatedBindingId
  }

  async shutdown() {
    return this.ports ? this.ports.shutdown() : []
  }

  private current() {
    if (!this.ports) throw new Error('installed session runtime is not bound')
    return this.ports
  }
}

import { randomUUID } from 'node:crypto'
import type { ChannelHandle, RunnerClient } from './client.js'
import type {
  SessionChannelPort,
  SessionProcessHandle,
  SessionProcessIdentity,
  SessionRecoveryChannelPort,
  SessionProcessPort,
  SessionProcessRequest,
} from './sessionLaunch.js'
import type { SpawnSeam } from './spawnSeam.js'
import { TerminalHost } from './terminalHost.js'
import { killTmuxSession, tmuxSessionName, tmuxSessionPresence, worktreeSocket, type TmuxRef } from './tmux.js'

const MAX_SESSION_CHANNELS = 32

export type SessionTerminalPortsOptions = {
  client: RunnerClient
  seam: SpawnSeam
}

export type SessionTerminalPorts = {
  channels: SessionChannelPort
  recoveryChannels: SessionRecoveryChannelPort
  processes: SessionProcessPort
  shutdown(): Promise<readonly string[]>
}

type ChannelSlot = {
  handle: ChannelHandle
  state: 'pending' | 'active'
  exit: ExitSignal
}

type ExitSignal = {
  promise: Promise<{ exitCode: number | null; signal: number | null }>
  exposed: boolean
  resolve(result: { exitCode: number | null; signal: number | null }): void
}

export function createSessionTerminalPorts(options: SessionTerminalPortsOptions): SessionTerminalPorts {
  const slots = new Map<string, ChannelSlot>()
  const exits = new Map<string, ExitSignal>()
  const channelProcesses = new Map<string, string>()
  const forcedTerminationKeys = new Set<string>()
  const retiredChannels = new Map<string, 'closed' | 'lost'>()
  let connectionEpoch = randomUUID()
  const host = new TerminalHost(options.client, {
    seam: options.seam,
    onSessionExit(exit) {
      settleExit(exits, channelProcesses, forcedTerminationKeys, exit.channelId, { exitCode: exit.exitCode, signal: exit.signal })
    },
  })
  const retireChannel = (status: 'closed' | 'lost') => (detail: unknown) => {
    const channelId = (detail as { channel?: unknown }).channel
    if (typeof channelId !== 'string') return
    slots.delete(channelId)
    rememberRetired(retiredChannels, channelId, status)
  }
  const closedChannel = retireChannel('closed')
  const expiredChannel = retireChannel('lost')
  const advanceConnectionEpoch = () => { connectionEpoch = randomUUID() }
  options.client.on('channel-closed', closedChannel)
  options.client.on('channel-expired', expiredChannel)
  options.client.on('connected', advanceConnectionEpoch)
  const channels: SessionChannelPort = {
    open: (_requestId, _sessionId, signal) => openChannel(options.client, slots, signal, connectionEpoch),
    close: (channelId, reason) => closeChannel(host, slots, channelId, reason),
  }
  const recoveryChannels: SessionRecoveryChannelPort = {
    ...channels,
    async status(channelId, _generation, expectedEpoch) {
      if (expectedEpoch !== undefined && expectedEpoch !== connectionEpoch) return 'lost'
      return slots.has(channelId) ? 'live' : (retiredChannels.get(channelId) ?? 'unknown')
    },
    async closeExact(channelId, _generation, reason, expectedEpoch) {
      if (expectedEpoch !== undefined && expectedEpoch !== connectionEpoch) return 'lost'
      const slot = slots.get(channelId)
      if (!slot) return retiredChannels.get(channelId) ?? 'unknown'
      try {
        await closeChannel(host, slots, channelId, reason)
        if (slot.state !== 'pending') return 'unknown'
        rememberRetired(retiredChannels, channelId, 'closed')
        return 'closed'
      } catch {
        return 'unknown'
      }
    },
  }
  const processes: SessionProcessPort = {
    start: (request, signal) => startProcess(options.seam, host, slots, exits, channelProcesses, forcedTerminationKeys, request, signal),
    adopt: (request, signal) => adoptProcess(host, slots, exits, channelProcesses, request, signal),
    inspect: identity => inspectProcess(options.seam, identity),
    terminate: identity => terminateProcess(options.seam, host, slots, exits, channelProcesses, forcedTerminationKeys, identity),
  }
  return {
    channels,
    recoveryChannels,
    processes,
    async shutdown() {
      options.client.off('channel-closed', closedChannel)
      options.client.off('channel-expired', expiredChannel)
      options.client.off('connected', advanceConnectionEpoch)
      for (const [channelId, slot] of [...slots]) {
        if (slot.state === 'pending') await closeChannel(host, slots, channelId, 'shutdown')
      }
      for (const key of channelProcesses.values()) forcedTerminationKeys.add(key)
      const unconfirmed = await host.killAll()
      const uncertain = new Set(unconfirmed)
      for (const [channelId, key] of [...channelProcesses]) {
        if (uncertain.has(channelId)) continue
        settleProcess(exits, channelProcesses, slots, key, { exitCode: null, signal: 15 })
        forcedTerminationKeys.delete(key)
      }
      return unconfirmed
    },
  }
}

async function openChannel(
  client: RunnerClient,
  slots: Map<string, ChannelSlot>,
  signal: AbortSignal,
  connectionEpoch: string,
) {
  if (signal.aborted || slots.size >= MAX_SESSION_CHANNELS) return { status: 'failed' as const, reason: 'channel-unavailable' as const }
  let handle: ChannelHandle
  try {
    handle = client.openChannel('terminal')
  } catch {
    return { status: 'failed' as const, reason: 'channel-unavailable' as const }
  }
  if (signal.aborted) {
    try {
      handle.close('launch-timeout')
    } catch {
      // The client may have stopped at the same cancellation boundary; no channel can survive it.
    }
    return { status: 'failed' as const, reason: 'channel-unavailable' as const }
  }
  slots.set(handle.id, { handle, state: 'pending', exit: exitSignal() })
  return { status: 'opened' as const, channelId: handle.id, connectionEpoch }
}

async function closeChannel(
  host: TerminalHost,
  slots: Map<string, ChannelSlot>,
  channelId: string,
  reason: string,
): Promise<void> {
  const slot = slots.get(channelId)
  if (!slot) return
  slots.delete(channelId)
  if (slot.state === 'active') {
    host.detach(channelId, true)
    return
  }
  slot.handle.close(reason)
}

async function startProcess(
  seam: SpawnSeam,
  host: TerminalHost,
  slots: Map<string, ChannelSlot>,
  exits: Map<string, ExitSignal>,
  channelProcesses: Map<string, string>,
  forcedTerminationKeys: Set<string>,
  request: SessionProcessRequest,
  signal: AbortSignal,
) {
  const slot = pendingSlot(slots, request.channelId)
  if (!slot || signal.aborted) return { status: 'failed' as const, reason: 'spawn-failed' as const }
  bindExit(exits, channelProcesses, request, slot)
  try {
    const launched = await host.launchOn(slot.handle, {
      sessionId: request.sessionId,
      command: request.plan.command,
      args: [...request.plan.args],
      cwd: request.cwd,
      profile: request.terminalProfile,
      env: { ...request.plan.env },
      secrets: request.plan.secrets,
    })
    if (launched.released || launched.sessionId !== request.sessionId) throw new Error('terminal launch identity mismatch')
    slot.state = 'active'
    if (signal.aborted) {
      const terminated = await terminateProcess(seam, host, slots, exits, channelProcesses, forcedTerminationKeys, request)
      if (terminated === 'uncertain') throw new Error('terminal launch cancellation was not confirmed')
      await closeChannel(host, slots, request.channelId, 'launch-timeout')
      return { status: 'failed' as const, reason: 'spawn-failed' as const }
    }
    return { status: 'started' as const, handle: processHandle(request, slot.exit) }
  } catch (error) {
    slots.delete(request.channelId)
    throw error
  }
}

async function adoptProcess(
  host: TerminalHost,
  slots: Map<string, ChannelSlot>,
  exits: Map<string, ExitSignal>,
  channelProcesses: Map<string, string>,
  request: SessionProcessRequest,
  signal: AbortSignal,
) {
  const slot = pendingSlot(slots, request.channelId)
  if (!slot || signal.aborted) return { status: 'failed' as const, reason: 'spawn-failed' as const }
  bindExit(exits, channelProcesses, request, slot)
  try {
    const adopted = await host.adoptOn(slot.handle, processRef(request), {
      sessionId: request.sessionId,
      cwd: request.cwd,
      command: request.plan.command,
      profile: request.terminalProfile,
    })
    if (adopted.released || adopted.sessionId !== request.sessionId) {
      if (adopted.released) slots.delete(request.channelId)
      else {
        slot.state = 'active'
        await closeChannel(host, slots, request.channelId, 'recovery-uncertain')
      }
      return { status: 'failed' as const, reason: 'spawn-failed' as const }
    }
    slot.state = 'active'
    if (signal.aborted) {
      await closeChannel(host, slots, request.channelId, 'launch-timeout')
      return { status: 'failed' as const, reason: 'spawn-failed' as const }
    }
    return { status: 'started' as const, handle: processHandle(request, slot.exit) }
  } catch {
    slots.delete(request.channelId)
    return { status: 'failed' as const, reason: 'spawn-failed' as const }
  }
}

async function inspectProcess(seam: SpawnSeam, identity: SessionProcessIdentity) {
  const presence = await tmuxSessionPresence(processRef(identity), seam)
  if (presence === 'present') return 'exact' as const
  return presence === 'absent' ? 'missing' as const : 'mismatch' as const
}

async function terminateProcess(
  seam: SpawnSeam,
  host: TerminalHost,
  slots: Map<string, ChannelSlot>,
  exits: Map<string, ExitSignal>,
  channelProcesses: Map<string, string>,
  forcedTerminationKeys: Set<string>,
  identity: SessionProcessIdentity,
) {
  const ref = processRef(identity)
  const presence = await tmuxSessionPresence(ref, seam)
  if (presence === 'absent') {
    const key = processKey(identity)
    if (!exits.get(key)?.exposed) settleProcess(exits, channelProcesses, slots, key, { exitCode: null, signal: 15 }, false)
    return 'missing' as const
  }
  if (presence === 'unknown') return 'uncertain' as const
  const key = processKey(identity)
  forcedTerminationKeys.add(key)
  if (!(await killTmuxSession(ref, seam))) return 'uncertain' as const
  for (const [channelId, held] of [...channelProcesses]) {
    if (held === key) host.detach(channelId)
  }
  settleProcess(exits, channelProcesses, slots, key, { exitCode: null, signal: 15 })
  forcedTerminationKeys.delete(key)
  return 'terminated' as const
}

function bindExit(
  exits: Map<string, ExitSignal>,
  channelProcesses: Map<string, string>,
  identity: SessionProcessIdentity,
  slot: ChannelSlot,
) {
  const key = processKey(identity)
  slot.exit = exits.get(key) ?? slot.exit
  exits.set(key, slot.exit)
  channelProcesses.set(slot.handle.id, key)
}

function settleExit(
  exits: Map<string, ExitSignal>,
  channelProcesses: Map<string, string>,
  forcedTerminationKeys: Set<string>,
  channelId: string,
  result: { exitCode: number | null; signal: number | null },
) {
  const key = channelProcesses.get(channelId)
  if (!key || (forcedTerminationKeys.has(key) && !completeExit(result))) return
  settleProcess(exits, channelProcesses, undefined, key, result)
  forcedTerminationKeys.delete(key)
}

function completeExit(result: { exitCode: number | null; signal: number | null }): boolean {
  const exitCode = result.exitCode !== null && Number.isSafeInteger(result.exitCode) && result.exitCode >= 0
  const signal = result.signal !== null && Number.isSafeInteger(result.signal) && result.signal >= 0
  return exitCode !== signal
}

function settleProcess(
  exits: Map<string, ExitSignal>,
  channelProcesses: Map<string, string>,
  slots: Map<string, ChannelSlot> | undefined,
  key: string,
  result: { exitCode: number | null; signal: number | null },
  resolve = true,
) {
  if (resolve) exits.get(key)?.resolve(result)
  exits.delete(key)
  for (const [channelId, held] of [...channelProcesses]) {
    if (held !== key) continue
    channelProcesses.delete(channelId)
    slots?.delete(channelId)
  }
}

function rememberRetired(
  retired: Map<string, 'closed' | 'lost'>,
  channelId: string,
  status: 'closed' | 'lost',
) {
  retired.delete(channelId)
  retired.set(channelId, status)
  if (retired.size > MAX_SESSION_CHANNELS * 2) retired.delete(retired.keys().next().value!)
}

function processKey(identity: SessionProcessIdentity): string {
  return `${identity.cwd}\u0000${identity.sessionId}`
}

function pendingSlot(slots: Map<string, ChannelSlot>, channelId: string): ChannelSlot | null {
  const slot = slots.get(channelId)
  return slot?.state === 'pending' ? slot : null
}

function processRef(identity: SessionProcessIdentity): TmuxRef {
  return {
    socket: worktreeSocket(identity.cwd),
    sessionName: tmuxSessionName(identity.cwd, identity.sessionId),
  }
}

function processHandle(request: SessionProcessRequest, exit: ExitSignal): SessionProcessHandle {
  exit.exposed = true
  return {
    sessionId: request.sessionId,
    channelId: request.channelId,
    ...(request.channelGeneration === undefined ? {} : { channelGeneration: request.channelGeneration }),
    finished: exit.promise,
  }
}

function exitSignal(): ExitSignal {
  let settled = false
  let settle!: (result: { exitCode: number | null; signal: number | null }) => void
  const promise = new Promise<{ exitCode: number | null; signal: number | null }>(resolve => { settle = resolve })
  return {
    promise,
    exposed: false,
    resolve(result) {
      if (settled) return
      settled = true
      settle(result)
    },
  }
}

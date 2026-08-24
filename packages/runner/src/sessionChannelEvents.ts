import type { SessionFinishedMessage } from '@modulastack/runner-protocol'
import type {
  SessionChannelEvent,
  SessionChannelEventCoordinator,
  SessionChannelEventCoordinatorOptions,
  SessionChannelEventResult,
  SessionLaunchAction,
  SessionReceipt,
  SessionReceiptLookup,
  SessionReceiptReplace,
} from './sessionLaunch.js'

export function createSessionChannelEventCoordinator(
  options: SessionChannelEventCoordinatorOptions,
): SessionChannelEventCoordinator {
  return { handle: event => handleChannelEvent(options, event) }
}

async function handleChannelEvent(
  options: SessionChannelEventCoordinatorOptions,
  event: SessionChannelEvent,
): Promise<SessionChannelEventResult> {
  let found: SessionReceiptLookup
  try {
    found = await options.receipts.lookup(event.key)
  } catch {
    return { status: 'storage-unavailable' }
  }
  if (found.status === 'missing') return { status: 'unknown' }
  if (found.status === 'tombstone') return { status: 'retired' }
  const current = found.receipt
  if (current.sessionId !== event.sessionId || !current.channel) return { status: 'unknown' }
  if (event.generation < current.channel.generation) return { status: 'retired' }
  if (event.generation !== current.channel.generation || event.channelId !== current.channel.channelId) return { status: 'unknown' }
  const duplicate = terminalDuplicate(current, event)
  if (duplicate) return duplicate
  if (current.result) return { status: 'unknown' }
  const next = channelEventReceipt(current, event, options.clock.now())
  if (!next) return { status: 'unknown' }
  if (event.kind === 'terminal' && !(await auditChannelEvent(options, next))) {
    return { status: 'storage-unavailable' }
  }
  const replaced = await replaceReceipt(options, current.revision, next)
  if (replaced.status !== 'updated') return replacementFailure(replaced, event.generation)
  if (event.kind !== 'terminal' && !(await auditChannelEvent(options, replaced.receipt))) {
    return { status: 'storage-unavailable' }
  }
  return { status: 'applied', receipt: replaced.receipt, action: channelEventAction(replaced.receipt) }
}

async function replaceReceipt(
  options: SessionChannelEventCoordinatorOptions,
  revision: number,
  receipt: SessionReceipt,
): Promise<SessionReceiptReplace> {
  try {
    return await options.receipts.replace(revision, receipt)
  } catch {
    return { status: 'storage-unavailable' }
  }
}

function replacementFailure(
  result: Exclude<SessionReceiptReplace, { status: 'updated' }>,
  generation: number,
): SessionChannelEventResult {
  if (result.status === 'storage-unavailable') return result
  const currentGeneration = result.current?.channel?.generation
  return currentGeneration !== undefined && currentGeneration > generation ? { status: 'retired' } : { status: 'unknown' }
}

function channelEventReceipt(
  receipt: SessionReceipt,
  event: SessionChannelEvent,
  now: number,
): SessionReceipt | null {
  if (!Number.isFinite(now)) return null
  if (event.kind !== 'terminal') {
    return {
      ...receipt,
      channel: {
        generation: event.generation,
        lifecycle: event.kind,
        channelId: event.channelId,
        ...(receipt.channel?.connectionEpoch === undefined ? {} : { connectionEpoch: receipt.channel.connectionEpoch }),
      },
    }
  }
  const result = terminalEventResult(receipt.key.requestId, event)
  if (!result) return null
  return {
    ...receipt,
    state: 'finished',
    result,
    channel: {
      generation: event.generation,
      lifecycle: 'closed',
      channelId: event.channelId,
      ...(receipt.channel?.connectionEpoch === undefined ? {} : { connectionEpoch: receipt.channel.connectionEpoch }),
    },
    phaseTimestamps: { ...receipt.phaseTimestamps, finished: new Date(now).toISOString() },
  }
}

function terminalDuplicate(
  receipt: SessionReceipt,
  event: SessionChannelEvent,
): SessionChannelEventResult | null {
  if (event.kind !== 'terminal' || receipt.state !== 'finished' || !receipt.result) return null
  const result = terminalEventResult(receipt.key.requestId, event)
  if (!result || JSON.stringify(result) !== JSON.stringify(receipt.result)) return null
  if (receipt.channel?.lifecycle !== 'closed') return null
  return { status: 'applied', receipt, action: channelEventAction(receipt) }
}

function terminalEventResult(
  requestId: string,
  event: Extract<SessionChannelEvent, { kind: 'terminal' }>,
): SessionFinishedMessage | null {
  if (event.exitCode !== null && Number.isSafeInteger(event.exitCode) && event.exitCode >= 0 && event.signal === null) {
    return { type: 'SESSION_FINISHED', requestId, exitCode: event.exitCode, signal: null }
  }
  if (event.signal !== null && Number.isSafeInteger(event.signal) && event.signal >= 0 && event.exitCode === null) {
    return { type: 'SESSION_FINISHED', requestId, exitCode: null, signal: event.signal }
  }
  return null
}

async function auditChannelEvent(
  options: SessionChannelEventCoordinatorOptions,
  receipt: SessionReceipt,
): Promise<boolean> {
  const at = receipt.phaseTimestamps[receipt.state] ?? new Date(options.clock.now()).toISOString()
  try {
    await options.audit.append({
      kind: 'session-launch',
      key: receipt.key,
      state: receipt.state,
      at,
      ...(receipt.sessionId ? { sessionId: receipt.sessionId } : {}),
      ...(receipt.result ? { result: receipt.result } : {}),
    })
    return true
  } catch {
    return false
  }
}

function channelEventAction(receipt: SessionReceipt): SessionLaunchAction | null {
  return receipt.result ? { kind: 'message', message: receipt.result } : null
}

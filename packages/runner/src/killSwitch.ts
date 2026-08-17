import type { AuditLog } from './auditLog.js'
import type { PreviewCleanupFailure } from './preview.js'

// The local kill switch (FR-15): one operator action severs the runner's connection to the
// control plane and ends every child the runner can still identify — all tmux sessions and
// every preview tree it can reach by ancestry or process group. It is purely local, so it works
// with the control plane offline, unresponsive, or hostile: the socket is cut without waiting
// for a wire acknowledgment a compromised plane could withhold. Teardown the runner cannot
// confirm is reported as unconfirmed, never as success — a process that resisted termination is
// still out there — and the whole action lands in the audit log, made durable before the kill
// reports done, so there is always a record that the switch was thrown and what it could prove.

export type KillOutcome = {
  // True only when every child the runner could see was confirmed gone. False leaves the
  // details naming what could not be proven dead.
  confirmed: boolean
  details: string
}

// The preview host's kill surface, structurally — its `stopAll` plus the `cleanup-failed` signal
// that names a tree whose teardown could not be proven. Narrow so the switch depends on the
// capability, not the whole host.
export type KillablePreviews = {
  stopAll(): Promise<void>
  on(event: 'cleanup-failed', listener: (failure: PreviewCleanupFailure) => void): unknown
  off(event: 'cleanup-failed', listener: (failure: PreviewCleanupFailure) => void): unknown
}

export type KillTargets = {
  audit: AuditLog
  now?: () => number
  // Optional so the switch composes with whatever a runner has assembled — a headless runner
  // with no live client, a session host with no previews — without a null object for each.
  client?: { stop(): void }
  terminals?: { killAll(): Promise<string[]> }
  previews?: KillablePreviews
}

export async function activateKillSwitch(targets: KillTargets): Promise<KillOutcome> {
  const now = targets.now ?? Date.now
  const unconfirmed: string[] = []
  // The socket is cut first, synchronously, before anything that can await: a compromised or
  // slow control plane must not be able to hold the kill by withholding an acknowledgment. A
  // throw here is an unconfirmed sever, not a reason to abandon terminal/preview teardown or the
  // audit — `stop()` emits synchronous user listeners that can throw.
  try {
    targets.client?.stop()
  } catch (error) {
    unconfirmed.push(`client teardown failed: ${messageOf(error)}`)
  }
  const previewFailures: PreviewCleanupFailure[] = []
  const collect = (failure: PreviewCleanupFailure) => previewFailures.push(failure)
  targets.previews?.on('cleanup-failed', collect)
  // allSettled, not all: a teardown subsystem that throws is an *unconfirmed* teardown, not a
  // reason to abandon the kill. Both are attempted, both failures are recorded, and the switch
  // still reports and audits — a kill that gave up because one subsystem errored would leave
  // children alive with no record that anyone tried.
  const [terminals, previews] = await Promise.allSettled([
    targets.terminals ? targets.terminals.killAll() : Promise.resolve([] as string[]),
    targets.previews ? targets.previews.stopAll() : Promise.resolve(),
  ])
  targets.previews?.off('cleanup-failed', collect)
  if (terminals.status === 'fulfilled') {
    if (terminals.value.length > 0) unconfirmed.push(`sessions: [${terminals.value.join(', ')}]`)
  } else {
    unconfirmed.push(`terminal teardown failed: ${messageOf(terminals.reason)}`)
  }
  if (previews.status === 'rejected') unconfirmed.push(`preview teardown failed: ${messageOf(previews.reason)}`)
  if (previewFailures.length > 0) unconfirmed.push(`previews: [${previewFailures.map(failure => failure.previewId).join(', ')}]`)
  const confirmed = unconfirmed.length === 0
  const details = confirmed ? 'all identified children terminated' : `unconfirmed — ${unconfirmed.join('; ')}`
  // The record is made durable before the switch reports done: a kill is never acknowledged
  // before there is a durable record that it was thrown and what it could prove dead.
  await targets.audit.append({ kind: 'kill', confirmed, details, at: new Date(now()).toISOString() })
  return { confirmed, details }
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

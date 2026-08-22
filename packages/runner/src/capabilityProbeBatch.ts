import { randomUUID } from 'node:crypto'
import { MAX_ENDPOINT_CAPABILITIES, hasControlCharacter, isSafeIdentifier } from '@modulastack/runner-protocol'
import {
  MAX_CAPABILITY_REFRESH_INTENTIONS,
  MAX_CAPABILITY_REFRESH_RUNTIMES,
  type CapabilityEndpointOutcomeCounts,
  type CapabilityRuntimeOutcomeCounts,
  type RunnerAuditLifecycle,
} from './auditLifecycle.js'
import type { CommandPolicy } from './allowlist.js'
import type { SpawnRequest, VettedSpawn } from './spawnSeam.js'

export type CapabilityProbeCheck = 'version' | 'auth'

export type CapabilityProbeIntent = {
  probeId: string
  runtimeId: string
  check: CapabilityProbeCheck
  request: SpawnRequest & { kind: 'probe' }
}

export type CapabilityRefreshBatch = {
  refreshId: string
  probes: readonly CapabilityProbeIntent[]
  endpointIntentions: number
}

export type CapabilityProbeDecision =
  | {
      status: 'admitted'
      probeId: string
      runtimeId: string
      check: CapabilityProbeCheck
      vetted: VettedSpawn
    }
  | {
      status: 'refused'
      probeId: string
      runtimeId: string
      check: CapabilityProbeCheck
    }

export type CapabilityRefreshOutcome = {
  runtimeOutcomes: CapabilityRuntimeOutcomeCounts
  endpointOutcomes: CapabilityEndpointOutcomeCounts
  snapshotChanged: boolean
}

export type CapabilityRefreshBatchResult<T> =
  | { status: 'completed'; value: T }
  | { status: 'storage-unavailable' }

export type CapabilityProbeBatchOptions = {
  policy: CommandPolicy | null
  audit: RunnerAuditLifecycle
  now?: () => number
}

export interface CapabilityProbeBatchSeam {
  run<T>(
    batch: CapabilityRefreshBatch,
    runner: (
      decisions: readonly CapabilityProbeDecision[],
    ) => Promise<{ outcome: CapabilityRefreshOutcome; value: T }>,
  ): Promise<CapabilityRefreshBatchResult<T>>
}

export class CapabilityProbeBatchNotImplementedError extends Error {
  constructor() {
    super('capability probe batching is interface-only and is not active')
    this.name = 'CapabilityProbeBatchNotImplementedError'
  }
}

export function createCapabilityProbeBatchSeam(options: CapabilityProbeBatchOptions): CapabilityProbeBatchSeam {
  const at = () => new Date((options.now ?? Date.now)()).toISOString()
  return {
    async run<T>(
      batch: CapabilityRefreshBatch,
      runner: (decisions: readonly CapabilityProbeDecision[]) => Promise<{ outcome: CapabilityRefreshOutcome; value: T }>,
    ) {
      if (!validBatch(batch)) throw new TypeError('invalid capability refresh batch')
      const decisions = batch.probes.map(probe => decide(options.policy, probe))
      if (!(await appendAdmission(options.audit, batch, at()))) return { status: 'storage-unavailable' }
      let completed: Awaited<ReturnType<typeof runner>>
      try {
        completed = await runner(decisions)
      } catch (error) {
        if (!(await appendOutcome(options.audit, batch.refreshId, failedOutcome(batch, decisions), at()))) {
          return { status: 'storage-unavailable' }
        }
        throw error
      }
      if (!validOutcome(batch, completed.outcome)) {
        if (!(await appendOutcome(options.audit, batch.refreshId, failedOutcome(batch, decisions), at()))) {
          return { status: 'storage-unavailable' }
        }
        throw new TypeError('invalid capability refresh outcome')
      }
      if (!(await appendOutcome(options.audit, batch.refreshId, completed.outcome, at()))) return { status: 'storage-unavailable' }
      return { status: 'completed', value: completed.value }
    },
  }
}

export function createUnimplementedCapabilityProbeBatchSeam(): CapabilityProbeBatchSeam {
  return {
    async run(): Promise<never> {
      throw new CapabilityProbeBatchNotImplementedError()
    },
  }
}

function validBatch(batch: CapabilityRefreshBatch): boolean {
  if (!isSafeIdentifier(batch.refreshId) || batch.probes.length > MAX_CAPABILITY_REFRESH_INTENTIONS) return false
  if (!Number.isSafeInteger(batch.endpointIntentions) || batch.endpointIntentions < 0 || batch.endpointIntentions > MAX_ENDPOINT_CAPABILITIES) return false
  const probeIds = new Set<string>()
  const checks = new Set<string>()
  const runtimes = new Set<string>()
  for (const probe of batch.probes) {
    if (!isSafeIdentifier(probe.probeId) || !isSafeIdentifier(probe.runtimeId)) return false
    if (probe.check !== 'version' && probe.check !== 'auth') return false
    if (probeIds.has(probe.probeId) || checks.has(`${probe.runtimeId}:${probe.check}`)) return false
    if (probe.request.kind !== 'probe' || probe.request.grantScoped || !probe.request.executable || probe.request.recipeId !== undefined) return false
    if (probe.request.args?.some(argument => typeof argument !== 'string' || hasControlCharacter(argument))) return false
    probeIds.add(probe.probeId)
    checks.add(`${probe.runtimeId}:${probe.check}`)
    runtimes.add(probe.runtimeId)
  }
  return runtimes.size <= MAX_CAPABILITY_REFRESH_RUNTIMES
}

function decide(policy: CommandPolicy | null, probe: CapabilityProbeIntent): CapabilityProbeDecision {
  if (!policy?.allowsExecutable(probe.request.executable!)) {
    return { status: 'refused', probeId: probe.probeId, runtimeId: probe.runtimeId, check: probe.check }
  }
  return {
    status: 'admitted',
    probeId: probe.probeId,
    runtimeId: probe.runtimeId,
    check: probe.check,
    vetted: {
      command: probe.request.executable!,
      args: [...(probe.request.args ?? [])],
      cwd: probe.request.cwd,
      spawnId: randomUUID(),
    },
  }
}

async function appendAdmission(audit: RunnerAuditLifecycle, batch: CapabilityRefreshBatch, at: string): Promise<boolean> {
  try {
    await audit.append({
      schemaVersion: 2,
      eventId: randomUUID(),
      at,
      kind: 'capability-refresh-admitted',
      refreshId: batch.refreshId,
      runtimeIds: [...new Set(batch.probes.map(probe => probe.runtimeId))].sort(),
      runtimeIntentions: batch.probes.length,
      endpointIntentions: batch.endpointIntentions,
    })
    return true
  } catch {
    return false
  }
}

async function appendOutcome(
  audit: RunnerAuditLifecycle,
  refreshId: string,
  outcome: CapabilityRefreshOutcome,
  at: string,
): Promise<boolean> {
  try {
    await audit.append({ schemaVersion: 2, eventId: randomUUID(), at, kind: 'capability-refresh-outcome', refreshId, ...outcome })
    return true
  } catch {
    return false
  }
}

function validOutcome(batch: CapabilityRefreshBatch, outcome: CapabilityRefreshOutcome): boolean {
  return counts(outcome.runtimeOutcomes) === batch.probes.length
    && counts(outcome.endpointOutcomes) === batch.endpointIntentions
    && typeof outcome.snapshotChanged === 'boolean'
}

function counts(values: Record<string, number>): number {
  const held = Object.values(values)
  return held.every(value => Number.isSafeInteger(value) && value >= 0)
    ? held.reduce((total, value) => total + value, 0)
    : -1
}

function failedOutcome(
  batch: CapabilityRefreshBatch,
  decisions: readonly CapabilityProbeDecision[],
): CapabilityRefreshOutcome {
  const refused = decisions.filter(decision => decision.status === 'refused').length
  return {
    runtimeOutcomes: { answered: 0, missing: 0, unanswered: batch.probes.length - refused, refused },
    endpointOutcomes: { available: 0, unavailable: batch.endpointIntentions, refused: 0 },
    snapshotChanged: false,
  }
}

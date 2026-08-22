import type {
  CapabilityEndpointOutcomeCounts,
  CapabilityRuntimeOutcomeCounts,
  RunnerAuditLifecycle,
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

export function createCapabilityProbeBatchSeam(_options: CapabilityProbeBatchOptions): CapabilityProbeBatchSeam {
  return createUnimplementedCapabilityProbeBatchSeam()
}

export function createUnimplementedCapabilityProbeBatchSeam(): CapabilityProbeBatchSeam {
  return {
    async run(): Promise<never> {
      throw new CapabilityProbeBatchNotImplementedError()
    },
  }
}

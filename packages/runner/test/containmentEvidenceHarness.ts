import {
  namespaceContainmentAvailable,
  type EvidenceState,
} from '../src/index.js'

export type ContainmentEvidenceResult =
  | { state: 'pass' }
  | { state: 'inconclusive'; capability: 'linux-user-network-namespace'; detail: string }
  | { state: 'not-applicable'; platform: NodeJS.Platform }

export type ContainmentEvidenceOptions = {
  platform?: NodeJS.Platform
  available?: () => boolean
}

export function probeContainmentEvidence(options: ContainmentEvidenceOptions = {}): ContainmentEvidenceResult {
  const platform = options.platform ?? process.platform
  if (platform !== 'linux') return { state: 'not-applicable', platform }
  const available = options.available ?? namespaceContainmentAvailable
  if (!available()) {
    return {
      state: 'inconclusive',
      capability: 'linux-user-network-namespace',
      detail: 'unprivileged user and network namespace creation with loopback setup was denied',
    }
  }
  return { state: 'pass' }
}

export function evidenceState(result: ContainmentEvidenceResult): EvidenceState {
  return result.state
}

export function requireContainmentPass(result: ContainmentEvidenceResult): asserts result is { state: 'pass' } {
  if (result.state === 'inconclusive') {
    throw new Error(`INCONCLUSIVE (${result.capability}): ${result.detail}`)
  }
  if (result.state === 'not-applicable') {
    throw new Error(`NOT_APPLICABLE (${result.platform}): Linux preview containment is outside this platform`)
  }
}

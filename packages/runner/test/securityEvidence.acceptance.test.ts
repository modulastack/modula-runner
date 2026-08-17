import { describe, expect, it } from 'vitest'
import { aggregateSecurityEvidence } from '../src/index.js'
import {
  evidenceState,
  probeContainmentEvidence,
  requireContainmentPass,
} from './containmentEvidenceHarness.js'

describe('CP-5 IC-5 tri-state security evidence', () => {
  it('AS-35 keeps denied namespace containment INCONCLUSIVE and non-green', () => {
    const containment = probeContainmentEvidence({ platform: 'linux', available: () => false })

    expect(containment).toEqual(expect.objectContaining({
      state: 'inconclusive',
      capability: 'linux-user-network-namespace',
    }))
    expect(() => requireContainmentPass(containment)).toThrow(/INCONCLUSIVE \(linux-user-network-namespace\)/)
    expect(aggregateSecurityEvidence({
      'runner-auth-trace': 'pass',
      'preview-containment': evidenceState(containment),
      'fallback-detection': 'pass',
    })).toEqual({ green: false, inconclusive: ['preview-containment'] })
  })

  it('AS-38 never hides an inconclusive or omitted required probe in aggregate CP-5 evidence', () => {
    expect(aggregateSecurityEvidence({})).toEqual({
      green: false,
      inconclusive: ['preview-containment', 'runner-auth-trace'],
    })
    expect(aggregateSecurityEvidence({ 'runner-auth-trace': 'pass' })).toEqual({
      green: false,
      inconclusive: ['preview-containment'],
    })
    expect(aggregateSecurityEvidence({ 'preview-containment': 'pass' })).toEqual({
      green: false,
      inconclusive: ['runner-auth-trace'],
    })
    expect(aggregateSecurityEvidence({
      'runner-auth-trace': 'inconclusive',
      'preview-containment': 'pass',
    })).toEqual({ green: false, inconclusive: ['runner-auth-trace'] })
    expect(aggregateSecurityEvidence({
      'runner-auth-trace': 'pass',
      'preview-containment': 'inconclusive',
    })).toEqual({ green: false, inconclusive: ['preview-containment'] })
    const bothInconclusive = aggregateSecurityEvidence({
      'runner-auth-trace': 'inconclusive',
      'preview-containment': 'inconclusive',
    })
    expect(bothInconclusive.green).toBe(false)
    expect([...bothInconclusive.inconclusive].sort()).toEqual(['preview-containment', 'runner-auth-trace'])
    expect(aggregateSecurityEvidence({
      'runner-auth-trace': 'pass',
      'preview-containment': 'pass',
    })).toEqual({ green: true, inconclusive: [] })
    expect(aggregateSecurityEvidence({
      'runner-auth-trace': 'pass',
      'preview-containment': 'not-applicable',
    })).toEqual({ green: true, inconclusive: [] })
  })
})

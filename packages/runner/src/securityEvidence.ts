// Tri-state security evidence (T-3; operator BLOCK-C ruling "degrade visibly, never silently").
// Some CP-5 invariants can only be *proven* on a host with a specific capability — syscall
// tracing for the runner-process auth trace, unprivileged network namespaces for preview
// containment. On a host without the capability the honest result is neither pass nor fail but
// INCONCLUSIVE: the probe could not run, so it must never be read as green. A probe that does not
// apply to the platform at all (Linux-only containment observed on macOS) is a third answer again —
// not a pass, but not a debt the gate should carry.
//
// This aggregates the named probes into one verdict: an inconclusive probe blocks the gate and is
// named so a reader sees which evidence is missing; a not-applicable probe is not counted against
// it; only all-pass, modulo not-applicable, is green. A green verdict therefore cannot hide a probe
// that never ran.

export type EvidenceState = 'pass' | 'inconclusive' | 'not-applicable'

// Named probe classes → their state. Keys are the evidence classes the gate reports on; the caller
// supplies every class it means to gate on, so a class it forgets to provide cannot read as green.
export type SecurityEvidence = Record<string, EvidenceState>

export type EvidenceVerdict = {
  green: boolean
  // The probe classes that are inconclusive, named so the gate can say which evidence is missing.
  inconclusive: string[]
}

// The capability-gated probes CP-5 cannot be green without. A caller that simply omits one must
// not get a green verdict — an absent probe is one that did not run, which is the whole failure
// mode the tri-state exists to catch — so a missing required class is treated as inconclusive.
export const REQUIRED_EVIDENCE_CLASSES = ['runner-auth-trace', 'preview-containment'] as const

export function aggregateSecurityEvidence(evidence: SecurityEvidence): EvidenceVerdict {
  const missing = REQUIRED_EVIDENCE_CLASSES.filter(cls => evidence[cls] === undefined)
  const reportedInconclusive = Object.keys(evidence).filter(cls => evidence[cls] === 'inconclusive')
  const inconclusive = [...new Set([...missing, ...reportedInconclusive])].sort()
  return { green: inconclusive.length === 0, inconclusive }
}

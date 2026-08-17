import {
  createGrants,
  createMemoryGrantStore,
  createSpawnSeam,
  type AuditLog,
  type AuditRecord,
  type CommandPolicy,
  type ConsentPolicy,
  type PreviewRecipe,
  type SpawnSeam,
} from '../src/index.js'

// Test doubles for the spawn seam. Production always injects a seam built from a verified
// allowlist; these let existing unit tests keep exercising a module's own behavior without
// re-deriving a signed allowlist, and let the routing integration tests deny by construction.

// Records every append so an integration test can assert a refusal was audited.
export function recordingAudit(): AuditLog & { records: AuditRecord[] } {
  const records: AuditRecord[] = []
  return { records, append: async record => void records.push(record) }
}

function permissivePolicy(recipes: Readonly<Record<string, PreviewRecipe>>): CommandPolicy {
  return {
    allowsExecutable: () => true,
    recipe: id => recipes[id] ?? null,
    executables: [],
    keyId: 'test-permissive',
  }
}

// A consent that grants any directory, resolving each to itself. The permissive seam now fails
// closed on a grant-scoped request with no consent (as production requires), so a seam whose
// allowlist decision is not what the test checks still needs a consent that simply says yes.
function allowAllConsent(): ConsentPolicy {
  return {
    resolveGrantedCwd: async cwd => cwd,
    isGrantedRealPath: async () => true,
  }
}

// A seam that permits every executable and resolves the recipes it is given. For modules whose
// own logic is under test, where the allowlist decision is not what the test is checking.
export function permissiveSpawnSeam(recipes: Readonly<Record<string, PreviewRecipe>> = {}): SpawnSeam {
  return createSpawnSeam({ policy: permissivePolicy(recipes), audit: recordingAudit(), consent: allowAllConsent() })
}

// A seam whose policy is empty: nothing is allowlisted, no recipe resolves. For the routing
// integration tests, whose whole point is that a denied policy stops a real spawn.
export function denyingSpawnSeam(audit: AuditLog = recordingAudit()): SpawnSeam {
  return createSpawnSeam({ policy: null, audit })
}

// A consent that grants the given directories, for modules whose own behavior is under test and
// that just need a real grant surface behind the seam.
export function permissiveConsent(grantedPaths: readonly string[] = []): ConsentPolicy {
  return createGrants({ store: createMemoryGrantStore(grantedPaths) })
}

// A permissive seam wired to a consent that grants `grantedPaths`, returned alongside that same
// consent so a caller can hand it to a PreviewHost for the post-spawn read-back — the seam and
// the host must share one consent, the whole point of consent living in one place.
export function grantingSpawnSeam(
  recipes: Readonly<Record<string, PreviewRecipe>> = {},
  grantedPaths: readonly string[] = [],
): { seam: SpawnSeam; consent: ConsentPolicy } {
  const consent = permissiveConsent(grantedPaths)
  const seam = createSpawnSeam({ policy: permissivePolicy(recipes), audit: recordingAudit(), consent })
  return { seam, consent }
}

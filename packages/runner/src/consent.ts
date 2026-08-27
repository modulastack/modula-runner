import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { hasControlCharacter } from '@modulastack/runner-protocol'
import type { ConsentPolicy } from './spawnSeam.js'

// Per-directory consent: the runner operates only inside directories the operator granted, and
// that decision lives here, once, behind the seam. Every grant-scoped spawn resolves its cwd to
// a real path and checks containment against the granted real paths — a symlink out of a grant
// or a `..` climb is caught because the question the grant answers is "which directory will the
// command actually run in", not "which string was asked for". Grants are local: added and
// revoked through the runner's own CLI, never over the wire, so a compromised control plane can
// name a directory but can neither grant one nor widen an existing grant.
//
// The residual is stated honestly rather than hidden: the resolved path can be swapped between
// the check and the exec. On Linux the running process's own working directory is read back
// from `/proc` and re-checked, closing that window; where that read-back is unavailable the
// window stays open and `cwdReadBackAvailable` says so, so a platform's limit is never dressed
// up as a guarantee.

export type GrantRecord = {
  // The resolved real path at grant time. Stored resolved so a later containment check compares
  // real paths on both sides, and a grant whose target is replaced by a symlink does not silently
  // start covering somewhere else.
  path: string
  // The lexical path the operator granted, kept only so a revoke can name the grant the way it was
  // created even after the alias's symlink is retargeted or deleted — without it, a moved alias
  // resolves elsewhere and the revoke silently misses a still-live grant. Never used for the
  // containment decision, which is `path` alone.
  alias?: string
  grantedAt: string
  revokedAt?: string
}

// The runner's grant surface: the seam's consent gate plus the local operator flow. Extends
// ConsentPolicy so one object answers both the pre-spawn admission (`resolveGrantedCwd`) and the
// post-spawn read-back (`isGrantedRealPath`).
export interface Grants extends ConsentPolicy {
  list(): Promise<string[]>
  grant(dir: string): Promise<string>
  revoke(dir: string): Promise<void>
  // True where the runner can read a running process's working directory back (Linux). Honest
  // by construction: a surface that reports this false is telling the operator the resolve-then-
  // enter window is open on their platform.
  readonly cwdReadBackAvailable: boolean
}

// Whether `resolved` lies within `granted`, both already real paths. A grant contains itself and
// anything beneath it; a sibling that merely shares a name prefix (`/g/project-escape` under
// `/g/project`) does not, which a plain string prefix would get wrong.
export function isContained(granted: string, resolved: string): boolean {
  const relative = path.relative(granted, resolved)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export type GrantsOptions = {
  // Injected so tests can hold grants in memory and the daemon can persist them locally, the same
  // split the key and pairing stores use.
  store: GrantStore
  // Overridable so the read-back path can be exercised on either branch under test; defaults to
  // the real platform check.
  cwdReadBackAvailable?: boolean
}

// The persistence the grant rules run over. Grants are operator-chosen directory paths — local
// configuration, not secrets — so this is plain local storage, not the encrypted store keys use.
export type GrantStore = {
  read(): Promise<GrantRecord[]>
  write(records: GrantRecord[]): Promise<void>
  serialize<T>(operation: () => Promise<T>): Promise<T>
}

export function createGrants(options: GrantsOptions): Grants {
  const store = options.store
  const cwdReadBackAvailable = options.cwdReadBackAvailable ?? process.platform === 'linux'

  // The stored real path *is* the grant boundary, taken verbatim and never re-resolved. Resolving
  // it again at check time would let a grant be retargeted after the fact: rename the granted
  // directory and drop a symlink at its old pathname, and a re-resolve would follow that symlink
  // and silently grant wherever it points. A grant is a fixed real path; if its target is moved
  // away, no cwd resolves under the stale path and it matches nothing, which is the safe outcome —
  // the operator re-grants the new location, the runner does not chase the old name.
  // Read through the store's serialization boundary, the same one grant/revoke mutate under, so an
  // admission check cannot straddle a revoke's read-modify-write and act on a pre-revocation
  // snapshot. Without this a spawn could be admitted against a grant the operator has just revoked.
  const liveGrantPaths = () =>
    store.serialize(async () => (await store.read()).filter(record => record.revokedAt === undefined).map(record => record.path))

  const contains = async (resolved: string) => (await liveGrantPaths()).some(granted => isContained(granted, resolved))

  return {
    cwdReadBackAvailable,
    resolveGrantedCwd: async cwd => {
      const resolved = await resolveRealPath(cwd)
      if (resolved === null) return null
      return (await contains(resolved)) ? resolved : null
    },
    isGrantedRealPath: resolved => contains(resolved),
    list: () => liveGrantPaths(),
    grant: dir =>
      store.serialize(async () => {
        const resolved = await resolveRealPath(dir)
        if (resolved === null) throw new Error(`cannot grant a directory that does not resolve: ${dir}`)
        const records = await store.read()
        // Idempotent: a directory already live as a grant is not added twice, so listing it stays
        // a single entry and a re-grant is not a way to multiply records.
        if (records.some(record => record.revokedAt === undefined && record.path === resolved)) return resolved
        await store.write([...records, { path: resolved, alias: path.resolve(dir), grantedAt: new Date().toISOString() }])
        return resolved
      }),
    revoke: dir =>
      store.serialize(async () => {
        const resolved = await resolveRealPath(dir)
        const lexical = path.resolve(dir)
        const records = await store.read()
        const revokedAt = new Date().toISOString()
        // Revocation marks the record rather than deleting it, and it governs only new admissions:
        // a pane already running was admitted against a live grant and is not reached from here. A
        // grant is reached by its current real target, its lexical spelling, or the spelling it was
        // granted under — so revoking by the name the operator used still lands after that name's
        // symlink has been retargeted or deleted, rather than silently leaving the grant live.
        await store.write(
          records.map(record =>
            record.revokedAt === undefined && (record.path === resolved || record.path === lexical || record.alias === lexical)
              ? { ...record, revokedAt }
              : record,
          ),
        )
      }),
  }
}

// An in-memory grant store, for tests and for a runner that has not been told where to persist.
export function createMemoryGrantStore(initial: readonly string[] = []): GrantStore {
  let records: GrantRecord[] = initial.map(target => ({ path: path.resolve(target), grantedAt: '1970-01-01T00:00:00.000Z' }))
  let queue: Promise<unknown> = Promise.resolve()
  return {
    read: async () => records.map(record => ({ ...record })),
    write: async next => {
      records = next.map(record => ({ ...record }))
    },
    serialize: operation => {
      const result = queue.then(operation, operation)
      // The queue only orders operations; a failed one reports to its own caller and must not
      // poison the chain for the next writer.
      queue = result.catch(() => {})
      return result
    },
  }
}

// Resolve a caller's cwd to its real path, or null when it does not resolve — an unresolvable
// path is ungranted, never granted by default. Shared by the admission check and available to the
// read-back so both ask the filesystem the same question.
export async function resolveRealPath(cwd: string): Promise<string | null> {
  // Unresolvable means ungranted: a path that does not exist, or that permissions hide, resolves
  // to null and flows to a refusal, never to permission by default.
  try {
    const resolved = await realpath(path.resolve(cwd))
    return hasControlCharacter(resolved) ? null : resolved
  } catch {
    return null
  }
}

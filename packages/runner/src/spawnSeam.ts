import { randomUUID } from 'node:crypto'
import type { RefusalReason } from '@modulastack/runner-protocol'
import type { AuditLog, SpawnOutcome } from './auditLog.js'
import type { CommandPolicy } from './allowlist.js'

// The single seam every runner-owned spawn passes through. "Runner-owned" means a process the
// runner itself decides to create — a pane's command, a preview recipe, the runner's own git
// and tmux and capability-probe calls. It does not mean what those programs spawn afterward:
// an allowed CLI can launch anything, and confining that needs OS mediation this slice does not
// build. The seam's job is the security decision and its record, made in one place so the floor
// has exactly one choke point instead of four copies drifting apart.
//
// Two things happen here and nowhere else: the allowlist decides whether the executable (or
// recipe) may run, and the audit log records that it did or that it was refused. Consent —
// whether the cwd is granted — is checked here too when a request is grant-scoped, through an
// injected policy a later slice fills in. The seam owns the decision, not the mechanics: a
// caller receives a *vetted* command to spawn with its own machinery (execFile, a detached
// spawn, a pty), which keeps the preview host's process-tree logic where it lives while its
// authorization and audit run through the one gate.

export type SpawnKind = 'pane' | 'preview' | 'git' | 'tmux' | 'probe'

// A request to run a process. Exactly one of `executable` or `recipeId` is meaningful: a direct
// executable (pane, git, tmux, probe) is checked against the allowlist's executable set and its
// args are the runner's own; a `recipeId` (preview) resolves to a signed recipe whose command
// AND args come from the allowlist, never from the caller, because caller-supplied argv under an
// allowlisted interpreter is arbitrary execution.
export type SpawnRequest = {
  kind: SpawnKind
  executable?: string
  recipeId?: string
  // Extra args for a direct executable. Ignored for a recipe — a recipe carries its own.
  args?: readonly string[]
  cwd: string
  // Whether the cwd must lie inside a granted directory. True for panes and previews; false for
  // the runner's own machinery (a probe runs in a temp dir, git runs in the repo it provisions).
  grantScoped: boolean
  // The wire request this spawn answers, when there is one, so a refusal's audit line and the
  // REFUSED frame name the same event. Absent for the runner's internal spawns.
  requestId?: string
}

// What the caller spawns with once authorized. The command and args are the seam's, resolved
// from the policy, so a caller cannot widen what it was cleared to run.
export type VettedSpawn = {
  command: string
  args: readonly string[]
  cwd: string
  spawnId: string
}

// A live authorization for a long-lived process. The admission is already audited; `complete`
// writes the terminal outcome when the process ends. It is safe to call once — a second call is
// a no-op — because an append-only log must not record two ends for one spawn.
export type Authorization = {
  vetted: VettedSpawn
  complete(outcome: SpawnOutcome): Promise<void>
  // Post-spawn cwd read-back, bound to the SAME consent this admission resolved against, so the
  // re-check cannot consult a different grant set than admission did. Present only for grant-scoped
  // admissions — the only ones with a grant to re-verify — and answers, of an already-resolved real
  // directory a process actually landed in, whether it is still inside a live grant. The caller
  // owns reading where the process is and deciding what "unavailable" means on its platform; the
  // seam owns only the grant question.
  verifyLanding?(resolvedRealCwd: string): Promise<boolean>
}

// A refusal carries the wire-mappable reason and, when the cause is local rather than a policy
// decision, a human-readable detail. Audit unavailability is the case that needs both: there is
// no wire reason for "the log is down" (adding one would bump the protocol version, which this
// slice does not), so it maps to the existing `spawn-failed` while the local detail says the
// truth — audit durability prevented execution.
export type SeamRefusal = {
  reason: RefusalReason
  local?: string
}

export type AuthorizeResult =
  | { status: 'admitted'; authorization: Authorization }
  | ({ status: 'refused' } & SeamRefusal)

export type RunResult<T> =
  | { status: 'ran'; value: T }
  | ({ status: 'refused' } & SeamRefusal)

// Resolves a grant-scoped cwd to its granted real path, or null if the directory is not
// granted. Injected so the consent slice fills it in without reshaping the seam. A grant-scoped
// request with no consent to consult fails closed — an unprovable grant is a refused one, never
// taken as-is. `isGrantedRealPath` is the post-spawn read-back's question — an already-resolved
// path's containment — kept on the same interface so one consent object answers both the
// admission and the re-check.
export interface ConsentPolicy {
  resolveGrantedCwd(cwd: string): Promise<string | null>
  isGrantedRealPath(resolved: string): Promise<boolean>
}

export type SpawnSeamOptions = {
  // The verified allowlist. Null when no trusted allowlist is loaded — the fail-closed state in
  // which nothing is spawnable, because an unverifiable policy is not a permissive one.
  policy: CommandPolicy | null
  audit: AuditLog
  consent?: ConsentPolicy
  now?: () => number
}

export interface SpawnSeam {
  // The pure allowlist decision, no audit and no admission. For the runner's own
  // high-frequency operations on an already-authorized resource — polling a tmux session it
  // created — where re-auditing every poll would flood the log for no security gain: the
  // session's creation was gated and audited once, and a poll that finds the executable
  // no longer permitted simply does not run. Returns false under a null policy, so the
  // fail-closed state denies here too.
  check(executable: string, recipeId?: string): boolean
  // Record a refusal the caller itself decided, after or outside an admission the seam does not
  // see — a preview refused for binding off loopback, or turned away while the host is shutting
  // down. Shapes the same durable `refused` record `authorize` writes, so every security refusal
  // is audited in one form regardless of which layer noticed it.
  recordRefusal(request: SpawnRequest, reason: RefusalReason): Promise<void>
  // Authorize a long-lived spawn. Policy and consent are decided and an admission is audited
  // before this resolves `admitted`; the caller then spawns with `vetted` and wires the exit to
  // `complete`. A refusal is audited too, and no admission record is written for it.
  authorize(request: SpawnRequest): Promise<AuthorizeResult>
  // Authorize a bounded command whose outcome is known when it returns. Implemented over
  // authorize(): the callback runs only if admitted, receives the vetted spawn, and returns the
  // outcome the seam then records.
  run<T>(
    request: SpawnRequest,
    runner: (vetted: VettedSpawn) => Promise<{ outcome: SpawnOutcome; value: T }>,
  ): Promise<RunResult<T>>
}

export function createSpawnSeam(options: SpawnSeamOptions): SpawnSeam {
  const now = options.now ?? Date.now
  const at = () => new Date(now()).toISOString()

  // A recipe's command and args come from the policy, never the request: a caller-supplied argv
  // under an allowlisted interpreter is arbitrary execution, so a preview names an id and the
  // seam supplies the whole command line. A direct executable is checked by name; its args are
  // the runner's own machinery, not the wire's. A null policy is the fail-closed state — an
  // unverifiable allowlist is not a permissive one — so nothing resolves and everything refuses.
  const resolve = (request: SpawnRequest): { command: string; args: readonly string[] } | null => {
    if (request.recipeId !== undefined) {
      const recipe = options.policy?.recipe(request.recipeId)
      return recipe ? { command: recipe.command, args: recipe.args } : null
    }
    if (request.executable !== undefined && options.policy?.allowsExecutable(request.executable)) {
      return { command: request.executable, args: request.args ?? [] }
    }
    return null
  }

  const check = (executable: string, recipeId?: string): boolean => {
    if (recipeId !== undefined) return options.policy?.recipe(recipeId) != null
    return options.policy?.allowsExecutable(executable) ?? false
  }

  const auditRefusal = (request: SpawnRequest, reason: RefusalReason) =>
    options.audit.append({
      kind: 'refused',
      requestId: request.requestId ?? null,
      // A refusal names what the request named, not what it resolved to — an unknown recipe has
      // no command to record, and a refused executable is exactly the one asked for.
      executable: request.recipeId !== undefined ? null : (request.executable ?? null),
      recipeId: request.recipeId ?? null,
      cwd: request.cwd ?? null,
      reason,
      at: at(),
    })

  const authorize = async (request: SpawnRequest): Promise<AuthorizeResult> => {
    const resolved = resolve(request)
    if (!resolved) {
      await auditRefusal(request, 'not-allowlisted')
      return { status: 'refused', reason: 'not-allowlisted' }
    }
    // A grant-scoped request requires a grant, so it fails closed: with no consent policy to
    // consult there is no way to prove the cwd is granted, and an unprovable grant is a refused
    // one — never taken as-is. With consent present, an ungranted cwd is refused the same way.
    let cwd = request.cwd
    if (request.grantScoped) {
      if (!options.consent) {
        await auditRefusal(request, 'path-not-granted')
        return { status: 'refused', reason: 'path-not-granted' }
      }
      const granted = await options.consent.resolveGrantedCwd(request.cwd)
      if (granted === null) {
        await auditRefusal(request, 'path-not-granted')
        return { status: 'refused', reason: 'path-not-granted' }
      }
      cwd = granted
    }
    const spawnId = randomUUID()
    // The admission is recorded and made durable before the process is allowed to exist. If it
    // cannot be — the log is unwritable — the spawn does not happen: an execution the runner
    // cannot account for is the one the audit log exists to prevent. There is no wire reason for
    // a down log without bumping the protocol, so it maps to `spawn-failed` and the local detail
    // carries the truth.
    try {
      await options.audit.append({
        kind: 'spawn-admitted',
        spawnId,
        executable: request.recipeId !== undefined ? resolved.command : (request.executable ?? null),
        recipeId: request.recipeId ?? null,
        cwd,
        at: at(),
      })
    } catch {
      return { status: 'refused', reason: 'spawn-failed', local: 'audit durability prevented execution' }
    }
    let completion: Promise<void> | undefined
    const complete = (outcome: SpawnOutcome): Promise<void> => {
      // The in-flight append is coalesced so concurrent terminal callbacks record one end, and a
      // resolved one makes repeat calls no-ops — an append-only log must not record two ends for
      // one spawn. But a REJECTED append clears the latch, because a failed outcome write left
      // nothing durable: the admission is still unmatched, and a retry must be able to record it.
      if (completion) return completion
      completion = options.audit.append({ kind: 'spawn-outcome', spawnId, outcome, at: at() }).catch(error => {
        completion = undefined
        throw error
      })
      return completion
    }
    const authorization: Authorization = { vetted: { command: resolved.command, args: resolved.args, cwd, spawnId }, complete }
    // Only a grant-scoped admission has a grant to re-verify, and only then is consent present.
    // Bound here rather than handed the raw policy so the read-back and the admission share one
    // consent object by construction.
    if (request.grantScoped && options.consent) {
      const consent = options.consent
      authorization.verifyLanding = resolvedRealCwd => consent.isGrantedRealPath(resolvedRealCwd)
    }
    return { status: 'admitted', authorization }
  }

  const run: SpawnSeam['run'] = async (request, runner) => {
    const authorization = await authorize(request)
    if (authorization.status === 'refused') return authorization
    const { vetted, complete } = authorization.authorization
    // The runner itself failing is recorded as `spawnFailed` so the reconciliation is not left
    // with an admission and no outcome; a failed OUTCOME append is a separate matter, handled
    // below, and must never be mistaken for a failed run. If even that record cannot be made
    // durable the failure is surfaced as a durability error (the runner's error is its cause),
    // failing closed rather than reporting a command failure whose outcome was never recorded.
    const observed = await runner(vetted).catch(async error => {
      if (!(await completeDurably(complete, { spawnFailed: true }))) {
        throw new Error('audit durability prevented recording the spawn outcome', { cause: error })
      }
      throw error
    })
    // The runner succeeded; its observed outcome is the record, retried through a transient append
    // failure rather than overwritten with `spawnFailed`. If durability cannot be reached the run
    // is not acknowledged — an outcome the runner cannot record is the case the audit exists for.
    if (!(await completeDurably(complete, observed.outcome))) {
      throw new Error('audit durability prevented recording the spawn outcome')
    }
    return { status: 'ran', value: observed.value }
  }

  return { check, recordRefusal: auditRefusal, authorize, run }
}

// Retries a spawn's outcome completion until the record is durable, bounded. A rejected append
// clears the completion latch, so this re-drives it through a transient audit failure. It returns
// whether durability was reached: a caller that gates an acknowledgment on the outcome — a pane
// EXIT, a preview exit — must withhold that acknowledgment on false rather than claim a record it
// does not have (AS-21), failing closed when the log cannot be written.
const OUTCOME_APPEND_ATTEMPTS = 5
const OUTCOME_APPEND_RETRY_MS = 100

export async function completeDurably(complete: (outcome: SpawnOutcome) => Promise<void>, outcome: SpawnOutcome): Promise<boolean> {
  for (let attempt = 0; attempt < OUTCOME_APPEND_ATTEMPTS; attempt += 1) {
    try {
      await complete(outcome)
      return true
    } catch {
      // The append failed and the latch has cleared, so a retry re-appends. Only a transient
      // failure recovers here; a persistently unwritable log exhausts the attempts and the caller
      // fails closed. The failure is surfaced through the audit writer's onFailure signal.
      if (attempt < OUTCOME_APPEND_ATTEMPTS - 1) await new Promise(resolve => setTimeout(resolve, OUTCOME_APPEND_RETRY_MS))
    }
  }
  return false
}

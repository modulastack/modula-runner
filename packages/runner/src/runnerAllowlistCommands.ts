import path from 'node:path'
import {
  DEFAULT_ALLOWLIST_EXECUTABLES,
  decodeAllowlistDocument,
  signAllowlist,
  trustSignedAllowlist,
} from './allowlist.js'
import {
  createAllowlistSigningKeyFile,
  readAllowlistDocumentFile,
  readAllowlistSigningKeyFile,
} from './allowlistKeyFile.js'
import type { RunnerHome, RunnerHomeSelection, RunnerHomeState, RunnerPolicySnapshot } from './runnerHome.js'

export type AllowlistCommandOutcome = {
  exitCode: 0 | 1 | 2
  stdout?: string
  stderr?: string
}

export function allowlistCommandSyntax(args: readonly string[], cwd: string): string | null {
  if (args[0] === 'verify' && args.length === 1) return null
  if (args[0] === 'init' && args.length === 3 && args[1] === '--key' && safeResolvedPath(cwd, args[2])) return null
  if (args[0] === 'sign' && args.length === 5 && args[1] === '--key' && args[3] === '--input') {
    return safeResolvedPath(cwd, args[2]) && safeResolvedPath(cwd, args[4]) ? null : usage()
  }
  return usage()
}

export async function runAllowlistInit(
  home: RunnerHome,
  selection: RunnerHomeSelection,
  cwd: string,
  args: readonly string[],
): Promise<AllowlistCommandOutcome> {
  const keyPath = path.resolve(cwd, args[2]!)
  if (!home.validateSigningKeyPath || !home.initializePolicy) return failed('state-io-failed')
  const pathFailure = await home.validateSigningKeyPath(selection, keyPath)
  if (pathFailure) return failed(pathFailure)
  const existing = await home.open(selection)
  if (existing.status === 'ready') {
    try {
      await home.close?.()
    } catch {
      return failed('state-io-failed')
    }
    return { exitCode: 1, stderr: 'allowlist policy already exists' }
  }
  if (existing.code !== 'policy-missing') return failed(existing.code)
  let generated: Awaited<ReturnType<typeof createAllowlistSigningKeyFile>>
  try {
    generated = await createAllowlistSigningKeyFile(keyPath)
  } catch {
    try {
      generated = await readAllowlistSigningKeyFile(keyPath)
    } catch {
      return { exitCode: 1, stderr: 'allowlist signing key was not created' }
    }
  }
  const policy: RunnerPolicySnapshot = {
    revision: 1,
    allowlist: signAllowlist({ executables: DEFAULT_ALLOWLIST_EXECUTABLES, recipes: {} }, generated.signingKey),
    trustAnchors: [generated.trustAnchor],
  }
  const initialized = await home.initializePolicy(selection, keyPath, policy)
  if (initialized.status === 'initialized') return { exitCode: 0, stdout: `allowlist initialized with key ${generated.signingKey.keyId}` }
  if (initialized.status === 'exists') return { exitCode: 1, stderr: 'allowlist policy already exists; the new key was retained for inspection' }
  return failed(initialized.code)
}

export async function runAllowlistCommand(
  args: readonly string[],
  cwd: string,
  home: RunnerHomeState,
): Promise<AllowlistCommandOutcome> {
  if (args[0] === 'verify') {
    const policy = await home.policyStore.snapshot()
    const trusted = trustSignedAllowlist(policy.allowlist, policy.trustAnchors)
    return trusted.status === 'trusted'
      ? { exitCode: 0, stdout: `allowlist verified with key ${trusted.policy.keyId}` }
      : { exitCode: 1, stderr: `allowlist verification failed: ${trusted.reason}` }
  }
  return await signPolicy(args, cwd, home)
}

async function signPolicy(
  args: readonly string[],
  cwd: string,
  home: RunnerHomeState,
): Promise<AllowlistCommandOutcome> {
  try {
    const key = await readAllowlistSigningKeyFile(path.resolve(cwd, args[2]!))
    const document = decodeAllowlistDocument(await readAllowlistDocumentFile(path.resolve(cwd, args[4]!)))
    if (!document) return { exitCode: 1, stderr: 'allowlist document is malformed' }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await home.policyStore.snapshot()
      const anchor = current.trustAnchors.find(candidate => candidate.keyId === key.signingKey.keyId)
      if (!anchor) return { exitCode: 1, stderr: 'signing key is not trusted by this runner home' }
      const result = await home.policyStore.replace(current.revision, {
        allowlist: signAllowlist(document, key.signingKey),
        trustAnchors: current.trustAnchors,
      })
      if (result.status === 'updated') return { exitCode: 0, stdout: `allowlist signed with key ${key.signingKey.keyId}` }
      if (result.status === 'storage-unavailable') return failed('state-io-failed')
    }
    return { exitCode: 1, stderr: 'allowlist policy remained conflicted' }
  } catch {
    return { exitCode: 1, stderr: 'allowlist was not signed' }
  }
}

function safeResolvedPath(cwd: string, candidate: string | undefined): boolean {
  if (!candidate) return false
  const resolved = path.resolve(cwd, candidate)
  return resolved.length <= 4_096 && !/[\u0000-\u001f\u007f]/.test(resolved)
}

function failed(code: string): AllowlistCommandOutcome {
  return { exitCode: 1, stderr: `${code}: allowlist operation failed` }
}

function usage(): string {
  return 'usage: modula-runner allowlist init --key <path> | sign --key <path> --input <json> | verify'
}

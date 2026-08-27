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
import { createTrustRotationAuthorization, decodeTrustAnchors, sameRunnerPolicy } from './runnerTrustStore.js'

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
  if (args[0] === 'trust' && args[1] === 'rotate' && args.length === 6
    && args[2] === '--authorizing-key' && args[4] === '--anchors') {
    return safeResolvedPath(cwd, args[3]) && safeResolvedPath(cwd, args[5]) ? null : usage()
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
    let outcome: AllowlistCommandOutcome
    try {
      const heldKey = await readExistingSigningKey(keyPath)
      const current = await existing.home.policyStore.snapshot()
      const requested = heldKey && initialPolicy(heldKey)
      outcome = requested && (sameRunnerPolicy(current, requested) || sameBootstrapKey(current, heldKey))
        ? { exitCode: 0, stdout: `allowlist already initialized with key ${heldKey.signingKey.keyId}` }
        : { exitCode: 1, stderr: 'allowlist policy already exists' }
    } catch {
      outcome = failed('state-io-failed')
    }
    try {
      await home.close?.()
    } catch {
      return failed('state-io-failed')
    }
    return outcome
  }
  if (existing.code !== 'policy-missing' && existing.code !== 'policy-trust-migration-required') return failed(existing.code)
  let generated: Awaited<ReturnType<typeof createAllowlistSigningKeyFile>>
  try {
    generated = existing.code === 'policy-trust-migration-required'
      ? await readAllowlistSigningKeyFile(keyPath)
      : await createOrReadSigningKey(keyPath)
  } catch {
    return { exitCode: 1, stderr: 'allowlist signing key was not created' }
  }
  const policy = initialPolicy(generated)
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
  if (args[0] === 'trust') return await rotateTrust(args, cwd, home)
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

async function rotateTrust(
  args: readonly string[],
  cwd: string,
  home: RunnerHomeState,
): Promise<AllowlistCommandOutcome> {
  try {
    if (!home.policyStore.rotateTrust) return failed('state-io-failed')
    const key = await readAllowlistSigningKeyFile(path.resolve(cwd, args[3]!))
    const anchors = decodeTrustAnchors(await readAllowlistDocumentFile(path.resolve(cwd, args[5]!)))
    if (!anchors) return { exitCode: 1, stderr: 'trust anchors are malformed' }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await home.policyStore.snapshot()
      const authorization = createTrustRotationAuthorization(current, anchors, key.signingKey)
      const result = await home.policyStore.rotateTrust(current.revision, anchors, authorization)
      if (result.status === 'updated') return { exitCode: 0, stdout: `trust anchors rotated by key ${key.signingKey.keyId}` }
      if (result.status === 'unauthorized') return { exitCode: 1, stderr: 'trust rotation was not authorized' }
      if (result.status === 'storage-unavailable') return failed('state-io-failed')
    }
    return { exitCode: 1, stderr: 'trust rotation remained conflicted' }
  } catch {
    return { exitCode: 1, stderr: 'trust anchors were not rotated' }
  }
}

async function createOrReadSigningKey(path: string) {
  try {
    return await createAllowlistSigningKeyFile(path)
  } catch {
    return await readAllowlistSigningKeyFile(path)
  }
}

function initialPolicy(
  key: Awaited<ReturnType<typeof readAllowlistSigningKeyFile>>,
): RunnerPolicySnapshot {
  return {
    revision: 1,
    allowlist: signAllowlist({ executables: DEFAULT_ALLOWLIST_EXECUTABLES, recipes: {} }, key.signingKey),
    trustAnchors: [key.trustAnchor],
  }
}

function sameBootstrapKey(
  current: RunnerPolicySnapshot,
  key: Awaited<ReturnType<typeof readAllowlistSigningKeyFile>>,
): boolean {
  const [anchor] = current.trustAnchors
  return current.revision === 1
    && current.trustAnchors.length === 1
    && anchor?.keyId === key.trustAnchor.keyId
    && anchor.publicKey === key.trustAnchor.publicKey
}

async function readExistingSigningKey(path: string) {
  try {
    return await readAllowlistSigningKeyFile(path)
  } catch {
    // An absent key means this is not an idempotent same-key bootstrap retry.
    return null
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
  return 'usage: modula-runner allowlist init --key <path> | sign --key <path> --input <json> | verify | trust rotate --authorizing-key <path> --anchors <json>'
}

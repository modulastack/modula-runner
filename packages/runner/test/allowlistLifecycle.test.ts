import { generateKeyPairSync } from 'node:crypto'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_ALLOWLIST_EXECUTABLES,
  createAllowlistSigningKeyFile,
  createFileRunnerHome,
  createRunnerHome,
  decodeAllowlistDocument,
  generateAllowlistSigningKey,
  readAllowlistSigningKeyFile,
  signAllowlist,
  signingKeyOutsideHome,
  verifyAllowlistSignature,
  type RunnerHomeStorage,
} from '../src/index.js'

const roots: string[] = []
const clock = { now: () => Date.parse('2026-08-22T00:00:00Z'), sleep: async () => undefined }

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function secureDirectory(prefix: string) {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  roots.push(root)
  return root
}

describe('allowlist signing-key custody and policy bootstrap', () => {
  it('creates one private Ed25519 key without overwrite and reads it through descriptor custody', async () => {
    const root = await secureDirectory('runner-allowlist-key-')
    const keyPath = path.join(root, 'operator.pem')
    const previousUmask = process.umask(0o200)
    let generated: Awaited<ReturnType<typeof createAllowlistSigningKeyFile>>
    try {
      generated = await createAllowlistSigningKeyFile(keyPath)
    } finally {
      process.umask(previousUmask)
    }
    const info = await lstat(keyPath)
    expect(info.mode & 0o777).toBe(0o600)
    expect(info.nlink).toBe(1)
    const read = await readAllowlistSigningKeyFile(keyPath)
    expect(read.signingKey.keyId).toBe(generated.signingKey.keyId)
    const signed = signAllowlist({ executables: ['git'], recipes: {} }, read.signingKey)
    expect(verifyAllowlistSignature(signed, read.trustAnchor)).toBe(true)
    const original = await readFile(keyPath, 'utf8')
    await expect(createAllowlistSigningKeyFile(keyPath)).rejects.toThrow('already exists')
    expect(await readFile(keyPath, 'utf8')).toBe(original)
  })

  it('rejects non-Ed25519 and arbitrary-id signing identities', () => {
    const ed448 = generateKeyPairSync('ed448')
    expect(() => signAllowlist(
      { executables: ['git'], recipes: {} },
      { keyId: 'arbitrary', privateKey: ed448.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
    )).toThrow('Ed25519')
    const ed25519 = generateKeyPairSync('ed25519')
    expect(() => signAllowlist(
      { executables: ['git'], recipes: {} },
      { keyId: 'arbitrary', privateKey: ed25519.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
    )).toThrow('does not match')
  })

  it('rejects permissive, linked, and symlinked private keys', async () => {
    const root = await secureDirectory('runner-allowlist-key-custody-')
    const keyPath = path.join(root, 'operator.pem')
    await createAllowlistSigningKeyFile(keyPath)
    await chmod(keyPath, 0o644)
    await expect(readAllowlistSigningKeyFile(keyPath)).rejects.toThrow('custody')
    await chmod(keyPath, 0o600)
    await link(keyPath, path.join(root, 'hard-link.pem'))
    await expect(readAllowlistSigningKeyFile(keyPath)).rejects.toThrow('custody')

    const alias = path.join(root, 'alias.pem')
    await symlink(keyPath, alias)
    await expect(readAllowlistSigningKeyFile(alias)).rejects.toThrow()
  })

  it('initializes signed policy once and opens the resulting file home', async () => {
    const parent = await secureDirectory('runner-allowlist-bootstrap-')
    const homeRoot = path.join(parent, 'home')
    const keyRoot = path.join(parent, 'operator-keys')
    await mkdir(keyRoot, { mode: 0o700 })
    const keyPath = path.join(keyRoot, 'allowlist.pem')
    const generated = await createAllowlistSigningKeyFile(keyPath)
    const allowlist = { executables: DEFAULT_ALLOWLIST_EXECUTABLES, recipes: {} }
    const policy = {
      revision: 1,
      allowlist: signAllowlist(allowlist, generated.signingKey),
      trustAnchors: [generated.trustAnchor],
    }
    const home = createFileRunnerHome({ defaultRoot: homeRoot, clock })
    await expect(home.initializePolicy?.({}, keyPath, policy)).resolves.toMatchObject({ status: 'initialized' })
    await expect(home.initializePolicy?.({}, keyPath, policy)).resolves.toEqual({ status: 'initialized', policy })
    await expect(home.open({})).resolves.toMatchObject({ status: 'ready', home: { policy: { keyId: generated.signingKey.keyId } } })
    await home.close?.()
    expect(signingKeyOutsideHome(keyPath, homeRoot)).toBe(true)
  })

  it('attempts storage close even when bootstrap lock release fails', async () => {
    let releases = 0
    let closes = 0
    const storage: RunnerHomeStorage = {
      inspect: async () => ({ rootKind: 'directory', rootOwner: 'current-user', rootMode: 0o700, entries: [] }),
      acquire: async () => 'acquired',
      release: async () => { releases += 1; throw new Error('release failed') },
      close: async () => { closes += 1 },
      read: async () => ({ status: 'missing' }),
      replace: async () => ({ status: 'written', sha256: 'a'.repeat(64) }),
    }
    const generated = generateAllowlistSigningKey()
    const policy = {
      revision: 1,
      allowlist: signAllowlist({ executables: ['git'], recipes: {} }, generated.signingKey),
      trustAnchors: [generated.trustAnchor],
    }
    const home = createRunnerHome({ storage, clock })
    await expect(home.initializePolicy?.({}, '/outside/operator.pem', policy)).resolves.toEqual({ status: 'failed', code: 'state-io-failed' })
    expect({ releases, closes }).toEqual({ releases: 1, closes: 1 })
  })

  it('rejects a signing key path inside runner state and malformed allowlist documents', async () => {
    const parent = await secureDirectory('runner-allowlist-outside-')
    const homeRoot = path.join(parent, 'home')
    const home = createFileRunnerHome({ defaultRoot: homeRoot, clock })
    const inside = path.join(homeRoot, 'operator.pem')
    const generatedRoot = path.join(parent, 'keys')
    await mkdir(generatedRoot, { mode: 0o700 })
    const generated = await createAllowlistSigningKeyFile(path.join(generatedRoot, 'operator.pem'))
    const policy = {
      revision: 1,
      allowlist: signAllowlist({ executables: ['git'], recipes: {} }, generated.signingKey),
      trustAnchors: [generated.trustAnchor],
    }
    await expect(home.initializePolicy?.({}, inside, policy)).resolves.toEqual({ status: 'failed', code: 'state-insecure-mode' })
    expect(decodeAllowlistDocument('{')).toBeNull()
    expect(decodeAllowlistDocument('{"executables":["git"],"recipes":{}}')).toEqual({ executables: ['git'], recipes: {} })
  })
})

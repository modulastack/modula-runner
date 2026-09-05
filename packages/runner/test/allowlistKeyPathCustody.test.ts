import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAllowlistSigningKeyFile } from '../src/index.js'

// A live flip of the directory a key path resolves through is timing-loaded and would land a flaky
// test in the suite. This stages the outcome instead: one path resolves to somewhere other than
// what a separate lstat of the literal path would inspect, which is exactly what the two concurrent
// walks could observe. Nothing is staged by default, so every other resolution is the real one.
const stagedResolution = vi.hoisted(() => ({ from: '', to: '' }))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const realpath = (async (target: unknown, ...rest: unknown[]) => {
    if (target === stagedResolution.from) return stagedResolution.to
    return await (actual.realpath as (...args: unknown[]) => Promise<string>)(target, ...rest)
  }) as typeof actual.realpath
  const patched = { ...actual, realpath }
  return { ...patched, default: patched }
})

const roots: string[] = []

afterEach(async () => {
  stagedResolution.from = ''
  stagedResolution.to = ''
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'allowlist-key-custody-'))
  roots.push(root)
  return await realpath(root)
}

async function directory(root: string, name: string, mode: number): Promise<string> {
  const created = path.join(root, name)
  await mkdir(created)
  await chmod(created, mode)
  return created
}

describe('allowlist signing key directory custody', () => {
  it('refuses a key path whose resolved parent is not the directory custody was proven on', async () => {
    const root = await temporaryRoot()
    const inspected = await directory(root, 'inspected', 0o755)
    const uninspected = await directory(root, 'uninspected', 0o777)
    stagedResolution.from = inspected
    stagedResolution.to = uninspected

    const outcome = await createAllowlistSigningKeyFile(path.join(inspected, 'operator.pem')).then(
      () => 'accepted',
      (error: Error) => error.message,
    )

    await expect(readdir(uninspected)).resolves.toEqual([])
    expect(outcome).toMatch(/directory custody is invalid/)
  })

  it('accepts a symlinked parent resolving to a custody-clean directory and writes at the realpath', async () => {
    const root = await temporaryRoot()
    const target = await directory(root, 'keys', 0o755)
    const link = path.join(root, 'keys-link')
    await symlink(target, link)

    const generated = await createAllowlistSigningKeyFile(path.join(link, 'operator.pem'))

    expect(generated.signingKey.keyId).toEqual(generated.trustAnchor.keyId)
    const info = await lstat(path.join(target, 'operator.pem'))
    expect(info.isFile()).toBe(true)
    expect(info.mode & 0o777).toBe(0o600)
  })
})

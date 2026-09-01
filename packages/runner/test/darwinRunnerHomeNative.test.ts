import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadDarwinRunnerHomeNative } from '../src/darwinRunnerHomeNative.js'

const describeOnDarwin = process.platform === 'darwin' ? describe : describe.skip
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryDirectory() {
  const root = await mkdtemp(path.join(tmpdir(), 'runner-home-native-'))
  roots.push(root)
  return root
}

describeOnDarwin('Darwin runner-home native descriptor adapter', () => {
  it('rejects non-single-entry names before descriptor-relative syscalls', async () => {
    const native = loadDarwinRunnerHomeNative()
    const root = await temporaryDirectory()
    const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const invalid = ['', '.', '..', 'child/name', 'child\0name']
    try {
      for (const name of invalid) {
        expect(() => native.fstatat(handle.fd, name)).toThrow(expect.objectContaining({ code: 'EINVAL', syscall: 'fstatat' }))
        expect(() => native.openat(handle.fd, name, constants.O_RDONLY)).toThrow(expect.objectContaining({ code: 'EINVAL', syscall: 'openat' }))
        expect(() => native.renameat(handle.fd, name, handle.fd, 'target')).toThrow(expect.objectContaining({ code: 'EINVAL', syscall: 'renameat' }))
        expect(() => native.unlinkat(handle.fd, name)).toThrow(expect.objectContaining({ code: 'EINVAL', syscall: 'unlinkat' }))
      }
      expect(await readFile(path.join(root, '..', path.basename(root), 'missing')).catch(error => error.code)).toBe('ENOENT')
    } finally {
      await handle.close()
    }
  })

  it('uses stable errno symbols for native failures and exposes expected errno constants', async () => {
    const native = loadDarwinRunnerHomeNative()
    expect(native.errnoSymbols()).toEqual({ EBADF: 'EBADF', EINVAL: 'EINVAL', EIO: 'EIO', ENOENT: 'ENOENT' })
    expect(() => native.fdFlags(-1)).toThrow(expect.objectContaining({ code: 'EBADF', syscall: 'fcntl' }))

    const root = await temporaryDirectory()
    const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      expect(native.fstatat(handle.fd, 'missing')).toBeNull()
      expect(native.openat(handle.fd, 'missing', constants.O_RDONLY)).toBeNull()
    } finally {
      await handle.close()
    }
  })

  it('marks native child descriptors close-on-exec where observable', async () => {
    const native = loadDarwinRunnerHomeNative()
    const root = await temporaryDirectory()
    await writeFile(path.join(root, 'record'), 'value', { mode: 0o600 })
    const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const fd = native.openat(handle.fd, 'record', constants.O_RDONLY)
    try {
      expect(fd).not.toBeNull()
      if (fd === null) throw new Error('native openat did not return a descriptor')
      expect(native.fdFlags(fd) & 1).toBe(1)
    } finally {
      if (fd !== null) native.close(fd)
      await handle.close()
    }
  })

  it('verifies deterministic source builds against the committed addon and loader digest', async () => {
    const result = spawnSync(process.execPath, ['scripts/verify-darwin-runner-home-native.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      status: 'verified',
      sha256: '55b028f57545276d7729ad468fe40992870c5e7b35e3cf7eb5ad8cfbb8232bde',
    })
  })
})

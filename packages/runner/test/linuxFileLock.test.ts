import { createHash } from 'node:crypto'
import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { tryExclusive, unlock } from '@modulastack/linux-file-lock'
import { acquireLinuxRootLifetime, releaseLinuxRootLifetime, withLinuxRootLease } from '../src/linuxRootLease.js'

const binaries = {
  arm64: '80c10393d3698397e35d30f0edca8d05f938c9f5f8be1a747d0bd56cedce6d06',
  x64: 'a58e01d64248b487d9c7dafba751d69b7924d16f0e31cedcce9d3226fdfdb514',
} as const

describe('private Linux file-lock boundary', () => {
  it('ships exact Node 22 prebuilts without install or loader fallbacks', async () => {
    const manifest = JSON.parse(await readFile('packages/linux-file-lock/package.json', 'utf8')) as Record<string, unknown>
    expect(manifest).not.toHaveProperty('scripts')
    expect(manifest).not.toHaveProperty('dependencies')
    const loader = await readFile('packages/linux-file-lock/index.js', 'utf8')
    expect(loader).not.toMatch(/node-gyp|build\/Release|prebuild|process\.env/)
    for (const [arch, expected] of Object.entries(binaries)) {
      const bytes = await readFile(`packages/linux-file-lock/binaries/fs-ext-linux-${arch}-node-22.0.0.node`)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected)
    }
  })

  it('hands a retained transient lease to a queued lifetime acquisition', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'runner-root-lease-handoff-'))
    const first = await open(directory, 'r')
    const second = await open(directory, 'r')
    let startOperation: (() => void) | undefined
    let finishOperation: (() => void) | undefined
    const started = new Promise<void>(resolve => { startOperation = resolve })
    const finish = new Promise<void>(resolve => { finishOperation = resolve })
    try {
      const transient = withLinuxRootLease(
        first,
        'unavailable',
        async () => { startOperation?.(); await finish; return 'written' },
        result => result === 'written',
        async () => undefined,
      )
      await started
      const lifetime = acquireLinuxRootLifetime(second)
      finishOperation?.()
      await expect(transient).resolves.toBe('written')
      await expect(lifetime).resolves.toBe('acquired')
      await expect(releaseLinuxRootLifetime(second)).resolves.toBe(true)
    } finally {
      await Promise.all([first.close(), second.close()])
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('takes an exclusive kernel lease on a directory file descriptor', async () => {
    const first = await open('.', 'r')
    const second = await open('.', 'r')
    try {
      await expect(tryExclusive(first.fd)).resolves.toBe('acquired')
      await expect(tryExclusive(second.fd)).resolves.toBe('contended')
      await unlock(first.fd)
      await expect(tryExclusive(second.fd)).resolves.toBe('acquired')
      await unlock(second.fd)
    } finally {
      await first.close()
      await second.close()
    }
  })
})

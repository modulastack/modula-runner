import { rename } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadDarwinRunnerHomeNative } from '../src/darwinRunnerHomeNative.js'

const describeOnDarwin = process.platform === 'darwin' ? describe : describe.skip
const packagedAddon = path.resolve('packages/darwin-file-lock/binaries/fs-ext-darwin-arm64-node-22.0.0.node')

describeOnDarwin('Darwin runner-home native loader', () => {
  it('verifies the packaged addon on the load that executes it and holds the binding', async () => {
    expect(loadDarwinRunnerHomeNative().errnoSymbols()).toEqual({ EBADF: 'EBADF', EINVAL: 'EINVAL', EIO: 'EIO', ENOENT: 'ENOENT' })

    const withheld = `${packagedAddon}.withheld`
    await rename(packagedAddon, withheld)
    try {
      expect(loadDarwinRunnerHomeNative().errnoSymbols()).toEqual({ EBADF: 'EBADF', EINVAL: 'EINVAL', EIO: 'EIO', ENOENT: 'ENOENT' })
    } finally {
      await rename(withheld, packagedAddon)
    }
  })
})

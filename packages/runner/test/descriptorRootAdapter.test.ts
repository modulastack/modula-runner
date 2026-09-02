import { constants } from 'node:fs'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { descriptorRootAdapter, type DescriptorChildHandle } from '../src/descriptorRootAdapter.js'

const describeOnDarwin = process.platform === 'darwin' ? describe : describe.skip
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'runner-descriptor-adapter-'))
  roots.push(root)
  return root
}

function descriptorNumber(handle: DescriptorChildHandle | null): number {
  if (!handle || !('platform' in handle)) throw new Error('expected a Darwin child descriptor')
  return handle.fd
}

describeOnDarwin('Darwin descriptor root adapter', () => {
  it('leaves a recycled descriptor alone when a stale handle is closed again', async () => {
    const root = await temporaryDirectory()
    await writeFile(path.join(root, 'first'), 'first-bytes', { mode: 0o600 })
    await writeFile(path.join(root, 'second'), 'second-bytes', { mode: 0o600 })
    const adapter = descriptorRootAdapter()
    const rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      const stale = await adapter.openEntry(rootHandle, 'first', constants.O_RDONLY | constants.O_NOFOLLOW)
      const recycledFd = descriptorNumber(stale)
      await adapter.close(stale!)
      const live = await adapter.openEntry(rootHandle, 'second', constants.O_RDONLY | constants.O_NOFOLLOW)
      // The premise of the case: openat hands back the lowest free descriptor, so the new segment
      // holds the number the sealed one just released.
      expect(descriptorNumber(live)).toBe(recycledFd)

      await adapter.close(stale!)

      expect((await adapter.read(live!, 32)).toString()).toBe('second-bytes')
      await adapter.close(live!)
    } finally {
      await rootHandle.close()
    }
  })
})

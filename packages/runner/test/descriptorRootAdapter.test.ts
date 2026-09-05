import { constants } from 'node:fs'
import { mkdtemp, open, rm, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { descriptorRootAdapter, type DescriptorRootAdapter } from '../src/descriptorRootAdapter.js'

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

async function openChild(
  adapter: DescriptorRootAdapter,
  root: FileHandle,
  entry: string,
): Promise<{ platform: 'darwin'; fd: number }> {
  const handle = await adapter.openEntry(root, entry, constants.O_RDONLY | constants.O_NOFOLLOW)
  if (!handle || !('platform' in handle)) throw new Error(`expected a Darwin child descriptor for ${entry}`)
  return handle
}

describeOnDarwin('Darwin descriptor root adapter', () => {
  it('leaves a recycled descriptor alone when a stale handle is closed again', async () => {
    const root = await temporaryDirectory()
    await writeFile(path.join(root, 'first'), 'first-bytes', { mode: 0o600 })
    await writeFile(path.join(root, 'second'), 'second-bytes', { mode: 0o600 })
    const adapter = descriptorRootAdapter()
    const rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      const stale = await openChild(adapter, rootHandle, 'first')
      const released = stale.fd
      await adapter.close(stale)
      const live = await openChild(adapter, rootHandle, 'second')
      // The case has no teeth unless openat really did hand the new entry the number the closed one
      // released, which is what makes the second close reach a live descriptor.
      expect(live.fd).toBe(released)

      await adapter.close(stale)

      expect((await adapter.read(live, 32)).toString()).toBe('second-bytes')
      await adapter.close(live)
    } finally {
      await rootHandle.close()
    }
  })
})

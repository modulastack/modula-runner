import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { PROTOCOL_VERSION } from '@modulastack/runner-protocol'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))

describe('CP-5 wire invariance acceptance', () => {
  it('AS-08 leaves the version-1 protocol package byte-for-byte unchanged from the adjudicated base', async () => {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--name-only', 'e2cf53a', '--', 'packages/protocol'],
      { cwd: repositoryRoot },
    )

    expect(PROTOCOL_VERSION).toBe(1)
    expect(stdout.trim()).toBe('')
  })
})

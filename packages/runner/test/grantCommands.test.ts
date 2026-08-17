import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createGrants,
  createMemoryGrantStore,
  runGrantAddCommand,
  runGrantListCommand,
  runGrantRevokeCommand,
  type Grants,
} from '../src/index.js'

const directories: string[] = []

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'runner-grant-cli-'))
  directories.push(directory)
  return realpath(directory)
}

function grants(cwdReadBackAvailable = true): Grants {
  return createGrants({ store: createMemoryGrantStore(), cwdReadBackAvailable })
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('grant CLI commands', () => {
  it('grants, lists, and revokes a directory locally', async () => {
    const directory = await workspace()
    const context = { grants: grants() }

    const added = await runGrantAddCommand([directory], context)
    expect(added).toEqual({ exitCode: 0, output: `granted ${directory}` })
    expect(await runGrantListCommand([], context)).toEqual({ exitCode: 0, output: directory })

    const revoked = await runGrantRevokeCommand([directory], context)
    expect(revoked.exitCode).toBe(0)
    expect(await runGrantListCommand([], context)).toMatchObject({ exitCode: 0, output: expect.stringContaining('no directories granted') })
  })

  it('rejects malformed invocations without touching the store', async () => {
    const context = { grants: grants() }
    expect((await runGrantAddCommand([], context)).exitCode).toBe(2)
    expect((await runGrantAddCommand(['/a', '/b'], context)).exitCode).toBe(2)
    expect((await runGrantRevokeCommand([], context)).exitCode).toBe(2)
    expect(await runGrantListCommand([], context)).toMatchObject({ output: expect.stringContaining('no directories granted') })
  })

  it('states the resolve-then-enter window when cwd read-back is unavailable', async () => {
    const directory = await workspace()
    const context = { grants: grants(false) }
    await runGrantAddCommand([directory], context)
    expect((await runGrantListCommand([], context)).output).toContain('cannot read a running process')
  })
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createInstalledRunnerApplication, type RunnerCliIo } from '../src/index.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function invocation(args: string[], home: string) {
  const stdout: string[] = []
  const stderr: string[] = []
  const io: RunnerCliIo = {
    inputIsTTY: false,
    readHidden: async () => { throw new Error('hidden input was not expected') },
    writeStdout: text => stdout.push(text),
    writeStderr: text => stderr.push(text),
  }
  return { value: { args, cwd: home, environment: { runnerHome: home }, io }, stdout, stderr }
}

describe('installed runner application', () => {
  it('answers help and package version without opening the runner home', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'runner-installed-'))
    roots.push(root)
    const home = path.join(root, 'home')
    const app = createInstalledRunnerApplication({ version: '9.8.7', defaultHomeRoot: home })
    const help = invocation(['help'], home)
    const version = invocation(['version'], home)
    await expect(app.execute(help.value)).resolves.toBe(0)
    await expect(app.execute(version.value)).resolves.toBe(0)
    expect(help.stdout.join('')).toContain('local pairing, state, and foreground runner commands')
    expect(version.stdout).toEqual(['9.8.7\n'])
  })

  it('preflights trusted policy before status or run can reach a connection', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'runner-installed-'))
    roots.push(root)
    const home = path.join(root, 'home')
    const app = createInstalledRunnerApplication({ version: '0.1.0', defaultHomeRoot: home })
    const status = invocation(['status', '--json'], home)
    await expect(app.execute(status.value)).resolves.toBe(1)
    expect(JSON.parse(status.stdout.join(''))).toEqual({ error: { code: 'policy-missing' } })

    const run = invocation(['run'], home)
    await expect(app.execute(run.value)).resolves.toBe(1)
    expect(run.stderr).toEqual(['policy-missing: runner home preflight failed\n'])
  })
})

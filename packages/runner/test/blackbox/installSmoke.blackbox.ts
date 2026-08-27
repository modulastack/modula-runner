import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installedRunner, type InstalledRunner } from './harness.js'

describe('A6-candidate install smoke', () => {
  let runner: InstalledRunner

  beforeAll(async () => {
    runner = await installedRunner()
  }, 600_000)

  afterAll(async () => {
    await runner?.dispose()
  })

  it('installs the modula-runner command into an isolated prefix', () => {
    expect(existsSync(runner.binary)).toBe(true)
  })

  it('reports the candidate manifest version and mutates no state', async () => {
    const home = await runner.freshHome()
    const runnerHome = join(home, 'runner-home')
    const result = await runner.run(['--version'], { home: runnerHome })
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(runner.version)
    expect(result.stderr).toBe('')
    expect(existsSync(runnerHome)).toBe(false)
  })

  it('prints command usage for --help without mutating state', async () => {
    const home = await runner.freshHome()
    const runnerHome = join(home, 'runner-home')
    const result = await runner.run(['--help'], { home: runnerHome })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('modula-runner')
    expect(result.stderr).toBe('')
    expect(existsSync(runnerHome)).toBe(false)
  })

  it('refuses an unknown command with the usage exit code on stderr', async () => {
    const result = await runner.run(['not-a-command'])
    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('usage: modula-runner')
  })

  it('refuses an empty invocation with the usage exit code', async () => {
    const result = await runner.run([])
    expect(result.status).toBe(2)
  })

  it('records node-pty native dependency evidence with valid name, version, and install path', () => {
    expect(runner.nativeDependency.name).toBe('node-pty')
    expect(runner.nativeDependency.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(['prebuilt', 'local-build']).toContain(runner.nativeDependency.installPath)
  })

  it('run exits fail-closed with non-empty stderr and empty stdout on a clean home', async () => {
    const home = await runner.freshHome()
    const runnerHome = join(home, 'runner-home')
    const result = await runner.run(['run'], { home: runnerHome })
    expect(result.status).not.toBe(0)
    expect(result.status).not.toBeNull()
    expect(result.stderr).not.toBe('')
    expect(result.stdout).toBe('')
  })
})

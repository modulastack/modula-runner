import { generateKeyPairSync } from 'node:crypto'
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installedRunner, type InstalledRunner } from './harness.js'

const statusTimeoutMs = 10_000
const commandTimeoutMs = 10_000

describe('A5 security invariants', () => {
  let runner: InstalledRunner

  beforeAll(async () => {
    runner = await installedRunner()
  }, 600_000)

  afterAll(async () => {
    await runner?.dispose()
  })

  async function initPolicy(runnerHome: string, keyPath: string): Promise<void> {
    const { privateKey } = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    await writeFile(keyPath, privateKey, { mode: 0o600 })
    const result = await runner.run(['allowlist', 'init', '--key', keyPath], { home: runnerHome })
    if (result.status !== 0) {
      throw new Error(`allowlist init failed (${result.status}): ${result.stderr.slice(0, 200)}`)
    }
  }

  describe('A5.1 policy and state error vocabulary', () => {
    it('plain status writes state-insecure-mode to stderr and status --json writes the same code to stdout with empty stderr when the home is world-accessible', async () => {
      const workspace = await runner.freshHome()
      const runnerHome = join(workspace, 'insecure-home')
      await mkdir(runnerHome)
      // Force the mode past umask so the runner sees exactly 0755.
      await chmod(runnerHome, 0o755)

      const plain = await runner.run(['status'], { home: runnerHome, timeoutMs: statusTimeoutMs })
      expect(plain.status).toBe(1)
      expect(plain.stderr.trimStart().startsWith('state-insecure-mode')).toBe(true)
      expect(plain.stdout).toBe('')

      const json = await runner.run(['status', '--json'], { home: runnerHome, timeoutMs: statusTimeoutMs })
      expect(json.status).toBe(1)
      expect(json.stderr).toBe('')
      const body = JSON.parse(json.stdout) as Record<string, unknown>
      const error = body['error'] as Record<string, unknown> | undefined
      expect(error?.['code']).toBe('state-insecure-mode')
    })

    it('plain status writes state-linked to stderr and status --json writes the same code to stdout with empty stderr when MODULA_RUNNER_HOME is a symlink', async () => {
      const workspace = await runner.freshHome()
      const realDir = join(workspace, 'real-home')
      const linkPath = join(workspace, 'linked-home')
      await mkdir(realDir, { mode: 0o700 })
      await symlink(realDir, linkPath)

      const plain = await runner.run(['status'], { home: linkPath, timeoutMs: statusTimeoutMs })
      expect(plain.status).toBe(1)
      expect(plain.stderr.trimStart().startsWith('state-linked')).toBe(true)
      expect(plain.stdout).toBe('')

      const json = await runner.run(['status', '--json'], { home: linkPath, timeoutMs: statusTimeoutMs })
      expect(json.status).toBe(1)
      expect(json.stderr).toBe('')
      const body = JSON.parse(json.stdout) as Record<string, unknown>
      const error = body['error'] as Record<string, unknown> | undefined
      expect(error?.['code']).toBe('state-linked')
    })

    it('plain status writes policy-missing to stderr and status --json writes the same code to stdout with empty stderr when the secure home has no initialized policy', async () => {
      const workspace = await runner.freshHome()
      const runnerHome = join(workspace, 'uninitialized-home')
      await mkdir(runnerHome, { mode: 0o700 })
      // Force the mode past umask so the only failing preflight is the missing policy, not the mode.
      await chmod(runnerHome, 0o700)

      const plain = await runner.run(['status'], { home: runnerHome, timeoutMs: statusTimeoutMs })
      expect(plain.status).toBe(1)
      expect(plain.stderr.trimStart().startsWith('policy-missing')).toBe(true)
      expect(plain.stdout).toBe('')

      const json = await runner.run(['status', '--json'], { home: runnerHome, timeoutMs: statusTimeoutMs })
      expect(json.status).toBe(1)
      expect(json.stderr).toBe('')
      const body = JSON.parse(json.stdout) as Record<string, unknown>
      const error = body['error'] as Record<string, unknown> | undefined
      expect(error?.['code']).toBe('policy-missing')
    })

    it('status --json after allowlist init reports a containment disposition from the stable vocabulary and a boolean prevention field', async () => {
      const workspace = await runner.freshHome()
      const runnerHome = join(workspace, 'runner-home')
      const keyPath = join(workspace, 'key.pem')
      await initPolicy(runnerHome, keyPath)

      const result = await runner.run(['status', '--json'], { home: runnerHome, timeoutMs: statusTimeoutMs })

      expect(result.status).toBe(0)
      const body = JSON.parse(result.stdout) as Record<string, unknown>
      expect(['unpaired', 'pending', 'paired', 'revoked']).toContain(body['state'])
      const validContainment = new Set(['network-namespace', 'detect-and-stop', 'unavailable-by-platform'])
      // Scan top-level string values; field name is implementation-owned (see matrix coverage note).
      const topLevelStrings = Object.values(body).filter((v): v is string => typeof v === 'string')
      expect(topLevelStrings.some(v => validContainment.has(v))).toBe(true)
      expect(typeof body['prevention']).toBe('boolean')
    })
  })

  describe('A5.3 grant admission and revocation', () => {
    it('grant creates a durable consent record and grant list includes the granted path', async () => {
      const workspace = await runner.freshHome()
      const runnerHome = join(workspace, 'runner-home')
      const keyPath = join(workspace, 'key.pem')
      const grantDir = join(workspace, 'project')
      await initPolicy(runnerHome, keyPath)
      await mkdir(grantDir)

      const grantResult = await runner.run(['grant', grantDir], { home: runnerHome, timeoutMs: commandTimeoutMs })
      expect(grantResult.status).toBe(0)

      const listResult = await runner.run(['grant', 'list'], { home: runnerHome, timeoutMs: commandTimeoutMs })
      expect(listResult.status).toBe(0)
      expect(listResult.stdout).toContain(grantDir)
    })

    it('grant revoke removes the consent record durably and grant list no longer includes the path', async () => {
      const workspace = await runner.freshHome()
      const runnerHome = join(workspace, 'runner-home')
      const keyPath = join(workspace, 'key.pem')
      const grantDir = join(workspace, 'project')
      await initPolicy(runnerHome, keyPath)
      await mkdir(grantDir)

      await runner.run(['grant', grantDir], { home: runnerHome, timeoutMs: commandTimeoutMs })
      const revokeResult = await runner.run(['grant', 'revoke', grantDir], { home: runnerHome, timeoutMs: commandTimeoutMs })
      expect(revokeResult.status).toBe(0)

      const listResult = await runner.run(['grant', 'list'], { home: runnerHome, timeoutMs: commandTimeoutMs })
      expect(listResult.status).toBe(0)
      expect(listResult.stdout).not.toContain(grantDir)
    })
  })

  describe('A5.5 audit archive offline refusal', () => {
    it('audit archive refuses a destination that overlaps with the runner home and exits non-zero', async () => {
      const workspace = await runner.freshHome()
      const runnerHome = join(workspace, 'runner-home')
      const keyPath = join(workspace, 'key.pem')
      await initPolicy(runnerHome, keyPath)

      const result = await runner.run(
        ['audit', 'archive', '--output', runnerHome],
        { home: runnerHome, timeoutMs: commandTimeoutMs },
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr.length).toBeGreaterThan(0)
    })
  })
})

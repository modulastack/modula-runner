import { generateKeyPairSync } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installedRunner, type InstalledRunner } from './harness.js'
import { PairingContractStub, type PairingObservation } from './pairingContractStub.js'

const pairTimeoutMs = 30_000
const statusTimeoutMs = 10_000

type RedeemObs = Extract<PairingObservation, { kind: 'redeem' }>
type ConfirmObs = Extract<PairingObservation, { kind: 'confirm' }>

function isRedeem(o: PairingObservation): o is RedeemObs {
  return o.kind === 'redeem'
}

function isConfirm(o: PairingObservation): o is ConfirmObs {
  return o.kind === 'confirm'
}

describe('A1 pairing and identity', () => {
  let runner: InstalledRunner

  beforeAll(async () => {
    runner = await installedRunner()
  }, 600_000)

  afterAll(async () => {
    await runner?.dispose()
  })

  async function initPolicy(runnerHome: string, keyPath: string): Promise<string> {
    const { privateKey } = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    await writeFile(keyPath, privateKey, { mode: 0o600 })
    const result = await runner.run(['allowlist', 'init', '--key', keyPath], { home: runnerHome })
    if (result.status !== 0) {
      throw new Error(`allowlist init failed (${result.status}): ${result.stderr.slice(0, 200)}`)
    }
    return privateKey
  }

  async function secureUninitializedHome(): Promise<string> {
    const workspace = await runner.freshHome()
    const runnerHome = join(workspace, 'runner-home')
    await mkdir(runnerHome, { mode: 0o700 })
    await chmod(runnerHome, 0o700)
    return runnerHome
  }

  function signingKeyBody(privateKey: string): string {
    return privateKey
      .split('\n')
      .filter(line => line.length > 0 && !line.includes('-----'))
      .join('')
  }

  function runPair(runnerHome: string, stubUrl: string, inputCode: string) {
    return runner.runInPty(
      ['pair', '--control-plane', stubUrl],
      { home: runnerHome, input: { after: 'code', value: inputCode }, timeoutMs: pairTimeoutMs },
    )
  }

  describe('A1.2 code redemption and confirmation', () => {
    it('redeems the pairing code at the exact configured stub origin', async () => {
      const workspace = await runner.freshHome()
      const runnerHome = join(workspace, 'runner-home')
      const stub = await new PairingContractStub({ confirmation: ['confirmed'] }).start()
      try {
        await initPolicy(runnerHome, join(workspace, 'signing.pem'))
        await runPair(runnerHome, stub.url, stub.inputCode)
        const redeem = stub.observations.find(isRedeem)
        expect(redeem).toBeDefined()
        expect(redeem?.requestValid).toBe(true)
        expect(redeem?.codeMatched).toBe(true)
      } finally {
        await stub.stop()
      }
    })

    it('sends a token proof rather than the raw bearer token in the confirmation body', async () => {
      const workspace = await runner.freshHome()
      const runnerHome = join(workspace, 'runner-home')
      const stub = await new PairingContractStub({ confirmation: ['confirmed'] }).start()
      try {
        await initPolicy(runnerHome, join(workspace, 'signing.pem'))
        await runPair(runnerHome, stub.url, stub.inputCode)
        const confirm = stub.observations.find(isConfirm)
        expect(confirm).toBeDefined()
        expect(confirm?.proofValid).toBe(true)
        expect(confirm?.bearerPresent).toBe(false)
      } finally {
        await stub.stop()
      }
    })

    it('emits no fixture secret in the terminal output after successful pairing', async () => {
      const workspace = await runner.freshHome()
      const runnerHome = join(workspace, 'runner-home')
      const stub = await new PairingContractStub({ confirmation: ['confirmed'] }).start()
      try {
        await initPolicy(runnerHome, join(workspace, 'signing.pem'))
        const result = await runPair(runnerHome, stub.url, stub.inputCode)
        expect(stub.containsFixtureSecret(result.output)).toBe(false)
      } finally {
        await stub.stop()
      }
    })

    it('exits 0 after the control plane confirms the binding', async () => {
      const workspace = await runner.freshHome()
      const runnerHome = join(workspace, 'runner-home')
      const stub = await new PairingContractStub({ confirmation: ['confirmed'] }).start()
      try {
        await initPolicy(runnerHome, join(workspace, 'signing.pem'))
        const result = await runPair(runnerHome, stub.url, stub.inputCode)
        expect(result.status).toBe(0)
      } finally {
        await stub.stop()
      }
    })
  })

  describe('A1.3 pairing resilience and state durability', () => {
    it('preserves pending state when the confirmation response is lost after server-side commit', async () => {
      const workspace = await runner.freshHome()
      const runnerHome = join(workspace, 'runner-home')
      const stub = await new PairingContractStub({ confirmation: ['response-lost-after-confirm'] }).start()
      try {
        await initPolicy(runnerHome, join(workspace, 'signing.pem'))
        await runPair(runnerHome, stub.url, stub.inputCode).catch(() => {})
        const status = await runner.run(['status', '--json'], { home: runnerHome, timeoutMs: statusTimeoutMs })
        expect(status.status).toBe(0)
        const body = JSON.parse(status.stdout) as Record<string, unknown>
        expect(body['state']).not.toBe('unpaired')
      } finally {
        await stub.stop()
      }
    })

    it('records revoked state when the control plane issues a terminal refusal', async () => {
      const workspace = await runner.freshHome()
      const runnerHome = join(workspace, 'runner-home')
      const stub = await new PairingContractStub({ confirmation: ['refused'] }).start()
      try {
        await initPolicy(runnerHome, join(workspace, 'signing.pem'))
        await runPair(runnerHome, stub.url, stub.inputCode).catch(() => {})
        const status = await runner.run(['status', '--json'], { home: runnerHome, timeoutMs: statusTimeoutMs })
        expect(status.status).toBe(0)
        const body = JSON.parse(status.stdout) as Record<string, unknown>
        expect(body['state']).toBe('revoked')
      } finally {
        await stub.stop()
      }
    })

    it('does not retry the revoked binding on re-pair and redeems a fresh binding', async () => {
      const workspace = await runner.freshHome()
      const runnerHome = join(workspace, 'runner-home')
      const stub = await new PairingContractStub({ confirmation: ['refused', 'confirmed'] }).start()
      try {
        await initPolicy(runnerHome, join(workspace, 'signing.pem'))
        await runPair(runnerHome, stub.url, stub.inputCode).catch(() => {})
        await runPair(runnerHome, stub.url, stub.inputCode)
        const redeems = stub.observations.filter(isRedeem)
        const confirms = stub.observations.filter(isConfirm)
        expect(redeems.length).toBeGreaterThanOrEqual(2)
        const bindingIds = confirms.map(o => o.bindingId).filter((id): id is string => id !== null)
        expect(new Set(bindingIds).size).toBeGreaterThanOrEqual(2)
      } finally {
        await stub.stop()
      }
    })
  })

  describe('A1.1 clean status and policy preflight', () => {
    it('reports unpaired at exit 0 after trusted policy initialization with no signing-key credential fragments in status output', async () => {
      const workspace = await runner.freshHome()
      const runnerHome = join(workspace, 'runner-home')
      const privateKey = await initPolicy(runnerHome, join(workspace, 'signing.pem'))
      const keyBody = signingKeyBody(privateKey)

      const plain = await runner.run(['status'], { home: runnerHome, timeoutMs: statusTimeoutMs })
      expect(plain.status).toBe(0)
      expect(plain.stdout.toLowerCase()).toContain('unpaired')
      expect(plain.stdout).not.toContain(keyBody)
      expect(plain.stderr).not.toContain(keyBody)

      const json = await runner.run(['status', '--json'], { home: runnerHome, timeoutMs: statusTimeoutMs })
      expect(json.status).toBe(0)
      const body = JSON.parse(json.stdout) as Record<string, unknown>
      expect(body['state']).toBe('unpaired')
      expect(json.stdout).not.toContain(keyBody)
      expect(json.stderr).not.toContain(keyBody)
    })

    it('fails closed with policy-missing on stderr and empty stdout at exit 1 for plain status before policy initialization', async () => {
      const runnerHome = await secureUninitializedHome()

      const plain = await runner.run(['status'], { home: runnerHome, timeoutMs: statusTimeoutMs })
      expect(plain.status).toBe(1)
      expect(plain.stderr.trimStart().startsWith('policy-missing')).toBe(true)
      expect(plain.stdout).toBe('')
    })

    it('returns error.code policy-missing on stdout and empty stderr at exit 1 for status --json before policy initialization', async () => {
      const runnerHome = await secureUninitializedHome()

      const json = await runner.run(['status', '--json'], { home: runnerHome, timeoutMs: statusTimeoutMs })
      expect(json.status).toBe(1)
      expect(json.stderr).toBe('')
      const body = JSON.parse(json.stdout) as Record<string, unknown>
      const error = body['error'] as Record<string, unknown> | undefined
      expect(error?.['code']).toBe('policy-missing')
    })
  })
})

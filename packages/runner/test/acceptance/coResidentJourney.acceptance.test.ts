import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  createMemoryPairingStore,
  createPairedClient,
  runPairCommand,
  RunnerIdentity,
  TerminalHost,
  type RunnerClient,
} from '../../src/index.js'
import { StubControlPlane } from '../stubControlPlane.js'
import { testRunnerInfo, until } from '../helpers.js'
import { binding, token } from './support.js'
import { permissiveSpawnSeam } from '../spawnSeamSupport.js'

const planes: StubControlPlane[] = []
const clients: RunnerClient[] = []
const hosts: TerminalHost[] = []
const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(hosts.map(host => host.killAll()))
  for (const client of clients) client.stop()
  await Promise.all(planes.map(plane => plane.stop()))
  await Promise.all(temporaryPaths.map(path => rm(path, { recursive: true, force: true })))
  vi.restoreAllMocks()
  planes.length = 0
  clients.length = 0
  hosts.length = 0
  temporaryPaths.length = 0
})

describe('AC-1 and AC-6 co-resident journey', () => {
  // FRD AC-1 and AC-6: local pair → bound path → live pane → operator input works over the same loopback contract.
  test('keeps the complete local deployment path working without a topology fork', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'runner-co-resident-'))
    temporaryPaths.push(cwd)
    const plane = await new StubControlPlane({
      token,
      terminalOnOpen: { type: 'INIT', cols: 80, rows: 24, profile: 'coder' },
    }).start()
    planes.push(plane)
    const store = createMemoryPairingStore()
    const identity = new RunnerIdentity(store)
    vi.spyOn(identity, 'pair').mockImplementation(async () => {
      const paired = binding({ controlPlaneUrl: plane.url })
      await store.save(paired)
      return paired
    })

    const pairResult = await runPairCommand(['local-pair-code'], {
      identity, controlPlaneUrl: 'http://127.0.0.1', version: '0.1.0',
    })
    expect(pairResult.exitCode).toBe(0)
    const client = await createPairedClient(identity, { runner: testRunnerInfo })
    clients.push(client)
    client.connect()
    await until(() => client.isConnected())

    const host = new TerminalHost(client, { seam: permissiveSpawnSeam(), pollMs: 50 })
    hosts.push(host)
    const pane = await host.launch({
      command: '/bin/sh',
      args: ['-lc', 'read value; printf "operator-input:%s\\n" "$value"'],
      cwd,
      profile: 'coder',
    })
    await until(() => plane.terminalMessages(pane.channelId).some(message => message.type === 'READY'))
    plane.sendTerminal(pane.channelId, { type: 'INPUT', data: 'round-trip\n' })

    await until(() => plane.terminalOutput(pane.channelId, false).includes('operator-input:round-trip'))
    expect(plane.terminalOutput(pane.channelId, false)).toContain('operator-input:round-trip')
  })
})

import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RunnerClient,
  SecretEnv,
  createSessionTerminalPorts,
  tmuxSessionName,
  worktreeSocket,
  type SessionProcessRequest,
  type SessionTerminalPorts,
  type SpawnSeam,
} from '../src/index.js'
import { permissiveSpawnSeam } from './spawnSeamSupport.js'
import { StubControlPlane } from './stubControlPlane.js'

const active: { stub: StubControlPlane; client: RunnerClient; ports: SessionTerminalPorts; cwd: string }[] = []

const runner = { name: 'test-runner', version: '0.1.0', os: process.platform, arch: process.arch }
const liveSignal = () => new AbortController().signal

async function rig(seam = permissiveSpawnSeam()) {
  const stub = await new StubControlPlane({ holdExitedChannels: true }).start()
  const client = new RunnerClient({ url: stub.url, token: 'stub-token', runner, backoff: { baseMs: 20, capMs: 50 } })
  const connected = once(client, 'connected')
  client.connect()
  await connected
  const cwd = mkdtempSync(path.join(tmpdir(), 'runner-session-terminal-'))
  const ports = createSessionTerminalPorts({ client, seam })
  const value = { stub, client, ports, cwd }
  active.push(value)
  return value
}

afterEach(async () => {
  for (const item of active.splice(0)) {
    await item.ports.shutdown()
    item.client.stop()
    await item.stub.stop()
    rmSync(item.cwd, { recursive: true, force: true })
  }
})

function controllableTmux() {
  const base = permissiveSpawnSeam()
  let allowed = true
  const seam: SpawnSeam = {
    check: (executable, recipeId) => allowed || executable !== 'tmux' ? base.check(executable, recipeId) : false,
    recordRefusal: (request, reason) => base.recordRefusal(request, reason),
    authorize: request => base.authorize(request),
    run: (request, runner) => base.run(request, runner),
  }
  return { seam, deny: () => { allowed = false }, allow: () => { allowed = true } }
}

function abortAfterTmux(controller: AbortController): SpawnSeam {
  const base = permissiveSpawnSeam()
  return {
    check: (executable, recipeId) => base.check(executable, recipeId),
    recordRefusal: (request, reason) => base.recordRefusal(request, reason),
    authorize: request => base.authorize(request),
    run: async (request, runner) => {
      const result = await base.run(request, runner)
      if (request.kind === 'tmux' && request.args?.includes('new-session')) controller.abort()
      return result
    },
  }
}

function request(cwd: string, channelId: string, sessionId = '123e4567-e89b-42d3-a456-426614174000'): SessionProcessRequest {
  return {
    requestId: '223e4567-e89b-42d3-a456-426614174001',
    sessionId,
    channelId,
    terminalProfile: 'coder',
    cwd,
    plan: {
      modelProfileId: 'daily',
      access: 'subscription',
      runtime: 'claude',
      command: '/bin/sh',
      args: ['-c', 'sleep 0.1; exit 7'],
      env: {},
      secrets: SecretEnv.empty(),
    },
  }
}

describe('production session terminal ports', () => {
  it('binds the reserved channel to the stable session and reports its durable exit', async () => {
    const item = await rig()
    const opened = await item.ports.channels.open('request-1', 'session-1', liveSignal())
    expect(opened.status).toBe('opened')
    if (opened.status !== 'opened') throw new Error('channel did not open')
    const processRequest = request(item.cwd, opened.channelId)
    const started = await item.ports.processes.start(processRequest, liveSignal())
    expect(started.status).toBe('started')
    if (started.status !== 'started') throw new Error('process did not start')
    expect(started.handle.sessionId).toBe(processRequest.sessionId)
    await waitUntil(() => item.stub.channels.has(opened.channelId))
    item.stub.sendTerminal(opened.channelId, { type: 'INIT', cols: 80, rows: 24, profile: 'coder' })
    await expect(started.handle.finished).resolves.toEqual({ exitCode: 7, signal: null })
    expect(await item.ports.processes.inspect(processRequest)).toBe('exact')
    expect(tmuxSessionName(item.cwd, processRequest.sessionId)).toContain(processRequest.sessionId)
    expect(worktreeSocket(item.cwd)).toMatch(/^modula-runner-/)
    expect(['terminated', 'missing']).toContain(await item.ports.processes.terminate(processRequest))
  })

  it('adopts the exact deterministic tmux session under a new channel', async () => {
    const item = await rig()
    const first = await item.ports.channels.open('request-1', 'session-1', liveSignal())
    if (first.status !== 'opened') throw new Error('channel did not open')
    const original = request(item.cwd, first.channelId)
    original.plan = { ...original.plan, args: ['-c', 'exec cat'] }
    const started = await item.ports.processes.start(original, liveSignal())
    if (started.status !== 'started') throw new Error('process did not start')
    await item.ports.channels.close(first.channelId, 'restart')

    const second = await item.ports.channels.open('request-1', original.sessionId, liveSignal())
    if (second.status !== 'opened') throw new Error('replacement channel did not open')
    const recovery = { ...original, channelId: second.channelId }
    const adopted = await item.ports.processes.adopt(recovery, liveSignal())
    expect(adopted.status).toBe('started')
    if (adopted.status !== 'started') throw new Error('process did not adopt')
    expect(adopted.handle.sessionId).toBe(original.sessionId)
    expect(await item.ports.processes.terminate(recovery)).toBe('terminated')
    await expect(settlement(started.handle.finished)).resolves.toBe('settled')
    await expect(settlement(adopted.handle.finished)).resolves.toBe('settled')
  })

  it('settles exposed process handles after confirmed terminal-port shutdown', async () => {
    const item = await rig()
    const opened = await item.ports.channels.open('request-1', 'session-1', liveSignal())
    if (opened.status !== 'opened') throw new Error('channel did not open')
    const processRequest = request(item.cwd, opened.channelId)
    processRequest.plan = { ...processRequest.plan, args: ['-c', 'exec cat'] }
    const started = await item.ports.processes.start(processRequest, liveSignal())
    if (started.status !== 'started') throw new Error('process did not start')
    await expect(item.ports.shutdown()).resolves.toEqual([])
    await expect(started.handle.finished).resolves.toEqual({ exitCode: null, signal: 15 })
  })

  it('leaves an exposed handle unsettled when shutdown cannot confirm termination', async () => {
    const control = controllableTmux()
    const item = await rig(control.seam)
    const opened = await item.ports.channels.open('request-1', 'session-1', liveSignal())
    if (opened.status !== 'opened') throw new Error('channel did not open')
    const processRequest = request(item.cwd, opened.channelId)
    processRequest.plan = { ...processRequest.plan, args: ['-c', 'exec cat'] }
    const started = await item.ports.processes.start(processRequest, liveSignal())
    if (started.status !== 'started') throw new Error('process did not start')
    control.deny()
    await expect(item.ports.shutdown()).resolves.toEqual([opened.channelId])
    await expect(settlement(started.handle.finished)).resolves.toBe('pending')
    control.allow()
  })

  it('removes a session created at the cancellation boundary before returning failure', async () => {
    const controller = new AbortController()
    const item = await rig(abortAfterTmux(controller))
    const opened = await item.ports.channels.open('request-1', 'session-1', liveSignal())
    if (opened.status !== 'opened') throw new Error('channel did not open')
    const processRequest = request(item.cwd, opened.channelId)
    const result = await item.ports.processes.start(processRequest, controller.signal)
    expect(controller.signal.aborted).toBe(true)
    expect(result).toEqual({ status: 'failed', reason: 'spawn-failed' })
    expect(await item.ports.processes.inspect(processRequest)).toBe('missing')
  })

  it('refuses pre-aborted channel and process steps without creating tmux state', async () => {
    const item = await rig()
    const aborted = new AbortController()
    aborted.abort()
    await expect(item.ports.channels.open('request-1', 'session-1', aborted.signal))
      .resolves.toEqual({ status: 'failed', reason: 'channel-unavailable' })

    const opened = await item.ports.channels.open('request-1', 'session-1', liveSignal())
    if (opened.status !== 'opened') throw new Error('channel did not open')
    const processRequest = request(item.cwd, opened.channelId)
    await expect(item.ports.processes.start(processRequest, aborted.signal))
      .resolves.toEqual({ status: 'failed', reason: 'spawn-failed' })
    expect(await item.ports.processes.inspect(processRequest)).toBe('missing')
  })
})

function settlement(promise: Promise<unknown>) {
  return Promise.race([
    promise.then(() => 'settled' as const),
    new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), 100)),
  ])
}

async function waitUntil(condition: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition did not become true')
}

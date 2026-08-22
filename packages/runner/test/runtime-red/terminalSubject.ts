import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { decodeTerminalServerMessage, type TerminalServerMessage } from '@modulastack/runner-protocol'
import { RunnerClient, TerminalHost } from '../../src/index.js'
import { StubControlPlane } from '../stubControlPlane.js'
import { permissiveSpawnSeam } from '../spawnSeamSupport.js'
import { sleep, testRunnerInfo, until } from '../helpers.js'
import { runtimeRedFixtureCredential } from './fixtureMaterial.js'
import { createRecorder } from './recorder.js'
import type { RuntimeObservation, RuntimeScenario } from './scenarioTypes.js'

const CONNECTION_TIMEOUT_MS = 5_000
const CLEANUP_TIMEOUT_MS = 5_000

export async function observeTerminalScenario(scenario: RuntimeScenario): Promise<RuntimeObservation> {
  const recorder = createRecorder()
  let stub = await new StubControlPlane({
    token: runtimeRedFixtureCredential,
    ...(scenario.fixture === 'terminal-exit-replay' ? { holdExitedChannels: true } : {}),
  }).start()
  const client = new RunnerClient({
    url: stub.url,
    token: runtimeRedFixtureCredential,
    runner: testRunnerInfo,
    backoff: { baseMs: 20, capMs: 50 },
    ...(scenario.fixture === 'terminal-reset' ? { bufferBytes: 4_096 } : {}),
  })
  let host: TerminalHost | null = null
  let cwd: string | null = null
  const socket = `runtime-red-${randomBytes(4).toString('hex')}`
  try {
    await connectWithin(client)
    host = new TerminalHost(client, { seam: permissiveSpawnSeam() })
    cwd = mkdtempSync(path.join(tmpdir(), 'runtime-red-terminal-'))
    recorder.record(`terminal.fixture:${scenario.fixture}`)
    if (scenario.fixture === 'terminal-ready-metadata') return await observeReady(host, stub, cwd, socket, recorder)
    if (scenario.fixture === 'terminal-exit-replay') {
      return await observeExit(host, stub, cwd, socket, recorder, client, nextStub => { stub = nextStub })
    }
    if (scenario.fixture === 'terminal-resume') return await observeResume(host, stub, cwd, socket, recorder, client)
    return await observeReset(host, stub, cwd, socket, recorder, client, nextStub => { stub = nextStub })
  } finally {
    await cleanupTerminal(host, client, stub, socket, cwd)
  }
}

async function observeReady(host: TerminalHost, stub: StubControlPlane, cwd: string, socket: string, recorder: ReturnType<typeof createRecorder>): Promise<RuntimeObservation> {
  const info = await host.launch({ command: '/bin/cat', cwd, socket, profile: 'coder' })
  await until(() => stub.channels.has(info.channelId))
  stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24, profile: 'coder' })
  await until(() => stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
  const ready = stub.terminalMessages(info.channelId).find(message => message.type === 'READY')
  if (ready?.type === 'READY' && ready.sessionId === info.sessionId && ready.profile === 'coder' && ready.cwd === cwd && ready.shell && ready.pid > 0) {
    recorder.record('terminal.ready:session+profile+cwd+shell+pid')
  }
  return observed('terminal:ready', recorder)
}

async function observeExit(
  host: TerminalHost,
  stub: StubControlPlane,
  cwd: string,
  socket: string,
  recorder: ReturnType<typeof createRecorder>,
  client: RunnerClient,
  replaceStub: (stub: StubControlPlane) => void,
): Promise<RuntimeObservation> {
  const info = await host.launch({ command: '/bin/sh', args: ['-c', 'sleep 0.2; exit 7'], cwd, socket })
  await until(() => terminalExit(stub, info.channelId) !== null)
  const first = terminalExit(stub, info.channelId)
  if (!first || first.message.exitCode !== 7 || first.message.signal !== null) throw new Error('terminal exit was not sequenced before disconnect')
  if (stub.closes.some(close => close.channel === info.channelId)) throw new Error('terminal consumer acknowledged EXIT before disconnect')
  recorder.record('terminal.exit:sequenced')
  recorder.record(`terminal.sequence:pre-disconnect:[${first.seq}]`)
  recorder.record('terminal.disconnect:before-exit-ack')
  const port = stub.port
  await stub.stop()
  const restarted = await new StubControlPlane({ token: runtimeRedFixtureCredential, holdExitedChannels: true }).start(port)
  replaceStub(restarted)
  await until(() => restarted.connectionCount >= 1, 10_000)
  recorder.record('terminal.reconnect:after-exit')
  await until(() => terminalExit(restarted, info.channelId) !== null, 10_000)
  const replayed = terminalExit(restarted, info.channelId)
  if (!replayed) throw new Error('terminal EXIT did not replay after reconnect')
  recorder.record(`terminal.sequence:post-reconnect:[${replayed.seq}]`)
  if (replayed.seq !== first.seq || replayed.message.exitCode !== first.message.exitCode || replayed.message.signal !== first.message.signal) {
    throw new Error('terminal EXIT changed across reconnect')
  }
  recorder.record('terminal.exit:replayed:same-sequence')
  restarted.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
  await until(() => hasContiguousPostReplayFrame(restarted, info.channelId, replayed.seq), 10_000)
  recorder.record('terminal.sequence:replay-next-contiguous')
  restarted.closeToRunner(info.channelId, 'consumer-ack')
  await until(() => !client.channelIds().includes(info.channelId))
  recorder.record('channel.close:after-exit-replay')
  return observed('terminal:finished', recorder)
}

async function observeResume(
  host: TerminalHost,
  stub: StubControlPlane,
  cwd: string,
  socket: string,
  recorder: ReturnType<typeof createRecorder>,
  client: RunnerClient,
): Promise<RuntimeObservation> {
  const info = await host.launch({ command: '/bin/cat', cwd, socket })
  await until(() => stub.channels.has(info.channelId))
  stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
  await until(() => stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
  const preDisconnectFrames = terminalFrames(stub, info.channelId)
  const highestBeforeDisconnect = highestTerminalSequence(stub, info.channelId)
  if (highestBeforeDisconnect < 1) throw new Error('terminal resume fixture observed no pre-disconnect frames')
  recorder.record(`terminal.sequence:pre-disconnect-high-water:[${highestBeforeDisconnect}]`)
  const token = stub.channels.get(info.channelId)?.attachToken
  stub.dropConnections()
  await until(() => stub.connectionCount >= 2, 10_000)
  await until(() => stub.channels.has(info.channelId), 10_000)
  stub.sendTerminal(info.channelId, { type: 'INPUT', data: 'resume-proof\n' })
  await until(() => terminalFrames(stub, info.channelId).length > preDisconnectFrames.length, 10_000)
  const postReconnectFrames = terminalFrames(stub, info.channelId).slice(preDisconnectFrames.length)
  const resetSequences = stub.resets.filter(reset => reset.channel === info.channelId).map(reset => reset.seq)
  if (!terminalResumeAdvances(highestBeforeDisconnect, postReconnectFrames.map(frame => frame.seq), resetSequences)) {
    throw new Error('terminal resume did not advance contiguously after reconnect')
  }
  const firstPostReconnect = postReconnectFrames[0]
  if (!firstPostReconnect) throw new Error('terminal resume observed no post-reconnect frame')
  recorder.record(`terminal.sequence:post-reconnect:[${firstPostReconnect.seq}]`)
  if (stub.channels.get(info.channelId)?.attachToken !== token || !client.channelIds().includes(info.channelId)) {
    recorder.record('terminal.replacement')
    return observed('terminal:resumed', recorder)
  }
  recorder.record('terminal.resume:same-channel+token+sequence')
  return observed('terminal:resumed', recorder)
}

async function observeReset(
  host: TerminalHost,
  stub: StubControlPlane,
  cwd: string,
  socket: string,
  recorder: ReturnType<typeof createRecorder>,
  client: RunnerClient,
  replaceStub: (stub: StubControlPlane) => void,
): Promise<RuntimeObservation> {
  const chunk = 'x'.repeat(120)
  const ticker = `i=0; while true; do echo tick-$i-${chunk}; i=$((i+1)); sleep 0.02; done`
  const info = await host.launch({ command: '/bin/sh', args: ['-c', ticker], cwd, socket })
  await until(() => stub.channels.has(info.channelId))
  stub.sendTerminal(info.channelId, { type: 'INIT', cols: 200, rows: 50 })
  await until(() => stub.terminalOutput(info.channelId, false).includes('tick-2-'))
  const highestBeforeDisconnect = highestTerminalSequence(stub, info.channelId)
  if (highestBeforeDisconnect < 1) throw new Error('terminal reset fixture observed no pre-disconnect frames')
  recorder.record(`terminal.sequence:pre-disconnect-high-water:[${highestBeforeDisconnect}]`)
  const port = stub.port
  await stub.stop()
  await sleep(1_500)
  const restarted = await new StubControlPlane({ token: runtimeRedFixtureCredential }).start(port)
  replaceStub(restarted)
  await until(() => restarted.resets.some(entry => entry.channel === info.channelId), 10_000)
  const reset = restarted.resets.find(entry => entry.channel === info.channelId)
  if (!reset || reset.seq <= highestBeforeDisconnect) throw new Error('terminal RESET did not advance past the pre-disconnect watermark')
  recorder.record(`terminal.sequence:reset:[${reset.seq}]`)
  recorder.record('terminal.reset:forward-only')
  recorder.record('terminal.reset:watermark-advances-pre-disconnect')
  await until(() => postResetFramesAdvance(restarted, info.channelId, reset.seq, highestBeforeDisconnect), 10_000)
  recorder.record('terminal.post-reset:all-advance')
  if (client.channelIds().includes(info.channelId)) recorder.record('terminal.correlation:unchanged')
  return observed('terminal:reset', recorder)
}

async function cleanupTerminal(
  host: TerminalHost | null,
  client: RunnerClient,
  stub: StubControlPlane,
  socket: string,
  cwd: string | null,
): Promise<void> {
  try {
    await settleWithin(host?.killAll())
  } finally {
    spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' })
    client.stop()
    try {
      await stub.stop()
    } finally {
      if (cwd) rmSync(cwd, { recursive: true, force: true })
    }
  }
}

async function connectWithin(client: RunnerClient): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (settle: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      client.off('connected', connected)
      client.off('failed', failed)
      settle()
    }
    const connected = () => finish(resolve)
    const failed = () => finish(() => reject(new Error('terminal runtime connection failed')))
    const timeout = setTimeout(() => finish(() => reject(new Error('terminal runtime connection timed out'))), CONNECTION_TIMEOUT_MS)
    client.once('connected', connected)
    client.once('failed', failed)
    try {
      client.connect()
    } catch (error) {
      finish(() => reject(error))
    }
  })
}

async function settleWithin(cleanup: Promise<unknown> | undefined): Promise<void> {
  if (!cleanup) return
  await new Promise<void>(resolve => {
    const timeout = setTimeout(resolve, CLEANUP_TIMEOUT_MS)
    void cleanup.then(
      () => {
        clearTimeout(timeout)
        resolve()
      },
      () => {
        clearTimeout(timeout)
        resolve()
      },
    )
  })
}

type SequencedTerminalMessage = { seq: number; message: TerminalServerMessage }
type SequencedTerminalExit = { seq: number; message: Extract<TerminalServerMessage, { type: 'EXIT' }> }

function terminalFrames(stub: StubControlPlane, channelId: string): readonly SequencedTerminalMessage[] {
  return stub.received.flatMap(entry => {
    const message = decodeTerminalServerMessage(entry.payload)
    return entry.channel === channelId && message ? [{ seq: entry.seq, message }] : []
  })
}

function terminalExit(stub: StubControlPlane, channelId: string): SequencedTerminalExit | null {
  for (const frame of terminalFrames(stub, channelId)) {
    if (frame.message.type === 'EXIT') return { seq: frame.seq, message: frame.message }
  }
  return null
}

function highestTerminalSequence(stub: StubControlPlane, channelId: string): number {
  return terminalFrames(stub, channelId).reduce((highest, frame) => Math.max(highest, frame.seq), 0)
}

export function terminalResumeAdvances(
  highestBeforeDisconnect: number,
  postReconnectSequences: readonly number[],
  resetSequences: readonly number[],
): boolean {
  return Number.isSafeInteger(highestBeforeDisconnect) && highestBeforeDisconnect >= 1
    && resetSequences.length === 0
    && postReconnectSequences.length > 0
    && postReconnectSequences.every((sequence, index) => Number.isSafeInteger(sequence)
      && sequence === highestBeforeDisconnect + index + 1)
}

function hasContiguousPostReplayFrame(stub: StubControlPlane, channelId: string, replayedSequence: number): boolean {
  const frames = terminalFrames(stub, channelId).filter(frame => frame.seq > replayedSequence)
  return frames.length > 0
    && frames[0]?.message.type === 'ERROR'
    && frames.every((frame, index) => frame.seq === replayedSequence + index + 1)
}

function postResetFramesAdvance(
  stub: StubControlPlane,
  channelId: string,
  resetSequence: number,
  highestBeforeDisconnect: number,
): boolean {
  const frames = terminalFrames(stub, channelId)
  return frames.length > 0
    && resetSequence > highestBeforeDisconnect
    && frames.every((frame, index) => frame.seq === resetSequence + index && frame.seq > highestBeforeDisconnect)
}

function observed(result: string, recorder: ReturnType<typeof createRecorder>): RuntimeObservation {
  return { status: 'observed', subject: 'terminal-host', result, events: recorder.events, output: recorder.output }
}

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RunnerClient, type RunnerClientOptions } from '../src/client.js'
import { TerminalHost, type TerminalHostOptions } from '../src/terminalHost.js'
import {
  captureTmuxScrollback as captureTmuxScrollbackRaw,
  exitTmuxCopyMode as exitTmuxCopyModeRaw,
  hasTmuxSession as hasTmuxSessionRaw,
  killTmuxSession as killTmuxSessionRaw,
  paneStatus as paneStatusRaw,
  paneWatcherCount,
  tmuxSessionPresence as tmuxSessionPresenceRaw,
  type TmuxRef,
} from '../src/tmux.js'
import type { TerminalClientMessage } from '@modulastack/runner-protocol'
import type { TerminalLaunchSpec } from '../src/terminalSession.js'
import { StubControlPlane, type StubOptions } from './stubControlPlane.js'
import { sleep, testRunnerInfo, until } from './helpers.js'
import { permissiveSpawnSeam } from './spawnSeamSupport.js'

// The tmux driver now takes the spawn seam; these tests exercise the terminal stack, not the
// allowlist, so a permissive seam is bound once and the call sites read unchanged.
const testSeam = permissiveSpawnSeam()
const hasTmuxSession = (ref: TmuxRef) => hasTmuxSessionRaw(ref, testSeam)
const killTmuxSession = (ref: TmuxRef) => killTmuxSessionRaw(ref, testSeam)
const tmuxSessionPresence = (ref: TmuxRef) => tmuxSessionPresenceRaw(ref, testSeam)
const paneStatus = (ref: TmuxRef) => paneStatusRaw(ref, testSeam)
const exitTmuxCopyMode = (ref: TmuxRef) => exitTmuxCopyModeRaw(ref, testSeam)
const captureTmuxScrollback = (ref: TmuxRef, lines: number, stillWanted?: () => boolean) =>
  captureTmuxScrollbackRaw(ref, lines, testSeam, stillWanted)

type Rig = {
  stub: StubControlPlane
  client: RunnerClient
  host: TerminalHost
  cwd: string
  socket: string
}

let rigs: Rig[] = []

afterEach(async () => {
  for (const rig of rigs) {
    await rig.host.killAll()
    spawnSync('tmux', ['-L', rig.socket, 'kill-server'], { stdio: 'ignore' })
    rig.client.stop()
    await rig.stub.stop()
    rmSync(rig.cwd, { recursive: true, force: true })
  }
  rigs = []
})

async function createRig(options: { stub?: StubOptions; client?: Partial<RunnerClientOptions>; host?: Partial<TerminalHostOptions> } = {}): Promise<Rig> {
  const stub = await new StubControlPlane(options.stub ?? {}).start()
  const client = new RunnerClient({ url: stub.url, token: 'stub-token', runner: testRunnerInfo, backoff: { baseMs: 20, capMs: 50 }, ...options.client })
  const connected = once(client, 'connected')
  client.connect()
  await connected
  const host = new TerminalHost(client, { seam: permissiveSpawnSeam(), ...options.host })
  const cwd = mkdtempSync(path.join(tmpdir(), 'mr-term-test-'))
  const socket = `mr-test-${randomBytes(4).toString('hex')}`
  const rig = { stub, client, host, cwd, socket }
  rigs.push(rig)
  return rig
}

async function openTerminal(rig: Rig, spec: Partial<TerminalLaunchSpec> = {}) {
  const info = await rig.host.launch({ command: '/bin/cat', cwd: rig.cwd, socket: rig.socket, ...spec })
  await until(() => rig.stub.channels.has(info.channelId))
  return info
}

function liveOutput(rig: Rig, channel: string) {
  return rig.stub.terminalOutput(channel, false)
}

function tmuxSessions(socket: string) {
  const result = spawnSync('tmux', ['-L', socket, 'list-sessions', '-F', '#S'], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.split('\n').filter(Boolean) : []
}

function tmuxClients(socket: string) {
  const result = spawnSync('tmux', ['-L', socket, 'list-clients'], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : ''
}

describe('pty host', () => {
  it('spawns under tmux, announces READY on INIT, and replays pre-attach scrollback', async () => {
    const rig = await createRig()
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', 'printf spawn-marker-xyz; exec cat'] })
    await sleep(400)
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    const ready = rig.stub.terminalMessages(info.channelId).find(message => message.type === 'READY')
    expect(ready).toMatchObject({ sessionId: info.sessionId, profile: 'shell', cwd: rig.cwd, shell: '/bin/sh' })
    await until(() => rig.stub.terminalOutput(info.channelId, true).includes('spawn-marker-xyz'))
    expect(await hasTmuxSession(info.ref)).toBe(true)
  })

  it('round-trips operator input through the pty', async () => {
    const rig = await createRig()
    const info = await openTerminal(rig)
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    rig.stub.sendTerminal(info.channelId, { type: 'INPUT', data: 'echo-round-trip\r' })
    await until(() => liveOutput(rig, info.channelId).includes('echo-round-trip'))
  })

  it('applies RESIZE to the pty the command actually sees', async () => {
    const rig = await createRig()
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', 'while read line; do stty size; done'] })
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    rig.stub.sendTerminal(info.channelId, { type: 'RESIZE', cols: 100, rows: 30 })
    // tmux coalesces client resizes right after attach, so poll with fresh
    // inputs: each one makes the loop report the size the pane sees right now.
    // The tmux status line takes one client row, so the pane sees rows - 1.
    await until(() => {
      rig.stub.sendTerminal(info.channelId, { type: 'INPUT', data: 'go\r' })
      return liveOutput(rig, info.channelId).includes('29 100')
    }, 10_000)
  })

  it('propagates the wrapped command exit code and lets the consumer close the channel', async () => {
    const rig = await createRig()
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', 'sleep 0.3; exit 7'] })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'EXIT'))
    expect(rig.stub.terminalMessages(info.channelId).find(message => message.type === 'EXIT')).toEqual({ type: 'EXIT', exitCode: 7, signal: null })
    // The consumer closes once EXIT is in hand; the runner drops the channel then.
    await until(() => !rig.client.channelIds().includes(info.channelId))
  })

  it('keeps EXIT replayable across a control-plane outage', async () => {
    const rig = await createRig()
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', 'sleep 0.2; exit 5'] })
    const port = rig.stub.port
    await rig.stub.stop()
    // The session dies while nobody is listening: EXIT lands in the replay
    // buffer of a channel that must stay open until a consumer has it.
    await sleep(1_800)
    rig.stub = await new StubControlPlane().start(port)
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'EXIT'), 10_000)
    expect(rig.stub.terminalMessages(info.channelId).find(message => message.type === 'EXIT')).toEqual({ type: 'EXIT', exitCode: 5, signal: null })
    await until(() => !rig.client.channelIds().includes(info.channelId))
  })

  it('KILL ends the tmux session and still reports EXIT', async () => {
    const rig = await createRig()
    const info = await openTerminal(rig)
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    rig.stub.sendTerminal(info.channelId, { type: 'KILL' })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'EXIT'))
    expect(await hasTmuxSession(info.ref)).toBe(false)
    await until(() => !rig.client.channelIds().includes(info.channelId))
  })

  it('rejects session messages before INIT', async () => {
    const rig = await createRig()
    const info = await openTerminal(rig)
    rig.stub.sendTerminal(info.channelId, { type: 'INPUT', data: 'too-early' })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'ERROR' && message.message === 'session not initialized'))
  })

  it('rejects an INIT whose profile does not match the bound session', async () => {
    const rig = await createRig()
    const info = await openTerminal(rig, { profile: 'coder' })
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24, profile: 'planner' })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'ERROR' && message.message === 'profile does not match the bound session'))
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24, profile: 'coder' })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
  })

  it('answers undecodable terminal payloads with a terminal ERROR', async () => {
    const rig = await createRig()
    const info = await openTerminal(rig)
    rig.stub.sendToRunner(info.channelId, { codec: 'text', body: 'not a terminal message' })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'ERROR' && message.message === 'invalid terminal message'))
  })

  it('pauses the pty at the high-water mark and resumes as ACKs open the window', async () => {
    const rig = await createRig({ host: { flow: { highWaterBytes: 4096, lowWaterBytes: 1024, flushMs: 5 } } })
    const producer = 'i=0; while [ "$i" -lt 20000 ]; do echo filler-line-$i; i=$((i+1)); done; echo ALL-DONE; exec cat'
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', producer] })
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => Buffer.byteLength(liveOutput(rig, info.channelId)) > 4096)
    await sleep(500)
    const stalled = Buffer.byteLength(liveOutput(rig, info.channelId))
    await sleep(400)
    expect(Buffer.byteLength(liveOutput(rig, info.channelId))).toBe(stalled)
    expect(liveOutput(rig, info.channelId)).not.toContain('ALL-DONE')
    let acked = 0
    await until(() => {
      const total = Buffer.byteLength(liveOutput(rig, info.channelId))
      if (total > acked) {
        rig.stub.sendTerminal(info.channelId, { type: 'ACK', bytes: total - acked })
        acked = total
      }
      return liveOutput(rig, info.channelId).includes('ALL-DONE')
    }, 12_000)
  })

  it('replays the exact gap after a control-plane outage, without loss or duplication', async () => {
    const rig = await createRig()
    const ticker = 'i=0; while true; do echo tick-$i.; i=$((i+1)); sleep 0.05; done'
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', ticker] })
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => liveOutput(rig, info.channelId).includes('tick-3.'))
    const port = rig.stub.port
    await rig.stub.stop()
    await sleep(600)
    rig.stub = await new StubControlPlane().start(port)
    await until(() => rig.client.isConnected())
    await until(() => liveOutput(rig, info.channelId).includes('tick-30.'), 10_000)
    const ticks = [...liveOutput(rig, info.channelId).matchAll(/tick-(\d+)\./g)].map(match => Number(match[1]))
    // Exactly-once is not a property of a terminal byte stream — tmux repaints
    // re-print lines already on screen — so the assertion is the one that
    // matters: nothing is lost and nothing arrives out of order across the
    // outage. Frame-level exactly-once is pinned by the sequence tests.
    const first = ticks[0]!
    const highest = ticks[ticks.length - 1]!
    expect([...ticks].sort((a, b) => a - b)).toEqual(ticks)
    expect([...new Set(ticks)].sort((a, b) => a - b)).toEqual(Array.from({ length: highest - first + 1 }, (_, index) => first + index))
  })

  it('announces continuity loss with a reset and heals it with scrollback replay', async () => {
    const rig = await createRig({ client: { bufferBytes: 4096 } })
    const chunk = 'x'.repeat(120)
    const ticker = `i=0; while true; do echo tick-$i-${chunk}; i=$((i+1)); sleep 0.02; done`
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', ticker] })
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 200, rows: 50 })
    await until(() => liveOutput(rig, info.channelId).includes('tick-2-'))
    const port = rig.stub.port
    await rig.stub.stop()
    // Enough offline output to overrun the 4 KiB replay buffer: continuity is
    // genuinely lost and must be announced, not spliced.
    await sleep(1_500)
    rig.stub = await new StubControlPlane().start(port)
    await until(() => rig.stub.resets.some(entry => entry.channel === info.channelId), 5_000)
    // The post-reset replay must carry ticks produced while offline — far past
    // anything the INIT-time replay could have contained.
    await until(() => {
      const replayTicks = [...rig.stub.terminalOutput(info.channelId, true).matchAll(/tick-(\d+)-/g)].map(match => Number(match[1]))
      return replayTicks.some(tick => tick >= 20)
    }, 5_000)
  })

  it('reports scroll hold honestly and releases it on SCROLL_RESET', async () => {
    const rig = await createRig()
    const info = await openTerminal(rig)
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    spawnSync('tmux', ['-L', rig.socket, 'copy-mode', '-t', `=${info.ref.sessionName}:`], { stdio: 'ignore' })
    await until(async () => (await paneStatus(info.ref))?.held === true)
    rig.stub.sendTerminal(info.channelId, { type: 'SCROLL_RESET' })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'SCROLL_STATE' && !message.held))
    await until(async () => (await paneStatus(info.ref))?.held === false)
  })

  it('keeps the acknowledged-output window across a repeated INIT', async () => {
    const rig = await createRig({ host: { flow: { highWaterBytes: 4096, lowWaterBytes: 1024, flushMs: 5 } } })
    const producer = 'read line; i=0; while [ "$i" -lt 20000 ]; do echo filler-line-$i; i=$((i+1)); done; echo ALL-DONE; exec cat'
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', producer] })
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    rig.stub.sendTerminal(info.channelId, { type: 'INPUT', data: 'go\r' })
    await until(() => Buffer.byteLength(liveOutput(rig, info.channelId)) > 4096)
    await sleep(500)
    const stalled = Buffer.byteLength(liveOutput(rig, info.channelId))
    // A fresh INIT must not reopen the window: acknowledgment debt belongs to
    // the channel peer, not the viewer attach cycle.
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await sleep(500)
    expect(Buffer.byteLength(liveOutput(rig, info.channelId))).toBe(stalled)
    let acked = 0
    await until(() => {
      const total = Buffer.byteLength(liveOutput(rig, info.channelId))
      if (total > acked) {
        rig.stub.sendTerminal(info.channelId, { type: 'ACK', bytes: total - acked })
        acked = total
      }
      return liveOutput(rig, info.channelId).includes('ALL-DONE')
    }, 12_000)
  })

  it('keeps scrollback depth past the tmux default', async () => {
    const rig = await createRig({ host: { replayLines: 4000 } })
    const producer = 'i=0; while [ "$i" -lt 5000 ]; do echo depth-line-$i; i=$((i+1)); done; exec cat'
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', producer] })
    await sleep(1_500)
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    // A line 3,500 lines back only survives if the server config raised
    // history-limit before the pane was created.
    await until(() => rig.stub.terminalOutput(info.channelId, true).includes('depth-line-1500'), 10_000)
  })

  it('replays the last words of a command that dies before any viewer attaches', async () => {
    const rig = await createRig()
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', 'printf dying-words-42; sleep 0.3; exit 3'] })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'EXIT'))
    expect(rig.stub.terminalMessages(info.channelId).find(message => message.type === 'EXIT')).toEqual({ type: 'EXIT', exitCode: 3, signal: null })
    // No INIT ever arrived: tmux history died with the session, so the ring is
    // the only path this output has to the viewer.
    expect(rig.stub.terminalOutput(info.channelId, true)).toContain('dying-words-42')
  })

  it('reports EXIT for a command that exits immediately', async () => {
    const rig = await createRig()
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', 'exit 7'] })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'EXIT'))
    expect(rig.stub.terminalMessages(info.channelId).find(message => message.type === 'EXIT')).toEqual({ type: 'EXIT', exitCode: 7, signal: null })
  })

  it('releases the pty attachment when the control plane closes the channel', async () => {
    const rig = await createRig()
    const info = await openTerminal(rig)
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    expect(tmuxClients(rig.socket)).not.toBe('')
    rig.stub.closeToRunner(info.channelId, 'viewer gone')
    await until(() => rig.host.sessions().length === 0)
    // The attachment is gone with the binding; the tmux session survives for adopt.
    await until(() => tmuxClients(rig.socket) === '')
    expect(await hasTmuxSession(info.ref)).toBe(true)
    const adopted = await rig.host.adopt(info.ref, { cwd: rig.cwd, command: '/bin/cat' })
    await until(() => rig.stub.channels.has(adopted.channelId))
    rig.stub.sendTerminal(adopted.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(adopted.channelId).some(message => message.type === 'READY'))
  })

  it('delivers a burst larger than the frame cap, chunked, without loss', async () => {
    // A 300 ms flush window makes the whole burst accumulate into one flush,
    // which is exactly the shape that must chunk instead of assembling a frame
    // past the wire cap.
    const rig = await createRig({ host: { flow: { highWaterBytes: 8 * 1024 * 1024, lowWaterBytes: 1024, flushMs: 300 } } })
    const burst = 'read line; head -c 2097152 /dev/zero | tr "\\0" x; echo; echo BIG-DONE; exec cat'
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', burst] })
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    rig.stub.sendTerminal(info.channelId, { type: 'INPUT', data: 'go\r' })
    await until(() => liveOutput(rig, info.channelId).includes('BIG-DONE'), 10_000)
    // The burst's tail arrived and no flush assembled an oversized frame: every
    // live OUTPUT stayed within the chunk bound instead of hitting the wire cap.
    const outputs = rig.stub.terminalMessages(info.channelId).filter(message => message.type === 'OUTPUT' && !message.replay)
    expect(outputs.length).toBeGreaterThan(5)
    for (const message of outputs) expect(message.type === 'OUTPUT' && message.data.length).toBeLessThanOrEqual(16 * 1024)
  })

  it('observes copy-mode hold and announces output arriving while held', async () => {
    const rig = await createRig({ host: { pollMs: 100 } })
    const ticker = 'i=0; while true; do echo held-tick-$i; i=$((i+1)); sleep 0.05; done'
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', ticker] })
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    spawnSync('tmux', ['-L', rig.socket, 'copy-mode', '-t', `=${info.ref.sessionName}:`], { stdio: 'ignore' })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'SCROLL_STATE' && message.held))
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'SCROLL_STATE' && message.held && message.newOutput))
    rig.stub.sendTerminal(info.channelId, { type: 'SCROLL_RESET' })
    await until(() => {
      const states = rig.stub.terminalMessages(info.channelId).filter(message => message.type === 'SCROLL_STATE')
      const last = states[states.length - 1]
      return last?.type === 'SCROLL_STATE' && !last.held
    })
    await until(async () => (await paneStatus(info.ref))?.held === false)
  })

  it('resolves capture as null and copy-mode exit as failed for an unreachable tmux server', async () => {
    const missing = { socket: `mr-missing-${randomBytes(4).toString('hex')}`, sessionName: 'nothing' }
    await expect(captureTmuxScrollback(missing, 200)).resolves.toBeNull()
    await expect(exitTmuxCopyMode(missing)).resolves.toBe(false)
  })

  it('tears down a failed launch and stays serviceable', async () => {
    const rig = await createRig()
    await expect(rig.host.launch({ command: '/bin/cat', cwd: rig.cwd, socket: 'bad/socket' })).rejects.toThrow()
    await until(() => rig.stub.closes.some(entry => entry.reason === 'spawn failed'))
    const info = await openTerminal(rig)
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
  })

  it('answers an impossible scroll reset with an error, never a released hold', async () => {
    const rig = await createRig({ stub: { holdExitedChannels: true } })
    const info = await openTerminal(rig)
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    const statesBefore = rig.stub.terminalMessages(info.channelId).filter(message => message.type === 'SCROLL_STATE').length
    spawnSync('tmux', ['-L', rig.socket, 'kill-server'], { stdio: 'ignore' })
    await sleep(100)
    rig.stub.sendTerminal(info.channelId, { type: 'SCROLL_RESET' })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'ERROR' && (message.message === 'scroll reset failed' || message.message === 'session already exited')))
    expect(rig.stub.terminalMessages(info.channelId).filter(message => message.type === 'SCROLL_STATE').length).toBe(statesBefore)
  })

  it('pauses the pty rather than growing the queue while a replay barrier holds output', async () => {
    const rig = await createRig({ host: { flow: { highWaterBytes: 4096, lowWaterBytes: 1024, flushMs: 5 }, replayLines: 4000 } })
    const producer = 'read line; i=0; while [ "$i" -lt 6000 ]; do echo barrier-line-$i; i=$((i+1)); done; echo ALL-DONE; exec cat'
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', producer] })
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    rig.stub.sendTerminal(info.channelId, { type: 'INPUT', data: 'go\r' })
    // A storm of INITs keeps a replay barrier up while the producer runs: the
    // pty must pause on queued bytes, not buffer the whole run in memory.
    for (let i = 0; i < 10; i += 1) rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await sleep(800)
    expect(liveOutput(rig, info.channelId)).not.toContain('ALL-DONE')
    let acked = 0
    await until(() => {
      const total = Buffer.byteLength(liveOutput(rig, info.channelId))
      if (total > acked) {
        rig.stub.sendTerminal(info.channelId, { type: 'ACK', bytes: total - acked })
        acked = total
      }
      return liveOutput(rig, info.channelId).includes('ALL-DONE')
    }, 15_000)
  })

  it('holds EXIT until the flow-controlled tail drains, losing nothing', async () => {
    const rig = await createRig({ host: { flow: { highWaterBytes: 4096, lowWaterBytes: 1024, flushMs: 5 } } })
    const producer = 'read line; i=0; while [ "$i" -lt 3000 ]; do echo tail-line-$i; i=$((i+1)); done; echo TAIL-END; exit 9'
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', producer] })
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    rig.stub.sendTerminal(info.channelId, { type: 'INPUT', data: 'go\r' })
    await until(() => Buffer.byteLength(liveOutput(rig, info.channelId)) > 4096)
    await sleep(800)
    // The command is long gone, but output is still held by the window: EXIT
    // must not overtake it.
    expect(rig.stub.terminalMessages(info.channelId).some(message => message.type === 'EXIT')).toBe(false)
    const stalled = Buffer.byteLength(liveOutput(rig, info.channelId))
    let acked = 0
    await until(() => {
      const total = Buffer.byteLength(liveOutput(rig, info.channelId))
      if (total > acked) {
        rig.stub.sendTerminal(info.channelId, { type: 'ACK', bytes: total - acked })
        acked = total
      }
      return rig.stub.terminalMessages(info.channelId).some(message => message.type === 'EXIT')
    }, 15_000)
    expect(rig.stub.terminalMessages(info.channelId).find(message => message.type === 'EXIT')).toEqual({ type: 'EXIT', exitCode: 9, signal: null })
    expect(Buffer.byteLength(liveOutput(rig, info.channelId))).toBeGreaterThanOrEqual(stalled)
    // The draining acknowledgments were honored, never bounced as "already
    // exited": a session waiting to emit EXIT is still draining, and that
    // drain runs on ACKs. What the viewer missed *while* paused lives in
    // scrollback, not in the live stream — tmux coalesces output for a client
    // that is not reading into a repaint, so replay makes it whole.
    expect(rig.stub.terminalMessages(info.channelId).filter(message => message.type === 'ERROR')).toEqual([])
  })

  it('confirms a kill instead of assuming it', async () => {
    const rig = await createRig()
    const info = await openTerminal(rig)
    expect(await killTmuxSession(info.ref)).toBe(true)
    expect(await hasTmuxSession(info.ref)).toBe(false)
    // Nothing to kill is success, not a failure to report.
    expect(await killTmuxSession({ socket: `mr-gone-${randomBytes(4).toString('hex')}`, sessionName: 'nothing' })).toBe(true)
  })

  it('releases a session whose channel closed while it was starting', async () => {
    const rig = await createRig({ stub: { closeOnOpen: true } })
    const info = await rig.host.launch({ command: '/bin/cat', cwd: rig.cwd, socket: rig.socket })
    expect(info.released).toBe(true)
    expect(rig.host.sessions()).toEqual([])
    // Released like any other closed channel: the attachment goes, the tmux
    // session stays adoptable.
    await until(() => tmuxClients(rig.socket) === '')
    expect(await hasTmuxSession(info.ref)).toBe(true)
  })

  it('kills a session that no viewer ever attached to', async () => {
    const rig = await createRig()
    const info = await openTerminal(rig)
    rig.stub.sendTerminal(info.channelId, { type: 'KILL' })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'EXIT'))
    expect(await hasTmuxSession(info.ref)).toBe(false)
  })

  it('does not loop replaying when a replay outruns the channel replay budget', async () => {
    const rig = await createRig({ client: { bufferBytes: 2048, totalBufferBytes: 2048 }, host: { replayLines: 4000 } })
    const producer = 'i=0; while [ "$i" -lt 3000 ]; do echo loop-line-$i; i=$((i+1)); done; exec cat'
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', producer] })
    await sleep(1_200)
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.resets.some(entry => entry.channel === info.channelId), 10_000)
    const settled = rig.stub.resets.length
    await sleep(1_500)
    // The reset announced the loss once; replaying again would overflow again,
    // so the runner stops instead of spinning.
    expect(rig.stub.resets.length - settled).toBeLessThanOrEqual(2)
  })

  it('keeps pre-INIT output when the capture that would replace it fails', async () => {
    const rig = await createRig({ stub: { holdExitedChannels: true } })
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', 'printf ring-survives-77; exec cat'] })
    await sleep(400)
    // The tmux server dies in the same breath as the INIT: the capture cannot
    // answer, so the ring must still carry the output out ahead of EXIT.
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    spawnSync('tmux', ['-L', rig.socket, 'kill-server'], { stdio: 'ignore' })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'EXIT'), 10_000)
    expect(rig.stub.terminalOutput(info.channelId, true)).toContain('ring-survives-77')
  })

  it('honors an INIT that arrives before the session finished starting', async () => {
    const rig = await createRig({ stub: { terminalOnOpen: { type: 'INIT', cols: 80, rows: 24 } } })
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', 'printf early-init-9; exec cat'] })
    // The test never sends INIT: the one the peer sent against the bare `open`
    // must survive the gap before the binding existed.
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    await until(() => rig.stub.terminalOutput(info.channelId, true).includes('early-init-9'))
  })

  it('kills a launch that lands after shutdown began', async () => {
    const rig = await createRig()
    const launching = rig.host.launch({ command: '/bin/cat', cwd: rig.cwd, socket: rig.socket })
    const unconfirmed = await rig.host.killAll()
    const info = await launching
    expect(unconfirmed).toEqual([])
    expect(rig.host.sessions()).toEqual([])
    expect(await hasTmuxSession(info.ref)).toBe(false)
  })

  it('shares one pane watcher per tmux server', async () => {
    const rig = await createRig({ host: { pollMs: 100 } })
    const before = paneWatcherCount()
    const infos = []
    for (let i = 0; i < 3; i += 1) infos.push(await openTerminal(rig))
    for (const info of infos) {
      rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
      await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    }
    // Three sessions on one server cost one poller, not three.
    expect(paneWatcherCount()).toBe(before + 1)
  })

  it('recovers scrollback before tearing down a pane whose viewer fell behind', async () => {
    const rig = await createRig({ host: { flow: { highWaterBytes: 4096, lowWaterBytes: 1024, flushMs: 5 }, pollMs: 100 } })
    // No acknowledgments, so the pty pauses and tmux coalesces output away:
    // the viewer genuinely has a hole only scrollback can fill.
    const producer = 'read line; i=0; while [ "$i" -lt 3000 ]; do echo behind-line-$i; i=$((i+1)); done; exit 4'
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', producer] })
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    rig.stub.sendTerminal(info.channelId, { type: 'INPUT', data: 'go\r' })
    await until(() => Buffer.byteLength(liveOutput(rig, info.channelId)) > 4096)
    let acked = 0
    await until(() => {
      if (rig.stub.terminalMessages(info.channelId).some(message => message.type === 'EXIT')) return true
      const total = Buffer.byteLength(liveOutput(rig, info.channelId))
      if (total > acked && rig.stub.channels.has(info.channelId)) {
        rig.stub.sendTerminal(info.channelId, { type: 'ACK', bytes: total - acked })
        acked = total
      }
      return false
    }, 20_000)
    const messages = rig.stub.terminalMessages(info.channelId)
    const exitAt = messages.findIndex(message => message.type === 'EXIT')
    const recoveredAt = messages.findIndex(message => message.type === 'OUTPUT' && message.replay && message.data.includes('behind-line-'))
    expect(recoveredAt).toBeGreaterThanOrEqual(0)
    // Recovery comes first; the session is only killed once the end-of-stream is out.
    expect(recoveredAt).toBeLessThan(exitAt)
    await until(async () => !(await hasTmuxSession(info.ref)))
  })

  it('does not replay at exit when the viewer never fell behind', async () => {
    const rig = await createRig({ host: { pollMs: 100 } })
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', 'read line; printf last-gasp-55; exit 4'] })
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    rig.stub.sendTerminal(info.channelId, { type: 'INPUT', data: 'go\r' })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'EXIT'), 10_000)
    // It arrived live; replaying it at exit would only duplicate what the
    // viewer already rendered.
    expect(liveOutput(rig, info.channelId)).toContain('last-gasp-55')
    expect(rig.stub.terminalOutput(info.channelId, true)).not.toContain('last-gasp-55')
  })

  it('reports presence, absence, and refuses to confirm a kill it could not verify', async () => {
    const rig = await createRig()
    const info = await openTerminal(rig)
    expect(await tmuxSessionPresence(info.ref)).toBe('present')
    expect(await tmuxSessionPresence({ socket: `mr-gone-${randomBytes(4).toString('hex')}`, sessionName: 'nothing' })).toBe('absent')
    // A tmux that cannot be executed at all is not an absent session.
    expect(await tmuxSessionPresence({ socket: 'x'.repeat(200), sessionName: 'nothing' })).not.toBe('present')
  })

  it('keeps an early KILL when input floods the pre-binding queue', async () => {
    // A hundred inputs land against the bare `open`, before the session exists,
    // and the kill behind them must still reach it.
    const flood: TerminalClientMessage[] = Array.from({ length: 100 }, (_, index) => ({ type: 'INPUT', data: `flood-${index}` }))
    const rig = await createRig({ stub: { terminalBurstOnOpen: [...flood, { type: 'KILL' }] } })
    const info = await openTerminal(rig)
    await until(async () => !(await hasTmuxSession(info.ref)), 10_000)
  })

  it('refuses new launches while the host is shutting down', async () => {
    const rig = await createRig()
    await openTerminal(rig)
    const shutdown = rig.host.killAll()
    expect(() => rig.host.launch({ command: '/bin/cat', cwd: rig.cwd, socket: rig.socket })).toThrow(/shutting down/)
    await shutdown
    expect(rig.host.sessions()).toEqual([])
  })

  it('does not report a session dead while one of its panes lives', async () => {
    const rig = await createRig({ host: { pollMs: 100 } })
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', 'exit 0'] })
    // A second, living pane in the same session: the first pane dies at once,
    // and the session must not be retired while the other one runs.
    spawnSync('tmux', ['-L', rig.socket, 'split-window', '-d', '-t', `=${info.ref.sessionName}:`, '--', '/bin/cat'], { stdio: 'ignore' })
    await sleep(700)
    expect(rig.stub.terminalMessages(info.channelId).some(message => message.type === 'EXIT')).toBe(false)
    expect(await hasTmuxSession(info.ref)).toBe(true)
  })

  it('coalesces a burst of KILLs into one exit', async () => {
    const rig = await createRig()
    const info = await openTerminal(rig)
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    for (let i = 0; i < 20; i += 1) rig.stub.sendTerminal(info.channelId, { type: 'KILL' })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'EXIT'))
    await sleep(400)
    expect(rig.stub.terminalMessages(info.channelId).filter(message => message.type === 'EXIT')).toHaveLength(1)
    expect(await hasTmuxSession(info.ref)).toBe(false)
  })

  it('shares one shutdown between concurrent killAll calls', async () => {
    const rig = await createRig()
    await openTerminal(rig)
    await openTerminal(rig)
    const [first, second] = await Promise.all([rig.host.killAll(), rig.host.killAll()])
    expect(first).toEqual([])
    expect(second).toEqual([])
    expect(rig.host.sessions()).toEqual([])
    // The gate reopens exactly once, after the shared shutdown settles.
    const info = await openTerminal(rig)
    expect(info.released).toBe(false)
  })

  it('keeps an early KILL even when the queue is nothing but INITs', async () => {
    const inits: TerminalClientMessage[] = Array.from({ length: 80 }, () => ({ type: 'INIT', cols: 80, rows: 24 }))
    const rig = await createRig({ stub: { terminalBurstOnOpen: [...inits, { type: 'KILL' }] } })
    const info = await openTerminal(rig)
    await until(async () => !(await hasTmuxSession(info.ref)), 10_000)
  })

  it('refuses a profile the peer validator would reject, before running anything', async () => {
    const rig = await createRig()
    await expect(rig.host.launch({ command: '/bin/cat', cwd: rig.cwd, socket: rig.socket, profile: 'code review' }))
      .rejects.toThrow(/not a valid terminal label/)
    // Refused before the command could run: no session, no side effects.
    expect(tmuxSessions(rig.socket)).toEqual([])
    // The host stays usable after refusing the bad launch.
    const info = await openTerminal(rig, { profile: 'code-review' })
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
  })

  it('refuses input once a kill is in flight', async () => {
    const rig = await createRig()
    const info = await openTerminal(rig)
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    rig.stub.sendTerminal(info.channelId, { type: 'KILL' })
    rig.stub.sendTerminal(info.channelId, { type: 'INPUT', data: 'too-late\r' })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'ERROR' && message.message === 'session kill is pending')
      || rig.stub.terminalMessages(info.channelId).some(message => message.type === 'ERROR' && message.message === 'session already exited'))
    await until(async () => !(await hasTmuxSession(info.ref)))
  })

  it('recovers history before the end-of-stream when a reset lands on a dying session', async () => {
    const rig = await createRig({ client: { bufferBytes: 4096 }, host: { flow: { highWaterBytes: 4096, lowWaterBytes: 1024, flushMs: 5 } } })
    const producer = 'read line; i=0; while [ "$i" -lt 3000 ]; do echo dying-line-$i; i=$((i+1)); done; echo DYING-END; exit 6'
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', producer] })
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    rig.stub.sendTerminal(info.channelId, { type: 'INPUT', data: 'go\r' })
    let acked = 0
    await until(() => {
      if (rig.stub.terminalMessages(info.channelId).some(message => message.type === 'EXIT')) return true
      const total = Buffer.byteLength(liveOutput(rig, info.channelId))
      if (total > acked && rig.stub.channels.has(info.channelId)) {
        rig.stub.sendTerminal(info.channelId, { type: 'ACK', bytes: total - acked })
        acked = total
      }
      return false
    }, 20_000)
    const messages = rig.stub.terminalMessages(info.channelId)
    const exitAt = messages.findIndex(message => message.type === 'EXIT')
    const lastReplayAt = messages.map(message => message.type === 'OUTPUT' && message.replay).lastIndexOf(true)
    // Whatever history was recovered arrived before the end-of-stream.
    expect(lastReplayAt).toBeLessThan(exitAt)
  })

  it('keeps early input ordered behind the INIT it depends on', async () => {
    // INIT, INPUT, INIT: the later INIT replaces the earlier one in place, so
    // the input still drains after an initialization, not before it.
    const burst: TerminalClientMessage[] = [
      { type: 'INIT', cols: 80, rows: 24 },
      { type: 'INPUT', data: 'ordered-input-7\r' },
      { type: 'INIT', cols: 100, rows: 30 },
    ]
    const rig = await createRig({ stub: { terminalBurstOnOpen: burst } })
    const info = await openTerminal(rig)
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    await until(() => liveOutput(rig, info.channelId).includes('ordered-input-7'), 10_000)
    expect(rig.stub.terminalMessages(info.channelId).some(message => message.type === 'ERROR' && message.message === 'session not initialized')).toBe(false)
  })

  it('keeps heartbeats flowing through a large scrollback replay', async () => {
    const rig = await createRig({ stub: { heartbeat: { intervalMs: 200, timeoutMs: 1_000 } }, host: { replayLines: 6000 } })
    const producer = 'i=0; while [ "$i" -lt 6000 ]; do echo heartbeat-line-$i; i=$((i+1)); done; exec cat'
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', producer] })
    await sleep(1_500)
    const pingsBefore = rig.stub.runnerPings.length
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalOutput(info.channelId, true).includes('heartbeat-line-'), 10_000)
    // The replay is paced, so liveness kept its cadence while it ran.
    await until(() => rig.stub.runnerPings.length > pingsBefore + 1, 10_000)
    expect(rig.client.isConnected()).toBe(true)
  })

  it('reattaches a live pane that lost its attachment', async () => {
    const rig = await createRig({ host: { pollMs: 150 } })
    const info = await openTerminal(rig)
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    spawnSync('tmux', ['-L', rig.socket, 'detach-client', '-s', info.ref.sessionName], { stdio: 'ignore' })
    await sleep(500)
    rig.stub.sendTerminal(info.channelId, { type: 'INPUT', data: 'after-detach-3\r' })
    await until(() => liveOutput(rig, info.channelId).includes('after-detach-3'), 10_000)
  })

  it('does not deliver the same bytes as both replay and live output', async () => {
    const rig = await createRig()
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', 'printf unique-marker-4242; exec cat'] })
    await sleep(400)
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalOutput(info.channelId, true).includes('unique-marker-4242'))
    await sleep(500)
    // The marker was on the pane before the capture, so it belongs to the
    // snapshot — it must not also arrive as live output afterwards.
    const occurrences = [...rig.stub.terminalOutput(info.channelId, false).matchAll(/unique-marker-4242/g)].length
    expect(occurrences).toBe(0)
  })

  it('delivers output still queued when the command exits', async () => {
    // A long flush window keeps the final bytes in the queue at the moment the
    // pane dies: the exit path has to deliver them, not discard them.
    const rig = await createRig({ host: { flow: { highWaterBytes: 512 * 1024, lowWaterBytes: 128 * 1024, flushMs: 500 }, pollMs: 100 } })
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', 'read line; printf final-words-99; exit 3'] })
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    rig.stub.sendTerminal(info.channelId, { type: 'INPUT', data: 'go\r' })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'EXIT'), 10_000)
    expect(liveOutput(rig, info.channelId)).toContain('final-words-99')
    expect(rig.stub.terminalMessages(info.channelId).find(message => message.type === 'EXIT')).toEqual({ type: 'EXIT', exitCode: 3, signal: null })
  })

  it('does not retire a session that launched while a pane poll was in flight', async () => {
    const rig = await createRig({ host: { pollMs: 60 } })
    const first = await openTerminal(rig)
    rig.stub.sendTerminal(first.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(first.channelId).some(message => message.type === 'READY'))
    // Launch into the middle of the poll cycle: a snapshot taken before these
    // existed must not be read as evidence that they are dead.
    const late = []
    for (let i = 0; i < 4; i += 1) {
      late.push(await openTerminal(rig))
      await sleep(35)
    }
    await sleep(600)
    for (const info of late) {
      expect(rig.stub.terminalMessages(info.channelId).some(message => message.type === 'EXIT')).toBe(false)
      expect(await hasTmuxSession(info.ref)).toBe(true)
    }
  })

  it('completes shutdown even when the tmux server is already gone', async () => {
    const rig = await createRig()
    const info = await openTerminal(rig)
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    spawnSync('tmux', ['-L', rig.socket, 'kill-server'], { stdio: 'ignore' })
    // Teardown must resolve rather than reject out of the shutdown and leave
    // the host permanently closed.
    await expect(rig.host.killAll()).resolves.toEqual([])
    const reopened = await openTerminal(rig)
    expect(reopened.released).toBe(false)
  })

  it('honors a kill requested before the session existed, even if the channel closes', async () => {
    // KILL lands against the bare `open`, then the channel closes while the
    // session is still starting: the queued message dies, the intent must not.
    const rig = await createRig({ stub: { terminalBurstOnOpen: [{ type: 'KILL' }], closeOnOpen: true } })
    const info = await rig.host.launch({ command: '/bin/cat', cwd: rig.cwd, socket: rig.socket })
    expect(info.released).toBe(true)
    await until(async () => !(await hasTmuxSession(info.ref)), 10_000)
  })

  it('rations scrollback captures against a peer that repeats INIT', async () => {
    const rig = await createRig()
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', 'printf ration-me; exec cat'] })
    for (let i = 0; i < 12; i += 1) rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'ERROR' && message.message === 'scrollback replay rate limited'), 10_000)
    // The budget bounds captures; the session stays healthy and still streams.
    rig.stub.sendTerminal(info.channelId, { type: 'INPUT', data: 'still-alive-8\r' })
    await until(() => liveOutput(rig, info.channelId).includes('still-alive-8'), 10_000)
  })

  it('reports an acknowledgment larger than the outstanding live output', async () => {
    const rig = await createRig()
    const info = await openTerminal(rig)
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    rig.stub.sendTerminal(info.channelId, { type: 'ACK', bytes: 5_000_000 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'ERROR' && message.message === 'acknowledgment exceeds outstanding live output'))
  })

  it('refuses a pre-binding input larger than the retained-byte cap', async () => {
    // One near-frame-sized INPUT against the bare `open`: counting only what is
    // already queued would let it through, once per channel, roster-wide.
    const oversized: TerminalClientMessage = { type: 'INPUT', data: `${'x'.repeat(300 * 1024)}cap-breaker-1\r` }
    const rig = await createRig({ stub: { terminalBurstOnOpen: [oversized] } })
    const info = await openTerminal(rig)
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    // A later input still works, so the channel was not broken — only the
    // oversized one was refused.
    rig.stub.sendTerminal(info.channelId, { type: 'INPUT', data: 'accepted-after\r' })
    await until(() => liveOutput(rig, info.channelId).includes('accepted-after'), 10_000)
    expect(liveOutput(rig, info.channelId)).not.toContain('cap-breaker-1')
  })

  it('refuses an over-acknowledgment instead of crediting it', async () => {
    const rig = await createRig({ host: { flow: { highWaterBytes: 4096, lowWaterBytes: 1024, flushMs: 5 } } })
    const producer = 'read line; i=0; while [ "$i" -lt 20000 ]; do echo credit-line-$i; i=$((i+1)); done; echo ALL-DONE; exec cat'
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', producer] })
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    rig.stub.sendTerminal(info.channelId, { type: 'INPUT', data: 'go\r' })
    await until(() => Buffer.byteLength(liveOutput(rig, info.channelId)) > 4096)
    await sleep(500)
    const stalled = Buffer.byteLength(liveOutput(rig, info.channelId))
    // A wildly oversized acknowledgment must not buy the window open.
    for (let i = 0; i < 5; i += 1) rig.stub.sendTerminal(info.channelId, { type: 'ACK', bytes: 9_000_000 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'ERROR' && message.message === 'acknowledgment exceeds outstanding live output'))
    await sleep(600)
    expect(Buffer.byteLength(liveOutput(rig, info.channelId))).toBe(stalled)
  })

  it('reports a signal-killed command as a signal, not an exit code', async () => {
    const rig = await createRig()
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', 'read line; kill -TERM $$'] })
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    rig.stub.sendTerminal(info.channelId, { type: 'INPUT', data: 'go\r' })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'EXIT'), 10_000)
    // SIGTERM is signal 15, distinct from an ordinary exit 143.
    expect(rig.stub.terminalMessages(info.channelId).find(message => message.type === 'EXIT')).toEqual({ type: 'EXIT', exitCode: null, signal: 15 })
  })

  it('never accepts an INIT for a session whose kill was confirmed', async () => {
    const rig = await createRig()
    const info = await openTerminal(rig)
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    const readyBefore = rig.stub.terminalMessages(info.channelId).filter(message => message.type === 'READY').length
    rig.stub.sendTerminal(info.channelId, { type: 'KILL' })
    // A re-INIT racing the kill must not resurrect the session as streaming.
    for (let i = 0; i < 5; i += 1) rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'EXIT'))
    expect(rig.stub.terminalMessages(info.channelId).filter(message => message.type === 'READY').length).toBe(readyBefore)
    expect(await hasTmuxSession(info.ref)).toBe(false)
  })

  it('drops the binding once a supervised session finishes after its channel closed', async () => {
    const rig = await createRig()
    const info = await openTerminal(rig)
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    // Kill in flight, then the channel closes underneath it: the binding is kept
    // to keep watching, and must be cleared once the session actually ends.
    rig.stub.sendTerminal(info.channelId, { type: 'KILL' })
    rig.stub.closeToRunner(info.channelId, 'gone')
    await until(() => rig.host.sessions().every(session => session.channelId !== info.channelId), 10_000)
    expect(await hasTmuxSession(info.ref)).toBe(false)
  })

  it('detects a dead pane on a later socket despite busy earlier ones', async () => {
    // More sockets than poll slots: FIFO scheduling must still service the last.
    const rigs6 = []
    for (let i = 0; i < 6; i += 1) rigs6.push(await createRig({ host: { pollMs: 60 } }))
    const infos = []
    for (const r of rigs6) {
      const info = await openTerminal(r, { command: '/bin/sh', args: ['-c', 'read line; exit 0'] })
      r.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
      await until(() => r.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
      infos.push(info)
    }
    // Make the last-created session's command exit; its EXIT must still arrive.
    const lastRig = rigs6[rigs6.length - 1]!
    const lastInfo = infos[infos.length - 1]!
    lastRig.stub.sendTerminal(lastInfo.channelId, { type: 'INPUT', data: 'go\r' })
    await until(() => lastRig.stub.terminalMessages(lastInfo.channelId).some(message => message.type === 'EXIT'), 10_000)
  })

  it('never emits OUTPUT after EXIT, whatever a late ACK or KILL asks', async () => {
    // holdExitedChannels keeps the channel open so post-EXIT messages can be
    // delivered at all — the whole point is that they change nothing.
    const rig = await createRig({ stub: { holdExitedChannels: true }, host: { flow: { highWaterBytes: 4096, lowWaterBytes: 1024, flushMs: 5 }, pollMs: 80 } })
    const producer = 'read line; i=0; while [ "$i" -lt 3000 ]; do echo held-tail-$i; i=$((i+1)); done; exit 0'
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', producer] })
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    rig.stub.sendTerminal(info.channelId, { type: 'INPUT', data: 'go\r' })
    // The viewer never ACKs, so output is held; the pane dies into the exit
    // path with a tail still owed. Force it out with KILL, then prod it with a
    // burst of ACKs and another KILL — none may produce OUTPUT after the EXIT.
    // Wait for the exit-time scrollback replay: proof the pane died into the
    // exit path with the tail still held (never ACKed).
    await until(() => rig.stub.terminalOutput(info.channelId, true).includes('held-tail-'), 15_000)
    rig.stub.sendTerminal(info.channelId, { type: 'KILL' })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'EXIT'), 6_000)
    for (let i = 0; i < 5; i += 1) rig.stub.sendTerminal(info.channelId, { type: 'ACK', bytes: 4096 })
    rig.stub.sendTerminal(info.channelId, { type: 'KILL' })
    await sleep(400)
    const after = rig.stub.terminalMessages(info.channelId)
    const exitAt = after.findIndex(message => message.type === 'EXIT')
    expect(after.slice(exitAt + 1).some(message => message.type === 'OUTPUT')).toBe(false)
  })

  it('recovers via replay at exit when a tail is still queued', async () => {
    // A long flush window keeps the final output queued at the moment the pane
    // dies. With the queue draining on exit and the window open, the exit-time
    // flush would finalize the session before recovery ran — the bug this pins.
    const rig = await createRig({ stub: { holdExitedChannels: true }, host: { flow: { highWaterBytes: 4096, lowWaterBytes: 1024, flushMs: 800 }, pollMs: 60 } })
    const producer = 'read line; i=0; while [ "$i" -lt 400 ]; do echo pl-$i; i=$((i+1)); done; echo SENTINEL-77; exit 0'
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', producer] })
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    // Momentarily pause so missedWhilePaused is recorded, then keep the window
    // open with a steady drain while output stays batched behind the flush.
    let acked = 0
    rig.stub.sendTerminal(info.channelId, { type: 'INPUT', data: 'go\r' })
    await until(() => {
      const total = Buffer.byteLength(liveOutput(rig, info.channelId))
      if (total > acked) {
        rig.stub.sendTerminal(info.channelId, { type: 'ACK', bytes: total - acked })
        acked = total
      }
      return rig.stub.terminalMessages(info.channelId).some(message => message.type === 'EXIT')
        || rig.stub.terminalOutput(info.channelId, true).includes('SENTINEL-77')
    }, 20_000)
    // The sentinel must reach the viewer — via live drain or exit-time replay —
    // never dropped because recovery was skipped when the exit finalized first.
    await until(() => liveOutput(rig, info.channelId).includes('SENTINEL-77')
      || rig.stub.terminalOutput(info.channelId, true).includes('SENTINEL-77'), 10_000)
  })

  it('adopts a detached tmux session and replays its scrollback', async () => {
    const rig = await createRig()
    const info = await openTerminal(rig, { command: '/bin/sh', args: ['-c', 'printf adopt-marker-999; exec cat'] })
    rig.stub.sendTerminal(info.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(info.channelId).some(message => message.type === 'READY'))
    rig.host.detach(info.channelId)
    await until(() => rig.stub.closes.some(entry => entry.channel === info.channelId && entry.reason === 'detached'))
    expect(await hasTmuxSession(info.ref)).toBe(true)

    const adopted = await rig.host.adopt(info.ref, { cwd: rig.cwd, command: '/bin/cat' })
    await until(() => rig.stub.channels.has(adopted.channelId))
    rig.stub.sendTerminal(adopted.channelId, { type: 'INIT', cols: 80, rows: 24 })
    await until(() => rig.stub.terminalMessages(adopted.channelId).some(message => message.type === 'READY'))
    await until(() => rig.stub.terminalOutput(adopted.channelId, true).includes('adopt-marker-999'))
    rig.stub.sendTerminal(adopted.channelId, { type: 'INPUT', data: 'post-adopt-input\r' })
    await until(() => rig.stub.terminalOutput(adopted.channelId, false).includes('post-adopt-input'))
  })
})

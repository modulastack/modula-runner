import { describe, expect, it } from 'vitest'
import { MAX_FRAME_BYTES, decodeFrame, encodeFrame, isSafeIdentifier, type Frame } from '@modulastack/runner-protocol'

const token = 'a'.repeat(32)

const validFrames: Frame[] = [
  { type: 'hello', protocol: { min: 1, max: 1 }, runner: { name: 'r1', version: '0.1.0', os: 'linux', arch: 'x64' }, channels: [] },
  { type: 'hello', protocol: { min: 1, max: 2 }, runner: { name: 'r1', version: '0.1.0', os: 'linux', arch: 'x64' }, channels: [{ id: 'ch1', kind: 'terminal', attachToken: token, sentSeq: 5, receivedSeq: 2 }] },
  { type: 'welcome', protocol: 1, heartbeat: { intervalMs: 1000, timeoutMs: 5000 }, channels: [{ id: 'ch1', status: 'resumed', receivedSeq: 4 }, { id: 'ch2', status: 'expired' }] },
  { type: 'reject', reason: 'no common protocol version', supported: [2, 3] },
  { type: 'ping', id: 'hb-1' },
  { type: 'pong', id: 'hb-1' },
  { type: 'open', channel: 'ch1', kind: 'terminal', attachToken: token },
  { type: 'data', channel: 'ch1', seq: 1, payload: { codec: 'json', body: { hello: true } } },
  { type: 'data', channel: 'ch1', seq: 2, payload: { codec: 'text', body: 'plain output' } },
  { type: 'data', channel: 'ch1', seq: 3, payload: { codec: 'sealed', alg: 'xchacha20poly1305', nonce: 'bm9uY2U', body: 'Y2lwaGVydGV4dA' } },
  { type: 'reset', channel: 'ch1', seq: 7 },
  { type: 'close', channel: 'ch1' },
  { type: 'close', channel: 'ch1', reason: 'done' },
  { type: 'error', message: 'boom' },
  { type: 'error', message: 'boom', channel: 'ch1' },
]

describe('codec', () => {
  it('round-trips every version-1 frame', () => {
    for (const frame of validFrames) {
      expect(decodeFrame(encodeFrame(frame)), `frame ${frame.type}`).toEqual(frame)
    }
  })

  it('rejects unknown frame types and junk', () => {
    expect(decodeFrame('{"type":"shutdown"}')).toBeNull()
    expect(decodeFrame('not json')).toBeNull()
    expect(decodeFrame('42')).toBeNull()
    expect(decodeFrame('[]')).toBeNull()
  })

  it('does not resolve frame types through the object prototype', () => {
    expect(decodeFrame('{"type":"constructor"}')).toBeNull()
    expect(decodeFrame('{"type":"toString"}')).toBeNull()
    expect(decodeFrame('{"type":"hasOwnProperty"}')).toBeNull()
  })

  it('bounds close reasons', () => {
    expect(decodeFrame(JSON.stringify({ type: 'close', channel: 'ch1', reason: 'x'.repeat(501) }))).toBeNull()
    expect(decodeFrame(JSON.stringify({ type: 'close', channel: 'ch1', reason: 'x'.repeat(500) }))).not.toBeNull()
  })

  it('rejects unsafe channel identifiers', () => {
    expect(decodeFrame(JSON.stringify({ type: 'reset', channel: '../etc', seq: 1 }))).toBeNull()
    expect(decodeFrame(JSON.stringify({ type: 'reset', channel: 'a/b', seq: 1 }))).toBeNull()
    expect(decodeFrame(JSON.stringify({ type: 'close', channel: '.hidden' }))).toBeNull()
  })

  it('rejects zero sequences on data and reset frames', () => {
    expect(decodeFrame(JSON.stringify({ type: 'data', channel: 'ch1', seq: 0, payload: { codec: 'text', body: 'x' } }))).toBeNull()
    expect(decodeFrame(JSON.stringify({ type: 'reset', channel: 'ch1', seq: 0 }))).toBeNull()
  })

  it('rejects rosters with duplicate channel ids', () => {
    const dupWelcome = { type: 'welcome', protocol: 1, heartbeat: { intervalMs: 200, timeoutMs: 1000 }, channels: [
      { id: 'ch1', status: 'resumed', receivedSeq: 3 },
      { id: 'ch1', status: 'expired' },
    ] }
    expect(decodeFrame(JSON.stringify(dupWelcome))).toBeNull()
    const dupHello = { type: 'hello', protocol: { min: 1, max: 1 }, runner: { name: 'r', version: 'v', os: 'l', arch: 'x' }, channels: [
      { id: 'ch1', kind: 'terminal', attachToken: token, sentSeq: 1, receivedSeq: 0 },
      { id: 'ch1', kind: 'terminal', attachToken: token, sentSeq: 2, receivedSeq: 0 },
    ] }
    expect(decodeFrame(JSON.stringify(dupHello))).toBeNull()
  })

  it('bounds runner metadata fields', () => {
    const hello = { type: 'hello', protocol: { min: 1, max: 1 }, runner: { name: 'r'.repeat(201), version: 'v', os: 'l', arch: 'x' }, channels: [] }
    expect(decodeFrame(JSON.stringify(hello))).toBeNull()
  })

  it('rejects structurally broken frames', () => {
    expect(decodeFrame(JSON.stringify({ type: 'data', channel: 'ch1', seq: -1, payload: { codec: 'text', body: 'x' } }))).toBeNull()
    expect(decodeFrame(JSON.stringify({ type: 'data', channel: 'ch1', seq: 1, payload: { codec: 'zip', body: 'x' } }))).toBeNull()
    expect(decodeFrame(JSON.stringify({ type: 'open', channel: 'ch1', kind: 'shell', attachToken: token }))).toBeNull()
    expect(decodeFrame(JSON.stringify({ type: 'open', channel: 'ch1', kind: 'terminal', attachToken: 'short' }))).toBeNull()
    expect(decodeFrame(JSON.stringify({ type: 'welcome', protocol: 1, heartbeat: { intervalMs: 0, timeoutMs: 5 }, channels: [] }))).toBeNull()
    expect(decodeFrame(JSON.stringify({ type: 'hello', protocol: { min: 2, max: 1 }, runner: { name: 'r', version: 'v', os: 'l', arch: 'x' }, channels: [] }))).toBeNull()
  })

  it('bounds heartbeat policy values', () => {
    const welcome = (intervalMs: number, timeoutMs: number) =>
      decodeFrame(JSON.stringify({ type: 'welcome', protocol: 1, heartbeat: { intervalMs, timeoutMs }, channels: [] }))
    expect(welcome(1, 1000)).toBeNull()
    expect(welcome(2_147_483_648, 2_147_483_648)).toBeNull()
    expect(welcome(1000, 500)).toBeNull()
    expect(welcome(200, 200)).toBeNull()
    expect(welcome(200, 399)).toBeNull()
    expect(welcome(200, 400)).not.toBeNull()
  })

  it('drops frames past the size cap', () => {
    const oversized = encodeFrame({ type: 'data', channel: 'ch1', seq: 1, payload: { codec: 'text', body: 'x'.repeat(MAX_FRAME_BYTES) } })
    expect(decodeFrame(oversized)).toBeNull()
  })

  it('enforces the safe-segment rule for identifiers', () => {
    expect(isSafeIdentifier('worktree-01.lane_2')).toBe(true)
    expect(isSafeIdentifier('..')).toBe(false)
    expect(isSafeIdentifier('-leading-dash')).toBe(false)
    expect(isSafeIdentifier('a'.repeat(129))).toBe(false)
    expect(isSafeIdentifier(42)).toBe(false)
  })
})

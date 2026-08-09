import { describe, expect, it } from 'vitest'
import {
  MAX_ACK_BYTES,
  decodeTerminalClientMessage,
  decodeTerminalServerMessage,
  parseTerminalClientMessage,
  parseTerminalServerMessage,
  terminalPayload,
  type TerminalClientMessage,
  type TerminalServerMessage,
} from '@modulastack/runner-protocol'

const clientMessages: TerminalClientMessage[] = [
  { type: 'INIT', cols: 80, rows: 24 },
  { type: 'INIT', cols: 120, rows: 40, profile: 'coder' },
  { type: 'INPUT', data: 'echo hi\r' },
  { type: 'INPUT', data: '' },
  { type: 'RESIZE', cols: 1, rows: 1000 },
  { type: 'ACK', bytes: 0 },
  { type: 'ACK', bytes: MAX_ACK_BYTES },
  { type: 'KILL' },
  { type: 'SCROLL_RESET' },
]

const serverMessages: TerminalServerMessage[] = [
  { type: 'READY', sessionId: 'sess-1', profile: 'shell', cwd: '/work/lane', shell: '/bin/bash', pid: 4242 },
  { type: 'OUTPUT', data: 'hello\r\n' },
  { type: 'OUTPUT', data: 'earlier scrollback', replay: true },
  { type: 'EXIT', exitCode: 0, signal: null },
  { type: 'EXIT', exitCode: null, signal: 15 },
  { type: 'ERROR', message: 'session already exited' },
  { type: 'SCROLL_STATE', held: true, newOutput: false },
]

describe('terminal payload codec', () => {
  it('round-trips every client message through a json payload', () => {
    for (const message of clientMessages) {
      expect(decodeTerminalClientMessage(terminalPayload(message)), message.type).toEqual(message)
    }
  })

  it('round-trips every server message through a json payload', () => {
    for (const message of serverMessages) {
      expect(decodeTerminalServerMessage(terminalPayload(message)), message.type).toEqual(message)
    }
  })

  it('rejects non-json payload codecs at the terminal layer', () => {
    expect(decodeTerminalClientMessage({ codec: 'text', body: '{"type":"KILL"}' })).toBeNull()
    expect(decodeTerminalServerMessage({ codec: 'sealed', alg: 'a', nonce: 'n', body: 'c' })).toBeNull()
  })

  it('rejects unknown message types and junk', () => {
    expect(parseTerminalClientMessage({ type: 'DESTROY' })).toBeNull()
    expect(parseTerminalClientMessage({ type: 'OUTPUT', data: 'server message on the client side' })).toBeNull()
    expect(parseTerminalServerMessage({ type: 'INPUT', data: 'client message on the server side' })).toBeNull()
    expect(parseTerminalClientMessage('KILL')).toBeNull()
    expect(parseTerminalClientMessage(null)).toBeNull()
    expect(parseTerminalClientMessage([])).toBeNull()
  })

  it('bounds terminal dimensions on INIT and RESIZE', () => {
    expect(parseTerminalClientMessage({ type: 'INIT', cols: 0, rows: 24 })).toBeNull()
    expect(parseTerminalClientMessage({ type: 'INIT', cols: 80, rows: 1001 })).toBeNull()
    expect(parseTerminalClientMessage({ type: 'RESIZE', cols: 80.5, rows: 24 })).toBeNull()
    expect(parseTerminalClientMessage({ type: 'RESIZE', cols: '80', rows: 24 })).toBeNull()
  })

  it('bounds ACK bytes', () => {
    expect(parseTerminalClientMessage({ type: 'ACK', bytes: -1 })).toBeNull()
    expect(parseTerminalClientMessage({ type: 'ACK', bytes: MAX_ACK_BYTES + 1 })).toBeNull()
    expect(parseTerminalClientMessage({ type: 'ACK', bytes: 3.5 })).toBeNull()
  })

  it('treats the profile as a bounded safe label, not an enum', () => {
    expect(parseTerminalClientMessage({ type: 'INIT', cols: 80, rows: 24, profile: 'any-future-role_2' })).not.toBeNull()
    expect(parseTerminalClientMessage({ type: 'INIT', cols: 80, rows: 24, profile: '../etc' })).toBeNull()
    expect(parseTerminalClientMessage({ type: 'INIT', cols: 80, rows: 24, profile: 'a'.repeat(129) })).toBeNull()
    expect(parseTerminalClientMessage({ type: 'INIT', cols: 80, rows: 24, profile: 42 })).toBeNull()
  })

  it('requires INPUT data to be a string', () => {
    expect(parseTerminalClientMessage({ type: 'INPUT', data: 42 })).toBeNull()
    expect(parseTerminalClientMessage({ type: 'INPUT' })).toBeNull()
  })

  it('validates READY fields', () => {
    const ready = { type: 'READY', sessionId: 'sess-1', profile: 'shell', cwd: '/work', shell: '/bin/sh', pid: 1 }
    expect(parseTerminalServerMessage(ready)).toEqual(ready)
    expect(parseTerminalServerMessage({ ...ready, sessionId: 'a/b' })).toBeNull()
    expect(parseTerminalServerMessage({ ...ready, pid: 0 })).toBeNull()
    expect(parseTerminalServerMessage({ ...ready, cwd: '' })).toBeNull()
    expect(parseTerminalServerMessage({ ...ready, shell: 'x'.repeat(1025) })).toBeNull()
  })

  it('validates EXIT values as non-negative integers or null', () => {
    expect(parseTerminalServerMessage({ type: 'EXIT', exitCode: -1, signal: null })).toBeNull()
    expect(parseTerminalServerMessage({ type: 'EXIT', exitCode: 0.5, signal: null })).toBeNull()
    expect(parseTerminalServerMessage({ type: 'EXIT', exitCode: null })).toBeNull()
    expect(parseTerminalServerMessage({ type: 'EXIT', exitCode: null, signal: null })).toEqual({ type: 'EXIT', exitCode: null, signal: null })
  })

  it('normalizes OUTPUT replay to presence-when-true', () => {
    expect(parseTerminalServerMessage({ type: 'OUTPUT', data: 'x', replay: false })).toEqual({ type: 'OUTPUT', data: 'x' })
    expect(parseTerminalServerMessage({ type: 'OUTPUT', data: 'x', replay: 'yes' })).toBeNull()
  })

  it('bounds ERROR messages like close reasons', () => {
    expect(parseTerminalServerMessage({ type: 'ERROR', message: 'x'.repeat(500) })).not.toBeNull()
    expect(parseTerminalServerMessage({ type: 'ERROR', message: 'x'.repeat(501) })).toBeNull()
    expect(parseTerminalServerMessage({ type: 'ERROR', message: '' })).toBeNull()
  })

  it('ignores unknown fields on known messages', () => {
    expect(parseTerminalClientMessage({ type: 'KILL', force: true })).toEqual({ type: 'KILL' })
    expect(parseTerminalServerMessage({ type: 'SCROLL_STATE', held: false, newOutput: true, extra: 1 })).toEqual({ type: 'SCROLL_STATE', held: false, newOutput: true })
  })
})

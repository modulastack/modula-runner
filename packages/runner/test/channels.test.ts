import { describe, expect, it } from 'vitest'
import type { Payload } from '@modulastack/runner-protocol'
import { ChannelStore } from '../src/channels.js'

function text(body: string): Payload {
  return { codec: 'text', body }
}

describe('channel store', () => {
  it('accepts only the next contiguous sequence', () => {
    const store = new ChannelStore()
    const { id } = store.open('terminal')
    expect(store.receive({ type: 'data', channel: id, seq: 1, payload: text('a') }).status).toBe('accepted')
    expect(store.receive({ type: 'data', channel: id, seq: 1, payload: text('a') }).status).toBe('duplicate')
    expect(store.receive({ type: 'data', channel: id, seq: 3, payload: text('c') }).status).toBe('gap')
    expect(store.get(id)?.receivedSeq).toBe(1)
    expect(store.receive({ type: 'data', channel: id, seq: 2, payload: text('b') }).status).toBe('accepted')
    expect(store.receive({ type: 'data', channel: id, seq: 3, payload: text('c') }).status).toBe('accepted')
  })

  it('accepts the gap start again after an explicit reset', () => {
    const store = new ChannelStore()
    const { id } = store.open('terminal')
    expect(store.receive({ type: 'data', channel: id, seq: 5, payload: text('e') }).status).toBe('gap')
    store.receiveReset(id, 5)
    expect(store.receive({ type: 'data', channel: id, seq: 5, payload: text('e') }).status).toBe('accepted')
  })

  it('leaves channel state untouched when a payload cannot be serialized', () => {
    const store = new ChannelStore()
    const { id } = store.open('terminal')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => store.record(id, { codec: 'json', body: circular })).toThrow()
    expect(() => store.record(id, { codec: 'json', body: { n: 1n } })).toThrow()
    const frame = store.record(id, text('fine'))
    expect(frame.seq).toBe(1)
    expect(store.get(id)?.buffer).toHaveLength(1)
  })

  it('offers a reset when eviction has outrun the flush position', () => {
    const store = new ChannelStore(1)
    const { id } = store.open('terminal')
    store.record(id, text('one'))
    store.record(id, text('two'))
    store.record(id, text('three'))
    const next = store.nextOutbound(id, 0)
    expect(next.reset).toEqual({ type: 'reset', channel: id, seq: 3 })
    expect(next.frame).toBeUndefined()
  })
})

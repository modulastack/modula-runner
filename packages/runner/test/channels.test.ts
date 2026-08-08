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
    expect(store.receiveReset(id, 5)).toBe(true)
    expect(store.receive({ type: 'data', channel: id, seq: 5, payload: text('e') }).status).toBe('accepted')
  })

  it('rejects a reset that would rewind the stream', () => {
    const store = new ChannelStore()
    const { id } = store.open('terminal')
    for (let seq = 1; seq <= 3; seq++) store.receive({ type: 'data', channel: id, seq, payload: text(String(seq)) })
    expect(store.receiveReset(id, 2)).toBe(false)
    expect(store.receiveReset(id, 0)).toBe(false)
    expect(store.get(id)?.receivedSeq).toBe(3)
    expect(store.receive({ type: 'data', channel: id, seq: 2, payload: text('again') }).status).toBe('duplicate')
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

  it('rejects a frame over the wire cap without corrupting state', () => {
    const store = new ChannelStore()
    const { id } = store.open('terminal')
    expect(() => store.record(id, text('x'.repeat(1024 * 1024)))).toThrow(RangeError)
    const frame = store.record(id, text('small'))
    expect(frame.seq).toBe(1)
  })

  it('buffers a snapshot immune to later caller mutation', () => {
    const store = new ChannelStore()
    const { id } = store.open('terminal')
    const body = { value: 1 }
    store.record(id, { codec: 'json', body })
    body.value = 2
    const next = store.nextOutbound(id, 0)
    expect((next.frame?.payload as { body: { value: number } }).body.value).toBe(1)
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

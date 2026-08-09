import { describe, expect, it } from 'vitest'
import type { Frame } from '@modulastack/runner-protocol'
import { ChannelStore } from '../src/channels.js'
import { ChannelReconciler } from '../src/reconciliation.js'
import type { Transport } from '../src/transport.js'

const idleTransport = { bufferedBytes: () => 0, sendAcked: () => true } as unknown as Transport

describe('channel reconciler', () => {
  it('reports an outbound reset from any pump, not only at resume time', () => {
    const store = new ChannelStore(1024, 1024)
    const sent: Frame[] = []
    const resets: string[] = []
    const reconciler = new ChannelReconciler({
      store,
      transport: idleTransport,
      isConnected: () => true,
      highWaterBytes: () => 1024 * 1024,
      sendFrame: frame => sent.push(frame),
      onOutboundReset: channel => resets.push(channel),
    })
    const state = store.open('terminal')
    // Enough recorded frames to evict the oldest while nothing was flushed:
    // the pump has to announce the gap with a reset before it can continue.
    for (let i = 0; i < 20; i += 1) store.record(state.id, { codec: 'text', body: 'x'.repeat(200) })
    reconciler.pump(state.id)
    expect(sent[0]?.type).toBe('reset')
    expect(resets).toEqual([state.id])
    const frames = sent.filter(frame => frame.type === 'data')
    expect(frames.length).toBeGreaterThan(0)
  })
})

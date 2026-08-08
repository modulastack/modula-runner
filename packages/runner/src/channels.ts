import { randomBytes, randomUUID } from 'node:crypto'
import type { ChannelKind, ChannelResumeState, DataFrame, Payload, ResetFrame } from '@modulastack/runner-protocol'

const DEFAULT_BUFFER_BYTES = 512 * 1024

export type ChannelState = {
  id: string
  kind: ChannelKind
  attachToken: string
  sentSeq: number
  receivedSeq: number
  flushedSeq: number
  buffer: DataFrame[]
  bufferBytes: number
}

export type ReceiveResult =
  | { status: 'accepted'; payload: Payload }
  | { status: 'duplicate' }
  | { status: 'gap' }

export type NextOutbound = { reset?: ResetFrame; frame?: DataFrame }

export class ChannelStore {
  private readonly channels = new Map<string, ChannelState>()
  private readonly bufferLimit: number

  constructor(bufferBytes = DEFAULT_BUFFER_BYTES) {
    this.bufferLimit = bufferBytes
  }

  open(kind: ChannelKind): ChannelState {
    const state: ChannelState = {
      id: randomUUID(),
      kind,
      attachToken: randomBytes(24).toString('base64url'),
      sentSeq: 0,
      receivedSeq: 0,
      flushedSeq: 0,
      buffer: [],
      bufferBytes: 0,
    }
    this.channels.set(state.id, state)
    return state
  }

  get(id: string) {
    return this.channels.get(id)
  }

  ids() {
    return [...this.channels.keys()]
  }

  drop(id: string) {
    this.channels.delete(id)
  }

  // The frame is proven serializable before any state mutates: an unencodable body
  // must fail the caller, not leave a hole in the sequence.
  record(id: string, payload: Payload): DataFrame {
    const state = this.require(id)
    const frame: DataFrame = { type: 'data', channel: id, seq: state.sentSeq + 1, payload }
    const bytes = frameBytes(frame)
    state.sentSeq = frame.seq
    state.buffer.push(frame)
    state.bufferBytes += bytes
    while (state.bufferBytes > this.bufferLimit && state.buffer.length > 1) {
      const evicted = state.buffer.shift()
      if (evicted) state.bufferBytes -= frameBytes(evicted)
    }
    return frame
  }

  // Only the next contiguous sequence advances the high-water mark: anything at or
  // below it is a replay duplicate, anything past it is a gap the sender must have
  // announced with a reset — accepting it would splice over lost frames silently.
  receive(frame: DataFrame): ReceiveResult {
    const state = this.require(frame.channel)
    if (frame.seq <= state.receivedSeq) return { status: 'duplicate' }
    if (frame.seq > state.receivedSeq + 1) return { status: 'gap' }
    state.receivedSeq = frame.seq
    return { status: 'accepted', payload: frame.payload }
  }

  receiveReset(id: string, seq: number) {
    this.require(id).receivedSeq = seq - 1
  }

  resumeStates(): ChannelResumeState[] {
    return [...this.channels.values()].map(state => ({
      id: state.id,
      kind: state.kind,
      attachToken: state.attachToken,
      sentSeq: state.sentSeq,
      receivedSeq: state.receivedSeq,
    }))
  }

  // The next thing to put on the wire after flushedSeq: a buffered frame when the
  // buffer still covers the gap, an explicit reset when eviction has outrun it.
  nextOutbound(id: string, flushedSeq: number): NextOutbound {
    const state = this.require(id)
    if (flushedSeq >= state.sentSeq) return {}
    const oldest = state.buffer[0]
    if (!oldest) return {}
    if (oldest.seq > flushedSeq + 1) return { reset: { type: 'reset', channel: id, seq: oldest.seq } }
    const frame = state.buffer.find(candidate => candidate.seq > flushedSeq)
    return frame ? { frame } : {}
  }

  private require(id: string): ChannelState {
    const state = this.channels.get(id)
    if (!state) throw new Error(`unknown channel: ${id}`)
    return state
  }
}

function frameBytes(frame: DataFrame) {
  return Buffer.byteLength(JSON.stringify(frame), 'utf8')
}

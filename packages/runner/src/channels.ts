import { randomBytes, randomUUID } from 'node:crypto'
import { MAX_FRAME_BYTES, type ChannelKind, type ChannelResumeState, type DataFrame, type Payload, type ResetFrame } from '@modulastack/runner-protocol'

const DEFAULT_BUFFER_BYTES = 512 * 1024
// Bounds total replay memory and keeps the resume hello far under the frame cap
// (a full roster serializes to roughly 150 KiB).
const MAX_CHANNELS = 1024

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
    // NaN or Infinity would make the eviction comparison permanently false and
    // retain every frame ever recorded.
    if (!Number.isSafeInteger(bufferBytes) || bufferBytes < 1) {
      throw new Error('bufferBytes must be a positive integer')
    }
    this.bufferLimit = bufferBytes
  }

  open(kind: ChannelKind): ChannelState {
    if (this.channels.size >= MAX_CHANNELS) throw new Error(`channel roster limit reached (${MAX_CHANNELS})`)
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

  // The frame is proven serializable, checked against the wire cap, and snapshotted
  // before any state mutates: an unencodable or oversized body must fail the caller
  // without leaving a hole, and a caller mutating its payload afterwards must not be
  // able to change what a replay retransmits under the same sequence number.
  record(id: string, payload: Payload): DataFrame {
    const state = this.require(id)
    const candidate: DataFrame = { type: 'data', channel: id, seq: state.sentSeq + 1, payload }
    const serialized = JSON.stringify(candidate)
    const bytes = Buffer.byteLength(serialized, 'utf8')
    if (bytes > MAX_FRAME_BYTES) throw new RangeError('frame exceeds MAX_FRAME_BYTES')
    const frame = JSON.parse(serialized) as DataFrame
    state.sentSeq = frame.seq
    state.buffer.push(frame)
    state.bufferBytes += bytes
    while (state.bufferBytes > this.bufferLimit && state.buffer.length > 1) {
      const evicted = state.buffer.shift()
      if (evicted) state.bufferBytes -= Buffer.byteLength(JSON.stringify(evicted), 'utf8')
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

  // A reset may only announce a forward gap: rewinding the high-water mark would
  // make already-consumed frames deliverable again (replaying terminal input).
  receiveReset(id: string, seq: number): boolean {
    const state = this.require(id)
    if (seq < 1 || seq <= state.receivedSeq) return false
    state.receivedSeq = seq - 1
    return true
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
  // The buffer holds contiguous ascending sequences, so the lookup is index math.
  nextOutbound(id: string, flushedSeq: number): NextOutbound {
    const state = this.require(id)
    if (flushedSeq >= state.sentSeq) return {}
    const oldest = state.buffer[0]
    if (!oldest) return {}
    if (oldest.seq > flushedSeq + 1) return { reset: { type: 'reset', channel: id, seq: oldest.seq } }
    const frame = state.buffer[flushedSeq + 1 - oldest.seq]
    return frame ? { frame } : {}
  }

  private require(id: string): ChannelState {
    const state = this.channels.get(id)
    if (!state) throw new Error(`unknown channel: ${id}`)
    return state
  }
}

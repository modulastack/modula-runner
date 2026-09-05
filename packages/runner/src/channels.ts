import { randomBytes, randomUUID } from 'node:crypto'
import { MAX_FRAME_BYTES, decodeFrame, type ChannelKind, type ChannelResumeState, type DataFrame, type Payload, type ResetFrame } from '@modulastack/runner-protocol'

const DEFAULT_BUFFER_BYTES = 512 * 1024
const DEFAULT_TOTAL_BUFFER_BYTES = 64 * 1024 * 1024
// Bounds total replay memory and keeps the resume hello far under the frame cap
// (a full roster serializes to roughly 150 KiB).
const MAX_CHANNELS = 1024
const COMPACT_THRESHOLD = 256

type BufferedFrame = { frame: DataFrame; bytes: number }
export type ChannelRecoveryMode = 'buffered' | 'application-reset'

export type ChannelState = {
  id: string
  kind: ChannelKind
  attachToken: string
  recovery: ChannelRecoveryMode
  sentSeq: number
  receivedSeq: number
  flushedSeq: number
  buffer: BufferedFrame[]
  head: number
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
  private readonly totalLimit: number
  private totalBytes = 0

  constructor(bufferBytes = DEFAULT_BUFFER_BYTES, totalBufferBytes = DEFAULT_TOTAL_BUFFER_BYTES) {
    // NaN or Infinity would make the eviction comparisons permanently false and
    // retain every frame ever recorded.
    if (!Number.isSafeInteger(bufferBytes) || bufferBytes < 1) {
      throw new Error('bufferBytes must be a positive integer')
    }
    if (!Number.isSafeInteger(totalBufferBytes) || totalBufferBytes < bufferBytes) {
      throw new Error('totalBufferBytes must be a positive integer >= bufferBytes')
    }
    this.bufferLimit = bufferBytes
    this.totalLimit = totalBufferBytes
  }

  open(kind: ChannelKind, recovery: ChannelRecoveryMode = 'buffered'): ChannelState {
    if (this.channels.size >= MAX_CHANNELS) throw new Error(`channel roster limit reached (${MAX_CHANNELS})`)
    const state: ChannelState = {
      id: randomUUID(),
      kind,
      attachToken: randomBytes(24).toString('base64url'),
      recovery,
      sentSeq: 0,
      receivedSeq: 0,
      flushedSeq: 0,
      buffer: [],
      head: 0,
      bufferBytes: 0,
    }
    this.channels.set(state.id, state)
    return state
  }

  get(id: string) {
    return this.channels.get(id)
  }

  // A closed channel has no recovery mode left to set, and the terminal host's send path is
  // documented to survive a channel closing under it — a READY answered after the viewer's
  // channel went away must not take the session down. Every sequence-bearing operation keeps
  // require(), because silently ignoring an absent channel there would lose frames.
  setRecovery(id: string, recovery: ChannelRecoveryMode) {
    const state = this.channels.get(id)
    if (state) state.recovery = recovery
  }

  ids() {
    return [...this.channels.keys()]
  }

  drop(id: string) {
    const state = this.channels.get(id)
    if (state) this.totalBytes -= state.bufferBytes
    this.channels.delete(id)
  }

  // The frame is proven serializable, checked against the wire cap, and snapshotted
  // before any state mutates: an unencodable or oversized body must fail the caller
  // without leaving a hole, and a caller mutating its payload afterwards must not be
  // able to change what a replay retransmits under the same sequence number.
  // Byte sizes are computed once at record time; eviction never re-serializes.
  record(id: string, payload: Payload): DataFrame {
    const state = this.require(id)
    const candidate: DataFrame = { type: 'data', channel: id, seq: state.sentSeq + 1, payload }
    const serialized = JSON.stringify(candidate)
    const bytes = Buffer.byteLength(serialized, 'utf8')
    if (bytes > MAX_FRAME_BYTES) throw new RangeError('frame exceeds MAX_FRAME_BYTES')
    // The snapshot parse runs through the codec: a structurally invalid payload from
    // an untyped caller must fail here, not advance the sequence and die at the peer.
    const frame = decodeFrame(serialized)
    if (frame === null || frame.type !== 'data') throw new TypeError('payload is not a valid protocol payload')
    state.sentSeq = frame.seq
    state.buffer.push({ frame, bytes })
    state.bufferBytes += bytes
    this.totalBytes += bytes
    while (state.bufferBytes > this.bufferLimit && this.retained(state) > 1) this.evictOldest(state)
    // The aggregate budget may empty other channels entirely; an emptied channel's
    // next flush announces a full reset rather than stalling (see nextOutbound).
    while (this.totalBytes > this.totalLimit) {
      const fullest = [...this.channels.values()].reduce((a, b) => (b.bufferBytes > a.bufferBytes ? b : a))
      if (this.retained(fullest) === 0) break
      this.evictOldest(fullest)
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
    const oldest = state.buffer[state.head]?.frame
    // A buffer emptied by the aggregate budget resets past everything recorded:
    // the stream restarts after sentSeq instead of stalling on unreachable frames.
    if (!oldest) return { reset: { type: 'reset', channel: id, seq: state.sentSeq + 1 } }
    if (oldest.seq > flushedSeq + 1) return { reset: { type: 'reset', channel: id, seq: oldest.seq } }
    const entry = state.buffer[state.head + flushedSeq + 1 - oldest.seq]
    return entry ? { frame: entry.frame } : {}
  }

  private retained(state: ChannelState) {
    return state.buffer.length - state.head
  }

  // Head-index eviction keeps the hot path O(1): no shifting, no re-serialization.
  // The array compacts once the dead prefix dominates.
  private evictOldest(state: ChannelState) {
    const entry = state.buffer[state.head]
    if (!entry) return
    state.head++
    state.bufferBytes -= entry.bytes
    this.totalBytes -= entry.bytes
    if (state.head >= COMPACT_THRESHOLD && state.head * 2 >= state.buffer.length) {
      state.buffer.splice(0, state.head)
      state.head = 0
    }
  }

  private require(id: string): ChannelState {
    const state = this.channels.get(id)
    if (!state) throw new Error(`unknown channel: ${id}`)
    return state
  }
}

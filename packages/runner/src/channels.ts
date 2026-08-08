import { randomBytes, randomUUID } from 'node:crypto'
import type { ChannelKind, ChannelResumeState, DataFrame, Payload, ResetFrame } from '@modulastack/runner-protocol'

const DEFAULT_BUFFER_BYTES = 512 * 1024

export type ChannelState = {
  id: string
  kind: ChannelKind
  attachToken: string
  sentSeq: number
  receivedSeq: number
  buffer: DataFrame[]
  bufferBytes: number
}

export type Replay = { reset?: ResetFrame; frames: DataFrame[] }

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

  record(id: string, payload: Payload): DataFrame {
    const state = this.require(id)
    const frame: DataFrame = { type: 'data', channel: id, seq: ++state.sentSeq, payload }
    state.buffer.push(frame)
    state.bufferBytes += frameBytes(frame)
    while (state.bufferBytes > this.bufferLimit && state.buffer.length > 1) {
      const evicted = state.buffer.shift()
      if (evicted) state.bufferBytes -= frameBytes(evicted)
    }
    return frame
  }

  // Replay is idempotent at the receiver, so duplicates are ignored there.
  receive(frame: DataFrame): Payload | null {
    const state = this.require(frame.channel)
    if (frame.seq <= state.receivedSeq) return null
    state.receivedSeq = frame.seq
    return frame.payload
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

  // The peer confirmed peerReceivedSeq; everything after it must be replayed. When the
  // gap has outrun the buffer, the loss is announced with a reset, never spliced over.
  replayAfter(id: string, peerReceivedSeq: number): Replay {
    const state = this.require(id)
    if (peerReceivedSeq >= state.sentSeq) return { frames: [] }
    const oldest = state.buffer[0]
    if (!oldest || oldest.seq > peerReceivedSeq + 1) {
      const floor = oldest?.seq ?? state.sentSeq + 1
      return { reset: { type: 'reset', channel: id, seq: floor }, frames: [...state.buffer] }
    }
    return { frames: state.buffer.filter(frame => frame.seq > peerReceivedSeq) }
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

import { describe, expect, test } from 'vitest'
import {
  MAX_PORT,
  REFUSAL_REASONS,
  decodeFrame,
  decodeJobControlServerMessage,
  jobControlPayload,
  parseJobControlClientMessage,
  parseJobControlServerMessage,
  type JobControlServerMessage,
} from '@modulastack/runner-protocol'

describe('FR-7 and FR-8 job-control seam', () => {
  // FRD FR-8 and runner-seam "Never crosses the seam": preview readiness carries a port, not an endpoint.
  test('reports only the preview identifier and port across the seam', () => {
    const message: JobControlServerMessage = {
      type: 'PREVIEW_READY',
      previewId: 'docs-preview',
      port: 4_173,
    }

    expect(jobControlPayload(message)).toEqual({ codec: 'json', body: message })
    expect(parseJobControlServerMessage({
      ...message,
      host: '0.0.0.0',
      url: 'http://private-endpoint.example:4173',
      token: 'credential-material',
    })).toEqual(message)
    expect(Object.keys(message).sort()).toEqual(['port', 'previewId', 'type'])
  })

  // FRD FR-8: reported preview ports are concrete TCP ports, never sentinel or out-of-range values.
  test('accepts the full valid port boundary and rejects invalid ports', () => {
    expect(parseJobControlServerMessage({
      type: 'PREVIEW_READY', previewId: 'preview-low', port: 1,
    })).not.toBeNull()
    expect(parseJobControlServerMessage({
      type: 'PREVIEW_READY', previewId: 'preview-high', port: MAX_PORT,
    })).not.toBeNull()

    for (const port of [0, MAX_PORT + 1, 1.5, Number.NaN]) {
      expect(parseJobControlServerMessage({
        type: 'PREVIEW_READY', previewId: 'preview-invalid', port,
      })).toBeNull()
    }
  })

  // FRD FR-7: every refused request carries a finite, renderable reason instead of disappearing into a queue.
  test('round-trips every declared refusal reason', () => {
    for (const reason of REFUSAL_REASONS) {
      const message: JobControlServerMessage = { type: 'REFUSED', requestId: 'request-one', reason }
      expect(decodeJobControlServerMessage(jobControlPayload(message))).toEqual(message)
    }
  })

  // Pairing trust boundary and runner-seam principle 2: a pairing code has no inbound protocol shape.
  test('rejects pairing codes arriving as wire frames or job-control messages', () => {
    expect(decodeFrame(JSON.stringify({ type: 'pair', code: 'remote-code' }))).toBeNull()
    expect(parseJobControlClientMessage({ type: 'PAIR', code: 'remote-code' })).toBeNull()
  })
})

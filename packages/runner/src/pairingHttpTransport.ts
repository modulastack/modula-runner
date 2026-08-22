import { MAX_PAIRING_RESPONSE_BYTES } from '@modulastack/runner-protocol'
import type {
  PairingContractTransport,
  PairingHttpRequest,
  PairingHttpResponse,
  PairingResponseMediaType,
} from './pairingContract.js'

const OVERSIZED_BODY = 'x'.repeat(MAX_PAIRING_RESPONSE_BYTES + 1)

export function createPairingHttpTransport(): PairingContractTransport {
  return { exchange }
}

async function exchange(request: PairingHttpRequest): Promise<PairingHttpResponse> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: { ...request.headers },
    body: request.body,
    redirect: request.redirect,
    signal: AbortSignal.timeout(request.timeoutMs),
  })
  const mediaType = responseMediaType(response.headers.get('content-type'))
  return {
    status: response.status,
    mediaType,
    body: await cappedBody(response),
  }
}

async function cappedBody(response: Response): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > MAX_PAIRING_RESPONSE_BYTES) {
    // Cancellation failure cannot replace the already-proved oversized classification.
    await response.body?.cancel().catch(() => undefined)
    return OVERSIZED_BODY
  }
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let bytes = 0
  let complete = false
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) {
        complete = true
        break
      }
      bytes += next.value.byteLength
      if (bytes > MAX_PAIRING_RESPONSE_BYTES) return OVERSIZED_BODY
      chunks.push(next.value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    // Preserve the primary size/read outcome if the peer also resists stream cancellation.
    if (!complete) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function responseMediaType(value: string | null): PairingResponseMediaType {
  if (value === null) return 'missing'
  return value.split(';', 1)[0]!.trim().toLowerCase() === 'application/json'
    ? 'application/json'
    : 'other'
}

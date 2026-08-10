const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
const WEBSOCKET_PATH = '/api/runner/v1/socket'

// No override exists on purpose: the bearer token rides the upgrade request, so
// plaintext toward anything but loopback would expose the connection credential.
export function assertSecureUrl(url: string) {
  const parsed = new URL(url)
  // The WebSocket constructor rejects fragments at dial time; failing here keeps
  // the failure at construction instead of stranding a running client.
  if (parsed.hash) throw new Error('WebSocket URLs must not contain a fragment')
  if (parsed.protocol === 'wss:') return
  if (parsed.protocol !== 'ws:') throw new Error(`unsupported URL scheme: ${parsed.protocol}`)
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) throw new Error('plaintext ws:// is only allowed toward loopback')
}

// Redemption carries a pairing code and returns a token, so it gets the same rule the
// socket gets: TLS everywhere except toward loopback, where the co-resident install lives.
export function assertSecureControlPlaneUrl(url: string) {
  const parsed = new URL(String(url))
  if (parsed.hash) throw new Error('control plane URLs must not contain a fragment')
  if (parsed.protocol === 'https:') return parsed
  if (parsed.protocol !== 'http:') throw new Error(`unsupported URL scheme: ${parsed.protocol}`)
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) throw new Error('plaintext http:// is only allowed toward loopback')
  return parsed
}

// One origin serves both halves, so a binding stores where it paired and the socket
// address follows from it. Storing two independently-editable URLs would let a runner
// pair against one host and dial another.
//
// A binding that already names a socket URL is used as given: no control plane exists to
// publish a socket path yet, so the default below is this runner's proposal rather than a
// settled contract, and a deployment that puts its socket elsewhere must be able to say so.
export function websocketUrlFor(controlPlaneUrl: string) {
  const url = String(controlPlaneUrl)
  if (/^wss?:/i.test(url)) {
    assertSecureUrl(url)
    return url
  }
  const parsed = assertSecureControlPlaneUrl(url)
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
  parsed.pathname = WEBSOCKET_PATH
  parsed.search = ''
  return parsed.toString()
}

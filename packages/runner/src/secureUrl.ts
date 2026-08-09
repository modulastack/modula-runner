const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

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

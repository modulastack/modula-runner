export type BackoffOptions = { baseMs?: number; capMs?: number; random?: () => number }

// Full-jitter exponential backoff: half the ceiling guaranteed, half randomized,
// so a fleet of runners does not reconnect in lockstep after a control-plane blip.
// Bounds are validated: NaN or non-positive values would produce zero-delay retries
// and turn every reconnect into a connection storm.
export function backoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseMs ?? 500
  const cap = options.capMs ?? 30_000
  if (!Number.isSafeInteger(base) || base < 1 || !Number.isSafeInteger(cap) || cap < base) {
    throw new Error('backoff bounds must be positive integers with capMs >= baseMs')
  }
  const random = options.random ?? Math.random
  const ceiling = Math.min(cap, base * 2 ** Math.min(attempt, 20))
  return Math.floor(ceiling / 2 + random() * (ceiling / 2))
}

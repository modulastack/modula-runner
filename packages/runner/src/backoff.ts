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
  // A misbehaving random source is clamped, not trusted: NaN or out-of-range
  // samples must never turn the delay into an immediate-retry storm, and the
  // reconnect path cannot afford to throw.
  const sample = random()
  const jitter = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 1) : 1
  return Math.floor(ceiling / 2 + jitter * (ceiling / 2))
}

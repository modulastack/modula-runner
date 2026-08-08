export type BackoffOptions = { baseMs?: number; capMs?: number; random?: () => number }

// Full-jitter exponential backoff: half the ceiling guaranteed, half randomized,
// so a fleet of runners does not reconnect in lockstep after a control-plane blip.
export function backoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseMs ?? 500
  const cap = options.capMs ?? 30_000
  const random = options.random ?? Math.random
  const ceiling = Math.min(cap, base * 2 ** Math.min(attempt, 20))
  return Math.floor(ceiling / 2 + random() * (ceiling / 2))
}

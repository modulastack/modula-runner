export const PROTOCOL_VERSION = 1
export const MIN_PROTOCOL_VERSION = 1
// Published for interface-first tests only. The active range stays v1 until the runner can
// answer every session-launch message and the matching counterpart is ready.
export const SESSION_LAUNCH_PROTOCOL_VERSION = 2

export type VersionRange = { min: number; max: number }

export function isValidVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

export function isValidRange(value: unknown): value is VersionRange {
  if (typeof value !== 'object' || value === null) return false
  const range = value as Record<string, unknown>
  return isValidVersion(range.min) && isValidVersion(range.max) && (range.min as number) <= (range.max as number)
}

// The control plane supports N and N−1; the runner offers a contiguous range.
// The negotiated version is the highest one both sides speak, or null when disjoint.
export function negotiate(offered: VersionRange, supported: number[]): number | null {
  if (!isValidRange(offered) || supported.length === 0 || !supported.every(isValidVersion)) return null
  const agreed = supported.filter(version => version >= offered.min && version <= offered.max)
  return agreed.length ? Math.max(...agreed) : null
}

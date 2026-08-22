import { hasControlCharacter } from './frames.js'

const LOWERCASE_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isBoundedControlFreeString(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max && !hasControlCharacter(value)
}

export function isLowercaseUuidV4(value: unknown): value is string {
  return typeof value === 'string' && LOWERCASE_UUID_V4.test(value)
}

export function isRfc3339Utc(value: unknown): value is string {
  if (typeof value !== 'string' || !RFC3339_UTC.test(value)) return false
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) return false
  return parsed.toISOString().slice(0, 19) === value.slice(0, 19)
}

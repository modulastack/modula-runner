import { describe, expect, it } from 'vitest'
import { backoffDelay } from '../src/backoff.js'

describe('backoff', () => {
  it('doubles the ceiling per attempt up to the cap', () => {
    const floor = { baseMs: 100, capMs: 1_000, random: () => 0 }
    expect(backoffDelay(0, floor)).toBe(50)
    expect(backoffDelay(1, floor)).toBe(100)
    expect(backoffDelay(2, floor)).toBe(200)
    expect(backoffDelay(10, floor)).toBe(500)
  })

  it('rejects bounds that would produce zero-delay retries', () => {
    expect(() => backoffDelay(0, { baseMs: Number.NaN })).toThrow(/positive integers/)
    expect(() => backoffDelay(0, { baseMs: 0 })).toThrow(/positive integers/)
    expect(() => backoffDelay(0, { capMs: Number.POSITIVE_INFINITY })).toThrow(/positive integers/)
    expect(() => backoffDelay(0, { baseMs: 100, capMs: 50 })).toThrow(/positive integers/)
  })

  it('never exceeds the cap and always jitters within the upper half', () => {
    const ceiling = { baseMs: 100, capMs: 1_000, random: () => 1 }
    expect(backoffDelay(20, ceiling)).toBe(1_000)
    for (let attempt = 0; attempt < 25; attempt++) {
      const delay = backoffDelay(attempt, { baseMs: 100, capMs: 1_000 })
      expect(delay).toBeGreaterThanOrEqual(50)
      expect(delay).toBeLessThanOrEqual(1_000)
    }
  })
})

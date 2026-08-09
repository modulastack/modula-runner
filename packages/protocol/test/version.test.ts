import { describe, expect, it } from 'vitest'
import { negotiate } from '@modulastack/runner-protocol'

describe('version negotiation', () => {
  it('picks the highest version both sides speak', () => {
    expect(negotiate({ min: 1, max: 3 }, [1, 2])).toBe(2)
    expect(negotiate({ min: 1, max: 1 }, [1])).toBe(1)
  })

  it('serves N−1 runners from an N/N−1 control plane', () => {
    const controlPlane = [1, 2]
    expect(negotiate({ min: 1, max: 1 }, controlPlane)).toBe(1)
    expect(negotiate({ min: 1, max: 2 }, controlPlane)).toBe(2)
    expect(negotiate({ min: 2, max: 2 }, controlPlane)).toBe(2)
  })

  it('returns null when the ranges are disjoint', () => {
    expect(negotiate({ min: 1, max: 1 }, [2, 3])).toBeNull()
    expect(negotiate({ min: 4, max: 5 }, [2, 3])).toBeNull()
  })

  it('rejects malformed input', () => {
    expect(negotiate({ min: 2, max: 1 }, [1])).toBeNull()
    expect(negotiate({ min: 0, max: 1 }, [1])).toBeNull()
    expect(negotiate({ min: 1, max: 1 }, [])).toBeNull()
    expect(negotiate({ min: 1, max: 1 }, [1.5])).toBeNull()
  })
})

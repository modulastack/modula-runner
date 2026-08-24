import { describe, expect, it } from 'vitest'
import { AsyncReplayCache } from '../src/asyncReplay.js'

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = []
  for await (const value of values) collected.push(value)
  return collected
}

describe('async replay cache', () => {
  it('settles every reader when the source factory throws synchronously', async () => {
    const cache = new AsyncReplayCache<number>(1, 2)
    const source = () => { throw new Error('factory failed') }
    await expect(collect(cache.stream('failed', source))).rejects.toThrow('factory failed')
    await expect(collect(cache.stream('failed', source))).rejects.toThrow('factory failed')
  })

  it('rejects a distinct active entry at capacity and admits it after eviction', async () => {
    const cache = new AsyncReplayCache<number>(1, 2)
    let releaseFirst: (() => void) | undefined
    let secondCalls = 0
    const first = collect(cache.stream('first', async function* () {
      await new Promise<void>(resolve => { releaseFirst = resolve })
      yield 5
    }))
    await Promise.resolve()
    const secondSource = async function* () {
      secondCalls += 1
      yield 6
    }
    await expect(collect(cache.stream('second', secondSource))).rejects.toThrow('maximum is 1 active entries')
    expect(secondCalls).toBe(0)
    releaseFirst?.()
    await expect(first).resolves.toEqual([5])
    await expect(collect(cache.stream('second', secondSource))).resolves.toEqual([6])
    expect(secondCalls).toBe(1)
  })
})

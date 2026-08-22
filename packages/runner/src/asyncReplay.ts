export class AsyncReplayCache<T> {
  private readonly entries = new Map<string, ReplayEntry<T>>()

  constructor(
    private readonly maxEntries: number,
    private readonly maxValuesPerEntry: number,
  ) {}

  stream(key: string, source: () => AsyncIterable<T>): AsyncIterable<T> {
    let entry = this.entries.get(key)
    if (!entry) {
      entry = { values: [], done: false, failed: false, failure: undefined, waiters: new Set() }
      this.entries.set(key, entry)
      this.evictCompleted()
      void pump(entry, source(), this.maxValuesPerEntry)
    }
    return replay(entry)
  }

  private evictCompleted(): void {
    if (this.entries.size <= this.maxEntries) return
    for (const [key, entry] of this.entries) {
      if (!entry.done) continue
      this.entries.delete(key)
      if (this.entries.size <= this.maxEntries) return
    }
  }
}

type ReplayEntry<T> = {
  values: T[]
  done: boolean
  failed: boolean
  failure: unknown
  waiters: Set<() => void>
}

async function pump<T>(entry: ReplayEntry<T>, values: AsyncIterable<T>, maxValues: number): Promise<void> {
  try {
    for await (const value of values) {
      if (entry.values.length >= maxValues) throw new Error(`async replay maximum is ${maxValues} values`)
      entry.values.push(structuredClone(value))
      notify(entry)
    }
  } catch (error) {
    entry.failed = true
    entry.failure = error
  } finally {
    entry.done = true
    notify(entry)
  }
}

async function* replay<T>(entry: ReplayEntry<T>): AsyncGenerator<T> {
  let index = 0
  for (;;) {
    while (index < entry.values.length) {
      yield structuredClone(entry.values[index]!)
      index += 1
    }
    if (entry.done) {
      if (entry.failed) throw entry.failure
      return
    }
    await new Promise<void>(resolve => entry.waiters.add(resolve))
  }
}

function notify<T>(entry: ReplayEntry<T>): void {
  const waiters = [...entry.waiters]
  entry.waiters.clear()
  for (const resolve of waiters) resolve()
}

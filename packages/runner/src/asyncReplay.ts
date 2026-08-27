export class AsyncReplayCache<T> {
  private readonly entries = new Map<string, ReplayEntry<T>>()

  constructor(
    private readonly maxEntries: number,
    private readonly maxValuesPerEntry: number,
  ) {}

  stream(key: string, source: () => AsyncIterable<T>): AsyncIterable<T> {
    let entry = this.entries.get(key)
    if (!entry) {
      this.evictCompleted(true)
      if (this.entries.size >= this.maxEntries) return rejectedReplay(this.maxEntries)
      entry = { values: [], done: false, failed: false, failure: undefined, waiters: new Set() }
      this.entries.set(key, entry)
      void pump(entry, source, this.maxValuesPerEntry, () => this.evictCompleted())
    }
    return replay(entry)
  }

  private evictCompleted(makeRoom = false): void {
    const limit = makeRoom ? this.maxEntries - 1 : this.maxEntries
    if (this.entries.size <= limit) return
    for (const [key, entry] of this.entries) {
      if (!entry.done) continue
      this.entries.delete(key)
      if (this.entries.size <= limit) return
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

async function pump<T>(
  entry: ReplayEntry<T>,
  source: () => AsyncIterable<T>,
  maxValues: number,
  completed: () => void,
): Promise<void> {
  try {
    for await (const value of source()) {
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
    completed()
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

async function* rejectedReplay<T>(maxEntries: number): AsyncGenerator<T> {
  throw new Error(`async replay maximum is ${maxEntries} active entries`)
}

function notify<T>(entry: ReplayEntry<T>): void {
  const waiters = [...entry.waiters]
  entry.waiters.clear()
  for (const resolve of waiters) resolve()
}

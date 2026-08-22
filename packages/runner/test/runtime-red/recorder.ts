export type RuntimeRecorder = {
  events: string[]
  output: string[]
  record(event: string): void
  capture(sink: string, value: unknown): void
  stdout(text: string): void
  stderr(text: string): void
}

export function createRecorder(): RuntimeRecorder {
  const events: string[] = []
  const output: string[] = []
  return {
    events,
    output,
    record(event) {
      events.push(`${events.length + 1}:${event}`)
    },
    capture(sink, value) {
      events.push(`${events.length + 1}:sink.${sink}`)
      output.push(`sink:${sink}:${JSON.stringify(value)}`)
    },
    stdout(text) {
      events.push(`${events.length + 1}:io.stdout`)
      output.push(`stdout:${text}`)
    },
    stderr(text) {
      events.push(`${events.length + 1}:io.stderr`)
      output.push(`stderr:${text}`)
    },
  }
}

export function eventIndex(events: readonly string[], fragment: string): number {
  return events.findIndex(event => event.includes(fragment))
}

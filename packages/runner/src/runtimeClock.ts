export interface RunnerClock {
  now(): number
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>
}

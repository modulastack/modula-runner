export interface RunnerClock {
  now(): number
  sleep(milliseconds: number): Promise<void>
}

import type { RunnerInfo } from '@modulastack/runner-protocol'

export const testRunnerInfo: RunnerInfo = { name: 'test-runner', version: '0.0.0', os: 'linux', arch: 'x64' }

export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const started = Date.now()
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time')
    await sleep(10)
  }
}

export function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

import type { PairingContractService } from './pairingContract.js'
import type { RunnerClock } from './runtimeClock.js'
import type { RunnerHome, RunnerHomeState } from './runnerHome.js'
import type { SessionJobControl } from './sessionJobControl.js'
import type { SessionLauncher } from './sessionLaunch.js'

export const RUNNER_TOP_LEVEL_COMMANDS = [
  'help',
  'version',
  'pair',
  'status',
  'run',
  'key',
  'project',
  'profile',
  'endpoint',
  'grant',
  'allowlist',
] as const
export type RunnerTopLevelCommand = (typeof RUNNER_TOP_LEVEL_COMMANDS)[number]

export const RUNNER_PROJECT_COMMANDS = ['create', 'list', 'remove'] as const
export type RunnerProjectCommand = (typeof RUNNER_PROJECT_COMMANDS)[number]

export type RunnerExitCode = 0 | 1 | 2

export type RunnerCliEnvironment = {
  runnerHome?: string
  endpointUrl?: string
}

export interface RunnerCliIo {
  inputIsTTY: boolean
  readHidden(prompt: string): Promise<string>
  writeStdout(text: string): void
  writeStderr(text: string): void
}

export type RunnerCliInvocation = {
  args: readonly string[]
  cwd: string
  environment: RunnerCliEnvironment
  io: RunnerCliIo
}

export interface RunnerApplication {
  execute(invocation: RunnerCliInvocation): Promise<RunnerExitCode>
}

export type RunnerShutdownResult =
  | { status: 'confirmed' }
  | { status: 'unconfirmed'; detail: string }

export interface RunnerRuntimeHandle {
  finished: Promise<RunnerShutdownResult>
  stop(signal: 'SIGINT' | 'SIGTERM'): Promise<RunnerShutdownResult>
  forceStop(): void
}

export interface RunnerRuntimePort {
  start(home: RunnerHomeState, jobControl: SessionJobControl): Promise<RunnerRuntimeHandle>
}

export type RunnerRuntimeOptions = {
  clock: RunnerClock
}

export class RunnerRuntimeNotImplementedError extends Error {
  constructor() {
    super('the runner runtime composition is interface-only and is not active')
    this.name = 'RunnerRuntimeNotImplementedError'
  }
}

export function createRunnerRuntime(_options: RunnerRuntimeOptions): RunnerRuntimePort {
  return {
    async start(): Promise<never> {
      throw new RunnerRuntimeNotImplementedError()
    },
  }
}

export type RunnerComposition = {
  pairing(home: RunnerHomeState): PairingContractService
  sessions(home: RunnerHomeState): SessionLauncher
  jobControl(sessions: SessionLauncher): SessionJobControl
  runtime: RunnerRuntimePort
}

export type RunnerApplicationOptions = {
  version: string
  home: RunnerHome
  clock: RunnerClock
  composition: RunnerComposition
}

export class RunnerApplicationNotImplementedError extends Error {
  constructor() {
    super('the runner CLI composition is interface-only and is not active')
    this.name = 'RunnerApplicationNotImplementedError'
  }
}

export function createRunnerApplication(_options: RunnerApplicationOptions): RunnerApplication {
  return createUnimplementedRunnerApplication()
}

export function createUnimplementedRunnerApplication(): RunnerApplication {
  return {
    async execute(): Promise<never> {
      throw new RunnerApplicationNotImplementedError()
    },
  }
}

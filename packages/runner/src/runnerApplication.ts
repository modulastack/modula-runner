import { hasControlCharacter, isSafeIdentifier } from '@modulastack/runner-protocol'
import { lstat, realpath, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import path from 'node:path'
import {
  runGrantAddCommand,
  runGrantListCommand,
  runGrantRevokeCommand,
  runKeyAddCommand,
  runKeyListCommand,
  runKeyRemoveCommand,
  type CommandResult,
} from './cli.js'
import { PairingContractError, type PairingContractService } from './pairingContract.js'
import {
  allowlistCommandSyntax,
  runAllowlistCommand,
  runAllowlistInit,
} from './runnerAllowlistCommands.js'
import {
  endpointCommandSyntax,
  profileCommandSyntax,
  runEndpointCommand,
  runProfileCommand,
} from './runnerConfigurationCommands.js'
import { assertProviderName } from './apiKeys.js'
import type { RunnerAuditArchiveResult } from './auditLifecycle.js'
import type { RunnerClock } from './runtimeClock.js'
import type { RunnerHome, RunnerHomeFailure, RunnerHomeSelection, RunnerHomeState } from './runnerHome.js'
import type { SessionJobControl } from './sessionJobControl.js'
import type { SessionLauncher } from './sessionLaunch.js'
import type { ContainmentStatus } from './previewContainment.js'

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
  'audit',
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

export interface RunnerCliSignals {
  subscribe(listener: (signal: 'SIGINT' | 'SIGTERM') => void): () => void
}

export type RunnerCliInvocation = {
  args: readonly string[]
  cwd: string
  environment: RunnerCliEnvironment
  io: RunnerCliIo
  signals?: RunnerCliSignals
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

export type RunnerContainmentStatus = Pick<ContainmentStatus, 'disposition' | 'prevention' | 'detail'>

export type RunnerComposition = {
  pairing(home: RunnerHomeState): PairingContractService
  sessions(home: RunnerHomeState): SessionLauncher
  jobControl(sessions: SessionLauncher): SessionJobControl
  containmentStatus(): RunnerContainmentStatus
  runtime: RunnerRuntimePort
}

export interface RunnerAuditArchivePort {
  archive(selection: RunnerHomeSelection, destination: string): Promise<RunnerAuditArchiveResult>
}

export type RunnerApplicationOptions = {
  version: string
  home: RunnerHome
  clock: RunnerClock
  composition: RunnerComposition
  auditArchive?: RunnerAuditArchivePort
}

export class RunnerApplicationNotImplementedError extends Error {
  constructor() {
    super('the requested runner command is not implemented')
    this.name = 'RunnerApplicationNotImplementedError'
  }
}

export function createRunnerApplication(options: RunnerApplicationOptions): RunnerApplication {
  return { execute: invocation => execute(options, invocation) }
}

export function createUnimplementedRunnerApplication(): RunnerApplication {
  return {
    async execute(): Promise<never> {
      throw new RunnerApplicationNotImplementedError()
    },
  }
}

type CommandOutcome = { exitCode: RunnerExitCode; stdout?: string; stderr?: string }

async function execute(options: RunnerApplicationOptions, invocation: RunnerCliInvocation): Promise<RunnerExitCode> {
  const [command, ...args] = invocation.args
  if (command === '--help' || command === 'help') return emit(invocation.io, args.length ? usage() : { exitCode: 0, stdout: helpText() })
  if (command === '--version' || command === 'version') return emit(invocation.io, args.length ? usage() : { exitCode: 0, stdout: options.version })
  if (!command) return emit(invocation.io, usage())
  if (!['pair', 'status', 'run', 'project', 'key', 'grant', 'profile', 'endpoint', 'allowlist', 'audit'].includes(command)) {
    if ((RUNNER_TOP_LEVEL_COMMANDS as readonly string[]).includes(command)) throw new RunnerApplicationNotImplementedError()
    return emit(invocation.io, usage())
  }
  const syntax = commandSyntax(command, args, invocation)
  if (syntax) return emit(invocation.io, syntax)
  if (command === 'audit') return emit(invocation.io, await auditArchiveCommand(options, invocation, args[2]!))
  if (command === 'allowlist' && args[0] === 'init') {
    try {
      return emit(invocation.io, await runAllowlistInit(options.home, homeSelection(invocation), invocation.cwd, args))
    } catch {
      return emit(invocation.io, commandFailure(command, args, 'state-io-failed', 'allowlist initialization failed'))
    }
  }
  const allowlistKeyArgument = args[0] === 'sign' ? args[2] : args[0] === 'trust' ? args[3] : undefined
  if (command === 'allowlist' && allowlistKeyArgument) {
    if (!options.home.validateSigningKeyPath) return emit(invocation.io, homeFailure('state-io-failed'))
    try {
      const failure = await options.home.validateSigningKeyPath(homeSelection(invocation), path.resolve(invocation.cwd, allowlistKeyArgument))
      if (failure) return emit(invocation.io, homeFailure(failure))
    } catch {
      return emit(invocation.io, commandFailure(command, args, 'state-io-failed', 'signing key path validation failed'))
    }
  }
  return await executeWithHome(options, invocation, command, args)
}

async function executeWithHome(
  options: RunnerApplicationOptions,
  invocation: RunnerCliInvocation,
  command: string,
  args: readonly string[],
): Promise<RunnerExitCode> {
  const opened = await options.home.open(homeSelection(invocation))
  if (opened.status === 'failed') {
    const outcome = command === 'status' && args[0] === '--json'
      ? { exitCode: 1 as const, stdout: JSON.stringify({ error: { code: opened.code } }) }
      : homeFailure(opened.code)
    return emit(invocation.io, outcome)
  }
  let outcome: CommandOutcome
  try {
    outcome = await runOpened(options, opened.home, invocation, command, args)
  } catch {
    outcome = commandFailure(command, args, 'state-io-failed', 'the local command could not complete')
  }
  try {
    await options.home.close?.()
  } catch {
    outcome = commandFailure(command, args, 'state-io-failed', 'the runner home could not close cleanly')
  }
  return emit(invocation.io, outcome)
}

async function runOpened(
  options: RunnerApplicationOptions,
  home: RunnerHomeState,
  invocation: RunnerCliInvocation,
  command: string,
  args: readonly string[],
): Promise<CommandOutcome> {
  if (command === 'pair') return await pairCommand(options, home, invocation, args[1]!)
  if (command === 'status') {
    return await statusCommand(
      options.composition.pairing(home),
      options.composition.containmentStatus(),
      args[0] === '--json',
    )
  }
  if (command === 'run') return await runCommand(options.composition, home, invocation.signals)
  if (command === 'project') return await projectCommand(home, invocation.cwd, args)
  if (command === 'key') return await keyCommand(home, invocation, args)
  if (command === 'grant') return await grantCommand(home, invocation.cwd, args)
  if (command === 'profile') return await runProfileCommand(args, home.configuration)
  if (command === 'endpoint') return await runEndpointCommand(args, invocation.environment.endpointUrl, home.configuration)
  return await runAllowlistCommand(args, invocation.cwd, home)
}

function commandSyntax(command: string, args: readonly string[], invocation: RunnerCliInvocation): CommandOutcome | null {
  if (command === 'pair') {
    if (args.length !== 2 || args[0] !== '--control-plane') return usage('usage: modula-runner pair --control-plane <url>')
    if (!invocation.io.inputIsTTY) return usage('pairing requires an interactive TTY')
  }
  if (command === 'status' && (args.length > 1 || (args[0] !== undefined && args[0] !== '--json'))) {
    return usage('usage: modula-runner status [--json]')
  }
  if (command === 'run' && args.length > 0) return usage('usage: modula-runner run')
  if (command === 'project' && !RUNNER_PROJECT_COMMANDS.includes(args[0] as RunnerProjectCommand)) {
    return usage('usage: modula-runner project <create|list|remove> ...')
  }
  if (command === 'key') return keySyntax(args, invocation)
  if (command === 'grant') return grantSyntax(args)
  if (command === 'profile') {
    const message = profileCommandSyntax(args)
    return message ? usage(message) : null
  }
  if (command === 'endpoint') {
    const message = endpointCommandSyntax(args, invocation.environment.endpointUrl)
    return message ? usage(message) : null
  }
  if (command === 'audit') {
    if (args.length !== 3 || args[0] !== 'archive' || args[1] !== '--output'
      || !args[2] || hasControlCharacter(args[2])) return usage('usage: modula-runner audit archive --output <directory>')
  }
  if (command === 'allowlist') {
    const message = allowlistCommandSyntax(args, invocation.cwd)
    return message ? usage(message) : null
  }
  return null
}

async function auditArchiveCommand(
  options: RunnerApplicationOptions,
  invocation: RunnerCliInvocation,
  destination: string,
): Promise<CommandOutcome> {
  if (!options.auditArchive) return { exitCode: 1, stderr: 'audit-unavailable: archive adapter is unavailable' }
  try {
    const result = await options.auditArchive.archive(homeSelection(invocation), path.resolve(invocation.cwd, destination))
    if (result.status === 'storage-unavailable') return { exitCode: 1, stderr: 'audit-unavailable: archive failed closed' }
    if (result.status === 'nothing-to-archive') return { exitCode: 0, stdout: JSON.stringify({ status: result.status }) }
    return { exitCode: 0, stdout: JSON.stringify({ status: result.status, segments: result.segments, bytes: result.bytes }) }
  } catch {
    return { exitCode: 1, stderr: 'audit-unavailable: archive failed closed' }
  }
}

async function pairCommand(
  options: RunnerApplicationOptions,
  home: RunnerHomeState,
  invocation: RunnerCliInvocation,
  controlPlaneOrigin: string,
): Promise<CommandOutcome> {
  const code = (await invocation.io.readHidden('Pairing code: ')).trim()
  if (!code) return usage('no pairing code was entered')
  try {
    const identity = await options.composition.pairing(home).pair(controlPlaneOrigin, {
      code,
      runner: runnerInfo(options.version),
    })
    return { exitCode: 0, stdout: `paired as runner ${identity.runnerId}` }
  } catch (error) {
    const reason = error instanceof PairingContractError ? error.failure : 'unreachable'
    return { exitCode: 1, stderr: `pairing failed: ${reason}` }
  }
}

async function runCommand(
  composition: RunnerComposition,
  home: RunnerHomeState,
  signals: RunnerCliSignals | undefined,
): Promise<CommandOutcome> {
  let handle: RunnerRuntimeHandle
  try {
    const sessions = composition.sessions(home)
    handle = await composition.runtime.start(home, composition.jobControl(sessions))
  } catch (error) {
    if (error instanceof RunnerRuntimeNotImplementedError) {
      return { exitCode: 1, stderr: 'protocol-inactive: session runtime awaits the separate protocol-v2 activation gate' }
    }
    throw error
  }
  const result = await waitForRuntime(handle, signals)
  return result.status === 'confirmed'
    ? { exitCode: 0, stdout: 'runner stopped — all identified children terminated' }
    : { exitCode: 1, stderr: result.detail.startsWith('unconfirmed') ? result.detail : `unconfirmed — ${result.detail}` }
}

function waitForRuntime(handle: RunnerRuntimeHandle, signals: RunnerCliSignals | undefined): Promise<RunnerShutdownResult> {
  return new Promise(resolve => {
    let settled = false
    let stopping = false
    let unsubscribe: (() => void) | undefined
    const finish = (result: RunnerShutdownResult) => {
      if (settled) return
      settled = true
      unsubscribe?.()
      resolve(result)
    }
    void handle.finished.then(finish, () => finish({ status: 'unconfirmed', detail: 'unconfirmed — runtime completion failed' }))
    if (!signals) return
    unsubscribe = signals.subscribe(signal => {
      if (stopping) {
        try {
          handle.forceStop()
        } catch {
          // The forced result is already unconfirmed; a throwing teardown cannot make a stronger claim.
        }
        finish({ status: 'unconfirmed', detail: 'unconfirmed — forced exit during cleanup' })
        return
      }
      stopping = true
      void Promise.resolve()
        .then(async () => await handle.stop(signal))
        .then(finish, () => finish({ status: 'unconfirmed', detail: 'unconfirmed — runtime cleanup failed' }))
    })
    if (settled) unsubscribe()
  })
}

async function statusCommand(
  pairing: PairingContractService,
  containment: RunnerContainmentStatus,
  json: boolean,
): Promise<CommandOutcome> {
  let snapshot = await pairing.snapshot()
  let pairingError: string | null = null
  if (snapshot.state === 'pending') {
    try {
      await pairing.resumeConfirmation()
      snapshot = await pairing.snapshot()
    } catch (error) {
      pairingError = error instanceof PairingContractError ? error.failure : 'unreachable'
      snapshot = await pairing.snapshot()
    }
  }
  const value = statusValue(snapshot, pairingError, containment)
  return {
    exitCode: pairingError ? 1 : 0,
    stdout: json ? JSON.stringify(value) : statusText(value),
  }
}

function statusValue(
  snapshot: Awaited<ReturnType<PairingContractService['snapshot']>>,
  error: string | null,
  containment: RunnerContainmentStatus,
) {
  const record = snapshot.state === 'pending' || snapshot.state === 'paired' || snapshot.state === 'revoked'
    ? snapshot.record
    : null
  return {
    state: snapshot.state,
    ...(record ? { runnerId: record.runnerId, controlPlaneOrigin: record.controlPlaneOrigin } : {}),
    containment: containment.disposition,
    prevention: containment.prevention,
    containmentDetail: containment.detail,
    ...(error ? { error: { code: error } } : {}),
  }
}

function statusText(value: ReturnType<typeof statusValue>): string {
  let pairing: string
  if (value.state === 'unpaired') pairing = 'unpaired — run modula-runner pair to connect'
  else if (value.state === 'reserved') pairing = 'pairing-in-progress'
  else if (value.state === 'revoked') pairing = 'revoked — pair again to reconnect'
  else if (value.state === 'pending') pairing = `pending as runner ${value.runnerId}${value.error ? ` — ${value.error.code}` : ''}`
  else pairing = `paired as runner ${value.runnerId} to ${value.controlPlaneOrigin}`
  return `${pairing}\ncontainment: ${value.containment}; prevention: ${value.prevention}; ${value.containmentDetail}`
}

function keySyntax(args: readonly string[], invocation: RunnerCliInvocation): CommandOutcome | null {
  const [action, label, flag, provider] = args
  if (action === 'list' && args.length === 1) return null
  if (action === 'remove' && args.length === 2 && isSafeIdentifier(label)) return null
  if (action === 'add' && args.length === 4 && isSafeIdentifier(label) && flag === '--provider' && validProvider(provider)) {
    return invocation.io.inputIsTTY ? null : usage('key entry requires an interactive TTY')
  }
  return usage('usage: modula-runner key <add|list|remove> ...')
}

function validProvider(value: string | undefined): value is string {
  if (!value) return false
  try {
    assertProviderName(value)
    return true
  } catch {
    return false
  }
}

function grantSyntax(args: readonly string[]): CommandOutcome | null {
  if (args[0] === 'list' && args.length === 1) return null
  if (args[0] === 'revoke' && args.length === 2 && !hasControlCharacter(args[1]!)) return null
  if (args.length === 1 && args[0] && !hasControlCharacter(args[0])) return null
  return usage('usage: modula-runner grant <directory>|list|revoke <directory>')
}

async function keyCommand(
  home: RunnerHomeState,
  invocation: RunnerCliInvocation,
  args: readonly string[],
): Promise<CommandOutcome> {
  const context = { keys: home.keys, readSecret: (prompt: string) => invocation.io.readHidden(prompt) }
  if (args[0] === 'add') return commandOutcome(await runKeyAddCommand(args.slice(1), context))
  if (args[0] === 'list') return commandOutcome(await runKeyListCommand([], context))
  return commandOutcome(await runKeyRemoveCommand(args.slice(1), context))
}

async function grantCommand(home: RunnerHomeState, cwd: string, args: readonly string[]): Promise<CommandOutcome> {
  const context = { grants: home.grants }
  if (args[0] === 'list') return commandOutcome(await runGrantListCommand([], context))
  const candidate = path.resolve(cwd, args[0] === 'revoke' ? args[1]! : args[0]!)
  if (hasControlCharacter(candidate)) return { exitCode: 1, stderr: 'grant path must not contain control characters' }
  return args[0] === 'revoke'
    ? commandOutcome(await runGrantRevokeCommand([candidate], context))
    : commandOutcome(await runGrantAddCommand([candidate], context))
}

function commandOutcome(result: CommandResult): CommandOutcome {
  const exitCode = result.exitCode === 0 || result.exitCode === 1 || result.exitCode === 2 ? result.exitCode : 1
  return exitCode === 0 ? { exitCode, stdout: result.output } : { exitCode, stderr: result.output }
}

async function projectCommand(home: RunnerHomeState, cwd: string, args: readonly string[]): Promise<CommandOutcome> {
  const [action, ...rest] = args
  if (action === 'list') {
    if (rest.length > 0) return usage('usage: modula-runner project list')
    const projects = [...await home.projects.list()].sort((left, right) => left.projectId.localeCompare(right.projectId))
    return { exitCode: 0, stdout: projects.length === 0 ? 'no projects configured' : projects.map(projectRow).join('\n') }
  }
  if (action === 'create') return await createProject(home, cwd, rest)
  return await removeProject(home, rest)
}

async function createProject(home: RunnerHomeState, cwd: string, args: readonly string[]): Promise<CommandOutcome> {
  const [projectId, repoFlag, repo, rootFlag, worktreesRoot, ...extra] = args
  if (!projectId || repoFlag !== '--repo' || !repo || rootFlag !== '--worktrees-root' || !worktreesRoot || extra.length) {
    return usage('usage: modula-runner project create <id> --repo <directory> --worktrees-root <directory>')
  }
  const resolvedRepo = await ownedDirectory(repo, cwd)
  const resolvedRoot = await ownedDirectory(worktreesRoot, cwd)
  if (!resolvedRepo || !resolvedRoot) return { exitCode: 1, stderr: 'project path must be an owned, existing, non-symlink directory' }
  try {
    const created = await home.projects.create({ projectId, repoPath: resolvedRepo, worktreesRoot: resolvedRoot })
    return { exitCode: 0, stdout: projectRow(created) }
  } catch {
    return { exitCode: 1, stderr: 'project was not created' }
  }
}

async function removeProject(home: RunnerHomeState, args: readonly string[]): Promise<CommandOutcome> {
  const [projectId, revisionFlag, revisionText, ...extra] = args
  if (!projectId || extra.length || (revisionFlag !== undefined && revisionFlag !== '--revision')) {
    return usage('usage: modula-runner project remove <id> [--revision <number>]')
  }
  const revision = revisionFlag ? Number(revisionText) : undefined
  if (revisionFlag && (!Number.isSafeInteger(revision) || revision! < 1)) return usage('project revision must be a positive integer')
  const result = await home.projects.remove(projectId, revision)
  return result === 'removed'
    ? { exitCode: 0, stdout: `removed ${projectId}` }
    : { exitCode: 1, stderr: `project ${result}` }
}

async function ownedDirectory(candidate: string, cwd: string): Promise<string | null> {
  if (hasControlCharacter(candidate)) return null
  const absolute = path.resolve(cwd, candidate)
  try {
    const lexical = await lstat(absolute)
    if (!lexical.isDirectory() || lexical.isSymbolicLink() || lexical.uid !== process.getuid?.()) return null
    const resolved = await realpath(absolute)
    if (resolved !== absolute) return null
    const held = await stat(resolved)
    return held.isDirectory() && held.uid === process.getuid?.() ? resolved : null
  } catch {
    return null
  }
}

function runnerInfo(version: string) {
  const name = hostname()
  return {
    name: name.length > 0 && name.length <= 200 && !hasControlCharacter(name) ? name : 'runner',
    version,
    os: process.platform,
    arch: process.arch,
  }
}

function projectRow(project: { projectId: string; repoPath: string; worktreesRoot: string; revision: number }): string {
  return `${project.projectId}\t${project.repoPath}\t${project.worktreesRoot}\t${project.revision}`
}

function homeSelection(invocation: RunnerCliInvocation) {
  return { ...(invocation.environment.runnerHome ? { override: invocation.environment.runnerHome } : {}) }
}

function commandFailure(command: string, args: readonly string[], code: string, detail: string): CommandOutcome {
  return command === 'status' && args[0] === '--json'
    ? { exitCode: 1, stdout: JSON.stringify({ error: { code } }) }
    : { exitCode: 1, stderr: `${code}: ${detail}` }
}

function homeFailure(code: RunnerHomeFailure): CommandOutcome {
  return { exitCode: 1, stderr: `${code}: runner home preflight failed` }
}

function usage(message = 'usage: modula-runner <help|version|pair|status|run|key|project|profile|endpoint|grant|allowlist|audit>'): CommandOutcome {
  return { exitCode: 2, stderr: message }
}

function emit(io: RunnerCliIo, outcome: CommandOutcome): RunnerExitCode {
  if (outcome.stdout) io.writeStdout(`${outcome.stdout}\n`)
  if (outcome.stderr) io.writeStderr(`${outcome.stderr}\n`)
  return outcome.exitCode
}

function helpText(): string {
  return 'modula-runner — local pairing, state, and foreground runner commands\nrun modula-runner <command> --help for command usage'
}

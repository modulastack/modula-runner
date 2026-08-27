import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as pty from 'node-pty'

const repoRoot = process.cwd()
const nodeBinDir = dirname(process.execPath)
const releaseScript = join(repoRoot, 'scripts', 'release.mjs')
const processOutputLimit = 1024 * 1024
const commandTimeoutMs = 10_000
const runnerManifest = JSON.parse(
  readFileSync(join(repoRoot, 'packages', 'runner', 'package.json'), 'utf8'),
) as Record<string, unknown>
const packageName = manifestString('name')
const packageVersion = manifestString('version')

export interface RunResult {
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

export interface PtyRunResult {
  status: number
  signal: number
  output: string
}

export interface RunOptions {
  home?: string
  cwd?: string
  endpointUrl?: string
  input?: string
  timeoutMs?: number
}

export interface PtyRunOptions extends Omit<RunOptions, 'input'> {
  input: {
    after: string
    value: string
  }
}

export interface NativeDependencyEvidence {
  name: 'node-pty'
  version: string
  installPath: 'prebuilt' | 'local-build'
}

export interface InstalledRunner {
  binary: string
  version: string
  nativeDependency: NativeDependencyEvidence
  run(args: string[], options?: RunOptions): Promise<RunResult>
  runInPty(args: string[], options: PtyRunOptions): Promise<PtyRunResult>
  freshHome(): Promise<string>
  dispose(): Promise<void>
}

let installation: Promise<InstalledRunner> | null = null

export function installedRunner(): Promise<InstalledRunner> {
  if (!installation) {
    installation = install().catch(error => {
      installation = null
      throw error
    })
  }
  return installation
}

async function install(): Promise<InstalledRunner> {
  const workspace = await mkdtemp(join(tmpdir(), 'modula-runner-blackbox-'))
  try {
    const output = join(workspace, 'artifact')
    const prefix = join(workspace, 'prefix')
    await prepareInstallWorkspace(workspace)
    buildCandidate(output)
    installCandidate(join(output, `modula-runner-${packageVersion}.tgz`), prefix, workspace)
    const binary = join(prefix, 'bin', 'modula-runner')
    return {
      binary,
      version: packageVersion,
      nativeDependency: nativeDependencyEvidence(prefix),
      run: (args, options = {}) => spawnInstalled(binary, args, options, workspace),
      runInPty: (args, options) => spawnInstalledInPty(binary, args, options, workspace),
      freshHome: () => mkdtemp(join(workspace, 'home-')),
      async dispose() {
        installation = null
        await rm(workspace, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await rm(workspace, { recursive: true, force: true })
    throw error
  }
}

function manifestString(field: 'name' | 'version'): string {
  const value = runnerManifest[field]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`runner manifest ${field} is invalid`)
  return value
}

function nativeDependencyEvidence(prefix: string): NativeDependencyEvidence {
  const root = join(prefix, 'lib', 'node_modules', packageName, 'node_modules', 'node-pty')
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>
  const version = manifest.version
  if (typeof version !== 'string' || version.length === 0) throw new Error('installed node-pty manifest is invalid')
  const prebuilt = join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'pty.node')
  const built = join(root, 'build', 'Release', 'pty.node')
  if (existsSync(prebuilt)) return { name: 'node-pty', version, installPath: 'prebuilt' }
  if (existsSync(built)) return { name: 'node-pty', version, installPath: 'local-build' }
  throw new Error('installed node-pty has no native binary for this platform')
}

async function prepareInstallWorkspace(workspace: string): Promise<void> {
  await Promise.all([
    mkdir(join(workspace, 'install-home')),
    mkdir(join(workspace, 'npm-cache')),
    mkdir(join(workspace, 'tmp')),
  ])
}

function buildCandidate(output: string): void {
  const built = spawnSync(process.execPath, [releaseScript, 'pack', '--output', output], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 10 * processOutputLimit,
    timeout: 20 * 60_000,
  })
  if (built.status !== 0) throw new Error(`candidate build failed: ${built.stderr}`)
}

function installCandidate(artifact: string, prefix: string, workspace: string): void {
  const installed = spawnSync(join(nodeBinDir, 'npm'),
    ['install', '--global', '--prefix', prefix, artifact],
    {
      cwd: workspace,
      encoding: 'utf8',
      env: installEnvironment(workspace),
      maxBuffer: 10 * processOutputLimit,
      timeout: 10 * 60_000,
    })
  if (installed.status !== 0) throw new Error(`candidate install failed: ${installed.stderr}`)
}

function installEnvironment(workspace: string): NodeJS.ProcessEnv {
  return {
    PATH: `${nodeBinDir}:/usr/bin:/bin`,
    HOME: join(workspace, 'install-home'),
    TMPDIR: join(workspace, 'tmp'),
    npm_config_cache: join(workspace, 'npm-cache'),
  }
}

function runnerEnvironment(
  workspace: string,
  options: Pick<RunOptions, 'home' | 'endpointUrl'>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: `${nodeBinDir}:/usr/bin:/bin`,
    HOME: workspace,
    TMPDIR: join(workspace, 'tmp'),
  }
  if (options.home) environment.MODULA_RUNNER_HOME = options.home
  if (options.endpointUrl) environment.MODULA_RUNNER_ENDPOINT_URL = options.endpointUrl
  return environment
}

async function spawnInstalled(
  binary: string,
  args: string[],
  options: RunOptions,
  workspace: string,
): Promise<RunResult> {
  const child = spawn(binary, args, {
    cwd: options.cwd ?? workspace,
    env: runnerEnvironment(workspace, options),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.end(options.input ?? '')
  return await pipeResult(child, options.timeoutMs ?? commandTimeoutMs)
}

function pipeResult(child: ChildProcess, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const stdout = capture(child.stdout!, () => fail('stdout exceeded the black-box capture limit'))
    const stderr = capture(child.stderr!, () => fail('stderr exceeded the black-box capture limit'))
    const timer = setTimeout(() => fail('installed command exceeded its deadline'), timeoutMs)
    const fail = (message: string) => {
      clearTimeout(timer)
      child.kill('SIGKILL')
      reject(new Error(message))
    }
    child.once('error', () => fail('installed command failed to start'))
    child.once('close', (status, signal) => {
      clearTimeout(timer)
      resolve({ status, signal, stdout: stdout.value(), stderr: stderr.value() })
    })
  })
}

function capture(stream: NodeJS.ReadableStream, overflow: () => void): { value(): string } {
  let output = ''
  let bytes = 0
  stream.on('data', (chunk: Buffer | string) => {
    bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
    if (bytes > processOutputLimit) return overflow()
    output += chunk.toString()
  })
  return { value: () => output }
}

function spawnInstalledInPty(
  binary: string,
  args: string[],
  options: PtyRunOptions,
  workspace: string,
): Promise<PtyRunResult> {
  const terminal = pty.spawn(binary, args, {
    cwd: options.cwd ?? workspace,
    env: runnerEnvironment(workspace, options),
    cols: 100,
    rows: 30,
  })
  return ptyResult(terminal, options.input, options.timeoutMs ?? commandTimeoutMs)
}

function ptyResult(
  terminal: pty.IPty,
  input: PtyRunOptions['input'],
  timeoutMs: number,
): Promise<PtyRunResult> {
  return new Promise((resolve, reject) => {
    let output = ''
    let bytes = 0
    let sent = false
    const timer = setTimeout(() => fail('interactive command exceeded its deadline'), timeoutMs)
    const fail = (message: string) => {
      clearTimeout(timer)
      terminal.kill()
      reject(new Error(message))
    }
    const data = terminal.onData(chunk => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > processOutputLimit) return fail('interactive output exceeded the black-box capture limit')
      output += chunk
      if (!sent && output.includes(input.after)) {
        sent = true
        terminal.write(`${input.value}\r`)
      }
    })
    terminal.onExit(({ exitCode, signal }) => {
      clearTimeout(timer)
      data.dispose()
      if (!sent) return reject(new Error('interactive command exited before requesting hidden input'))
      resolve({ status: exitCode, signal: signal ?? 0, output })
    })
  })
}

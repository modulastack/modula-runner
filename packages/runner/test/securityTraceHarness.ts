import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export type TracePass = {
  status: 'pass'
  runnerPid: number
  runnerTrace: string
  descendantTrace: string
}

export type TraceInconclusive = {
  status: 'inconclusive'
  capability: 'linux-procfs' | 'syscall-tracing' | 'linux-ptrace' | 'pid-attribution'
  detail: string
}

export type TraceResult = TracePass | TraceInconclusive

export type TraceHarnessOptions = {
  workspace: string
  claudeCanary: string
  codexCanary: string
  stracePath?: string
}

export async function traceRepresentativeRunner(options: TraceHarnessOptions): Promise<TraceResult> {
  if (process.platform !== 'linux') return inconclusive('linux-procfs', 'runner PID tracing requires Linux')
  try {
    await access('/proc/self/status', constants.R_OK)
  } catch {
    return inconclusive('linux-procfs', '/proc is unavailable')
  }
  const strace = options.stracePath ?? '/usr/bin/strace'
  try {
    await access(strace, constants.X_OK)
  } catch {
    return inconclusive('syscall-tracing', `strace is unavailable at ${strace}`)
  }
  const tracePrefix = join(options.workspace, 'runner-auth.trace')
  const fixture = resolve('packages/runner/test/fixtures/securityTraceScenario.ts')
  const viteNode = resolve('node_modules/.bin/vite-node')
  const execution = await execute(strace, [
    '-ff',
    '-qq',
    '-s',
    '4096',
    '-e',
    'trace=%file',
    '-o',
    tracePrefix,
    viteNode,
    fixture,
    options.workspace,
    options.claudeCanary,
    options.codexCanary,
  ])
  if (execution.code !== 0) return inconclusive('linux-ptrace', execution.stderr || `strace exited ${execution.code}`)
  const pidMatch = /RUNNER_PID=(\d+)/.exec(execution.stdout)
  if (!pidMatch?.[1]) return inconclusive('pid-attribution', 'trace fixture did not report its runner PID')
  const runnerPid = Number(pidMatch[1])
  const names = (await readdir(options.workspace)).filter(name => name.startsWith('runner-auth.trace.'))
  const rootName = `runner-auth.trace.${runnerPid}`
  if (!names.includes(rootName)) return inconclusive('pid-attribution', `trace has no stream for runner PID ${runnerPid}`)
  const runnerTrace = await readFile(join(options.workspace, rootName), 'utf8')
  const descendantTrace = (await Promise.all(names.filter(name => name !== rootName).map(name => readFile(join(options.workspace, name), 'utf8')))).join('\n')
  return { status: 'pass', runnerPid, runnerTrace, descendantTrace }
}

export function openedFileCalls(trace: string): string {
  return trace
    .split('\n')
    .filter(line => /^open(?:at|at2)?\(/.test(line))
    .join('\n')
}

export function requireTracePass(result: TraceResult): asserts result is TracePass {
  if (result.status === 'inconclusive') {
    throw new Error(`INCONCLUSIVE (${result.capability}): ${result.detail}`)
  }
}

function inconclusive(capability: TraceInconclusive['capability'], detail: string): TraceInconclusive {
  return { status: 'inconclusive', capability, detail }
}

function execute(command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolveExecution => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.once('error', error => resolveExecution({ code: null, stdout, stderr: String(error) }))
    child.once('exit', code => resolveExecution({ code, stdout, stderr }))
  })
}

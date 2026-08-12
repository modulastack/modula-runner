import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { readdirSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer, type Server as NetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Shared rig for the CP-4 acceptance tests: real local HTTP endpoints, real stand-in
// runtime executables, and the process-table and output taps the secrecy obligations are
// measured against. Nothing here depends on Ollama, claude, codex or pi being installed —
// docs/model-access.md's probe shapes are served by a node:http server the test owns.

// Sixteen characters is MIN_API_KEY_LENGTH, so this is a key the store will accept. The
// body and the last four are separated because the sweep exemption is exactly four
// characters wide (docs/model-access.md, "The fingerprint is the literal last four").
export const apiKeySecret = 'sk-acceptance-key-material-9x7q'
export const apiKeyBody = apiKeySecret.slice(0, -4)
export const apiKeyLastFour = apiKeySecret.slice(-4)

export type EndpointServerOptions = {
  models?: readonly string[]
  status?: number
  body?: string
  delayMs?: number
  padBytes?: number
}

export type EndpointServer = {
  baseUrl: string
  host: string
  port: number
  paths(): string[]
  requestCount(): number
  update(patch: EndpointServerOptions): void
  stop(): Promise<void>
}

// Serves both documented probe shapes (docs/model-access.md, "Probe shapes — PROPOSAL"):
// ollama at /api/tags reading models[].name, openai-compatible at /v1/models reading
// data[].id. Both are served regardless of the endpoint kind under test, so a probe that
// asks the wrong path gets a 404 and the test can say which path was asked for.
export async function startEndpointServer(initial: EndpointServerOptions = {}): Promise<EndpointServer> {
  let options: EndpointServerOptions = { models: [], ...initial }
  const paths: string[] = []
  const server = createServer((request, response) => {
    paths.push(request.url ?? '')
    const send = () => respond(response, request.url ?? '', options)
    if (options.delayMs) setTimeout(send, options.delayMs)
    else send()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = portOf(server)
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    host: '127.0.0.1',
    port,
    paths: () => [...paths],
    requestCount: () => paths.length,
    update: patch => { options = { ...options, ...patch } },
    stop: () => closeServer(server),
  }
}

function respond(response: import('node:http').ServerResponse, url: string, options: EndpointServerOptions) {
  if (options.status && options.status !== 200) {
    response.writeHead(options.status)
    response.end('denied')
    return
  }
  if (options.body !== undefined) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(options.body)
    return
  }
  if (options.padBytes) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(`{"models":[],"pad":"${'p'.repeat(options.padBytes)}"}`)
    return
  }
  const models = options.models ?? []
  if (url.startsWith('/api/tags')) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ models: models.map(name => ({ name })) }))
    return
  }
  if (url.startsWith('/v1/models')) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: models.map(id => ({ id })) }))
    return
  }
  response.writeHead(404)
  response.end('no such path')
}

// Accepts the connection and never answers. This is the case an ECONNREFUSED-only reading
// of "fails fast" misses entirely: the OS default wait is about two minutes.
export async function startBlackHoleServer() {
  const held: import('node:net').Socket[] = []
  const server: NetServer = createNetServer(socket => held.push(socket))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('black hole did not bind')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stop: async () => {
      for (const socket of held) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

export type StandInRuntimeOptions = {
  version?: string | null
  versionExitCode?: number
  authenticated?: boolean
  authStallMs?: number
  versionPadBytes?: number
  dumpPath?: string
  cwdRecordPath?: string
}

// An executable stand-in for an agent CLI. `--version` and `--auth` answer the catalog's
// probe subcommands; any other invocation is a launch, which records the environment and
// argument vector it was given and then stays alive so the process table can be read while
// it runs. Both probe answers are unambiguous under either plausible reading of "ask the
// CLI about itself" — exit status and printed text agree.
export async function writeStandInRuntime(root: string, name: string, options: StandInRuntimeOptions = {}) {
  const path = join(root, `${name}.mjs`)
  const version = options.version === undefined ? '1.2.3' : options.version
  const authenticated = options.authenticated ?? true
  const source = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
const mode = process.argv[2]
if (mode === '--version') {
  ${options.cwdRecordPath ? `writeFileSync(${JSON.stringify(options.cwdRecordPath)}, process.cwd())` : ''}
  ${options.versionPadBytes ? `process.stdout.write('v'.repeat(${options.versionPadBytes}))` : ''}
  ${version === null ? 'process.exit(3)' : `process.stdout.write(${JSON.stringify(`${version}\n`)})`}
  process.exit(${options.versionExitCode ?? 0})
}
if (mode === '--auth') {
  ${options.authStallMs ? `setTimeout(() => process.exit(0), ${options.authStallMs}); await new Promise(() => {})` : ''}
  process.stdout.write(${JSON.stringify(authenticated ? 'Logged in as acceptance@example.test\n' : 'Not logged in\n')})
  process.exit(${authenticated ? 0 : 1})
}
${options.dumpPath ? dumpSource(options.dumpPath) : ''}
setInterval(() => undefined, 1000)
`
  await writeFile(path, source)
  await chmod(path, 0o755)
  return path
}

function dumpSource(dumpPath: string) {
  return `writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify({
  env: process.env,
  argv: process.argv,
  cwd: process.cwd(),
  pid: process.pid,
}))`
}

export type LaunchDump = {
  env: Record<string, string>
  argv: string[]
  cwd: string
  pid: number
}

export async function readDump(path: string): Promise<LaunchDump> {
  return JSON.parse(await readFile(path, 'utf8')) as LaunchDump
}

export async function temporaryRoot(prefix: string) {
  return mkdtemp(join(tmpdir(), prefix))
}

// Every argument vector this user can see. Env-only injection is a promise about the
// process table, and trust boundary 2 extends it to every process in the chain — the CLI,
// the shell, the tmux client and the tmux server alike — so the sweep is over all of them
// rather than over one pid the test happens to hold.
export function allProcessArguments(): string {
  if (process.platform === 'linux') return linuxProcessArguments()
  const result = spawnSync('ps', ['-ww', '-eo', 'command'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return result.stdout ?? ''
}

function linuxProcessArguments() {
  const parts: string[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      parts.push(readFileSync(`/proc/${entry}/cmdline`, 'utf8').replaceAll('\0', ' '))
    } catch {
      continue
    }
  }
  return parts.join('\n')
}

// AC-2 sweeps the control plane; docs/model-access.md and the CP-4 adjudication extend the
// obligation to the runner's own output, because a key echoed into a local log is the same
// disclosure class and the more likely bug.
export function captureRunnerOutput() {
  const chunks: string[] = []
  const realOut = process.stdout.write.bind(process.stdout)
  const realErr = process.stderr.write.bind(process.stderr)
  const tap = (real: typeof realOut) => ((chunk: unknown, ...rest: unknown[]) => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
    return (real as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof realOut
  process.stdout.write = tap(realOut)
  process.stderr.write = tap(realErr)
  return {
    text: () => chunks.join(''),
    restore: () => {
      process.stdout.write = realOut
      process.stderr.write = realErr
    },
  }
}

export function killTmuxServer(socket: string) {
  spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' })
}

function portOf(server: Server) {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind')
  return address.port
}

function closeServer(server: Server) {
  return new Promise<void>(resolve => {
    server.close(() => resolve())
    // A keep-alive connection from an earlier probe would otherwise hold the port open,
    // and "the service stopped" has to mean the port is actually gone.
    server.closeAllConnections()
  })
}

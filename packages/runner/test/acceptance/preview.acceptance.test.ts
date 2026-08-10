import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { PreviewHost, type PreviewOutcome, type PreviewRecipe } from '../../src/index.js'
import { sleep, until } from '../helpers.js'

const hosts: PreviewHost[] = []
const temporaryPaths: string[] = []
const fixturePids = new Set<number>()

afterEach(async () => {
  await Promise.all(hosts.map(host => host.stopAll()))
  for (const pid of fixturePids) killIfAlive(pid)
  await Promise.all(temporaryPaths.map(path => rm(path, { recursive: true, force: true })))
  hosts.length = 0
  temporaryPaths.length = 0
  fixturePids.clear()
})

async function fixture(host: string) {
  const root = await mkdtemp(join(tmpdir(), 'runner-preview-'))
  temporaryPaths.push(root)
  const script = join(root, 'server.mjs')
  const pidPath = join(root, 'server.pid')
  await writeFile(script, serverSource(host))
  return { root, script, pidPath }
}

function serverSource(host: string) {
  return `
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
writeFileSync(process.argv[2], String(process.pid))
const server = createServer((_request, response) => response.end('preview-ready'))
server.listen(0, ${JSON.stringify(host)})
process.on('SIGTERM', () => server.close(() => process.exit(0)))
`
}

function previewHost(root: string, recipes: Record<string, PreviewRecipe>) {
  const host = new PreviewHost({
    allowlist: { recipes, grantedPaths: [root] },
    readyTimeoutMs: 4_000,
  })
  hosts.push(host)
  return host
}

function start(host: PreviewHost, recipe: string, cwd: string, previewId = 'preview-one') {
  return host.start({ previewId, recipe, cwd })
}

function nodeRecipe(script: string, ...args: string[]): PreviewRecipe {
  return { command: process.execPath, args: [script, ...args] }
}

describe('FR-8 localhost preview adjacency', () => {
  // FRD FR-8: a preview binds on runner localhost and reports the usable port.
  test('reports a loopback preview port that the local browser can reach', async () => {
    const local = await fixture('127.0.0.1')
    const host = previewHost(local.root, { app: nodeRecipe(local.script, local.pidPath) })

    const outcome = await start(host, 'app', local.root)

    expect(outcome.status).toBe('ready')
    if (outcome.status !== 'ready') throw new Error(`preview refused: ${outcome.reason}`)
    const response = await fetch(`http://127.0.0.1:${outcome.record.port}`)
    expect(await response.text()).toBe('preview-ready')
    expect(host.list()).toEqual([outcome.record])
    expect(Object.keys(outcome.record).sort()).toEqual(['pid', 'port', 'previewId'])
  })

  // FRD FR-8: actual socket adjacency is verified after spawn; command-string inspection is insufficient.
  test('kills and refuses a process that actually listens on a non-loopback address', async () => {
    const exposed = await fixture('0.0.0.0')
    const host = previewHost(exposed.root, { app: nodeRecipe(exposed.script, exposed.pidPath) })

    const outcome = await start(host, 'app', exposed.root)

    expect(outcome).toEqual<PreviewOutcome>({ status: 'refused', reason: 'non-loopback-bind' })
    const pid = Number(await readFile(exposed.pidPath, 'utf8'))
    await until(() => !processExists(pid))
    expect(processExists(pid)).toBe(false)
  })

  // SCHEMA "Loopback binding is verified": adjacency remains enforced for the preview's whole lifetime.
  test('ends a ready preview if a later descendant exposes a non-loopback socket', async () => {
    const tree = await delayedExposedTree()
    const host = previewHost(tree.root, {
      app: nodeRecipe(tree.parent, tree.child, tree.childPid, tree.trigger),
    })
    const exited = new Promise<string>(resolve => host.once('exit', event => resolve(event.previewId)))

    const outcome = await start(host, 'app', tree.root, 'changing-tree')
    expect(outcome.status).toBe('ready')
    if (outcome.status !== 'ready') throw new Error(`preview refused: ${outcome.reason}`)
    fixturePids.add(outcome.record.pid)
    await writeFile(tree.trigger, 'expose')
    await until(async () => {
      try {
        fixturePids.add(Number(await readFile(tree.childPid, 'utf8')))
        return true
      } catch {
        return false
      }
    })

    await expect(exited).resolves.toBe('changing-tree')
    await until(() => host.list().length === 0)
    await until(() => [...fixturePids].every(pid => !processExists(pid)))
  })

  // FRD FR-8 and the seam local floor: refused preview starts return named values, never silent absence.
  test('returns visible reasons for locally decidable preview refusals', async () => {
    const local = await fixture('127.0.0.1')
    const outside = await mkdtemp(join(tmpdir(), 'runner-preview-outside-'))
    temporaryPaths.push(outside)
    const host = previewHost(local.root, { app: nodeRecipe(local.script, local.pidPath) })

    await expect(start(host, 'unknown-recipe', local.root, 'not-allowed')).resolves.toEqual({
      status: 'refused', reason: 'not-allowlisted',
    })
    expect(host.list()).toEqual([])
    await expect(start(host, 'app', outside, 'outside-grant')).resolves.toEqual({
      status: 'refused', reason: 'path-not-granted',
    })
  })

  // FRD FR-8: a preview identifier names one live local server and duplicate starts are refused.
  test('does not replace an already-running preview implicitly', async () => {
    const local = await fixture('127.0.0.1')
    const host = previewHost(local.root, { app: nodeRecipe(local.script, local.pidPath) })
    const first = await start(host, 'app', local.root)
    expect(first.status).toBe('ready')

    await expect(start(host, 'app', local.root)).resolves.toEqual({
      status: 'refused', reason: 'already-running',
    })
    expect(host.list()).toHaveLength(1)
  })

  // SCHEMA "Preview lifecycle": an id remains reserved until its previous process has exited.
  test('holds a preview id while its previous process is still stopping', async () => {
    const slow = await slowStoppingFixture()
    const host = previewHost(slow.root, { app: nodeRecipe(slow.script, slow.marker) })
    const first = await start(host, 'app', slow.root, 'reused-preview')
    expect(first.status).toBe('ready')
    const exited = new Promise<void>(resolve => host.once('exit', () => resolve()))

    const stopping = host.stop('reused-preview')
    await expect(start(host, 'app', slow.root, 'reused-preview')).resolves.toEqual({
      status: 'refused', reason: 'already-running',
    })
    await stopping
    await exited

    const replacement = await start(host, 'app', slow.root, 'reused-preview')
    expect(replacement.status).toBe('ready')
  })

  // SCHEMA "Preview lifecycle": closing the advertised listener ends a process that remains alive.
  test('terminates a preview that closes its server without exiting', async () => {
    const closing = await selfClosingFixture()
    const host = previewHost(closing.root, {
      app: nodeRecipe(closing.script, closing.pidPath, closing.trigger),
    })
    const exited = new Promise<string>(resolve => host.once('exit', event => resolve(event.previewId)))
    const outcome = await start(host, 'app', closing.root, 'dead-port')
    expect(outcome.status).toBe('ready')
    if (outcome.status !== 'ready') throw new Error(`preview refused: ${outcome.reason}`)
    fixturePids.add(outcome.record.pid)
    await writeFile(closing.trigger, 'close')

    await expect(exited).resolves.toBe('dead-port')
    await until(() => host.list().length === 0)
    await until(() => !processExists(outcome.record.pid))
  })

  // runner-seam "Preview process ownership": a wrapper exit does not end a still-serving process group.
  test('retains ownership after a wrapper exits while its descendant still serves', async () => {
    const wrapped = await exitingWrapperFixture()
    const host = previewHost(wrapped.root, {
      app: nodeRecipe(wrapped.wrapper, wrapped.child, wrapped.childPid),
    })
    const exits: string[] = []
    host.on('exit', event => exits.push(event.previewId))

    const outcome = await start(host, 'app', wrapped.root, 'wrapped-preview')
    expect(outcome.status).toBe('ready')
    if (outcome.status !== 'ready') throw new Error(`preview refused: ${outcome.reason}`)
    await until(async () => {
      try {
        fixturePids.add(Number(await readFile(wrapped.childPid, 'utf8')))
        return true
      } catch {
        return false
      }
    })

    await sleep(300)
    expect(exits).toEqual([])
    expect(await (await fetch(`http://127.0.0.1:${outcome.record.port}`)).text()).toBe('descendant-serving')
    await until(() => exits.includes('wrapped-preview'), 10_000)
    expect(host.list()).toEqual([])
  })

  // FRD FR-8: a failed local preview spawn is surfaced rather than left looking queued.
  test('reports spawn failure as a refusal value', async () => {
    const local = await fixture('127.0.0.1')
    const missing = join(local.root, 'missing-preview-executable')
    const host = previewHost(local.root, { missing: { command: missing, args: [] } })

    await expect(start(host, 'missing', local.root, 'spawn-failure')).resolves.toEqual({
      status: 'refused', reason: 'spawn-failed',
    })
  })
})

async function slowStoppingFixture() {
  const root = await mkdtemp(join(tmpdir(), 'runner-preview-stopping-'))
  temporaryPaths.push(root)
  const script = join(root, 'server.mjs')
  const marker = join(root, 'stopping')
  await writeFile(script, `
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
const server = createServer((_request, response) => response.end('ready'))
server.listen(0, '127.0.0.1')
process.on('SIGTERM', () => {
  writeFileSync(process.argv[2], 'stopping')
  setTimeout(() => server.close(() => process.exit(0)), 750)
})
`)
  return { root, script, marker }
}

async function selfClosingFixture() {
  const root = await mkdtemp(join(tmpdir(), 'runner-preview-closing-'))
  temporaryPaths.push(root)
  const script = join(root, 'server.mjs')
  const pidPath = join(root, 'server.pid')
  const trigger = join(root, 'close-now')
  await writeFile(script, `
import { existsSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
writeFileSync(process.argv[2], String(process.pid))
const server = createServer((_request, response) => response.end('ready'))
server.listen(0, '127.0.0.1')
setInterval(() => { if (existsSync(process.argv[3])) server.close() }, 50)
`)
  return { root, script, pidPath, trigger }
}

async function exitingWrapperFixture() {
  const root = await mkdtemp(join(tmpdir(), 'runner-preview-wrapper-'))
  temporaryPaths.push(root)
  const wrapper = join(root, 'wrapper.mjs')
  const child = join(root, 'child.mjs')
  const childPid = join(root, 'child.pid')
  await writeFile(wrapper, `
import { spawn } from 'node:child_process'
spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: 'ignore' })
`)
  await writeFile(child, `
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
writeFileSync(process.argv[2], String(process.pid))
const server = createServer((_request, response) => response.end('descendant-serving'))
server.listen(0, '127.0.0.1', () => setTimeout(() => server.close(() => process.exit(0)), 6000))
`)
  return { root, wrapper, child, childPid }
}

async function delayedExposedTree() {
  const root = await mkdtemp(join(tmpdir(), 'runner-preview-tree-'))
  temporaryPaths.push(root)
  const parent = join(root, 'parent.mjs')
  const child = join(root, 'child.mjs')
  const childPid = join(root, 'child.pid')
  const trigger = join(root, 'expose-now')
  await writeFile(child, exposedChildSource())
  await writeFile(parent, delayedParentSource())
  return { root, parent, child, childPid, trigger }
}

function delayedParentSource() {
  return `
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
const server = createServer((_request, response) => response.end('initially-local'))
server.listen(0, '127.0.0.1')
const trigger = setInterval(() => {
  if (!existsSync(process.argv[4])) return
  clearInterval(trigger)
  spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: 'ignore' })
}, 50)
process.on('SIGTERM', () => server.close(() => process.exit(0)))
`
}

function exposedChildSource() {
  return `
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
writeFileSync(process.argv[2], String(process.pid))
createServer((_request, response) => response.end('exposed')).listen(0, '0.0.0.0')
`
}

function killIfAlive(pid: number) {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    return
  }
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

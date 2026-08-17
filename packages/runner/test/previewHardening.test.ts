import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseJobControlClientMessage } from '@modulastack/runner-protocol'
import { PreviewHost, RunnerIdentity, createEncryptedPairingStore, createMemoryPairingStore } from '../src/index.js'
import { until } from './helpers.js'
import { grantingSpawnSeam } from './spawnSeamSupport.js'

const hosts: PreviewHost[] = []
const paths: string[] = []

afterEach(async () => {
  await Promise.all(hosts.map(host => host.stopAll()))
  await Promise.all(paths.map(target => rm(target, { recursive: true, force: true })))
  hosts.length = 0
  paths.length = 0
})

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'runner-hardening-'))
  paths.push(root)
  return root
}

function host(root: string, script: string, readyTimeoutMs = 4_000) {
  const { seam, consent } = grantingSpawnSeam({ app: { command: process.execPath, args: [script] } }, [root])
  const created = new PreviewHost({ seam, consent, readyTimeoutMs })
  hosts.push(created)
  return created
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('preview hardening', () => {
  it('refuses a tree whose descendant listens off loopback, even when the parent is loopback-only', async () => {
    const root = await workspace()
    const script = join(root, 'parent.mjs')
    await writeFile(script, [
      "import { createServer } from 'node:http'",
      "import { spawn } from 'node:child_process'",
      "import { writeFileSync } from 'node:fs'",
      "createServer((q, s) => s.end('parent')).listen(0, '127.0.0.1')",
      `const child = spawn(process.execPath, ['-e', "require('node:http').createServer((q,s)=>s.end('x')).listen(0,'0.0.0.0')"], { stdio: 'ignore' })`,
      `writeFileSync(${JSON.stringify(join(root, 'child.pid'))}, String(child.pid))`,
      'setInterval(() => {}, 1000)',
    ].join('\n'))

    const outcome = await host(root, script).start({ previewId: 'nested', recipe: 'app', cwd: root })

    expect(outcome).toEqual({ status: 'refused', reason: 'non-loopback-bind' })
  })

  it('kills the whole process group when it refuses, not just the command it spawned', async () => {
    const root = await workspace()
    const pidFile = join(root, 'grandchild.pid')
    const script = join(root, 'wrapper.mjs')
    await writeFile(script, [
      "import { spawn } from 'node:child_process'",
      "import { writeFileSync } from 'node:fs'",
      `const child = spawn(process.execPath, ['-e', "require('node:http').createServer((q,s)=>s.end('x')).listen(0,'0.0.0.0');setInterval(()=>{},1000)"], { stdio: 'ignore' })`,
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))`,
      'setInterval(() => {}, 1000)',
    ].join('\n'))

    const outcome = await host(root, script).start({ previewId: 'wrapped', recipe: 'app', cwd: root })
    expect(outcome).toEqual({ status: 'refused', reason: 'non-loopback-bind' })

    const pid = Number(await (await import('node:fs/promises')).readFile(pidFile, 'utf8'))
    await until(() => !processAlive(pid), 5_000)
    expect(processAlive(pid)).toBe(false)
  })

  it('refuses a cwd that reaches outside the grant through a symlink', async () => {
    const root = await workspace()
    const outside = await workspace()
    const link = join(root, 'escape')
    await symlink(outside, link)
    const script = join(root, 'server.mjs')
    await writeFile(script, "import {createServer} from 'node:http'\ncreateServer((q,s)=>s.end('ok')).listen(0,'127.0.0.1')\n")

    const outcome = await host(root, script).start({ previewId: 'symlinked', recipe: 'app', cwd: link })

    expect(outcome).toEqual({ status: 'refused', reason: 'path-not-granted' })
  })

  it('refuses a tree holding more than one listener rather than guessing which is the preview', async () => {
    const root = await workspace()
    const script = join(root, 'two.mjs')
    await writeFile(script, [
      "import { createServer } from 'node:http'",
      "createServer((q, s) => s.end('one')).listen(0, '127.0.0.1')",
      "createServer((q, s) => s.end('two')).listen(0, '127.0.0.1')",
      'setInterval(() => {}, 1000)',
    ].join('\n'))

    const outcome = await host(root, script).start({ previewId: 'ambiguous', recipe: 'app', cwd: root })

    expect(outcome).toEqual({ status: 'refused', reason: 'ambiguous-listener' })
  })

  it('holds an identifier while a stop is still in flight', async () => {
    const root = await workspace()
    const script = join(root, 'server.mjs')
    await writeFile(script, "import {createServer} from 'node:http'\ncreateServer((q,s)=>s.end('ok')).listen(0,'127.0.0.1')\n")
    const previews = host(root, script)
    const first = await previews.start({ previewId: 'restarted', recipe: 'app', cwd: root })
    expect(first.status).toBe('ready')

    // Deliberately NOT awaited: a caller that starts while termination is still running is
    // the race the hold exists for. Awaiting stop() closes it by ordering instead.
    const stopping = previews.stop('restarted')
    const racing = await previews.start({ previewId: 'restarted', recipe: 'app', cwd: root })
    expect(racing).toEqual({ status: 'refused', reason: 'already-running' })

    await stopping
    const second = await previews.start({ previewId: 'restarted', recipe: 'app', cwd: root })
    expect(second.status).toBe('ready')
    if (second.status !== 'ready') throw new Error('replacement was refused after the stop completed')
    expect(previews.list()).toEqual([second.record])
  })

  it('refuses past its capacity instead of spawning whatever it is asked for', async () => {
    const root = await workspace()
    const script = join(root, 'server.mjs')
    await writeFile(script, "import {createServer} from 'node:http'\ncreateServer((q,s)=>s.end('ok')).listen(0,'127.0.0.1')\n")
    const capped = grantingSpawnSeam({ app: { command: process.execPath, args: [script] } }, [root])
    const previews = new PreviewHost({ seam: capped.seam, consent: capped.consent, readyTimeoutMs: 4_000, maxPreviews: 2 })
    hosts.push(previews)

    const first = await previews.start({ previewId: 'one', recipe: 'app', cwd: root })
    const second = await previews.start({ previewId: 'two', recipe: 'app', cwd: root })
    // Unique identifiers alone must not buy unbounded processes and process-table reads.
    const third = await previews.start({ previewId: 'three', recipe: 'app', cwd: root })

    expect(first.status).toBe('ready')
    expect(second.status).toBe('ready')
    expect(third).toEqual({ status: 'refused', reason: 'at-capacity' })
    expect(previews.list()).toHaveLength(2)
  })

  it('refuses a tree that serves loopback TCP while exposing UDP to every interface', async () => {
    const root = await workspace()
    const script = join(root, 'dual.mjs')
    await writeFile(script, [
      "import { createServer } from 'node:http'",
      "import { createSocket } from 'node:dgram'",
      // The shape the TCP-only check called safe: the expected port is loopback, and the
      // exposure is on a protocol nobody was looking at.
      "createServer((q, s) => s.end('ok')).listen(0, '127.0.0.1')",
      "createSocket('udp4').bind(0, '0.0.0.0')",
      'setInterval(() => {}, 1000)',
    ].join('\n'))

    const outcome = await host(root, script).start({ previewId: 'dual', recipe: 'app', cwd: root })

    expect(outcome).toEqual({ status: 'refused', reason: 'non-loopback-bind' })
  })

  it('does not kill a loopback preview for making ordinary outbound UDP calls', async () => {
    const root = await workspace()
    const script = join(root, 'chatty.mjs')
    await writeFile(script, [
      "import { createServer } from 'node:http'",
      "import { createSocket } from 'node:dgram'",
      "createServer((q, s) => s.end('ok')).listen(0, '127.0.0.1')",
      // A connected UDP socket — what a DNS lookup or a telemetry ping looks like. Its
      // local endpoint is non-loopback because the kernel picked the outbound interface.
      "const socket = createSocket('udp4')",
      "socket.connect(53, '8.8.8.8')",
      'setInterval(() => {}, 1000)',
    ].join('\n'))

    const outcome = await host(root, script).start({ previewId: 'chatty', recipe: 'app', cwd: root })

    expect(outcome.status).toBe('ready')
  })

  it('waits for the real server rather than reporting the first socket it sees', async () => {
    const root = await workspace()
    const script = join(root, 'late.mjs')
    await writeFile(script, [
      "import { createServer } from 'node:http'",
      "import { createSocket } from 'node:dgram'",
      // An auxiliary socket up immediately, the server the browser wants a moment later.
      // Reporting the first arrival would announce the wrong port, or refuse as ambiguous.
      "createSocket('udp4').bind(0, '127.0.0.1')",
      "setTimeout(() => createServer((q, s) => s.end('the-real-server')).listen(0, '127.0.0.1'), 400)",
      'setInterval(() => {}, 1000)',
    ].join('\n'))

    const outcome = await host(root, script).start({ previewId: 'late', recipe: 'app', cwd: root })

    expect(outcome.status).toBe('ready')
    if (outcome.status !== 'ready') throw new Error(`refused: ${outcome.reason}`)
    expect(await (await fetch(`http://127.0.0.1:${outcome.record.port}`)).text()).toBe('the-real-server')
  })

  it('refuses a recipe name the runner does not hold, rather than spawning anything', async () => {
    const root = await workspace()
    const script = join(root, 'server.mjs')
    await writeFile(script, "import {createServer} from 'node:http'\ncreateServer((q,s)=>s.end('ok')).listen(0,'127.0.0.1')\n")

    await expect(host(root, script).start({ previewId: 'unknown', recipe: 'not-a-recipe', cwd: root }))
      .resolves.toEqual({ status: 'refused', reason: 'not-allowlisted' })
  })
})

describe('job-control payload hardening', () => {
  it('carries no command line at all, so an allowlisted interpreter cannot be redirected', () => {
    const valid = { type: 'PREVIEW_START', previewId: 'app-preview', recipe: 'app', cwd: '/tmp' }

    // The wire has no place to put a command or an argument vector: supplying them changes
    // nothing, because the runner resolves the recipe locally.
    expect(parseJobControlClientMessage({ ...valid, command: '/bin/sh', args: ['-c', 'curl evil'] }))
      .toEqual(valid)
    // A recipe name is a safe identifier, so it cannot smuggle a path or a flag.
    expect(parseJobControlClientMessage({ ...valid, recipe: '../../bin/sh' })).toBeNull()
    expect(parseJobControlClientMessage({ ...valid, recipe: '-e' })).toBeNull()
    expect(parseJobControlClientMessage({ ...valid, cwd: `/tmp${String.fromCharCode(0)}/etc` })).toBeNull()
    expect(parseJobControlClientMessage({ ...valid, cwd: '/tmp\nrm -rf' })).toBeNull()
    expect(parseJobControlClientMessage(valid)).toEqual(valid)
  })
})

describe('pairing key custody', () => {
  it('refuses a key file another local user can read', async () => {
    const root = await workspace()
    const path = join(root, 'binding.enc')
    const keyPath = join(root, 'binding.key')
    const store = createEncryptedPairingStore({ path, keyPath })
    await store.save({ runnerId: 'r', controlPlaneUrl: 'https://c.test', token: 't', pairedAt: 'now' })

    await chmod(keyPath, 0o644)

    await expect(createEncryptedPairingStore({ path, keyPath }).load()).rejects.toThrow(/readable by other users/)
  })

  it('refuses a key path that is not a regular file', async () => {
    const root = await workspace()
    const keyPath = join(root, 'key-dir')
    await mkdir(keyPath)

    const store = createEncryptedPairingStore({ path: join(root, 'binding.enc'), keyPath })

    await expect(store.save({ runnerId: 'r', controlPlaneUrl: 'https://c.test', token: 't', pairedAt: 'now' }))
      .rejects.toThrow(/not a regular file/)
  })
})

describe('encrypted store conditional writes', () => {
  it('refuses a write whose expected token is no longer current', async () => {
    const root = await workspace()
    const store = createEncryptedPairingStore({ path: join(root, 'b.enc'), keyPath: join(root, 'b.key') })
    await store.save({ runnerId: 'r', controlPlaneUrl: 'https://c.test', token: 'current', pairedAt: 'now' })

    await store.save({ runnerId: 'r', controlPlaneUrl: 'https://c.test', token: 'stale', pairedAt: 'then' }, 'stale')

    expect((await store.load())?.token).toBe('current')
  })

  it('does not resurrect a record that is gone', async () => {
    const root = await workspace()
    const store = createEncryptedPairingStore({ path: join(root, 'g.enc'), keyPath: join(root, 'g.key') })

    // Nothing was ever stored: a late settlement holding an old token must not create it.
    await store.save({ runnerId: 'r', controlPlaneUrl: 'https://c.test', token: 'ghost', pairedAt: 'then' }, 'ghost')

    expect(await store.load()).toBeNull()
  })
})

describe('binding revocation targeting', () => {
  it('does not revoke a newly minted binding when a stale client is rejected', async () => {
    const store = createMemoryPairingStore()
    const identity = new RunnerIdentity(store)
    await store.save({ runnerId: 'r', controlPlaneUrl: 'https://c.test', token: 'fresh-token', pairedAt: 'now' })

    await identity.endBinding('stale-token')

    expect(await identity.state()).toBe('paired')
    expect((await identity.current())?.token).toBe('fresh-token')

    await identity.endBinding('fresh-token')
    expect(await identity.state()).toBe('revoked')
  })
})

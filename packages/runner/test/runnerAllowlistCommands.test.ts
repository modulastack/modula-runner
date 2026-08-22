import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createAllowlistSigningKeyFile,
  createFileRunnerHome,
  createRunnerApplication,
  type RunnerApplicationOptions,
} from '../src/index.js'

const roots: string[] = []
const clock = { now: () => Date.parse('2026-08-22T00:00:00Z'), sleep: async () => undefined }

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const parent = await mkdtemp(path.join(tmpdir(), 'runner-allowlist-command-'))
  roots.push(parent)
  const homeRoot = path.join(parent, 'home')
  const operatorRoot = path.join(parent, 'operator')
  await mkdir(operatorRoot, { mode: 0o700 })
  const home = createFileRunnerHome({ defaultRoot: homeRoot, clock })
  const options: RunnerApplicationOptions = {
    version: '0.1.0',
    clock,
    home,
    composition: {
      pairing: () => { throw new Error('pairing not used') },
      sessions: () => { throw new Error('sessions not used') },
      jobControl: () => { throw new Error('job control not used') },
      runtime: { start: async () => { throw new Error('runtime not used') } },
    },
  }
  return { parent, homeRoot, operatorRoot, home, application: createRunnerApplication(options) }
}

function invocation(args: string[], cwd: string) {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    value: {
      args,
      cwd,
      environment: {},
      io: {
        inputIsTTY: false,
        readHidden: async () => '',
        writeStdout: (value: string) => stdout.push(value),
        writeStderr: (value: string) => stderr.push(value),
      },
    },
    stdout,
    stderr,
  }
}

describe('allowlist application commands', () => {
  it('initializes once, signs an edited document, and verifies without printing private material', async () => {
    const held = await fixture()
    const keyPath = path.join(held.operatorRoot, 'allowlist.pem')
    const init = invocation(['allowlist', 'init', '--key', keyPath], held.parent)
    await expect(held.application.execute(init.value)).resolves.toBe(0)
    expect(init.stdout.join('')).toContain('allowlist initialized with key')
    expect(init.stdout.join('')).not.toContain('PRIVATE KEY')
    expect((await lstat(keyPath)).mode & 0o777).toBe(0o600)

    const verify = invocation(['allowlist', 'verify'], held.parent)
    await expect(held.application.execute(verify.value)).resolves.toBe(0)
    expect(verify.stdout.join('')).toContain('allowlist verified with key')

    const documentPath = path.join(held.operatorRoot, 'allowlist.json')
    await writeFile(documentPath, JSON.stringify({ executables: ['git', 'tmux'], recipes: {} }), { mode: 0o600 })
    const sign = invocation(['allowlist', 'sign', '--key', keyPath, '--input', documentPath], held.parent)
    await expect(held.application.execute(sign.value)).resolves.toBe(0)
    expect(sign.stdout.join('')).toContain('allowlist signed with key')
    expect(`${sign.stdout.join('')} ${sign.stderr.join('')}`).not.toContain(await readFile(keyPath, 'utf8'))

    const secondKey = path.join(held.operatorRoot, 'second.pem')
    const repeated = invocation(['allowlist', 'init', '--key', secondKey], held.parent)
    await expect(held.application.execute(repeated.value)).resolves.toBe(1)
    await expect(lstat(secondKey)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('resumes policy bootstrap from an existing secure key without overwriting it', async () => {
    const held = await fixture()
    const keyPath = path.join(held.operatorRoot, 'existing.pem')
    await createAllowlistSigningKeyFile(keyPath)
    const original = await readFile(keyPath, 'utf8')
    const call = invocation(['allowlist', 'init', '--key', keyPath], held.parent)
    await expect(held.application.execute(call.value)).resolves.toBe(0)
    expect(await readFile(keyPath, 'utf8')).toBe(original)
  })

  it('rejects key paths inside runner state before creating a private file', async () => {
    const held = await fixture()
    const inside = path.join(held.homeRoot, 'operator.pem')
    const call = invocation(['allowlist', 'init', '--key', inside], held.parent)
    await expect(held.application.execute(call.value)).resolves.toBe(1)
    await expect(lstat(inside)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(call.stderr.join('')).toContain('state-insecure-mode')
  })

  it('rejects malformed documents and untrusted signing keys without replacing policy', async () => {
    const held = await fixture()
    const trustedKey = path.join(held.operatorRoot, 'trusted.pem')
    const init = invocation(['allowlist', 'init', '--key', trustedKey], held.parent)
    await held.application.execute(init.value)

    const malformed = path.join(held.operatorRoot, 'malformed.json')
    await writeFile(malformed, '{', { mode: 0o600 })
    const malformedCall = invocation(['allowlist', 'sign', '--key', trustedKey, '--input', malformed], held.parent)
    await expect(held.application.execute(malformedCall.value)).resolves.toBe(1)
    expect(malformedCall.stderr).toEqual(['allowlist document is malformed\n'])

    const other = await fixture()
    const foreignKey = path.join(other.operatorRoot, 'foreign.pem')
    const foreignInit = invocation(['allowlist', 'init', '--key', foreignKey], other.parent)
    await other.application.execute(foreignInit.value)
    const document = path.join(held.operatorRoot, 'allowlist.json')
    await writeFile(document, JSON.stringify({ executables: ['git'], recipes: {} }), { mode: 0o600 })
    const foreign = invocation(['allowlist', 'sign', '--key', foreignKey, '--input', document], held.parent)
    await expect(held.application.execute(foreign.value)).resolves.toBe(1)
    expect(foreign.stderr).toEqual(['signing key is not trusted by this runner home\n'])
  })
})

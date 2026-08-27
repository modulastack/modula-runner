import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createAllowlistSigningKeyFile,
  createFileRunnerHome,
  createRunnerApplication,
  readAllowlistSigningKeyFile,
  signAllowlist,
  type RunnerApplicationOptions,
  type RunnerHome,
} from '../src/index.js'
import { runAllowlistInit } from '../src/runnerAllowlistCommands.js'

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
      containmentStatus: () => ({ disposition: 'detect-and-stop', prevention: false, detail: 'test containment' }),
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
    const retry = invocation(['allowlist', 'init', '--key', keyPath], held.parent)
    await expect(held.application.execute(retry.value)).resolves.toBe(0)
    expect(retry.stdout.join('')).toContain('already initialized')

    const verify = invocation(['allowlist', 'verify'], held.parent)
    await expect(held.application.execute(verify.value)).resolves.toBe(0)
    expect(verify.stdout.join('')).toContain('allowlist verified with key')

    const documentPath = path.join(held.operatorRoot, 'allowlist.json')
    await writeFile(documentPath, JSON.stringify({ executables: ['git', 'tmux'], recipes: {} }), { mode: 0o600 })
    const sign = invocation(['allowlist', 'sign', '--key', keyPath, '--input', documentPath], held.parent)
    await expect(held.application.execute(sign.value)).resolves.toBe(0)
    expect(sign.stdout.join('')).toContain('allowlist signed with key')
    expect(`${sign.stdout.join('')} ${sign.stderr.join('')}`).not.toContain(await readFile(keyPath, 'utf8'))
    const changedPolicyRetry = invocation(['allowlist', 'init', '--key', keyPath], held.parent)
    await expect(held.application.execute(changedPolicyRetry.value)).resolves.toBe(1)
    expect(changedPolicyRetry.stderr).toEqual(['allowlist policy already exists\n'])

    const secondKey = path.join(held.operatorRoot, 'second.pem')
    const repeated = invocation(['allowlist', 'init', '--key', secondKey], held.parent)
    await expect(held.application.execute(repeated.value)).resolves.toBe(1)
    await expect(lstat(secondKey)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('accepts a same-key retry after legacy allowlist migration', async () => {
    const held = await fixture()
    const keyPath = path.join(held.operatorRoot, 'migrated.pem')
    const key = await createAllowlistSigningKeyFile(keyPath)
    const migrated = {
      revision: 1,
      allowlist: signAllowlist({ executables: ['git'], recipes: {} }, key.signingKey),
      trustAnchors: [key.trustAnchor],
    }
    const home: RunnerHome = {
      validateSigningKeyPath: async () => null,
      open: async () => ({ status: 'ready', home: { policyStore: { snapshot: async () => migrated } } as never }),
      initializePolicy: async () => ({ status: 'exists' }),
    }
    await expect(runAllowlistInit(home, {}, held.parent, ['init', '--key', keyPath]))
      .resolves.toMatchObject({ exitCode: 0, stdout: expect.stringContaining('already initialized') })
    const foreignKeyPath = path.join(held.operatorRoot, 'foreign.pem')
    await createAllowlistSigningKeyFile(foreignKeyPath)
    await expect(runAllowlistInit(home, {}, held.parent, ['init', '--key', foreignKeyPath]))
      .resolves.toEqual({ exitCode: 1, stderr: 'allowlist policy already exists' })

    migrated.revision = 2
    await expect(runAllowlistInit(home, {}, held.parent, ['init', '--key', keyPath]))
      .resolves.toEqual({ exitCode: 1, stderr: 'allowlist policy already exists' })
  })

  it('closes a ready home when idempotent bootstrap inspection fails', async () => {
    const held = await fixture()
    let closed = false
    const home: RunnerHome = {
      validateSigningKeyPath: async () => null,
      open: async () => ({
        status: 'ready',
        home: { policyStore: { snapshot: async () => { throw new Error('read failed') } } } as never,
      }),
      initializePolicy: async () => ({ status: 'exists' }),
      close: async () => { closed = true },
    }
    await expect(runAllowlistInit(home, {}, held.parent, ['init', '--key', path.join(held.operatorRoot, 'key.pem')]))
      .resolves.toMatchObject({ exitCode: 1, stderr: expect.stringContaining('state-io-failed') })
    expect(closed).toBe(true)
  })

  it('does not create a new key while legacy trust migration is required', async () => {
    const held = await fixture()
    const keyPath = path.join(held.operatorRoot, 'missing.pem')
    const home: RunnerHome = {
      validateSigningKeyPath: async () => null,
      open: async () => ({ status: 'failed', code: 'policy-trust-migration-required' }),
      initializePolicy: async () => { throw new Error('must not initialize') },
    }
    await expect(runAllowlistInit(home, {}, held.parent, ['init', '--key', keyPath])).resolves.toMatchObject({ exitCode: 1 })
    await expect(lstat(keyPath)).rejects.toMatchObject({ code: 'ENOENT' })
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

  it('adds, adopts, and removes a signing key through atomic trust rotation', async () => {
    const held = await fixture()
    const oldPath = path.join(held.operatorRoot, 'old.pem')
    const init = invocation(['allowlist', 'init', '--key', oldPath], held.parent)
    await expect(held.application.execute(init.value)).resolves.toBe(0)
    const old = await readAllowlistSigningKeyFile(oldPath)
    const nextPath = path.join(held.operatorRoot, 'next.pem')
    const next = await createAllowlistSigningKeyFile(nextPath)
    const anchorsPath = path.join(held.operatorRoot, 'anchors.json')
    await writeFile(anchorsPath, JSON.stringify([old.trustAnchor, next.trustAnchor]), { mode: 0o600 })

    const add = invocation(['allowlist', 'trust', 'rotate', '--authorizing-key', oldPath, '--anchors', anchorsPath], held.parent)
    await expect(held.application.execute(add.value)).resolves.toBe(0)

    const documentPath = path.join(held.operatorRoot, 'allowlist.json')
    await writeFile(documentPath, JSON.stringify({ executables: ['git'], recipes: {} }), { mode: 0o600 })
    const adopt = invocation(['allowlist', 'sign', '--key', nextPath, '--input', documentPath], held.parent)
    await expect(held.application.execute(adopt.value)).resolves.toBe(0)

    await writeFile(anchorsPath, JSON.stringify([next.trustAnchor]), { mode: 0o600 })
    const remove = invocation(['allowlist', 'trust', 'rotate', '--authorizing-key', nextPath, '--anchors', anchorsPath], held.parent)
    await expect(held.application.execute(remove.value)).resolves.toBe(0)
    const verify = invocation(['allowlist', 'verify'], held.parent)
    await expect(held.application.execute(verify.value)).resolves.toBe(0)
    expect(verify.stdout.join('')).toContain(next.signingKey.keyId)
  })

  it('rejects bootstrap and rotation key paths inside runner state', async () => {
    const held = await fixture()
    const inside = path.join(held.homeRoot, 'operator.pem')
    const call = invocation(['allowlist', 'init', '--key', inside], held.parent)
    await expect(held.application.execute(call.value)).resolves.toBe(1)
    await expect(lstat(inside)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(call.stderr.join('')).toContain('state-insecure-mode')

    const trustedPath = path.join(held.operatorRoot, 'trusted.pem')
    await held.application.execute(invocation(['allowlist', 'init', '--key', trustedPath], held.parent).value)
    await writeFile(inside, await readFile(trustedPath), { mode: 0o600 })
    const trusted = await readAllowlistSigningKeyFile(trustedPath)
    const anchorsPath = path.join(held.operatorRoot, 'anchors.json')
    await writeFile(anchorsPath, JSON.stringify([trusted.trustAnchor]), { mode: 0o600 })
    const rotate = invocation(['allowlist', 'trust', 'rotate', '--authorizing-key', inside, '--anchors', anchorsPath], held.parent)
    await expect(held.application.execute(rotate.value)).resolves.toBe(1)
    expect(rotate.stderr.join('')).toContain('state-insecure-mode')
  })

  it('recovers the one provable temporary hard link from interrupted key publication', async () => {
    const held = await fixture()
    const keyPath = path.join(held.operatorRoot, 'allowlist.pem')
    const generated = await createAllowlistSigningKeyFile(keyPath)
    const temporary = `${keyPath}.tmp-999-${generated.signingKey.keyId.slice(0, 16)}`
    await link(keyPath, temporary)
    await expect(readAllowlistSigningKeyFile(keyPath)).resolves.toMatchObject({
      signingKey: { keyId: generated.signingKey.keyId },
    })
    expect((await lstat(keyPath)).nlink).toBe(1)
    await expect(lstat(temporary)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an allowlist document writable by group or other users', async () => {
    const held = await fixture()
    const keyPath = path.join(held.operatorRoot, 'allowlist.pem')
    await expect(held.application.execute(invocation(['allowlist', 'init', '--key', keyPath], held.parent).value)).resolves.toBe(0)
    const documentPath = path.join(held.operatorRoot, 'allowlist.json')
    await writeFile(documentPath, JSON.stringify({ executables: ['git'], recipes: {} }), { mode: 0o600 })
    await chmod(documentPath, 0o666)
    const sign = invocation(['allowlist', 'sign', '--key', keyPath, '--input', documentPath], held.parent)
    await expect(held.application.execute(sign.value)).resolves.toBe(1)
    expect(sign.stderr).toEqual(['allowlist was not signed\n'])
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

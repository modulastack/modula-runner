import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createRunnerApplication,
  type ContractPairingRecord,
  type LocalProjectRecord,
  type PairingContractService,
  type RunnerApplicationOptions,
  type RunnerHome,
  type RunnerHomeState,
  type RunnerRuntimePort,
} from '../src/index.js'

const roots: string[] = []
const token = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
const pairedRecord: ContractPairingRecord = {
  bindingId: '123e4567-e89b-42d3-a456-426614174000',
  runnerId: 'runner-01',
  token,
  confirmationNonce: 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8',
  confirmationExpiresAt: '2026-08-21T00:10:00Z',
  controlPlaneOrigin: 'https://example.test',
  pendingSince: '2026-08-21T00:00:00Z',
  pairedAt: '2026-08-21T00:01:00Z',
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function pairing(overrides: Partial<PairingContractService> = {}): PairingContractService {
  return {
    pair: async () => ({ bindingId: pairedRecord.bindingId, runnerId: pairedRecord.runnerId }),
    resumeConfirmation: async () => null,
    snapshot: async () => ({ state: 'unpaired', record: null }),
    current: async () => null,
    revoke: async () => undefined,
    ...overrides,
  }
}

function projectRegistry() {
  let records: LocalProjectRecord[] = []
  return {
    create: async (project: Omit<LocalProjectRecord, 'revision'>) => {
      const record = { ...project, revision: 1 }
      records.push(record)
      return record
    },
    list: async () => records.map(record => ({ ...record })),
    get: async (projectId: string) => records.find(record => record.projectId === projectId) ?? null,
    remove: async (projectId: string, revision?: number) => {
      const found = records.find(record => record.projectId === projectId)
      if (!found) return 'missing' as const
      if (revision !== undefined && revision !== found.revision) return 'conflict' as const
      records = records.filter(record => record !== found)
      return 'removed' as const
    },
  }
}

function application(pairingService = pairing(), projects = projectRegistry()) {
  const state = { projects } as unknown as RunnerHomeState
  const open = vi.fn<RunnerHome['open']>(async () => ({ status: 'ready', home: state }))
  const close = vi.fn<NonNullable<RunnerHome['close']>>(async () => undefined)
  const home: RunnerHome = { open, close }
  const runtime: RunnerRuntimePort = { start: async () => { throw new Error('runtime must not start') } }
  const options: RunnerApplicationOptions = {
    version: '0.1.0',
    clock: { now: () => 0, sleep: async () => undefined },
    home,
    composition: {
      pairing: () => pairingService,
      sessions: () => ({ async *handle() {}, async *recover() {} }),
      jobControl: () => ({ async *dispatch() {}, async *recover() {} }),
      runtime,
    },
  }
  return { value: createRunnerApplication(options), open, close }
}

function invocation(args: string[], options: { tty?: boolean; hidden?: string; cwd?: string; runnerHome?: string } = {}) {
  const stdout: string[] = []
  const stderr: string[] = []
  const readHidden = vi.fn(async () => options.hidden ?? '')
  return {
    value: {
      args,
      cwd: options.cwd ?? '/tmp',
      environment: { ...(options.runnerHome ? { runnerHome: options.runnerHome } : {}) },
      io: {
        inputIsTTY: options.tty ?? false,
        readHidden,
        writeStdout: (text: string) => stdout.push(text),
        writeStderr: (text: string) => stderr.push(text),
      },
    },
    stdout,
    stderr,
    readHidden,
  }
}

describe('core runner application commands', () => {
  it('answers help and version without opening mutable state', async () => {
    const app = application()
    const help = invocation(['--help'])
    const version = invocation(['--version'])
    await expect(app.value.execute(help.value)).resolves.toBe(0)
    await expect(app.value.execute(version.value)).resolves.toBe(0)
    expect(help.stdout.join('')).toContain('modula-runner')
    expect(version.stdout).toEqual(['0.1.0\n'])
    expect(app.open).not.toHaveBeenCalled()
  })

  it('accepts pairing codes only through a hidden interactive read', async () => {
    const pair = vi.fn(async () => ({ bindingId: pairedRecord.bindingId, runnerId: pairedRecord.runnerId }))
    const app = application(pairing({ pair }))
    const call = invocation(['pair', '--control-plane', 'https://example.test'], { tty: true, hidden: 'secret-code' })
    await expect(app.value.execute(call.value)).resolves.toBe(0)
    expect(call.readHidden).toHaveBeenCalledOnce()
    expect(pair).toHaveBeenCalledWith('https://example.test', expect.objectContaining({ code: 'secret-code' }))
    expect(`${call.stdout.join('')} ${call.stderr.join('')}`).not.toContain('secret-code')
    expect(app.close).toHaveBeenCalledOnce()

    const positional = invocation(['pair', '--control-plane', 'https://example.test', 'secret-code'], { tty: true })
    await expect(app.value.execute(positional.value)).resolves.toBe(2)
    expect(positional.readHidden).not.toHaveBeenCalled()
  })

  it('reports status without exposing the binding token', async () => {
    const app = application(pairing({ snapshot: async () => ({ state: 'paired', record: pairedRecord }) }))
    const call = invocation(['status', '--json'])
    await expect(app.value.execute(call.value)).resolves.toBe(0)
    const status = JSON.parse(call.stdout.join('')) as Record<string, unknown>
    expect(status).toEqual({ state: 'paired', runnerId: 'runner-01', controlPlaneOrigin: 'https://example.test' })
    expect(call.stdout.join('')).not.toContain(token)
  })

  it('keeps runtime status failures in the JSON error vocabulary', async () => {
    const app = application(pairing({ snapshot: async () => { throw new Error('sealed record failed') } }))
    const call = invocation(['status', '--json'])
    await expect(app.value.execute(call.value)).resolves.toBe(1)
    expect(JSON.parse(call.stdout.join(''))).toEqual({ error: { code: 'state-io-failed' } })
    expect(call.stderr).toEqual([])
  })

  it('creates, lists, and removes only owned real project directories', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'runner-application-project-'))
    roots.push(root)
    const repo = path.join(root, 'repo')
    const worktrees = path.join(root, 'worktrees')
    await mkdir(repo)
    await mkdir(worktrees)
    const projects = projectRegistry()
    const app = application(pairing(), projects)
    const create = invocation(['project', 'create', 'modulastack', '--repo', repo, '--worktrees-root', worktrees], { cwd: root })
    await expect(app.value.execute(create.value)).resolves.toBe(0)
    expect(create.stdout.join('')).toContain(`modulastack\t${repo}\t${worktrees}\t1`)

    const list = invocation(['project', 'list'])
    await expect(app.value.execute(list.value)).resolves.toBe(0)
    expect(list.stdout).toEqual(create.stdout)

    const remove = invocation(['project', 'remove', 'modulastack', '--revision', '1'])
    await expect(app.value.execute(remove.value)).resolves.toBe(0)
    await expect(projects.list()).resolves.toEqual([])
  })

  it('rejects a symlinked project path before registry mutation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'runner-application-project-link-'))
    roots.push(root)
    const repo = path.join(root, 'repo')
    const alias = path.join(root, 'alias')
    const worktrees = path.join(root, 'worktrees')
    await mkdir(repo)
    await mkdir(worktrees)
    await symlink(repo, alias)
    const projects = projectRegistry()
    const create = vi.spyOn(projects, 'create')
    const app = application(pairing(), projects)
    const call = invocation(['project', 'create', 'modulastack', '--repo', alias, '--worktrees-root', worktrees], { cwd: root })
    await expect(app.value.execute(call.value)).resolves.toBe(1)
    expect(create).not.toHaveBeenCalled()
  })

  it('uses stable home failure codes and closes state before emitting success', async () => {
    const app = application()
    app.open.mockResolvedValueOnce({ status: 'failed', code: 'policy-missing' })
    const failed = invocation(['status'])
    await expect(app.value.execute(failed.value)).resolves.toBe(1)
    expect(failed.stderr).toEqual(['policy-missing: runner home preflight failed\n'])

    app.open.mockResolvedValueOnce({ status: 'failed', code: 'policy-missing' })
    const failedJson = invocation(['status', '--json'])
    await expect(app.value.execute(failedJson.value)).resolves.toBe(1)
    expect(JSON.parse(failedJson.stdout.join(''))).toEqual({ error: { code: 'policy-missing' } })
    expect(failedJson.stderr).toEqual([])

    app.close.mockRejectedValueOnce(new Error('close failed'))
    const closeFailure = invocation(['status'])
    await expect(app.value.execute(closeFailure.value)).resolves.toBe(1)
    expect(closeFailure.stdout).toEqual([])
    expect(closeFailure.stderr).toEqual(['state-io-failed: the runner home could not close cleanly\n'])
  })
})

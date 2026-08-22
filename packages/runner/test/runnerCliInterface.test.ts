import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  RUNNER_HOME_FAILURES,
  RUNNER_PROJECT_COMMANDS,
  RUNNER_TOP_LEVEL_COMMANDS,
  RunnerApplicationNotImplementedError,
  SessionLaunchNotImplementedError,
  SessionReceiptStorageUnavailableError,
  createPairingContractService,
  createRunnerApplication,
  createRunnerHome,
  createRunnerRuntime,
  createSessionJobControl,
  createSessionLauncher,
  createSessionReceiptLedger,
  type PairingContractServiceOptions,
  type RunnerApplicationOptions,
  type RunnerClock,
  type RunnerHomeOptions,
  type SessionLauncherOptions,
  type SessionReceiptLedgerOptions,
} from '../src/index.js'

const clock: RunnerClock = {
  now: () => Date.parse('2026-08-21T00:00:00Z'),
  sleep: async () => undefined,
}

const pairingOptions = {
  clock,
  transport: {
    exchange: async request => ({ status: 200, mediaType: 'application/json', body: request.body }),
  },
  store: {
    reserve: async () => ({ status: 'reserved', reservationId: 'reservation-1' }),
    release: async () => undefined,
    commitPending: async () => 'updated',
    snapshot: async () => ({ state: 'unpaired', record: null }),
    markConfirmationUnknown: async () => 'updated',
    settle: async () => 'updated',
    revoke: async () => 'updated',
  },
} satisfies PairingContractServiceOptions

const receiptOptions = {
  clock,
  storage: {
    load: async () => ({ status: 'storage-unavailable' }),
    replace: async () => ({ status: 'storage-unavailable' }),
  },
} satisfies SessionReceiptLedgerOptions

const homeOptions = {
  clock,
  storage: {
    inspect: async () => ({
      rootKind: 'missing',
      rootOwner: 'current-user',
      rootMode: 0o700,
      entries: [],
    }),
    read: async () => ({ status: 'missing' }),
    replace: async () => ({ status: 'storage-unavailable' }),
    append: async () => 'storage-unavailable',
  },
} satisfies RunnerHomeOptions

const sessionOptions = {
  bindingId: () => '123e4567-e89b-42d3-a456-426614174000',
  projects: {
    create: async project => ({ ...project, revision: 1 }),
    list: async () => [],
    get: async () => null,
    remove: async () => 'missing',
  },
  receipts: {
    lookup: async () => ({ status: 'missing' }),
    claim: async () => ({ status: 'storage-unavailable' }),
    replace: async () => ({ status: 'storage-unavailable' }),
    recover: async () => [],
    compact: async () => undefined,
  },
  access: {
    resolve: async () => ({ status: 'refused', reason: 'unknown-profile' }),
  },
  worktrees: {
    prepare: async () => ({ status: 'failed', reason: 'worktree-invalid' }),
    register: async () => ({ status: 'failed', reason: 'provision-failed' }),
    verify: async () => ({ status: 'failed', reason: 'worktree-invalid' }),
    inspect: async () => 'mismatch',
    rollback: async () => 'uncertain',
  },
  channels: {
    open: async () => ({ status: 'failed', reason: 'channel-unavailable' }),
    close: async () => undefined,
  },
  processes: {
    start: async () => ({ status: 'failed', reason: 'spawn-failed' }),
    adopt: async () => ({ status: 'failed', reason: 'spawn-failed' }),
    inspect: async () => 'missing',
    terminate: async () => 'missing',
  },
  identifiers: { nextSessionId: () => 'session-1' },
  audit: { append: async () => undefined },
  clock,
} satisfies SessionLauncherOptions

async function next<T>(values: AsyncIterable<T>) {
  return await values[Symbol.asyncIterator]().next()
}

describe('G2 runner CLI composition interface', () => {
  it('publishes the installed command path and closed environment surface', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8')) as Record<string, unknown>
    expect(manifest.bin).toEqual({ 'modula-runner': 'packages/runner/dist/bin/modula-runner.js' })
    expect((await readFile('packages/runner/src/bin/modula-runner.ts', 'utf8')).startsWith('#!/usr/bin/env node\n')).toBe(true)
    expect(RUNNER_TOP_LEVEL_COMMANDS).toEqual([
      'help', 'version', 'pair', 'status', 'run', 'key', 'project', 'profile', 'endpoint', 'grant', 'allowlist',
    ])
    expect(RUNNER_PROJECT_COMMANDS).toEqual(['create', 'list', 'remove'])
  })

  it('runs pairing through injected transport, store, and clock boundaries', async () => {
    const service = createPairingContractService(pairingOptions)
    await expect(service.snapshot()).resolves.toEqual({ state: 'unpaired', record: null })
  })

  it('exposes launch and negotiated job-control ports without activating protocol v2', async () => {
    const launcher = createSessionLauncher(sessionOptions)
    await expect(next(launcher.recover())).rejects.toBeInstanceOf(SessionLaunchNotImplementedError)
    const jobControl = createSessionJobControl({ launcher, audit: { append: async () => undefined }, clock })
    await expect(next(jobControl.dispatch({
      context: {
        connectionId: 'connection-1',
        channelId: 'job-control-1',
        phase: 'active',
        selectedProtocolVersion: 1,
        authenticatedBindingId: null,
      },
      payload: { codec: 'json', body: { type: 'SESSION_START' } },
    }))).resolves.toMatchObject({ value: { kind: 'close-job-control', error: 'unsupported-session-launch' } })
  })

  it('runs the production receipt subject behind deterministic storage boundaries', async () => {
    const receipts = createSessionReceiptLedger(receiptOptions)
    await expect(receipts.recover()).rejects.toBeInstanceOf(SessionReceiptStorageUnavailableError)
    const home = createRunnerHome(homeOptions)
    await expect(home.open({})).resolves.toEqual({ status: 'failed', code: 'state-not-regular' })
  })

  it('exposes one home-backed application root with stable startup failures', async () => {
    expect(RUNNER_HOME_FAILURES).toContain('state-insecure-mode')
    expect(RUNNER_HOME_FAILURES).toContain('audit-unavailable')
    const pairing = createPairingContractService(pairingOptions)
    const sessions = createSessionLauncher(sessionOptions)
    const options = {
      version: '0.1.0',
      clock,
      home: { open: async () => ({ status: 'failed', code: 'policy-missing' }) },
      composition: {
        pairing: () => pairing,
        sessions: () => sessions,
        jobControl: launcher => createSessionJobControl({ launcher }),
        runtime: createRunnerRuntime({ clock }),
      },
    } satisfies RunnerApplicationOptions
    expect(options.composition.runtime.start).toBeTypeOf('function')
    const application = createRunnerApplication(options)
    await expect(application.execute({
      args: ['status'],
      cwd: '/tmp',
      environment: {},
      io: {
        inputIsTTY: false,
        readHidden: async () => '',
        writeStdout: () => undefined,
        writeStderr: () => undefined,
      },
    })).rejects.toBeInstanceOf(RunnerApplicationNotImplementedError)
  })
})

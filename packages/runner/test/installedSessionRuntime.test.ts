import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStartMessage } from '@modulastack/runner-protocol'
import type {
  CommandPolicy,
  RunnerClient,
  RunnerHomeState,
  SessionLaunchAction,
} from '../src/index.js'
import { createInstalledSessionRuntime } from '../src/installedSessionRuntime.js'

const roots: string[] = []
const originalPath = process.env.PATH
// Sleep never resolves, so a launch deadline never fires and the assertions are about the
// probe pass rather than about a race with the launcher's own timeouts.
const clock = { now: () => Date.parse('2026-08-21T00:00:00Z'), sleep: () => new Promise<void>(() => undefined) }
const project = { projectId: 'modulastack', repoPath: '/repos/modulastack', worktreesRoot: '/worktrees', revision: 1 }

afterEach(async () => {
  process.env.PATH = originalPath
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function launchRequest(requestId: string): SessionStartMessage {
  return {
    type: 'SESSION_START',
    bindingId: '123e4567-e89b-42d3-a456-426614174000',
    requestId,
    expiresAt: '2026-08-21T00:10:00Z',
    terminalProfile: 'coder',
    modelProfileId: 'daily',
    target: { projectId: 'modulastack', worktreeName: 'lane-01', branch: 'feat/lane-01', baseBranch: 'main', relativeCwd: '.' },
  }
}

// A runtime that answers every question with success, so a launch turns on the snapshot the
// monitor holds rather than on what happens to be installed where the suite runs.
async function catalogRuntimeOnPath() {
  const root = await mkdtemp(path.join(tmpdir(), 'runner-capability-probe-'))
  roots.push(root)
  const executable = path.join(root, 'claude')
  await writeFile(executable, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 9.9.9; fi\nexit 0\n')
  await chmod(executable, 0o755)
  process.env.PATH = `${root}${path.delimiter}${originalPath ?? ''}`
}

function installedRuntime() {
  const probed: string[] = []
  const policy: CommandPolicy = {
    allowsExecutable: name => {
      probed.push(name)
      return name === 'claude'
    },
    recipe: () => null,
    executables: ['claude'],
    keyId: 'test-allowlist',
  }
  const home = {
    policy,
    audit: { append: async () => undefined },
    grants: { resolveGrantedCwd: async () => null, isGrantedRealPath: async () => false, list: async () => [] },
    keys: { injectAsForProvider: async () => ({ status: 'missing' as const }) },
    projects: { get: async () => project, list: async () => [project] },
    configuration: {
      snapshot: async () => ({
        revision: 1,
        profiles: [{ modelProfileId: 'daily', access: 'subscription' as const, runtime: 'claude' }],
        endpoints: [],
      }),
    },
    receipts: {
      lookup: async () => ({ status: 'missing' as const }),
      // Admission is blocked so a launch stops the moment access resolution has answered:
      // this suite is about how often the catalog is probed, not about provisioning.
      claim: async () => ({ status: 'at-capacity' as const, blockedUntil: '2026-08-21T01:00:00Z' }),
    },
  } as unknown as RunnerHomeState
  const runtime = createInstalledSessionRuntime(home, clock)
  const client = { on: () => undefined, off: () => undefined } as unknown as RunnerClient
  runtime.bind(client, '123e4567-e89b-42d3-a456-426614174000')
  return { runtime, catalogProbes: () => probed.filter(name => name === 'claude' || name === 'codex') }
}

async function collect(actions: AsyncIterable<SessionLaunchAction>) {
  const collected: SessionLaunchAction[] = []
  for await (const action of actions) collected.push(action)
  return collected
}

describe('installed session runtime', () => {
  it('probes the runtime catalog once across launches', async () => {
    await catalogRuntimeOnPath()
    const installed = installedRuntime()
    try {
      await collect(installed.runtime.launcher.handle(launchRequest('223e4567-e89b-42d3-a456-426614174001')))
      const afterFirst = installed.catalogProbes()
      await collect(installed.runtime.launcher.handle(launchRequest('223e4567-e89b-42d3-a456-426614174002')))

      expect(afterFirst.filter(name => name === 'claude')).toHaveLength(2)
      expect(afterFirst.filter(name => name === 'codex')).toHaveLength(1)
      expect(installed.catalogProbes()).toEqual(afterFirst)
    } finally {
      await installed.runtime.shutdown()
    }
  })

  it('resolves the first launch against a warmed capability snapshot', async () => {
    await catalogRuntimeOnPath()
    const installed = installedRuntime()
    try {
      const actions = await collect(installed.runtime.launcher.handle(launchRequest('223e4567-e89b-42d3-a456-426614174003')))

      expect(actions).toEqual([{
        kind: 'message',
        message: { type: 'SESSION_REFUSED', requestId: '223e4567-e89b-42d3-a456-426614174003', reason: 'at-capacity' },
      }])
    } finally {
      await installed.runtime.shutdown()
    }
  })
})

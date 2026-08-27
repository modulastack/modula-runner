import { describe, expect, it } from 'vitest'
import {
  endpointCommandSyntax,
  profileCommandSyntax,
  runEndpointCommand,
  runProfileCommand,
} from '../src/runnerConfigurationCommands.js'
import type {
  RunnerConfigurationReplace,
  RunnerConfigurationStore,
  RunnerLocalConfiguration,
} from '../src/index.js'

function configurationStore(initial: RunnerLocalConfiguration = { revision: 1, profiles: [], endpoints: [] }) {
  let configuration = structuredClone(initial)
  const store: RunnerConfigurationStore = {
    snapshot: async () => structuredClone(configuration),
    replace: async (expectedRevision, candidate): Promise<RunnerConfigurationReplace> => {
      if (expectedRevision !== configuration.revision) return { status: 'conflict', current: structuredClone(configuration) }
      configuration = { ...structuredClone(candidate), revision: expectedRevision + 1 }
      return { status: 'updated', configuration: structuredClone(configuration) }
    },
  }
  return { store, value: () => structuredClone(configuration) }
}

describe('profile and endpoint configuration commands', () => {
  it('adds, lists, and removes complete subscription and API-key profiles with redacted output', async () => {
    const held = configurationStore()
    await expect(runProfileCommand([
      'add', 'daily', '--runtime', 'claude', '--access', 'subscription', '--model', 'sonnet',
    ], held.store)).resolves.toMatchObject({ exitCode: 0, stdout: 'daily\tclaude\tsubscription\tsonnet\tsubscription' })
    await expect(runProfileCommand([
      'add', 'metered', '--runtime', 'claude', '--access', 'api-key', '--provider', 'anthropic', '--key', 'private-label',
    ], held.store)).resolves.toMatchObject({ exitCode: 0 })
    const listed = await runProfileCommand(['list'], held.store)
    expect(listed.stdout).toContain('metered\tclaude\tapi-key\t-\tkey=configured')
    expect(listed.stdout).not.toContain('private-label')
    expect(held.value().profiles).toHaveLength(2)
    await expect(runProfileCommand(['remove', 'daily'], held.store)).resolves.toEqual({ exitCode: 0, stdout: 'removed daily' })
  })

  it('requires access-specific profile fields and rejects remote command-shaped flags', () => {
    expect(profileCommandSyntax(['add', 'local', '--runtime', 'codex', '--access', 'local', '--endpoint', 'ollama'])).toContain('usage:')
    expect(profileCommandSyntax(['add', 'keyed', '--runtime', 'claude', '--access', 'api-key', '--key', 'daily'])).toContain('usage:')
    expect(profileCommandSyntax([
      'add', 'unsafe', '--runtime', 'claude', '--access', 'subscription', '--command', '/bin/sh',
    ])).toContain('usage:')
  })

  it('adds endpoints from environment-only URLs and never lists their address', async () => {
    const held = configurationStore()
    expect(endpointCommandSyntax(['add', 'lab', '--kind', 'openai-compatible'], undefined)).toContain('MODULA_RUNNER_ENDPOINT_URL')
    expect(endpointCommandSyntax(['add', 'lab', '--kind', 'openai-compatible'], 'https://user:secret@example.test')).toContain('valid http or https')
    for (const baseUrl of ['https://example.test?', 'https://example.test#', 'https://example.test/path?#']) {
      expect(endpointCommandSyntax(['add', 'lab', '--kind', 'openai-compatible'], baseUrl)).toContain('valid http or https')
    }
    await expect(runEndpointCommand(
      ['add', 'lab', '--kind', 'openai-compatible'],
      'http://127.0.0.1:8000',
      held.store,
    )).resolves.toEqual({ exitCode: 0, stdout: 'lab\topenai-compatible' })
    const listed = await runEndpointCommand(['list'], undefined, held.store)
    expect(listed).toEqual({ exitCode: 0, stdout: 'lab\topenai-compatible' })
    expect(JSON.stringify(listed)).not.toContain('127.0.0.1')
    expect(held.value().endpoints[0]).toMatchObject({ endpointId: 'lab', baseUrl: 'http://127.0.0.1:8000' })
    await expect(runEndpointCommand(['remove', 'lab'], undefined, held.store)).resolves.toEqual({ exitCode: 0, stdout: 'removed lab' })
  })

  it('retries a storage compare-and-set conflict against the new complete configuration', async () => {
    const held = configurationStore()
    let conflict = true
    const store: RunnerConfigurationStore = {
      snapshot: held.store.snapshot,
      replace: async (revision, candidate) => {
        if (conflict) {
          conflict = false
          return { status: 'conflict', current: await held.store.snapshot() }
        }
        return await held.store.replace(revision, candidate)
      },
    }
    await expect(runProfileCommand([
      'add', 'daily', '--runtime', 'claude', '--access', 'subscription',
    ], store)).resolves.toMatchObject({ exitCode: 0 })
    expect(held.value().revision).toBe(2)
  })
})

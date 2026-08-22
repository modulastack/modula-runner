import {
  hasControlCharacter,
  isAccessMode,
  isLocalEndpointKind,
  isSafeIdentifier,
  type AccessMode,
  type LocalEndpointKind,
} from '@modulastack/runner-protocol'
import type { LocalModelProfile } from './accessProfiles.js'
import { assertProviderName } from './apiKeys.js'
import type { LocalEndpointConfig } from './localEndpoints.js'
import type { RunnerConfigurationStore, RunnerLocalConfiguration } from './runnerHome.js'

export type LocalConfigurationCommandOutcome = {
  exitCode: 0 | 1 | 2
  stdout?: string
  stderr?: string
}

export function profileCommandSyntax(args: readonly string[]): string | null {
  if (args[0] === 'list' && args.length === 1) return null
  if (args[0] === 'remove' && args.length === 2 && isSafeIdentifier(args[1])) return null
  if (args[0] === 'add' && parseProfile(args.slice(1))) return null
  return 'usage: modula-runner profile add <id> --runtime <id> --access <mode> [--model <name>] [--provider <name> --key <label>|--endpoint <id>] | list | remove <id>'
}

export function endpointCommandSyntax(args: readonly string[], endpointUrl: string | undefined): string | null {
  if (args[0] === 'list' && args.length === 1) return null
  if (args[0] === 'remove' && args.length === 2 && isSafeIdentifier(args[1])) return null
  if (args[0] === 'add' && args.length === 4 && isSafeIdentifier(args[1]) && args[2] === '--kind' && isLocalEndpointKind(args[3])) {
    return validEndpointUrl(endpointUrl) ? null : 'MODULA_RUNNER_ENDPOINT_URL must contain a valid http or https URL for endpoint add'
  }
  return 'usage: MODULA_RUNNER_ENDPOINT_URL=<url> modula-runner endpoint add <id> --kind <kind> | list | remove <id>'
}

export async function runProfileCommand(
  args: readonly string[],
  store: RunnerConfigurationStore,
): Promise<LocalConfigurationCommandOutcome> {
  if (args[0] === 'list') {
    const configuration = await store.snapshot()
    const profiles = [...configuration.profiles].sort((left, right) => left.modelProfileId.localeCompare(right.modelProfileId))
    return { exitCode: 0, stdout: profiles.length ? profiles.map(profileRow).join('\n') : 'no profiles configured' }
  }
  if (args[0] === 'remove') return await removeProfile(args[1]!, store)
  const profile = parseProfile(args.slice(1))
  if (!profile) return { exitCode: 2, stderr: profileCommandSyntax(args) ?? 'invalid profile command' }
  try {
    const updated = await updateConfiguration(store, current => {
      if (current.profiles.some(candidate => candidate.modelProfileId === profile.modelProfileId)) throw new Error('duplicate profile')
      return { ...current, profiles: [...current.profiles, profile] }
    })
    const created = updated.profiles.find(candidate => candidate.modelProfileId === profile.modelProfileId)!
    return { exitCode: 0, stdout: profileRow(created) }
  } catch {
    return { exitCode: 1, stderr: 'profile was not added' }
  }
}

export async function runEndpointCommand(
  args: readonly string[],
  endpointUrl: string | undefined,
  store: RunnerConfigurationStore,
): Promise<LocalConfigurationCommandOutcome> {
  if (args[0] === 'list') {
    const configuration = await store.snapshot()
    const endpoints = [...configuration.endpoints].sort((left, right) => left.endpointId.localeCompare(right.endpointId))
    return { exitCode: 0, stdout: endpoints.length ? endpoints.map(endpointRow).join('\n') : 'no endpoints configured' }
  }
  if (args[0] === 'remove') return await removeEndpoint(args[1]!, store)
  if (!validEndpointUrl(endpointUrl) || !isSafeIdentifier(args[1]) || !isLocalEndpointKind(args[3])) {
    return { exitCode: 2, stderr: endpointCommandSyntax(args, endpointUrl) ?? 'invalid endpoint command' }
  }
  const endpoint: LocalEndpointConfig = { endpointId: args[1], kind: args[3], baseUrl: endpointUrl }
  try {
    const updated = await updateConfiguration(store, current => {
      if (current.endpoints.some(candidate => candidate.endpointId === endpoint.endpointId)) throw new Error('duplicate endpoint')
      return { ...current, endpoints: [...current.endpoints, endpoint] }
    })
    const created = updated.endpoints.find(candidate => candidate.endpointId === endpoint.endpointId)!
    return { exitCode: 0, stdout: endpointRow(created) }
  } catch {
    return { exitCode: 1, stderr: 'endpoint was not added' }
  }
}

async function removeProfile(id: string, store: RunnerConfigurationStore): Promise<LocalConfigurationCommandOutcome> {
  try {
    await updateConfiguration(store, current => {
      if (!current.profiles.some(profile => profile.modelProfileId === id)) throw new Error('missing profile')
      return { ...current, profiles: current.profiles.filter(profile => profile.modelProfileId !== id) }
    })
    return { exitCode: 0, stdout: `removed ${id}` }
  } catch {
    return { exitCode: 1, stderr: 'profile was not removed' }
  }
}

async function removeEndpoint(id: string, store: RunnerConfigurationStore): Promise<LocalConfigurationCommandOutcome> {
  try {
    await updateConfiguration(store, current => {
      if (!current.endpoints.some(endpoint => endpoint.endpointId === id)) throw new Error('missing endpoint')
      return { ...current, endpoints: current.endpoints.filter(endpoint => endpoint.endpointId !== id) }
    })
    return { exitCode: 0, stdout: `removed ${id}` }
  } catch {
    return { exitCode: 1, stderr: 'endpoint was not removed' }
  }
}

async function updateConfiguration(
  store: RunnerConfigurationStore,
  change: (current: RunnerLocalConfiguration) => RunnerLocalConfiguration,
): Promise<RunnerLocalConfiguration> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await store.snapshot()
    const next = change(current)
    const result = await store.replace(current.revision, { profiles: next.profiles, endpoints: next.endpoints })
    if (result.status === 'updated') return result.configuration
    if (result.status === 'storage-unavailable') throw new Error('configuration unavailable')
  }
  throw new Error('configuration remained conflicted')
}

function parseProfile(args: readonly string[]): LocalModelProfile | null {
  const [modelProfileId, ...flagArgs] = args
  if (!isSafeIdentifier(modelProfileId) || flagArgs.length % 2 !== 0) return null
  const flags = parseFlags(flagArgs)
  if (!flags || !isSafeIdentifier(flags['--runtime']) || !isAccessMode(flags['--access'])) return null
  const access = flags['--access'] as AccessMode
  const model = flags['--model']
  if (model !== undefined && (model.length === 0 || model.length > 128 || hasControlCharacter(model))) return null
  const profile: LocalModelProfile = { modelProfileId, runtime: flags['--runtime'], access, ...(model ? { model } : {}) }
  if (access === 'subscription') return onlyFlags(flags, ['--runtime', '--access', '--model']) ? profile : null
  if (access === 'api-key') {
    if (!validProvider(flags['--provider']) || !isSafeIdentifier(flags['--key'])) return null
    return onlyFlags(flags, ['--runtime', '--access', '--model', '--provider', '--key'])
      ? { ...profile, provider: flags['--provider'], keyLabel: flags['--key'] }
      : null
  }
  if (!model || !isSafeIdentifier(flags['--endpoint'])) return null
  return onlyFlags(flags, ['--runtime', '--access', '--model', '--endpoint'])
    ? { ...profile, endpointId: flags['--endpoint'] }
    : null
}

function parseFlags(args: readonly string[]): Record<string, string> | null {
  const flags: Record<string, string> = Object.create(null)
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!flag?.startsWith('--') || !value || Object.hasOwn(flags, flag)) return null
    flags[flag] = value
  }
  return flags
}

function onlyFlags(flags: Record<string, string>, allowed: readonly string[]): boolean {
  return Object.keys(flags).every(flag => allowed.includes(flag))
}

function validProvider(value: string | undefined): value is string {
  if (!value) return false
  try {
    assertProviderName(value)
    return true
  } catch {
    return false
  }
}

function validEndpointUrl(value: string | undefined): value is string {
  if (!value || value.length > 2_048 || hasControlCharacter(value) || value.includes('?') || value.includes('#')) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !url.search && !url.hash
  } catch {
    return false
  }
}

function profileRow(profile: LocalModelProfile): string {
  const model = profile.model ?? '-'
  const binding = profile.access === 'api-key'
    ? 'key=configured'
    : profile.access === 'local' ? `endpoint=${profile.endpointId}` : 'subscription'
  return `${profile.modelProfileId}\t${profile.runtime}\t${profile.access}\t${model}\t${binding}`
}

function endpointRow(endpoint: Pick<LocalEndpointConfig, 'endpointId' | 'kind'>): string {
  return `${endpoint.endpointId}\t${endpoint.kind}`
}

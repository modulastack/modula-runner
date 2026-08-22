import {
  hasControlCharacter,
  isAccessMode,
  isSafeIdentifier,
  type AccessMode,
  type CliAuthState,
  type LocalEndpointKind,
  type RunnerCapabilities,
} from '@modulastack/runner-protocol'
import { assertProviderName, keyVariableFor, type ApiKeyStore } from './apiKeys.js'
import type { RuntimeSpec } from './capabilities.js'
import { probeLocalEndpoint, type LocalEndpointRegistry } from './localEndpoints.js'
import { SecretEnv } from './secretEnv.js'

// Turning a model profile the control plane named into a launch this machine can perform.
//
// This is the second place in the runner where caller-controlled input meets an ambient
// credential, and it gets the same treatment pairing got. The trust boundary, stated here
// rather than left to each call site:
//
// The control plane may NAME a model profile the operator created locally. It may not create
// one, may not name or choose a key, may not supply an endpoint address, and may not cause a
// key to be used by any command outside the runner's local catalog. A name this runner does
// not hold is refused by name — never resolved to a default, never resolved to "the only key
// we have", and never treated as a request to create one. Resolution reads local
// configuration and answers; it never writes.
//
// Nothing on the wire names a launch yet: the control plane cannot request a pane in
// version 1, so this boundary is enforced here, at the only place a launch is decided. The
// vocabulary below is defined now so the slice that adds a launch request inherits it
// instead of inventing a second one — the shape is settled, the wire form is not this
// checkpoint's to invent.
//
// A model profile is NOT the terminal `profile`. That one is a pane label — 'coder' — and
// stays what it was. This one names a model, its access mode, and what serves it. Two
// objects, two words, because sharing one would have them conflated within a month.
//
// Every refusal is a value, not an exception, for the same reason the preview host's are:
// a caller cannot accidentally drop a reason on the floor, and "fails fast with
// detect-and-guide" needs a reason to guide with.

export const ACCESS_REFUSALS = [
  'unknown-profile',
  'runtime-unknown',
  'runtime-unavailable',
  'runtime-unauthenticated',
  'access-unsupported',
  'unknown-key',
  'key-provider-mismatch',
  'unknown-endpoint',
  'endpoint-unavailable',
  'model-unavailable',
  'profile-incomplete',
] as const
export type AccessRefusal = (typeof ACCESS_REFUSALS)[number]

// The operator's local binding: what a profile name means on this machine. The control
// plane holds the metadata half of this (provider, model, access, label); the half that
// resolves to a credential or an address exists only here.
export type LocalModelProfile = {
  modelProfileId: string
  access: AccessMode
  runtime: string
  // Which vendor this profile talks to. **Required when `access` is `api-key`** — absent is
  // `profile-incomplete`, not "no mismatch is possible". Sending an Anthropic key to an
  // OpenAI endpoint is credential disclosure to a third party, and a check that switches
  // itself off when a field is missing is the permissive default this contract refuses
  // everywhere else. Optional on the type because `subscription` and `local` have no key to
  // mis-route; the resolver enforces the rest.
  //
  // It lives on the profile rather than on the runtime because a CLI can serve several
  // vendors — one provider per runtime is simply false — while a profile names exactly one.
  provider?: string
  // The model to run. Required for `local`, where it must be in the endpoint's inventory.
  model?: string
  // `api-key` access: which stored key, by label.
  keyLabel?: string
  // `local` access: which configured endpoint, by its operator-chosen local id.
  endpointId?: string
}

export function isCompleteLocalModelProfile(profile: LocalModelProfile): boolean {
  if (profile.access === 'subscription') {
    return profile.provider === undefined && profile.keyLabel === undefined && profile.endpointId === undefined
  }
  if (profile.access === 'api-key') {
    return profile.provider !== undefined && profile.keyLabel !== undefined && profile.endpointId === undefined
  }
  if (profile.access === 'local') {
    return profile.model !== undefined && profile.endpointId !== undefined
      && profile.provider === undefined && profile.keyLabel === undefined
  }
  return false
}

// What a launch needs, with the secret half kept in a value that does not serialize.
// `env` holds non-secret orchestration variables only. Anything the argv rule covers — the
// API key, and the endpoint URL, which is not secret but sits on the never-crosses list for
// the same reason arguments are readable by any local process — travels in `secrets`.
export type LaunchPlan = {
  modelProfileId: string
  access: AccessMode
  runtime: string
  command: string
  args: readonly string[]
  env: Readonly<Record<string, string>>
  secrets: SecretEnv
}

export type AccessResolution =
  | { status: 'resolved'; plan: LaunchPlan }
  | { status: 'refused'; reason: AccessRefusal }

export type AccessResolverOptions = {
  profiles: readonly LocalModelProfile[]
  // Injected, never resolved from PATH alone: a runtime whose command is not in this local
  // catalog is neither advertised nor launchable. This is the preview allowlist rule
  // extended to panes — the moment a control-plane-named profile selects a runtime, the
  // control plane is naming a command by proxy, and an approved binary plus a
  // caller-influenced argv is not an allowlist.
  runtimes: readonly RuntimeSpec[]
  keys: ApiKeyStore
  endpoints: LocalEndpointRegistry
  // The last probed snapshot. Null before the first probe completes, which is a refusal
  // rather than an optimistic launch.
  capabilities: () => RunnerCapabilities | null
}

// Which variable a local endpoint's address travels in, when the runtime does not name one.
// A table rather than a derivation, unlike the key variable: an endpoint kind is not a
// variable stem the way a provider name is, so there is nothing to derive from. It is keyed
// by the protocol's own enum, so a new kind fails to compile rather than falling through to
// no variable at all.
const ENDPOINT_VARIABLES: Record<LocalEndpointKind, string> = { ollama: 'OLLAMA_HOST', 'openai-compatible': 'OPENAI_BASE_URL' }
const DEFAULT_MODEL_FLAG = '--model'
const MAX_MODEL_LENGTH = 128

export class AccessResolver {
  private readonly profiles: Map<string, LocalModelProfile>
  private readonly runtimes: Map<string, RuntimeSpec>
  private readonly keys: ApiKeyStore
  private readonly endpoints: LocalEndpointRegistry
  private readonly capabilities: () => RunnerCapabilities | null

  constructor(options: AccessResolverOptions) {
    for (const profile of options.profiles) assertProfile(profile)
    // Built through a check rather than straight into a Map, because a Map lets the last
    // entry win in silence: a control plane naming a duplicated profile would resolve to a
    // binding the operator did not intend, and nothing would say which one it got. The two
    // other registries in this package — the endpoint registry and the capability monitor —
    // already refuse duplicates; this one was the odd one out.
    this.profiles = uniqueByKey(options.profiles, profile => profile.modelProfileId, 'model profile ids')
    this.runtimes = uniqueByKey(options.runtimes, spec => spec.runtime, 'runtime names')
    this.keys = options.keys
    this.endpoints = options.endpoints
    this.capabilities = options.capabilities
  }

  // Local configuration, for the CLI's own surfaces. Never includes a secret.
  list(): readonly LocalModelProfile[] {
    return [...this.profiles.values()].map(profile => ({ ...profile }))
  }

  // A `local` profile is resolved against a FRESH endpoint probe under its own deadline,
  // not against the last poll. That is what makes "fails fast, never a hung spawn" true by
  // construction instead of true when the cadence happens to have caught up — and it is the
  // only form that covers an endpoint which accepts the connection and then answers nothing,
  // where waiting on the OS default is a two-minute hang.
  async resolve(modelProfileId: string): Promise<AccessResolution> {
    const profile = this.profiles.get(modelProfileId)
    // Refused by name. Never resolved to a default, never to "the only one we have", and
    // never treated as a request to create one — resolution reads configuration and
    // answers; it never writes.
    if (!profile) return refused('unknown-profile')
    const runtime = this.runtimes.get(profile.runtime)
    if (!runtime) return refused('runtime-unknown')
    // The catalog is what a runtime can do; the snapshot is what this machine currently
    // reports. A mode the runtime never serves is refused before availability, because
    // installing it would not make the combination work.
    if (!runtime.access.includes(profile.access)) return refused('access-unsupported')
    const detected = this.capabilities()?.runtimes.find(entry => entry.runtime === profile.runtime)
    if (!detected) return refused('runtime-unavailable')
    const credential = await this.credentialFor(profile, runtime, detected.auth)
    if ('reason' in credential) return refused(credential.reason)
    return { status: 'resolved', plan: launchPlan(profile, runtime, credential.secrets) }
  }

  private async credentialFor(profile: LocalModelProfile, runtime: RuntimeSpec, auth: CliAuthState): Promise<{ secrets: SecretEnv } | { reason: AccessRefusal }> {
    if (profile.access === 'subscription') {
      // `unknown` is not a refusal: a runtime that offers no way to ask must not be read as
      // signed out, which would render sign-in guidance at somebody already signed in.
      return auth === 'unauthenticated' ? { reason: 'runtime-unauthenticated' } : { secrets: SecretEnv.empty() }
    }
    if (profile.access === 'api-key') return await this.keyFor(profile, runtime)
    return await this.endpointFor(profile, runtime)
  }

  private async keyFor(profile: LocalModelProfile, runtime: RuntimeSpec): Promise<{ secrets: SecretEnv } | { reason: AccessRefusal }> {
    // Both halves are required, and a missing provider is incomplete rather than
    // unchecked: a check that switches itself off when a field is absent is the permissive
    // default this contract refuses everywhere else.
    if (!profile.provider || !profile.keyLabel) return { reason: 'profile-incomplete' }
    // One call, because the provider check and the sealing must be one operation. Read the
    // record, compare its provider, then ask for the key and a rotation landing in that
    // window injects the new vendor's key under the old vendor's variable, into a launch
    // validated against the old vendor — the disclosure this check exists to prevent.
    const variable = runtime.keyVariable ?? keyVariableFor(profile.provider)
    const injection = await this.keys.injectAsForProvider(profile.keyLabel, profile.provider, variable)
    if (injection.status === 'missing') return { reason: 'unknown-key' }
    if (injection.status === 'provider-mismatch') return { reason: 'key-provider-mismatch' }
    return { secrets: injection.secrets }
  }

  private async endpointFor(profile: LocalModelProfile, runtime: RuntimeSpec): Promise<{ secrets: SecretEnv } | { reason: AccessRefusal }> {
    if (!profile.endpointId || !profile.model) return { reason: 'profile-incomplete' }
    const config = this.endpoints.get(profile.endpointId)
    if (!config) return { reason: 'unknown-endpoint' }
    const health = await probeLocalEndpoint(config)
    if (!health.reachable) return { reason: 'endpoint-unavailable' }
    // A truncated inventory cannot prove absence, so it does not: the endpoint reported
    // more models than it listed, and refusing there would make a large model library
    // unlaunchable to save the CLI from saying "no such model" itself.
    const listed = health.models.includes(profile.model) || health.modelCount > health.models.length
    if (!listed) return { reason: 'model-unavailable' }
    // The address travels in `secrets`, not in `env` and never in argv. It is not a
    // credential, but it is on the seam's never-crosses list and the argv rationale —
    // arguments are readable by any local process — applies to it verbatim.
    return { secrets: SecretEnv.of({ [runtime.endpointVariable ?? ENDPOINT_VARIABLES[config.kind]]: config.baseUrl }) }
  }
}

function launchPlan(profile: LocalModelProfile, runtime: RuntimeSpec, secrets: SecretEnv): LaunchPlan {
  const modeArgs = runtime.accessArgs?.[profile.access] ?? []
  const model = profile.model === undefined ? [] : [runtime.modelFlag ?? DEFAULT_MODEL_FLAG, profile.model]
  return {
    modelProfileId: profile.modelProfileId,
    access: profile.access,
    runtime: profile.runtime,
    command: runtime.command,
    args: [...modeArgs, ...model],
    // Nothing non-secret needs saying here yet. The field exists because a launch plan
    // has to be able to carry orchestration variables; inventing one to fill it would be
    // a value nothing reads.
    env: {},
    secrets,
  }
}

function refused(reason: AccessRefusal): AccessResolution {
  return { status: 'refused', reason }
}

// A Map that refuses to lose an entry. Two configurations claiming one name are
// contradictory the same way two channels claiming one id are, and there is no rule that
// says which the operator meant.
function uniqueByKey<T>(entries: readonly T[], key: (entry: T) => string, what: string) {
  const held = new Map<string, T>()
  for (const entry of entries) {
    const name = key(entry)
    if (held.has(name)) throw new Error(`${what} must be unique: ${name}`)
    held.set(name, { ...entry })
  }
  return held
}

// Local configuration is checked where it is loaded, not where it is launched: a profile
// naming something the wire could never carry would otherwise be a refusal — or an
// argument vector — built one layer away from the mistake.
function assertProfile(profile: LocalModelProfile) {
  if (!isSafeIdentifier(profile.modelProfileId)) throw new Error('a model profile id must be a safe identifier')
  if (!isAccessMode(profile.access)) throw new Error(`unsupported access mode: ${String(profile.access)}`)
  if (!isSafeIdentifier(profile.runtime)) throw new Error(`a runtime name must be a safe identifier: ${profile.modelProfileId}`)
  for (const [field, value] of [['keyLabel', profile.keyLabel], ['endpointId', profile.endpointId]] as const) {
    if (value !== undefined && !isSafeIdentifier(value)) throw new Error(`${field} must be a safe identifier: ${profile.modelProfileId}`)
  }
  // The store's grammar, not a second one that agrees with it today: a profile naming a
  // provider the store would refuse could never load a key anyway.
  if (profile.provider !== undefined) assertProviderName(profile.provider)
  // A model name is not a safe identifier — real ones carry a colon — so it is bounded and
  // control-character-free under its own rule, and it never reaches a filesystem path.
  if (profile.model !== undefined && (profile.model.length === 0 || profile.model.length > MAX_MODEL_LENGTH || hasControlCharacter(profile.model))) {
    throw new Error(`a model name must be a bounded string free of control characters: ${profile.modelProfileId}`)
  }
}

export function isAccessRefusal(value: unknown): value is AccessRefusal {
  return typeof value === 'string' && (ACCESS_REFUSALS as readonly string[]).includes(value)
}

// Guidance for a refusal, so detect-and-guide is one sentence in one place rather than a
// phrase each surface invents. Derived from the reason code, and carrying no endpoint, no
// key material and no path.
//
// Guidance points at what the operator can do; it never offers to do it. Nothing here
// installs, bundles or fetches a runtime — that is the "detect and guide, never bundle"
// rule in the one place a surface would be tempted to break it.
export function accessRefusalGuidance(reason: AccessRefusal): string {
  return GUIDANCE[reason]
}

const GUIDANCE: Record<AccessRefusal, string> = {
  'unknown-profile': 'this runner holds no model profile by that name; create one on this machine before binding it',
  'runtime-unknown': 'that profile names a runtime this runner does not hold in its local catalog',
  'runtime-unavailable': 'that runtime is not installed on this machine; install it yourself and it will be advertised on the next refresh',
  'runtime-unauthenticated': 'that runtime reports no credentials; sign in with the CLI itself and try again',
  'access-unsupported': 'that runtime cannot serve that access mode',
  'unknown-key': 'this runner holds no key under that label; add one with `modula-runner key add`',
  'key-provider-mismatch': 'that key belongs to a different provider than the profile names',
  'unknown-endpoint': 'this runner holds no local endpoint under that id',
  'endpoint-unavailable': 'that local endpoint did not answer; start the service and try again',
  'model-unavailable': 'that endpoint does not report the model this profile names',
  'profile-incomplete': 'that profile is missing something its access mode needs: a provider, a key label, an endpoint or a model',
}

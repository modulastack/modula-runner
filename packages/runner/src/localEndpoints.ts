import {
  MAX_ENDPOINT_CAPABILITIES,
  MAX_ENDPOINT_MODELS,
  MAX_MODEL_NAME_LENGTH,
  hasControlCharacter,
  isLocalEndpointKind,
  isSafeIdentifier,
  type EndpointUnreachableReason,
  type LocalEndpointCapability,
  type LocalEndpointKind,
} from '@modulastack/runner-protocol'

// Local model endpoints — Ollama as the reference integration, any OpenAI-compatible
// endpoint by configuration.
//
// The endpoint URL is configured here and nowhere else. If the control plane could name an
// address, the runner would be a request forwarder for whatever the hosted plane chose,
// which is the shape FR-13 already refuses for commands. The wire carries the opaque
// `endpointId` only, and a profile naming an id this runner does not hold is refused by
// name rather than resolved to whatever endpoint happens to exist.
//
// Endpoints are CONFIGURED, never discovered. "Detected local endpoints" means detecting
// whether a configured endpoint is up — not scanning loopback ports, which would advertise a
// colleague's model server on a shared machine without anyone asking for it. A default
// Ollama entry ships in the default configuration; that is a sensible default the operator
// can remove, not a scan.
//
// PROPOSAL: the probe request shapes are this runner's proposal rather than a settled
// contract. Ollama's own API is external and versioned by its project; the OpenAI-compatible
// shape is a de-facto convention. Both are recorded in docs/model-access.md so a
// disagreement shows up as a documented difference rather than as a mystery.

export const DEFAULT_PROBE_TIMEOUT_MS = 2_000
export const MAX_PROBE_RESPONSE_BYTES = 1024 * 1024
// A probe per endpoint is cheap; a fleet of them on a slow machine is not, and probeAll
// runs on a cadence. The bound is what keeps a refresh from being a burst.
const MAX_CONCURRENT_PROBES = 4

const INVENTORY_PATHS: Record<LocalEndpointKind, string> = {
  ollama: '/api/tags',
  'openai-compatible': '/v1/models',
}

export type LocalEndpointConfig = {
  // Operator-chosen, and never derived from the address. A hash of
  // `http://127.0.0.1:<port>` has an input space of about 65,000 values and is brute-forced
  // back to the port in milliseconds, so a derived id would disclose exactly the thing the
  // opaque id exists to withhold. An operator-chosen name is also stable across restarts by
  // construction, so a hosted binding does not break when the runner comes back.
  endpointId: string
  kind: LocalEndpointKind
  // Local configuration only. This value never appears in a frame, a log line, an
  // unreachable reason, or any process's argument vector.
  baseUrl: string
}

export type ProbeOptions = {
  timeoutMs?: number
  maxModels?: number
}

// The default configuration, not a discovery: an operator who does not run Ollama removes
// this entry, and nothing goes looking for what replaced it.
export const DEFAULT_LOCAL_ENDPOINTS: readonly LocalEndpointConfig[] = [
  { endpointId: 'ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
]

// The probe answers with the same shape the wire carries, so nothing has to translate
// between a "probe result" and a "capability" — they are one fact with one representation.
// A probe never rejects: an endpoint that is down is a reachable:false answer with a named
// reason, because a thrown error here would have to be turned back into that answer by
// every caller, and one of them would eventually turn it into "no endpoints" instead.
export async function probeLocalEndpoint(config: LocalEndpointConfig, options: ProbeOptions = {}): Promise<LocalEndpointCapability> {
  const target = inventoryUrl(config)
  // A configuration this runner cannot dial answers the way an address with nothing behind
  // it does. The alternative is a rejection every caller would have to translate back into
  // this same answer, and the typo is visible where it was made — in local configuration.
  if (target === null) return unreachable(config, 'not-running')
  let response: Response
  try {
    response = await fetch(target, {
      // A redirect would take the probe somewhere the operator did not configure, and the
      // answer would describe that place instead.
      redirect: 'error',
      signal: AbortSignal.timeout(probeTimeout(options.timeoutMs)),
    })
  } catch (error) {
    return unreachable(config, transportReason(error))
  }
  return await readInventory(config, response, options)
}

async function readInventory(config: LocalEndpointConfig, response: Response, options: ProbeOptions): Promise<LocalEndpointCapability> {
  if (response.status === 401 || response.status === 403) return await discard(response, unreachable(config, 'unauthorized'))
  // Anything else that is not a 200 answered, but not with an inventory. There is no
  // reason code for "spoke a different protocol", and this is the closest true statement:
  // the runner could not read what it was told.
  if (!response.ok) return await discard(response, unreachable(config, 'unreadable-response'))
  let body: unknown
  try {
    body = JSON.parse(await readCapped(response))
  } catch (error) {
    // A body that outran the deadline is a timeout, not a malformed answer: the read shares
    // the request's signal, so an endpoint that accepts the connection and then says nothing
    // lands here rather than hanging on the OS default.
    return unreachable(config, isTimeout(error) ? 'timed-out' : 'unreadable-response')
  }
  const reported = reportedModels(config.kind, body)
  if (reported === null) return unreachable(config, 'unreadable-response')
  const carried = reported.slice(0, modelLimit(options.maxModels))
  // Bounded at the producing end, not only at the validator: a name the wire would reject
  // must not be able to poison a whole snapshot, and truncation stays visible through the
  // count rather than through a shortened list that says nothing.
  if (!carried.every(isCarryableModelName)) return unreachable(config, 'unreadable-response')
  return { endpointId: config.endpointId, kind: config.kind, reachable: true, models: carried, modelCount: reported.length }
}

export class LocalEndpointRegistry {
  private readonly configs: readonly LocalEndpointConfig[]

  constructor(configs: readonly LocalEndpointConfig[]) {
    // The wire caps the advertisement at MAX_ENDPOINT_CAPABILITIES, so a longer
    // configuration would build a snapshot the validator drops whole. Refusing it here
    // makes the bound an operator-visible fact instead of a silent truncation.
    if (configs.length > MAX_ENDPOINT_CAPABILITIES) throw new Error(`a runner advertises at most ${MAX_ENDPOINT_CAPABILITIES} local endpoints`)
    for (const config of configs) assertEndpointConfig(config)
    // Duplicate ids are contradictory the same way they are on the wire: two answers for
    // one name, and no rule that says which a profile means.
    if (new Set(configs.map(config => config.endpointId)).size !== configs.length) throw new Error('local endpoint ids must be unique')
    this.configs = configs.map(config => ({ ...config }))
  }

  list(): readonly LocalEndpointConfig[] {
    return this.configs.map(config => ({ ...config }))
  }

  get(endpointId: string): LocalEndpointConfig | null {
    const found = this.configs.find(config => config.endpointId === endpointId)
    return found ? { ...found } : null
  }

  // Probes run concurrently but bounded, and each carries its own deadline: a hung endpoint
  // costs one unreachable answer, never a delayed handshake or a missed heartbeat.
  async probeAll(options?: ProbeOptions): Promise<LocalEndpointCapability[]> {
    const results: LocalEndpointCapability[] = []
    let next = 0
    const worker = async () => {
      for (;;) {
        const index = next
        next += 1
        const config = this.configs[index]
        if (!config) return
        results[index] = await probeLocalEndpoint(config, options)
      }
    }
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_PROBES, this.configs.length) }, worker))
    return results
  }
}

function assertEndpointConfig(config: LocalEndpointConfig) {
  if (!isSafeIdentifier(config.endpointId)) throw new Error('a local endpoint id must be a safe identifier')
  if (!isLocalEndpointKind(config.kind)) throw new Error(`unsupported local endpoint kind: ${String(config.kind)}`)
  // Not restricted to loopback: the address is local configuration that the wire can never
  // name, and a model server on the operator's own second machine is a legitimate answer.
  if (inventoryUrl(config) === null) throw new Error(`a local endpoint needs an http or https base URL: ${config.endpointId}`)
}

function inventoryUrl(config: LocalEndpointConfig): URL | null {
  const path = INVENTORY_PATHS[config.kind]
  if (path === undefined || typeof config.baseUrl !== 'string' || config.baseUrl.length > 2_048 || hasControlCharacter(config.baseUrl)) return null
  if (config.baseUrl.includes('?') || config.baseUrl.includes('#')) return null
  try {
    const base = new URL(config.baseUrl)
    if ((base.protocol !== 'http:' && base.protocol !== 'https:') || base.username || base.password || base.search || base.hash) return null
    // Concatenated rather than resolved: a base URL carrying a path prefix is part of the
    // address the operator configured, and resolving an absolute path would discard it.
    return new URL(`${config.baseUrl.replace(/\/+$/, '')}${path}`)
  } catch {
    return null
  }
}

function unreachable(config: LocalEndpointConfig, reason: EndpointUnreachableReason): LocalEndpointCapability {
  // No models and no count: an endpoint that did not answer has no inventory to report, and
  // a remembered one would describe a machine state that is no longer true.
  return { endpointId: config.endpointId, kind: config.kind, reachable: false, models: [], modelCount: 0, reason }
}

// PROPOSAL, per docs/model-access.md: these two shapes are what "compatible" means here.
// Strictly read, so a drifting server fails loudly rather than half-working — an entry
// without a name is a different protocol, not an endpoint with one fewer model.
function reportedModels(kind: LocalEndpointKind, body: unknown): string[] | null {
  if (typeof body !== 'object' || body === null) return null
  const [field, key] = kind === 'ollama' ? (['models', 'name'] as const) : (['data', 'id'] as const)
  const entries = (body as Record<string, unknown>)[field]
  if (!Array.isArray(entries)) return null
  const names = entries.map(entry => (typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>)[key] : undefined))
  return names.every(name => typeof name === 'string') ? (names as string[]) : null
}

// Model names are not safe identifiers: a real one carries a colon
// (`llama3.1:8b-instruct-q4_K_M`). They cross as bounded, control-character-free strings
// under their own rule — and never as a path segment on this machine.
function isCarryableModelName(value: string) {
  return value.length > 0 && value.length <= MAX_MODEL_NAME_LENGTH && !hasControlCharacter(value)
}

function modelLimit(requested: number | undefined) {
  if (requested === undefined || !Number.isSafeInteger(requested) || requested < 0) return MAX_ENDPOINT_MODELS
  return Math.min(requested, MAX_ENDPOINT_MODELS)
}

function probeTimeout(requested: number | undefined) {
  return Number.isSafeInteger(requested) && (requested as number) > 0 ? (requested as number) : DEFAULT_PROBE_TIMEOUT_MS
}

// The body is read through a cap rather than parsed whole. An inventory is a few kilobytes;
// without a byte bound a misbehaving endpoint could make the runner allocate and parse an
// arbitrarily large one, and the deadline bounds duration, not volume.
async function readCapped(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_PROBE_RESPONSE_BYTES) throw new Error('the endpoint answered with more than this runner will read')
      chunks.push(value)
    }
  } finally {
    // Releasing the stream; the outcome the caller waits on has already been decided.
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function discard<T>(response: Response, answer: T): Promise<T> {
  // An unread body holds its connection open, and this runs on a cadence.
  await response.body?.cancel().catch(() => undefined)
  return answer
}

function transportReason(error: unknown): EndpointUnreachableReason {
  if (isTimeout(error)) return 'timed-out'
  // Nothing is listening, or nothing resolves: the service is not running, which is the
  // answer the operator can act on.
  const code = errorCode(error)
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'not-running'
  // Something is there and would not hold the conversation — a reset, a TLS refusal, a
  // proxy hanging up. Distinct from not-running because the fix is a different one.
  return 'refused'
}

function isTimeout(error: unknown) {
  const named = error as { name?: unknown; cause?: { name?: unknown } }
  return named?.name === 'TimeoutError' || named?.name === 'AbortError' || named?.cause?.name === 'TimeoutError'
}

function errorCode(error: unknown) {
  const failure = error as { code?: unknown; cause?: { code?: unknown } }
  return typeof failure?.code === 'string' ? failure.code : failure?.cause?.code
}

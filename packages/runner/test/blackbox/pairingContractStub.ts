import { createHmac } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  MAX_PAIRING_RESPONSE_BYTES,
  PAIRING_CONFIRM_PATH,
  PAIRING_REDEEM_PATH,
  pairingConfirmationMessage,
  pairingSecretBytes,
  parsePairingConfirmationRequest,
  parsePairingRedemptionRequest,
} from '@modulastack/runner-protocol'

export type PairingConfirmationOutcome =
  | 'confirmed'
  | 'response-lost-after-confirm'
  | 'unreachable'
  | 'refused'
  | 'expired'

export type PairingRedemptionOutcome =
  | 'pending'
  | 'invalid'
  | 'expired'
  | { redirectTo: string }

export type PairingStubOptions = {
  redemption?: PairingRedemptionOutcome
  confirmation?: readonly PairingConfirmationOutcome[]
}

export type PairingObservation =
  | {
    kind: 'redeem'
    method: string
    path: string
    bodyFields: readonly string[]
    requestValid: boolean
    codeMatched: boolean
  }
  | {
    kind: 'confirm'
    method: string
    path: string
    bindingId: string | null
    bodyFields: readonly string[]
    requestValid: boolean
    proofValid: boolean
    bearerPresent: boolean
  }

type Binding = {
  bindingId: string
  runnerId: string
  token: string
  confirmationNonce: string
  state: 'pending' | 'confirmed' | 'revoked'
}

const pairingCode = `${Buffer.alloc(16, 0x31).toString('base64url')}.${Buffer.alloc(14, 0x32).toString('base64url')}`
const maxObservations = 64

export class PairingContractStub {
  readonly observations: PairingObservation[] = []
  private readonly bindings = new Map<string, Binding>()
  private server: Server | null = null
  private port = 0
  private redemptionCount = 0
  private confirmationCount = 0

  constructor(private readonly options: PairingStubOptions = {}) {}

  get url(): string {
    if (this.port === 0) throw new Error('pairing stub is not listening')
    return `http://127.0.0.1:${this.port}`
  }

  get inputCode(): string {
    return pairingCode
  }

  containsFixtureSecret(value: string): boolean {
    if (value.includes(pairingCode)) return true
    return [...this.bindings.values()].some(binding =>
      value.includes(binding.token) || value.includes(binding.confirmationNonce))
  }

  async start(): Promise<this> {
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(() => send(response, 500))
    })
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(0, '127.0.0.1', resolve)
    })
    this.port = boundPort(this.server)
    return this
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.port = 0
    if (!server) return
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    })
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', this.url).pathname
    if (request.method === 'POST' && path === PAIRING_REDEEM_PATH) {
      await this.redeem(request, response, path)
      return
    }
    if (request.method === 'POST' && path === PAIRING_CONFIRM_PATH) {
      await this.confirm(request, response, path)
      return
    }
    send(response, 404)
  }

  private async redeem(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    const body = await readJson(request)
    const parsed = parsePairingRedemptionRequest(body)
    this.record({
      kind: 'redeem',
      method: request.method ?? '',
      path,
      bodyFields: fieldsOf(body),
      requestValid: parsed !== null,
      codeMatched: parsed?.code === pairingCode,
    })
    if (!parsed || parsed.code !== pairingCode) return send(response, 400)
    const outcome = this.options.redemption ?? 'pending'
    if (outcome === 'invalid') return send(response, 400)
    if (outcome === 'expired') return send(response, 410)
    if (typeof outcome === 'object') return redirect(response, outcome.redirectTo)
    const binding = this.createBinding()
    this.bindings.set(binding.bindingId, binding)
    send(response, 200, {
      bindingId: binding.bindingId,
      runnerId: binding.runnerId,
      token: binding.token,
      confirmationNonce: binding.confirmationNonce,
      confirmationExpiresAt: '2099-01-01T00:00:00.000Z',
    })
  }

  private async confirm(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    const body = await readJson(request)
    const parsed = parsePairingConfirmationRequest(body)
    const binding = parsed ? this.bindings.get(parsed.bindingId) : undefined
    const proofValid = parsed !== null && binding !== undefined && validProof(binding, parsed.tokenProof, this.url)
    this.record({
      kind: 'confirm',
      method: request.method ?? '',
      path,
      bindingId: parsed?.bindingId ?? null,
      bodyFields: fieldsOf(body),
      requestValid: parsed !== null,
      proofValid,
      bearerPresent: containsBearer(body, binding?.token),
    })
    if (!parsed || !binding || !proofValid) return send(response, 400)
    if (binding.state === 'revoked') return send(response, 403)
    if (binding.state === 'confirmed') return send(response, 204)
    const outcome = this.nextConfirmationOutcome()
    if (outcome === 'unreachable') {
      response.destroy()
      return
    }
    if (outcome === 'refused') {
      binding.state = 'revoked'
      return send(response, 403)
    }
    if (outcome === 'expired') {
      binding.state = 'revoked'
      return send(response, 410)
    }
    binding.state = 'confirmed'
    if (outcome === 'response-lost-after-confirm') {
      response.destroy()
      return
    }
    send(response, 204)
  }

  private createBinding(): Binding {
    this.redemptionCount += 1
    const suffix = String(this.redemptionCount).padStart(12, '0')
    return {
      bindingId: `00000000-0000-4000-8000-${suffix}`,
      runnerId: `blackbox-runner-${this.redemptionCount}`,
      token: fixtureSecret(0x40 + this.redemptionCount),
      confirmationNonce: fixtureSecret(0x60 + this.redemptionCount),
      state: 'pending',
    }
  }

  private nextConfirmationOutcome(): PairingConfirmationOutcome {
    const plan = this.options.confirmation ?? ['confirmed']
    const outcome = plan[Math.min(this.confirmationCount, plan.length - 1)] ?? 'confirmed'
    this.confirmationCount += 1
    return outcome
  }

  private record(observation: PairingObservation): void {
    if (this.observations.length >= maxObservations) throw new Error('pairing stub observation limit exceeded')
    this.observations.push(observation)
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const held = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += held.byteLength
    if (bytes > MAX_PAIRING_RESPONSE_BYTES) throw new Error('pairing request exceeded the stub limit')
    chunks.push(held)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

function validProof(binding: Binding, actual: string, origin: string): boolean {
  const message = pairingConfirmationMessage({
    bindingId: binding.bindingId,
    runnerId: binding.runnerId,
    origin,
    confirmationNonce: binding.confirmationNonce,
  })
  const token = pairingSecretBytes(binding.token)
  if (!message || !token) return false
  return createHmac('sha256', token).update(message, 'utf8').digest('hex') === actual
}

function containsBearer(value: unknown, token: string | undefined): boolean {
  if (!token) return false
  if (typeof value === 'string') return value.includes(token)
  if (Array.isArray(value)) return value.some(entry => containsBearer(entry, token))
  if (typeof value !== 'object' || value === null) return false
  return Object.values(value).some(entry => containsBearer(entry, token))
}

function fieldsOf(value: unknown): readonly string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  return Object.keys(value).sort().slice(0, 32)
}

function fixtureSecret(fill: number): string {
  return Buffer.alloc(32, fill).toString('base64url')
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    response.writeHead(status).end()
    return
  }
  const encoded = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) })
  response.end(encoded)
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { location }).end()
}

function boundPort(server: Server | null): number {
  const address = server?.address()
  if (!address || typeof address === 'string') throw new Error('pairing stub has no bound port')
  return address.port
}

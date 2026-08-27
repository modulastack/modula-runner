import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_PAIRING_RESPONSE_BYTES } from '@modulastack/runner-protocol'
import { createPairingHttpTransport, type PairingHttpRequest } from '../src/index.js'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

function request(url: string, timeoutMs = 1_000): PairingHttpRequest {
  return {
    method: 'POST',
    url,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: '{"code":"hidden"}',
    redirect: 'error',
    timeoutMs,
  }
}

describe('production pairing HTTP transport', () => {
  it('posts the exact request and classifies JSON media parameters', async () => {
    let observed = ''
    const url = await serve((incoming, response) => {
      incoming.setEncoding('utf8')
      incoming.on('data', (chunk: string) => { observed += chunk })
      incoming.on('end', () => {
        response.writeHead(201, { 'content-type': 'Application/JSON; charset=utf-8' })
        response.end('{"ok":true}')
      })
    })
    await expect(createPairingHttpTransport().exchange(request(url))).resolves.toEqual({
      status: 201,
      mediaType: 'application/json',
      body: '{"ok":true}',
    })
    expect(observed).toBe('{"code":"hidden"}')
  })

  it('returns bounded classifications for missing, wrong, and oversized bodies', async () => {
    const missing = await serve((_incoming, response) => {
      response.writeHead(204)
      response.end()
    })
    await expect(createPairingHttpTransport().exchange(request(missing))).resolves.toEqual({ status: 204, mediaType: 'missing', body: '' })

    const oversized = await serve((_incoming, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('x'.repeat(MAX_PAIRING_RESPONSE_BYTES + 10))
    })
    const result = await createPairingHttpTransport().exchange(request(oversized))
    expect(result).toMatchObject({ status: 200, mediaType: 'other' })
    expect(Buffer.byteLength(result.body)).toBe(MAX_PAIRING_RESPONSE_BYTES + 1)
  })

  it('rejects redirects and request timeouts instead of following or hanging', async () => {
    const redirect = await serve((_incoming, response) => {
      response.writeHead(302, { location: '/elsewhere' })
      response.end()
    })
    await expect(createPairingHttpTransport().exchange(request(redirect))).rejects.toThrow()

    const delayed = await serve((_incoming, response) => {
      setTimeout(() => response.end('{}'), 100)
    })
    await expect(createPairingHttpTransport().exchange(request(delayed, 20))).rejects.toThrow()
  })
})

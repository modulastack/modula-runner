import { createServer, type Server } from 'node:http'
import { createMemoryPairingStore, RunnerIdentity, type RunnerBinding } from '../../src/index.js'

export const token = 'runner-token-acceptance-secret'

export function binding(overrides: Partial<RunnerBinding> = {}): RunnerBinding {
  return {
    runnerId: 'runner-acceptance',
    controlPlaneUrl: 'ws://127.0.0.1:1',
    token,
    pairedAt: '2026-08-09T12:00:00.000Z',
    ...overrides,
  }
}

export async function identityWithBinding(value: RunnerBinding) {
  const store = createMemoryPairingStore()
  await store.save(value)
  return { identity: new RunnerIdentity(store), store }
}

export async function startAuthRejectingServer() {
  let attempts = 0
  const server = createServer()
  server.on('upgrade', (_request, socket) => {
    attempts += 1
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    socket.destroy()
  })
  await listen(server)
  return {
    url: `ws://127.0.0.1:${portOf(server)}`,
    attempts: () => attempts,
    stop: () => close(server),
  }
}

function listen(server: Server) {
  return new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
}

function close(server: Server) {
  return new Promise<void>(resolve => server.close(() => resolve()))
}

function portOf(server: Server) {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind')
  return address.port
}

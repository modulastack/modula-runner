import { afterEach, describe, expect, test } from 'vitest'
import { createPairedClient, PresenceTracker, type RunnerClient } from '../../src/index.js'
import { StubControlPlane } from '../stubControlPlane.js'
import { sleep, testRunnerInfo, until } from '../helpers.js'
import { binding, identityWithBinding, startAuthRejectingServer, token } from './support.js'

const intervalMs = 200
const timeoutMs = 1_000
const heartbeat = { intervalMs, timeoutMs }
const clients: RunnerClient[] = []
const planes: StubControlPlane[] = []
const trackers: PresenceTracker[] = []

afterEach(async () => {
  for (const tracker of trackers) tracker.stop()
  for (const client of clients) client.stop()
  await Promise.all(planes.map(plane => plane.stop()))
  trackers.length = 0
  clients.length = 0
  planes.length = 0
})

async function connectedPresence() {
  const plane = await new StubControlPlane({ token, heartbeat }).start()
  planes.push(plane)
  const seeded = await identityWithBinding(binding({ controlPlaneUrl: plane.url }))
  const client = await createPairedClient(seeded.identity, { runner: testRunnerInfo })
  const tracker = new PresenceTracker({ client })
  clients.push(client)
  trackers.push(tracker)
  client.connect()
  await until(() => tracker.snapshot().state === 'online')
  return { client, plane, tracker }
}

describe('FR-7 presence and scheduling', () => {
  // SCHEMA "Liveness" and FRD FR-7: silence becomes visibly offline within the negotiated timeout window.
  test('surfaces offline state no later than timeoutMs after the last accepted traffic', async () => {
    const { plane, tracker } = await connectedPresence()
    expect(tracker.snapshot()).toEqual(expect.objectContaining({ state: 'online', heartbeat }))
    expect(tracker.canAcceptWork()).toBe(true)
    plane.options.mutePings = true
    plane.pingRunner('last-accepted-traffic')
    await until(() => plane.runnerPongs.includes('last-accepted-traffic'))

    const silencedAt = Date.now()
    const observedAt = await offlineTransitionAt(tracker)

    expect(observedAt - silencedAt).toBeLessThanOrEqual(timeoutMs)
    expect(tracker.canAcceptWork()).toBe(false)
  })

  // FRD FR-7: offline work is refused by an observable state rather than accepted into a hidden queue.
  test('makes the offline scheduling decision explicit and stable across reconnect', async () => {
    const { client, plane, tracker } = await connectedPresence()
    const observed: string[] = []
    tracker.on('presence', snapshot => observed.push(snapshot.state))

    plane.dropConnections()
    await until(() => tracker.snapshot().state === 'offline')
    expect(tracker.canAcceptWork()).toBe(false)
    await until(() => plane.connectionCount >= 2 && client.isConnected())

    expect(tracker.canAcceptWork()).toBe(true)
    expect(observed).toContain('offline')
    expect(observed.at(-1)).toBe('online')
  })

  // FRD FR-6: revocation outranks a later socket close and remains terminal for presence.
  test('keeps revoked presence terminal when the rejected socket closes', async () => {
    const server = await startAuthRejectingServer()
    const seeded = await identityWithBinding(binding({ controlPlaneUrl: server.url }))
    const client = await createPairedClient(seeded.identity, {
      runner: testRunnerInfo,
      backoff: { baseMs: 10, capMs: 10, random: () => 0 },
    })
    const tracker = new PresenceTracker({ client })
    clients.push(client)
    trackers.push(tracker)
    client.on('error', () => undefined)

    try {
      client.connect()
      await until(() => tracker.snapshot().state === 'revoked')
      await sleep(100)
      expect(tracker.snapshot().state).toBe('revoked')
      expect(tracker.canAcceptWork()).toBe(false)
      expect(server.attempts()).toBe(1)
    } finally {
      await server.stop()
    }
  })

  // SCHEMA "Liveness": presence rides the welcome heartbeat rather than creating a second heartbeat.
  test('does not add a second heartbeat to the transport liveness machinery', async () => {
    const withoutTracker = await countPings(false)
    const withTracker = await countPings(true)

    expect(withTracker).toBeLessThanOrEqual(withoutTracker + 1)
  })

  // FRD AC-3 and SCHEMA "Reconnect and attach continuity": channel identity survives reconnect.
  test('preserves active session handles while presence transitions offline and online', async () => {
    const { client, plane, tracker } = await connectedPresence()
    const channel = client.openChannel('terminal')
    await until(() => plane.opens.includes(channel.id))

    plane.dropConnections()
    await until(() => tracker.snapshot().state === 'offline')
    await until(() => plane.connectionCount >= 2 && client.isConnected())

    expect(client.channelIds()).toContain(channel.id)
    expect(plane.hellos.at(-1)?.channels).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: channel.id, kind: 'terminal' }),
    ]))
  })
})

function offlineTransitionAt(tracker: PresenceTracker) {
  return new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('offline was not observable within timeoutMs')), timeoutMs + 100)
    tracker.on('presence', snapshot => {
      if (snapshot.state !== 'offline') return
      clearTimeout(timeout)
      resolve(Date.now())
    })
  })
}

async function countPings(trackPresence: boolean) {
  const plane = await new StubControlPlane({ token, heartbeat }).start()
  planes.push(plane)
  const seeded = await identityWithBinding(binding({ controlPlaneUrl: plane.url }))
  const client = await createPairedClient(seeded.identity, { runner: testRunnerInfo })
  clients.push(client)
  if (trackPresence) trackers.push(new PresenceTracker({ client }))
  client.connect()
  await until(() => client.isConnected())
  await sleep(700)
  return plane.runnerPings.length
}

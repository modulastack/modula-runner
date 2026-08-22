import { describe, expect, it } from 'vitest'
import { unemittableOracleFragments } from './driverEmittability.js'
import { RUNTIME_RED_OBLIGATIONS } from './obligationMatrix.js'
import { pairingFixtureBearer, runtimeRedFixtureForbiddenEnv } from './fixtureMaterial.js'
import { createHomeFixtureStorage, observeHomeScenario } from './homeSubject.js'
import { jobControlPayloadForScenario } from './jobControlSubject.js'
import { pairingRequestContainsFixtureBearer, pairingResponsesForFixture } from './pairingSubject.js'
import { scenarioFor } from './runtimeScenarios.js'
import { observationMatches, type RuntimeScenario } from './scenarioTypes.js'
import { observeTerminalScenario } from './terminalSubject.js'

function scenario(id: string): RuntimeScenario {
  const obligation = RUNTIME_RED_OBLIGATIONS.find(candidate => candidate.id === id)
  if (!obligation) throw new Error(`missing runtime-red obligation ${id}`)
  return scenarioFor(obligation)
}

describe('PR43 round 4 origin adaptation', () => {
  it('injects unsafe home metadata, read failure, and replace failure by fixture', async () => {
    const metadataEvents: string[] = []
    const metadata = createHomeFixtureStorage('home-unsafe-metadata', event => metadataEvents.push(event))
    const inspection = await metadata.inspect({ override: '/tmp/runtime-red-home' })
    expect(inspection.entries).toEqual([{ record: 'configuration', kind: 'symlink', owner: 'current-user', mode: 0o600, links: 1 }])
    expect(metadataEvents).toContain('storage.inspect:unsafe-metadata')

    const readEvents: string[] = []
    const readFailure = createHomeFixtureStorage('home-read-unavailable', event => readEvents.push(event))
    await expect(readFailure.read('configuration')).resolves.toEqual({ status: 'storage-unavailable' })
    expect(readEvents).toContain('storage.read:configuration:storage-unavailable')

    const replaceEvents: string[] = []
    const replaceFailure = createHomeFixtureStorage('home-replace-unavailable', event => replaceEvents.push(event))
    await expect(replaceFailure.replace('configuration', null, Buffer.from('{}'))).resolves.toEqual({ status: 'storage-unavailable' })
    expect(replaceEvents).toContain('storage.replace:configuration:storage-unavailable')

    const duplicate = await observeHomeScenario(scenario('G1-L19'))
    expect(observationMatches(duplicate, scenario('G1-L19').oracle)).toBe(true)

    const unsafe = await observeHomeScenario({ ...scenario('G1-L19'), fixture: 'home-unsafe-metadata' })
    expect(unsafe).toMatchObject({ status: 'observed', result: 'home:failed:state-linked' })
    if (unsafe.status === 'observed') expect(unsafe.events.some(event => event.includes('storage.acquire'))).toBe(false)

    const unreadable = await observeHomeScenario({ ...scenario('G1-L19'), fixture: 'home-read-unavailable' })
    expect(unreadable).toMatchObject({ status: 'observed', result: 'home:failed:state-io-failed' })
    if (unreadable.status === 'observed') expect(unreadable.events).toEqual(expect.arrayContaining([
      expect.stringContaining('storage.acquire'),
      expect.stringContaining('storage.release'),
    ]))
  })

  it('uses only deterministic non-credential material in the forbidden environment fixture', () => {
    const payload = jobControlPayloadForScenario(scenario('G1-L06'))
    const serialized = JSON.stringify(payload)
    expect(runtimeRedFixtureForbiddenEnv).toBe('[runtime-red-fixture:forbidden-env]')
    expect(serialized).toContain(runtimeRedFixtureForbiddenEnv)
    expect(serialized).not.toMatch(/secret|credential/i)
  })

  it('pins the deadline response and bearer scan across headers and nested body values', () => {
    expect(pairingResponsesForFixture('confirmation-deadline-uncertain')[0]).toEqual({ status: 503, mediaType: 'missing', body: '' })
    expect(pairingRequestContainsFixtureBearer({
      headers: { 'x-probe': 'safe' },
      body: JSON.stringify({ nested: ['safe', { value: 'safe' }] }),
    })).toBe(false)
    expect(pairingRequestContainsFixtureBearer({
      headers: { 'x-probe': `prefix-${pairingFixtureBearer}-suffix` },
      body: JSON.stringify({ value: 'safe' }),
    })).toBe(true)
    expect(pairingRequestContainsFixtureBearer({
      headers: { 'x-probe': 'safe' },
      body: JSON.stringify({ nested: ['safe', { value: pairingFixtureBearer }] }),
    })).toBe(true)
  })

  it('requires second-connection recovery before the quiet interval', () => {
    const reconnect = scenario('G1-N13')
    const ambiguousLoss = scenario('G1-S10')
    expect(unemittableOracleFragments(reconnect)).toEqual([])
    expect(unemittableOracleFragments(ambiguousLoss)).toEqual([])
    expect(reconnect.oracle.require).toContain('runtime.job-control-recovery:connection:>=2')
    expect(reconnect.oracle.before).toContainEqual(['runtime.protocol-recovery:2:connection:[2]', 'runtime.job-control-recovery:connection:>=2'])
    expect(ambiguousLoss.oracle.before).toContainEqual(['runtime.reconnect', 'runtime.job-control-recovery:connection:>=2'])
    expect(ambiguousLoss.oracle.before).toContainEqual(['runtime.job-control-recovery:connection:>=2', 'runtime.ambiguous-loss:quiet-window:begin:connection:>=2'])
  })

  it('runs the strengthened terminal exit and reset continuity observers', async () => {
    for (const id of ['G1-C11', 'G1-C13']) {
      const current = scenario(id)
      expect(unemittableOracleFragments(current)).toEqual([])
      const observation = await observeTerminalScenario(current)
      expect(observation.status).toBe('observed')
      expect(observationMatches(observation, current.oracle)).toBe(true)
    }
  })
})

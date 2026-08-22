import {
  RunnerHomeNotImplementedError,
  createRunnerHome,
  type RunnerHomeInspection,
  type RunnerHomeStorage,
} from '../../src/index.js'
import { createRecorder } from './recorder.js'
import type { RuntimeObservation, RuntimeScenario } from './scenarioTypes.js'

export async function observeHomeScenario(scenario: RuntimeScenario): Promise<RuntimeObservation> {
  const recorder = createRecorder()
  const storage = createHomeFixtureStorage(scenario.fixture, recorder.record)
  const subject = createRunnerHome({
    clock: {
      now() {
        recorder.record('clock.now')
        return Date.parse('2026-08-21T00:00:00Z')
      },
      async sleep(milliseconds) {
        recorder.record(`clock.sleep:${milliseconds}`)
      },
    },
    storage,
  })
  try {
    const result = await subject.open({ override: '/tmp/runtime-red-home' })
    const outcome = result.status === 'ready' ? 'home:ready' : `home:failed:${result.code}`
    if (result.status === 'failed') recorder.record(`home.failure:${result.code}`)
    return { status: 'observed', subject: 'home', result: outcome, events: recorder.events, output: recorder.output }
  } catch (error) {
    if (error instanceof RunnerHomeNotImplementedError) {
      return { status: 'missing-production-runtime', subject: 'home', error: error.name }
    }
    throw error
  }
}

export function createHomeFixtureStorage(fixture: string, record: (event: string) => void): RunnerHomeStorage {
  return {
    async inspect() {
      record(`storage.fixture:${fixture}`)
      if (fixture === 'home-unsafe-metadata') record('storage.inspect:unsafe-metadata')
      else record('storage.inspect:0700-current-user')
      return homeInspection(fixture)
    },
    async read(name) {
      record(`storage.read:${name}`)
      if (fixture === 'home-read-unavailable' && name === 'configuration') {
        record('storage.read:configuration:storage-unavailable')
        return { status: 'storage-unavailable' }
      }
      if (name !== 'configuration') return { status: 'missing' }
      return encodedConfiguration(fixture)
    },
    async replace(name, _expectedSha256, bytes) {
      record(`storage.replace:${name}:${bytes.byteLength}`)
      if (fixture === 'home-replace-unavailable') {
        record('storage.replace:configuration:storage-unavailable')
        return { status: 'storage-unavailable' }
      }
      return { status: 'written', sha256: 'a'.repeat(64) }
    },
    async append() {
      return 'storage-unavailable'
    },
  }
}

function homeInspection(fixture: string): RunnerHomeInspection {
  if (fixture === 'home-unsafe-metadata') {
    return {
      rootKind: 'directory',
      rootOwner: 'current-user',
      rootMode: 0o700,
      entries: [{ record: 'configuration', kind: 'symlink', owner: 'current-user', mode: 0o600, links: 1 }],
    }
  }
  return {
    rootKind: 'directory',
    rootOwner: 'current-user',
    rootMode: 0o700,
    entries: [{ record: 'configuration', kind: 'regular', owner: 'current-user', mode: 0o600, links: 1 }],
  }
}

function encodedConfiguration(fixture: string) {
  const profiles = fixture === 'duplicate-local-configuration'
    ? [profile('daily'), profile('daily')]
    : [profile('daily')]
  const bytes = Buffer.from(JSON.stringify({ revision: 1, profiles, endpoints: [] }))
  return { status: 'found' as const, bytes, sha256: 'a'.repeat(64) }
}

function profile(modelProfileId: string) {
  return { modelProfileId, access: 'subscription', runtime: 'claude' }
}

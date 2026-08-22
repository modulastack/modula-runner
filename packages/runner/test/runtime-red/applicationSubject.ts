import {
  RunnerApplicationNotImplementedError,
  SecretEnv,
  createRunnerApplication,
  type RunnerApplicationOptions,
  type RunnerCliInvocation,
  type RunnerHomeState,
} from '../../src/index.js'
import { createRecorder } from './recorder.js'
import { pairingCodeFor } from './scenarioIdentity.js'
import type { RuntimeObservation, RuntimeScenario } from './scenarioTypes.js'

export async function observeApplicationScenario(scenario: RuntimeScenario): Promise<RuntimeObservation> {
  const recorder = createRecorder()
  const home = createTestHomeState(recorder.record)
  let pairingCompositions = 0
  let hiddenReads = 0
  const options: RunnerApplicationOptions = {
    version: '0.1.0',
    clock: { now: () => Date.parse('2026-08-21T00:00:00Z'), sleep: async () => undefined },
    home: {
      async open() {
        recorder.record(`application.fixture:${scenario.fixture}`)
        recorder.record('application.home.open')
        return { status: 'ready', home }
      },
    },
    composition: {
      pairing() {
        pairingCompositions += 1
        recorder.record('composition.pairing')
        return {
          async pair() {
            recorder.record('pairing.pair')
            return { bindingId: '123e4567-e89b-42d3-a456-426614174000', runnerId: 'runner-01' }
          },
          async resumeConfirmation() { return null },
          async snapshot() { return { state: 'unpaired', record: null } },
          async current() { return null },
          async revoke() { recorder.record('pairing.revoke') },
        }
      },
      sessions() {
        recorder.record('composition.sessions')
        return { async *handle() {}, async *recover() {} }
      },
      jobControl() {
        recorder.record('composition.jobControl')
        return { async *dispatch() {}, async *recover() {} }
      },
      runtime: {
        async start() {
          recorder.record('runtime.start')
          return { finished: Promise.resolve({ status: 'confirmed' }), stop: async () => ({ status: 'confirmed' }), forceStop: () => undefined }
        },
      },
    },
  }
  const application = createRunnerApplication(options)
  const pairingCode = pairingCodeFor(scenario.obligationId)
  const execute = async (
    args: readonly string[],
    inputIsTTY: boolean,
    environmentExtras: Record<string, unknown> = {},
    invocationExtras: Record<string, unknown> = {},
  ) => {
    const environment = { runnerHome: '/tmp/runtime-red-home' }
    Object.assign(environment, environmentExtras)
    const invocation: RunnerCliInvocation = {
      args,
      cwd: '/tmp',
      environment,
      io: {
        inputIsTTY,
        async readHidden() {
          hiddenReads += 1
          recorder.record('io.readHidden')
          return pairingCode
        },
        writeStdout: recorder.stdout,
        writeStderr: recorder.stderr,
      },
    }
    Object.assign(invocation, invocationExtras)
    return await application.execute(invocation)
  }
  try {
    const exitCode = await execute(['pair', '--control-plane', 'https://example.test'], true)
    const alternateEntries = [
      { route: 'argv', args: ['pair', pairingCode], inputIsTTY: true, environment: {}, invocation: {} },
      { route: 'environment', args: ['pair', '--control-plane', 'https://example.test'], inputIsTTY: false, environment: { PAIRING_CODE: pairingCode }, invocation: {} },
      { route: 'http', args: ['pair', '--control-plane', 'https://example.test'], inputIsTTY: false, environment: {}, invocation: { inboundHttpPairingCode: pairingCode } },
      { route: 'wire', args: ['pair', '--control-plane', 'https://example.test'], inputIsTTY: false, environment: {}, invocation: { inboundWirePairingCode: pairingCode } },
    ]
    for (const entry of alternateEntries) {
      const compositionsBefore = pairingCompositions
      const hiddenReadsBefore = hiddenReads
      const outcome = await execute(entry.args, entry.inputIsTTY, entry.environment, entry.invocation)
      if (outcome === 2 && pairingCompositions === compositionsBefore && hiddenReads === hiddenReadsBefore) {
        recorder.record(`application.entry:${entry.route}:rejected`)
      }
    }
    return { status: 'observed', subject: 'application', result: `application:exit:${exitCode}`, events: recorder.events, output: recorder.output }
  } catch (error) {
    if (error instanceof RunnerApplicationNotImplementedError) {
      return { status: 'missing-production-runtime', subject: 'application', error: error.name }
    }
    throw error
  }
}

export function createTestHomeState(record: (event: string) => void): RunnerHomeState {
  return {
    pairing: {
      reserve: async () => ({ status: 'reserved', reservationId: 'reservation-1' }),
      release: async () => undefined,
      commitPending: async () => 'updated',
      snapshot: async () => ({ state: 'unpaired', record: null }),
      markConfirmationUnknown: async () => 'updated',
      settle: async () => 'updated',
      revoke: async () => 'updated',
    },
    keys: {
      list: async () => [], get: async () => null,
      put: async entry => ({ label: entry.label, provider: entry.provider, lastFour: entry.secret.slice(-4), createdAt: '2026-08-21T00:00:00Z' }),
      remove: async () => undefined,
      injectAs: async () => SecretEnv.empty(),
      injectAsForProvider: async () => ({ status: 'injected', secrets: SecretEnv.empty() }),
    },
    grants: {
      cwdReadBackAvailable: true,
      list: async () => ['/tmp'], grant: async value => value, revoke: async () => undefined,
      resolveGrantedCwd: async value => value, isGrantedRealPath: async () => true,
    },
    configuration: {
      snapshot: async () => ({ revision: 1, profiles: [], endpoints: [] }),
      replace: async (_revision, configuration) => ({ status: 'updated', configuration: { ...configuration, revision: 2 } }),
    },
    policyStore: {
      snapshot: async () => ({ revision: 1, allowlist: { allowlist: { executables: [], recipes: {} }, signature: 'x', keyId: 'key-1' }, trustAnchors: [] }),
      replace: async (_revision, policy) => ({ status: 'updated', policy: { ...policy, revision: 2 } }),
    },
    policy: { allowsExecutable: () => true, recipe: () => null, executables: [], keyId: 'key-1' },
    projects: { create: async project => ({ ...project, revision: 1 }), list: async () => [], get: async () => null, remove: async () => 'missing' },
    receipts: { lookup: async () => ({ status: 'missing' }), claim: async () => ({ status: 'storage-unavailable' }), replace: async () => ({ status: 'storage-unavailable' }), recover: async () => [], compact: async () => undefined },
    audit: { append: async audit => { record(`audit.${audit.kind}`) } },
  }
}

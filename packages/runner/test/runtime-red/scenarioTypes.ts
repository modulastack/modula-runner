import type { RuntimeRedObligation } from './obligationMatrix.js'

export type RuntimeSubject = 'application' | 'pairing' | 'runtime' | 'job-control' | 'launcher' | 'terminal-host' | 'ledger' | 'home'

export type RuntimeOracle = {
  result: string
  require: readonly string[]
  forbid: readonly string[]
  before?: readonly (readonly [string, string])[]
  counts?: Readonly<Record<string, number>>
  outputIncludes?: readonly string[]
  outputExcludes?: readonly string[]
}

export type RuntimeScenario = {
  obligationId: RuntimeRedObligation['id']
  assertion: string
  subject: RuntimeSubject
  fixture: string
  stimulus: string
  oracle: RuntimeOracle
}

export type RuntimeObservation =
  | { status: 'missing-production-runtime'; subject: RuntimeSubject; error: string }
  | {
      status: 'observed'
      subject: RuntimeSubject
      result: string
      events: readonly string[]
      output: readonly string[]
    }

export function observationMatches(observation: RuntimeObservation, oracle: RuntimeOracle): boolean {
  if (observation.status !== 'observed' || observation.result !== oracle.result) return false
  if (!oracle.require.every(required => observation.events.some(event => event.includes(required)))) return false
  if (oracle.forbid.some(forbidden => observation.events.some(event => event.includes(forbidden)))) return false
  if (oracle.before?.some(([first, second]) => {
    const firstIndex = observation.events.findIndex(event => event.includes(first))
    const secondIndex = observation.events.findIndex(event => event.includes(second))
    return firstIndex === -1 || secondIndex === -1 || firstIndex >= secondIndex
  })) return false
  if (oracle.counts && Object.entries(oracle.counts).some(([fragment, expected]) => {
    return observation.events.filter(event => event.includes(fragment)).length !== expected
  })) return false
  const output = observation.output.join('\n')
  if (oracle.outputIncludes && !oracle.outputIncludes.every(required => output.includes(required))) return false
  return !oracle.outputExcludes?.some(forbidden => output.includes(forbidden))
}

export function emptySubjectMutant(scenario: RuntimeScenario): RuntimeObservation {
  return { status: 'observed', subject: scenario.subject, result: scenario.oracle.result, events: [], output: [] }
}

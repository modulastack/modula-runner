import { observeApplicationScenario } from './applicationSubject.js'
import { observeHomeScenario } from './homeSubject.js'
import { observeJobControlScenario } from './jobControlSubject.js'
import { observeLauncherScenario } from './launcherSubject.js'
import { observeLedgerScenario } from './ledgerSubject.js'
import { observePairingScenario } from './pairingSubject.js'
import { observeRuntimeCompositionScenario } from './runtimeCompositionSubject.js'
import { observeTerminalScenario } from './terminalSubject.js'
import type { RuntimeObservation, RuntimeScenario } from './scenarioTypes.js'

export async function observeRuntimeScenario(scenario: RuntimeScenario): Promise<RuntimeObservation> {
  if (scenario.subject === 'application') return observeApplicationScenario(scenario)
  if (scenario.subject === 'pairing') return observePairingScenario(scenario)
  if (scenario.subject === 'runtime') return observeRuntimeCompositionScenario(scenario)
  if (scenario.subject === 'job-control') return observeJobControlScenario(scenario)
  if (scenario.subject === 'launcher') return observeLauncherScenario(scenario)
  if (scenario.subject === 'terminal-host') return observeTerminalScenario(scenario)
  if (scenario.subject === 'ledger') return observeLedgerScenario(scenario)
  return observeHomeScenario(scenario)
}

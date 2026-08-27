import { homedir } from 'node:os'
import path from 'node:path'
import { archiveRunnerAudit } from './fileAuditLifecycle.js'
import { createFileRunnerHome } from './fileRunnerHome.js'
import { createPairingContractService } from './pairingContract.js'
import { createPairingHttpTransport } from './pairingHttpTransport.js'
import { detectPreviewContainment, type PreviewContainment } from './previewContainment.js'
import {
  createRunnerApplication,
  createRunnerRuntime,
  type RunnerApplication,
  type RunnerComposition,
} from './runnerApplication.js'
import type { RunnerClock } from './runtimeClock.js'
import { createSessionJobControl } from './sessionJobControl.js'
import { createUnimplementedSessionLauncher } from './sessionLaunch.js'

export type InstalledRunnerOptions = {
  version: string
  defaultHomeRoot?: string
}

export function createInstalledRunnerApplication(options: InstalledRunnerOptions): RunnerApplication {
  const clock = systemClock()
  const defaultHomeRoot = path.resolve(options.defaultHomeRoot ?? path.join(homedir(), '.modula-runner'))
  const home = createFileRunnerHome({ defaultRoot: defaultHomeRoot, clock })
  const transport = createPairingHttpTransport()
  let containment: PreviewContainment | null = null
  const composition: RunnerComposition = {
    pairing: state => createPairingContractService({ store: state.pairing, transport, clock }),
    sessions: () => createUnimplementedSessionLauncher(),
    jobControl: launcher => createSessionJobControl({ launcher }),
    containmentStatus: () => (containment ??= detectPreviewContainment()).status,
    runtime: createRunnerRuntime({ clock }),
  }
  return createRunnerApplication({
    version: options.version,
    home,
    clock,
    composition,
    auditArchive: {
      archive: (selection, destination) => archiveRunnerAudit({
        runnerHome: path.resolve(selection.override ?? defaultHomeRoot),
        destination,
      }),
    },
  })
}

function systemClock(): RunnerClock {
  return {
    now: Date.now,
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  }
}

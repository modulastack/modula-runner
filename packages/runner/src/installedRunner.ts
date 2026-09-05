import { homedir, hostname } from 'node:os'
import { hasControlCharacter } from '@modulastack/runner-protocol'
import path from 'node:path'
import { archiveRunnerAudit } from './fileAuditLifecycle.js'
import { createFileRunnerHome } from './fileRunnerHome.js'
import { createPairingContractService } from './pairingContract.js'
import { createPairingHttpTransport } from './pairingHttpTransport.js'
import { detectPreviewContainment, type PreviewContainment } from './previewContainment.js'
import {
  createRunnerApplication,
  type RunnerApplication,
  type RunnerComposition,
} from './runnerApplication.js'
import { createProductionRunnerRuntime } from './runnerRuntime.js'
import type { RunnerClock } from './runtimeClock.js'
import { createInstalledSessionRuntime, type InstalledSessionRuntime } from './installedSessionRuntime.js'

export type InstalledRunnerOptions = {
  version: string
  defaultHomeRoot?: string
}

export function createInstalledRunnerApplication(options: InstalledRunnerOptions): RunnerApplication {
  const clock = systemClock()
  const defaultHomeRoot = path.resolve(options.defaultHomeRoot ?? path.join(homedir(), '.modula-runner'))
  const home = createFileRunnerHome({ defaultRoot: defaultHomeRoot, clock })
  const transport = createPairingHttpTransport()
  const runner = installedRunnerInfo(options.version)
  let containment: PreviewContainment | null = null
  let sessions: InstalledSessionRuntime | undefined
  const composition: RunnerComposition = {
    pairing: state => createPairingContractService({ store: state.pairing, transport, clock }),
    sessions: state => (sessions = createInstalledSessionRuntime(state, clock)).launcher,
    jobControl: () => {
      if (!sessions) throw new Error('installed session runtime is unavailable')
      return sessions.jobControl
    },
    containmentStatus: () => (containment ??= detectPreviewContainment()).status,
    runtime: createProductionRunnerRuntime({
      clock,
      runner,
      bindClient: (_home, client, bindingId) => {
        if (!sessions) throw new Error('installed session runtime is unavailable')
        sessions.bind(client, bindingId)
      },
      shutdown: () => sessions?.shutdown() ?? Promise.resolve([]),
    }),
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

function installedRunnerInfo(version: string) {
  const name = hostname()
  const safeName = name.length > 0 && name.length <= 200 && !hasControlCharacter(name) ? name : 'runner'
  return { name: safeName, version, os: process.platform, arch: process.arch }
}

function systemClock(): RunnerClock {
  return { now: Date.now, sleep: abortableSleep }
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, milliseconds)
    signal?.addEventListener('abort', done, { once: true })
  })
}

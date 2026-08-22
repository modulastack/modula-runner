import path from 'node:path'
import { createEncryptedApiKeyStore } from './apiKeys.js'
import { signingKeyOutsideHome } from './allowlistKeyFile.js'
import { createEncryptedPairingContractStore } from './pairingContractStore.js'
import {
  createRunnerHome,
  type RunnerHome,
  type RunnerHomeOpen,
  type RunnerHomeSelection,
} from './runnerHome.js'
import {
  createFileRunnerHomeStorage,
  fileRunnerHomeRecordPath,
  fileRunnerHomeSealingKeyPath,
} from './runnerHomeStorage.js'
import type { RunnerClock } from './runtimeClock.js'

export type FileRunnerHomeOptions = {
  defaultRoot: string
  clock: RunnerClock
  currentUserId?: number
}

export function createFileRunnerHome(options: FileRunnerHomeOptions): RunnerHome {
  let active: RunnerHome | null = null
  return {
    async open(selection): Promise<RunnerHomeOpen> {
      if (active) return { status: 'failed', code: 'state-io-failed' }
      const root = selectedRoot(options.defaultRoot, selection)
      const home = homeFor(options, root)
      const opened = await home.open({ override: root })
      if (opened.status === 'ready') active = home
      return opened
    },
    async initializePolicy(selection, signingKeyPath, policy) {
      if (active) return { status: 'failed', code: 'state-io-failed' }
      const root = selectedRoot(options.defaultRoot, selection)
      if (!signingKeyOutsideHome(signingKeyPath, root)) return { status: 'failed', code: 'state-insecure-mode' }
      return await homeFor(options, root).initializePolicy!({ override: root }, signingKeyPath, policy)
    },
    async close(): Promise<void> {
      if (!active) return
      await active.close?.()
      active = null
    },
  }
}

function homeFor(options: FileRunnerHomeOptions, root: string): RunnerHome {
  const keyPath = fileRunnerHomeSealingKeyPath(root)
  const storage = createFileRunnerHomeStorage({
    defaultRoot: root,
    ...(options.currentUserId === undefined ? {} : { currentUserId: options.currentUserId }),
  })
  return createRunnerHome({
    storage,
    clock: options.clock,
    pairing: createEncryptedPairingContractStore({ path: fileRunnerHomeRecordPath(root, 'pairing'), keyPath }),
    keys: createEncryptedApiKeyStore({ path: fileRunnerHomeRecordPath(root, 'keys'), keyPath }),
  })
}

function selectedRoot(defaultRoot: string, selection: RunnerHomeSelection): string {
  return path.resolve(selection.override ?? defaultRoot)
}

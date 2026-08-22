#!/usr/bin/env node

import { createRequire } from 'node:module'
import { Writable } from 'node:stream'
import { createInterface } from 'node:readline/promises'
import {
  createInstalledRunnerApplication,
  type RunnerCliEnvironment,
  type RunnerCliIo,
  type RunnerCliSignals,
} from '../index.js'

const require = createRequire(import.meta.url)
const manifest = require('../../package.json') as { version?: unknown }
const version = typeof manifest.version === 'string' ? manifest.version : 'unknown'
const application = createInstalledRunnerApplication({ version })
const environment: RunnerCliEnvironment = {}
if (process.env.MODULA_RUNNER_HOME) environment.runnerHome = process.env.MODULA_RUNNER_HOME
if (process.env.MODULA_RUNNER_ENDPOINT_URL) environment.endpointUrl = process.env.MODULA_RUNNER_ENDPOINT_URL

const io: RunnerCliIo = {
  inputIsTTY: Boolean(process.stdin.isTTY),
  readHidden,
  writeStdout(text) {
    process.stdout.write(text)
  },
  writeStderr(text) {
    process.stderr.write(text)
  },
}

try {
  process.exitCode = await application.execute({
    args: process.argv.slice(2),
    cwd: process.cwd(),
    environment,
    io,
    signals: processSignals(),
  })
} catch {
  process.stderr.write('the runner CLI could not complete\n')
  process.exitCode = 1
}

async function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('hidden input requires a TTY')
  process.stderr.write(prompt)
  const muted = new Writable({ write(_chunk, _encoding, done) { done() } })
  const input = createInterface({ input: process.stdin, output: muted, terminal: true })
  try {
    return await input.question('')
  } finally {
    input.close()
    process.stderr.write('\n')
  }
}

function processSignals(): RunnerCliSignals {
  const listeners = new Set<(signal: 'SIGINT' | 'SIGTERM') => void>()
  const onInterrupt = () => notify('SIGINT')
  const onTerminate = () => notify('SIGTERM')
  const notify = (signal: 'SIGINT' | 'SIGTERM') => {
    for (const listener of [...listeners]) listener(signal)
  }
  return {
    subscribe(listener) {
      if (listeners.size === 0) {
        process.on('SIGINT', onInterrupt)
        process.on('SIGTERM', onTerminate)
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          process.off('SIGINT', onInterrupt)
          process.off('SIGTERM', onTerminate)
        }
      }
    },
  }
}

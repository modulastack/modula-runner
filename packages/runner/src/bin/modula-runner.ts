#!/usr/bin/env node

import {
  RunnerApplicationNotImplementedError,
  createUnimplementedRunnerApplication,
  type RunnerCliEnvironment,
  type RunnerCliIo,
} from '../runnerApplication.js'

const application = createUnimplementedRunnerApplication()
const environment: RunnerCliEnvironment = {}
if (process.env.MODULA_RUNNER_HOME) environment.runnerHome = process.env.MODULA_RUNNER_HOME
if (process.env.MODULA_RUNNER_ENDPOINT_URL) environment.endpointUrl = process.env.MODULA_RUNNER_ENDPOINT_URL

const io: RunnerCliIo = {
  inputIsTTY: Boolean(process.stdin.isTTY),
  async readHidden() {
    throw new RunnerApplicationNotImplementedError()
  },
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
  })
} catch (error) {
  const message = error instanceof RunnerApplicationNotImplementedError
    ? error.message
    : 'the runner CLI could not start'
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}

import { spawnSync } from 'node:child_process'

const ansiEscape = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g
const controlCharacter = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g
const urlUserInfo = /(https?:\/\/)[^/@\s]+@/gi

function commandIdentity(command) {
  return String(command).replace(ansiEscape, '').replace(controlCharacter, '').replace(/[^A-Za-z0-9._/-]/g, '?')
}

export function runProcess(command, args, options = {}) {
  const { capture = true, ...spawnOptions } = options
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...spawnOptions,
    stdio: 'pipe',
  })
  if (result.status === 0) {
    if (!capture && result.stdout) process.stdout.write(result.stdout)
    if (!capture && result.stderr) process.stderr.write(result.stderr)
    return result.stdout ?? ''
  }
  const outcome = result.signal ? `signal ${result.signal}` : `exit ${result.status ?? 'unknown'}`
  throw new Error(`${commandIdentity(command)} failed with ${outcome}`)
}

export function safeDiagnostic(error) {
  const message = error instanceof Error ? error.message : 'unexpected failure'
  return message
    .replace(ansiEscape, '')
    .replace(urlUserInfo, '$1[redacted]@')
    .replace(controlCharacter, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000) || 'unexpected failure'
}

export function reportFailure(label, error) {
  process.stderr.write(`${commandIdentity(label)}: ${safeDiagnostic(error)}\n`)
}

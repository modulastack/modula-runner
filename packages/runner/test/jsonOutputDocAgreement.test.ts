import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PAIRING_CONTRACT_FAILURES, RUNNER_HOME_FAILURES } from '../src/index.js'

// Both domains share one public error field, so the docs must pin the typed vocabulary and
// namespace rule together or a valid local code can silently collide at the JSON boundary.

const document = readFileSync(fileURLToPath(new URL('../../../docs/json-output.md', import.meta.url)), 'utf8')
const homePrefixes = ['policy-', 'state-', 'config-', 'audit-'] as const
const pairingPrefixes = ['pairing-'] as const

function sectionAfter(heading: string) {
  const start = document.indexOf(heading)
  expect(start).toBeGreaterThan(-1)
  const next = document.indexOf('\n## ', start)
  return document.slice(start, next === -1 ? undefined : next)
}

function documentedValues(heading: string) {
  const section = sectionAfter(heading)
  return new Set([...section.matchAll(/`([a-z][a-z-]+)`/g)].map(match => match[1] as string))
}

describe('the JSON output contract and the code agree', () => {
  it('documents every runner-home failure the preflight can answer with', () => {
    const documented = documentedValues('## Home preflight error codes')
    const missing = RUNNER_HOME_FAILURES.filter(code => !documented.has(code))

    expect(missing).toEqual([])
  })

  it('documents every pairing-contract failure the runner can answer with', () => {
    const documented = documentedValues('## Pairing contract error codes')
    const missing = PAIRING_CONTRACT_FAILURES.filter(code => !documented.has(code))

    expect(missing).toEqual([])
  })

  it('keeps every failure in its documented domain namespace', () => {
    const namespaceSection = sectionAfter('## `error.code` is one flat vocabulary, and every code is namespaced')
    const documentedPrefixes = new Set([...namespaceSection.matchAll(/`([a-z]+-)`/g)].map(match => match[1] as string))
    const expectedPrefixes = [...homePrefixes, ...pairingPrefixes]
    const unprefixedHome = RUNNER_HOME_FAILURES.filter(code => !homePrefixes.some(prefix => code.startsWith(prefix)))
    const unprefixedPairing = PAIRING_CONTRACT_FAILURES.filter(code => !pairingPrefixes.some(prefix => code.startsWith(prefix)))

    expect(expectedPrefixes.filter(prefix => !documentedPrefixes.has(prefix))).toEqual([])
    expect(unprefixedHome).toEqual([])
    expect(unprefixedPairing).toEqual([])
  })
})

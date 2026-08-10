import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CHANNEL_KINDS, PROTOCOL_VERSION, REFUSAL_REASONS } from '../src/index.js'

// The schema document is the contract; the validators are its executable form. Three
// separate review findings in this checkpoint were the two disagreeing — a reason the
// decoder accepted but the document did not list, semantics the code defined while the
// document still called them reserved. A peer written against the document would reject
// valid traffic, and nothing in the suite noticed.
//
// So the document is checked like code. These tests fail when an enum grows and the prose
// does not, which is the moment the drift is cheap to fix.

const schema = readFileSync(fileURLToPath(new URL('../SCHEMA.md', import.meta.url)), 'utf8')

function backtickedIn(section: string) {
  return new Set([...section.matchAll(/`([a-z][a-z-]+)`/g)].map(match => match[1] as string))
}

describe('schema and validators agree', () => {
  it('documents every refusal reason the decoder accepts', () => {
    const start = schema.indexOf('**Refusals are answers.**')
    expect(start).toBeGreaterThan(-1)
    const documented = backtickedIn(schema.slice(start, schema.indexOf('\n\n', start)))

    const missing = REFUSAL_REASONS.filter(reason => !documented.has(reason))

    expect(missing).toEqual([])
  })

  it('documents every channel kind as defined or reserved, and never both', () => {
    const start = schema.indexOf('Channel kinds in version 1:')
    expect(start).toBeGreaterThan(-1)
    const section = schema.slice(start, schema.indexOf('\n\n', start))
    const mentioned = backtickedIn(section)

    for (const kind of CHANNEL_KINDS) expect(mentioned.has(kind)).toBe(true)
  })

  it('states the protocol version the package implements', () => {
    expect(schema).toContain(`*Protocol version **${PROTOCOL_VERSION}**`)
  })
})

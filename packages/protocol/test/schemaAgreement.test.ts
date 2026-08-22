import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ACCESS_MODES,
  CHANNEL_KINDS,
  CLI_AUTH_STATES,
  ENDPOINT_UNREACHABLE_REASONS,
  LOCAL_ENDPOINT_KINDS,
  PAIRING_CONFIRM_PATH,
  PAIRING_REDEEM_PATH,
  PROTOCOL_VERSION,
  REFUSAL_REASONS,
  SESSION_FAILURE_REASONS,
  SESSION_LAUNCH_PROTOCOL_VERSION,
  SESSION_REFUSAL_REASONS,
} from '../src/index.js'

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

  it('states the active version and the inactive session-launch version separately', () => {
    expect(schema).toContain(`*Protocol version **${PROTOCOL_VERSION}**`)
    expect(schema).toContain(`SESSION_LAUNCH_PROTOCOL_VERSION = ${SESSION_LAUNCH_PROTOCOL_VERSION}`)
  })

  it('documents the adopted pairing routes', () => {
    expect(schema).toContain(PAIRING_REDEEM_PATH)
    expect(schema).toContain(PAIRING_CONFIRM_PATH)
  })

  // Every enum that crosses the wire, not only the two that existed when this file was
  // written. An enum grows one member at a time and the document is updated by whoever
  // remembers to; the point of this file is that nobody has to remember.
  const wireEnums = {
    'Access modes are': ACCESS_MODES,
    'Per-CLI auth states are': CLI_AUTH_STATES,
    'Endpoint kinds are': LOCAL_ENDPOINT_KINDS,
    'An unreachable endpoint names one of': ENDPOINT_UNREACHABLE_REASONS,
    'Session refusal reasons are': SESSION_REFUSAL_REASONS,
    'Session failure reasons are': SESSION_FAILURE_REASONS,
  }

  for (const [marker, members] of Object.entries(wireEnums)) {
    it(`documents every member the decoder accepts after "${marker}"`, () => {
      const start = schema.indexOf(marker)
      expect(start).toBeGreaterThan(-1)
      const documented = backtickedIn(schema.slice(start, schema.indexOf('\n\n', start)))

      const missing = members.filter(member => !documented.has(member))

      expect(missing).toEqual([])
    })
  }
})

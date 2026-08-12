import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ACCESS_REFUSALS } from '../src/index.js'

// The protocol package checks its schema document against its validators, and that convention
// exists because three review findings in one checkpoint were the two disagreeing. The
// runner's own contract document earns the same treatment: `docs/model-access.md` is what the
// acceptance tests cite, and a refusal reason the code can produce but the document does not
// name is a promise nobody can look up.

const document = readFileSync(fileURLToPath(new URL('../../../docs/model-access.md', import.meta.url)), 'utf8')

function sectionAfter(heading: string) {
  const start = document.indexOf(heading)
  expect(start).toBeGreaterThan(-1)
  const next = document.indexOf('\n## ', start)
  return document.slice(start, next === -1 ? undefined : next)
}

describe('the model-access contract and the code agree', () => {
  it('documents every access refusal the resolver can answer with', () => {
    const section = sectionAfter('### Refusals name their reason')
    const documented = new Set([...section.matchAll(/`([a-z][a-z-]+)`/g)].map(match => match[1] as string))

    const missing = ACCESS_REFUSALS.filter(reason => !documented.has(reason))

    expect(missing).toEqual([])
  })
})

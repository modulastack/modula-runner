import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Five separate defects in this package have been the same mistake: an error caught and
// turned into a value that reads as a safe answer. An enumeration failure became "no
// children", an inspection failure became "healthy", an unreadable directory became "the
// process exited". Each was found by review, one per round, and each was locally
// plausible — which is exactly why remembering not to write them does not work.
//
// So the gate asks for a sentence instead. Swallowing an error is often right; doing it
// without saying why is what produced every one of those defects. A comment immediately
// above the catch is cheap, and writing it is the moment the author has to decide whether
// the swallowed case really is safe.

const sourceDirectory = fileURLToPath(new URL('../src', import.meta.url))
const SWALLOWING_CATCH = /\.catch\(\(\)\s*=>/

function sourceFiles() {
  return readdirSync(sourceDirectory)
    .filter(name => name.endsWith('.ts'))
    .map(name => ({ name, lines: readFileSync(`${sourceDirectory}/${name}`, 'utf8').split('\n') }))
}

describe('swallowed errors are justified where they happen', () => {
  it('has a reason written above every catch that discards its error', () => {
    const unexplained = sourceFiles().flatMap(({ name, lines }) =>
      lines.flatMap((line, index) => {
        if (!SWALLOWING_CATCH.test(line)) return []
        const previous = index > 0 ? (lines[index - 1] ?? '').trim() : ''
        return previous.startsWith('//') ? [] : [`${name}:${index + 1}  ${line.trim()}`]
      }),
    )

    expect(unexplained).toEqual([])
  })
})

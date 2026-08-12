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
// The statement form of the same mistake. The rule was written when every swallow in this
// package was a promise handler, so a `try { … } catch {}` discarded its error with nothing
// asked of the author — the guard passed while the defect it exists to prevent stayed
// expressible. Currently zero of these are unexplained, which is exactly when a rule is
// cheap to widen: closing it now costs nothing and stops the next one.
const SWALLOWING_BLOCK = /\}?\s*catch\s*(\(\s*\w+\s*\))?\s*\{\s*$/

function sourceFiles() {
  return readdirSync(sourceDirectory)
    .filter(name => name.endsWith('.ts'))
    .map(name => ({ name, lines: readFileSync(`${sourceDirectory}/${name}`, 'utf8').split('\n') }))
}

function explained(lines: string[], index: number) {
  // Above the catch, or inside an otherwise-empty body — both put the reason where the
  // next reader of this line will look.
  const previous = index > 0 ? (lines[index - 1] ?? '').trim() : ''
  const inside = (lines[index + 1] ?? '').trim()
  return previous.startsWith('//') || inside.startsWith('//')
}

describe('swallowed errors are justified where they happen', () => {
  it('has a reason written above every catch that discards its error', () => {
    const unexplained = sourceFiles().flatMap(({ name, lines }) =>
      lines.flatMap((line, index) => {
        if (!SWALLOWING_CATCH.test(line)) return []
        return explained(lines, index) ? [] : [`${name}:${index + 1}  ${line.trim()}`]
      }),
    )

    expect(unexplained).toEqual([])
  })

  it('has a reason written on every catch block that discards its error', () => {
    const unexplained = sourceFiles().flatMap(({ name, lines }) =>
      lines.flatMap((line, index) => {
        if (!SWALLOWING_BLOCK.test(line)) return []
        // Only an empty body swallows. A catch that does something with the error is
        // answerable for it in the ordinary way, and demanding prose there would train
        // authors to write it without meaning it.
        const body = lines.slice(index + 1).find(candidate => candidate.trim() !== '') ?? ''
        if (!body.trim().startsWith('}')) return []
        return explained(lines, index) ? [] : [`${name}:${index + 1}  ${line.trim()}`]
      }),
    )

    expect(unexplained).toEqual([])
  })
})

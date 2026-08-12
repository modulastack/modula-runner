import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { SECRET_PLACEHOLDER, SecretEnv } from '../src/secretEnv.js'

// The point of this type is that a value cannot be printed by accident, so the tests are
// about the ways a value gets printed by accident: a whole object stringified into a log
// line, a template literal in an error message, an inspect from a debugger or a console.

const KEY = 'sk-test-0123456789abcdef'

describe('secret environments', () => {
  it('renders as a placeholder wherever a value would otherwise be printed', () => {
    const secrets = SecretEnv.of({ ANTHROPIC_API_KEY: KEY })

    const rendered = [
      JSON.stringify({ plan: 'launch', secrets }),
      `${secrets}`,
      inspect({ secrets }, { depth: 5 }),
      inspect(secrets),
    ]

    for (const text of rendered) {
      expect(text).not.toContain(KEY)
      expect(text).toContain(SECRET_PLACEHOLDER)
    }
  })

  it('shows which variables it will set, because a name discloses nothing', () => {
    const secrets = SecretEnv.of({ OPENAI_BASE_URL: 'http://127.0.0.1:11434', ANTHROPIC_API_KEY: KEY })

    expect(secrets.names).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_BASE_URL'])
    expect(secrets.size).toBe(2)
    expect(JSON.stringify(secrets.names)).not.toContain(KEY)
  })

  it('hands the plaintext to one callback and keeps no property holding it', () => {
    const secrets = SecretEnv.of({ ANTHROPIC_API_KEY: KEY })

    expect(secrets.use(entries => entries.ANTHROPIC_API_KEY)).toBe(KEY)
    expect(Object.keys(secrets)).toEqual([])
    expect(JSON.stringify({ ...secrets })).not.toContain(KEY)
  })

  it('refuses a variable two sources disagree about rather than picking a winner', () => {
    const first = SecretEnv.of({ ANTHROPIC_API_KEY: KEY })
    const second = SecretEnv.of({ ANTHROPIC_API_KEY: 'sk-test-fedcba9876543210' })

    expect(() => first.merge(second)).toThrow(/two sources/)
    expect(first.merge(SecretEnv.of({ OPENAI_BASE_URL: 'http://127.0.0.1:11434' })).names).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_BASE_URL'])
  })

  it('refuses what an environment cannot carry', () => {
    expect(() => SecretEnv.of({ 'not a name': KEY })).toThrow(/environment variable name/)
    expect(() => SecretEnv.of({ ANTHROPIC_API_KEY: `sk-${String.fromCharCode(0)}` })).toThrow(/cannot carry|environment/)
    expect(SecretEnv.empty().size).toBe(0)
  })
})

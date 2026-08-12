import { describe, expect, it } from 'vitest'
import { createMemoryApiKeyStore } from '../src/apiKeys.js'
import { runKeyAddCommand, runKeyListCommand, runKeyRemoveCommand, type KeyCommandContext } from '../src/cli.js'

// The local CLI is the only door a key comes through, so these tests are about the door:
// the key is prompted for and never taken from an argument, and nothing the command prints
// is the key. Terminal scrollback outlives the command, which is why the second half
// matters as much as the first.

const SECRET = 'sk-test-0123456789abcdef'

function context(answers: string[] = [SECRET]) {
  const prompts: string[] = []
  const keys = createMemoryApiKeyStore()
  const asked = answers.slice()
  const value: KeyCommandContext = {
    keys,
    readSecret: async prompt => {
      prompts.push(prompt)
      return asked.shift() ?? ''
    },
  }
  return { keys, prompts, context: value }
}

describe('modula-runner key add', () => {
  it('prompts for the key and reports only its fingerprint', async () => {
    const { context: value, prompts, keys } = context()

    const result = await runKeyAddCommand(['work', '--provider', 'anthropic'], value)

    expect(result).toEqual({ exitCode: 0, output: 'stored work for anthropic (****cdef)' })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).not.toContain(SECRET)
    expect(await keys.get('work')).toMatchObject({ label: 'work', provider: 'anthropic', lastFour: 'cdef' })
  })

  it('never takes the key from an argument, however it is offered', async () => {
    const { context: value, prompts, keys } = context()

    const results = await Promise.all([
      runKeyAddCommand(['work', '--provider', 'anthropic', SECRET], value),
      runKeyAddCommand(['work', SECRET], value),
      runKeyAddCommand([], value),
      runKeyAddCommand(['work'], value),
    ])

    for (const result of results) {
      expect(result.exitCode).toBe(2)
      expect(result.output).toContain('never accepted as an argument')
    }
    expect(prompts).toEqual([])
    expect(await keys.list()).toEqual([])
  })

  it('stores nothing when the prompt comes back empty, and says why it refused', async () => {
    const { context: value, keys } = context([''])

    const empty = await runKeyAddCommand(['work', '--provider', 'anthropic'], value)
    const short = await runKeyAddCommand(['work', '--provider', 'anthropic'], context(['sk-short']).context)

    expect(empty).toEqual({ exitCode: 2, output: 'no key was entered, so nothing was stored' })
    expect(short.exitCode).toBe(1)
    expect(short.output).not.toContain('sk-short')
    expect(await keys.list()).toEqual([])
  })
})

describe('modula-runner key list and remove', () => {
  it('lists labels, providers and fingerprints, and marks what was removed', async () => {
    const { context: value, keys } = context([SECRET, 'sk-test-fedcba9876543210'])
    await runKeyAddCommand(['work', '--provider', 'anthropic'], value)
    await runKeyAddCommand(['lab', '--provider', 'openai'], value)
    await keys.remove('lab')

    const listed = await runKeyListCommand([], value)

    expect(listed.output.split('\n')).toEqual(['work  anthropic  ****cdef', 'lab  openai  ****3210  (removed)'])
    expect(listed.output).not.toContain(SECRET)
  })

  it('says what to do when there is nothing to list', async () => {
    expect(await runKeyListCommand([], context().context)).toEqual({
      exitCode: 0,
      output: expect.stringContaining('modula-runner key add'),
    })
  })

  it('records a removal and is honest about the pane that is already running', async () => {
    const { context: value } = context()
    await runKeyAddCommand(['work', '--provider', 'anthropic'], value)

    const removed = await runKeyRemoveCommand(['work'], value)
    const unknown = await runKeyRemoveCommand(['never-added'], value)

    expect(removed.exitCode).toBe(0)
    expect(removed.output).toContain('a pane already running keeps the key it was given')
    expect(unknown.exitCode).toBe(1)
    expect(await runKeyRemoveCommand([], value)).toMatchObject({ exitCode: 2 })
  })
})

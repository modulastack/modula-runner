import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  openedFileCalls,
  requireTracePass,
  traceRepresentativeRunner,
  type TraceResult,
} from './securityTraceHarness.js'

let directory = ''
let claudeCanary = ''
let codexCanary = ''
let trace: TraceResult

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'runner-auth-trace-'))
  claudeCanary = join(directory, '.claude', 'auth-canary')
  codexCanary = join(directory, '.codex', 'auth-canary')
  await mkdir(join(directory, '.claude'), { recursive: true })
  await mkdir(join(directory, '.codex'), { recursive: true })
  await writeFile(claudeCanary, 'claude-canary')
  await writeFile(codexCanary, 'codex-canary')
  trace = await traceRepresentativeRunner({ workspace: directory, claudeCanary, codexCanary })
}, 30_000)

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

describe('CP-5 IC-4 runner-process auth-store tracing', () => {
  it('AS-25 attributes no Claude or Codex auth-store open to the representative runner PID', () => {
    if (process.platform !== 'linux') {
      expect(trace).toEqual(expect.objectContaining({ status: 'inconclusive', capability: 'linux-procfs' }))
      expect(() => requireTracePass(trace)).toThrow(/INCONCLUSIVE \(linux-procfs\)/)
      return
    }
    requireTracePass(trace)
    expect(openedFileCalls(trace.runnerTrace)).not.toContain(claudeCanary)
    expect(openedFileCalls(trace.runnerTrace)).not.toContain(codexCanary)
  })

  it('AS-26 observes the CLI fixture auth reads only in descendant PID traces', () => {
    if (process.platform !== 'linux') {
      expect(trace).toEqual(expect.objectContaining({ status: 'inconclusive', capability: 'linux-procfs' }))
      expect(() => requireTracePass(trace)).toThrow(/INCONCLUSIVE \(linux-procfs\)/)
      return
    }
    requireTracePass(trace)
    expect(openedFileCalls(trace.descendantTrace)).toContain(claudeCanary)
    expect(openedFileCalls(trace.descendantTrace)).toContain(codexCanary)
    expect(openedFileCalls(trace.runnerTrace)).not.toContain(claudeCanary)
    expect(openedFileCalls(trace.runnerTrace)).not.toContain(codexCanary)
  })

  it('AS-27 makes unavailable syscall tracing explicitly INCONCLUSIVE and non-green', async () => {
    const result = await traceRepresentativeRunner({
      workspace: directory,
      claudeCanary,
      codexCanary,
      stracePath: join(directory, 'missing-strace'),
    })
    if (process.platform !== 'linux') {
      expect(result).toEqual(expect.objectContaining({ status: 'inconclusive', capability: 'linux-procfs' }))
      expect(() => requireTracePass(result)).toThrow(/INCONCLUSIVE \(linux-procfs\)/)
      return
    }
    expect(result).toEqual(expect.objectContaining({ status: 'inconclusive', capability: 'syscall-tracing' }))
    expect(() => requireTracePass(result)).toThrow(/INCONCLUSIVE \(syscall-tracing\)/)
  })
})

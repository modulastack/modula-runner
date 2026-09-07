import { mkdtemp, rm } from 'node:fs/promises'
import { constants as osConstants, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_FLOW,
  DEFAULT_REPLAY_LINES,
  TerminalSession,
  createSpawnSeam,
  type AuditLog,
  type AuditRecord,
  type SpawnOutcome,
  type SpawnSeam,
} from '../src/index.js'
import { permissiveConsent, recordingAudit } from './spawnSeamSupport.js'

const tmux = vi.hoisted(() => ({
  killResults: [] as boolean[],
  killTmuxSession: vi.fn(async () => tmux.killResults.shift() ?? true),
}))

vi.mock('../src/tmux.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/tmux.js')>(),
  killTmuxSession: tmux.killTmuxSession,
}))

type RecordingAudit = AuditLog & { records: AuditRecord[] }
type SessionRig = { directory: string; session: TerminalSession; exited: Promise<void> }
type SpawnAdmission = Extract<AuditRecord, { kind: 'spawn-admitted' }>
type SpawnOutcomeRecord = Extract<AuditRecord, { kind: 'spawn-outcome' }>
type SessionConstructor = new (init: {
  spec: { command: string; cwd: string; profile: string }
  ref: { socket: string; sessionName: string }
  exitDir: string
  policy: { flow: typeof DEFAULT_FLOW; replayLines: number; pollMs: number }
  events: { send: () => void; onExited: () => void }
  seam: SpawnSeam
  paneComplete: (outcome: SpawnOutcome) => Promise<void>
}) => TerminalSession

const active: SessionRig[] = []

beforeEach(() => {
  tmux.killResults.splice(0)
  tmux.killTmuxSession.mockClear()
})

afterEach(async () => {
  for (const rig of active.splice(0)) {
    await rig.session.dispose(false)
    await rm(rig.directory, { recursive: true, force: true })
  }
})

function policy() {
  return {
    allowsExecutable: (executable: string) => executable === process.execPath || executable === 'tmux',
    recipe: () => null,
    executables: [process.execPath, 'tmux'],
    keyId: 'terminal-session',
  }
}

async function createSession(audit: RecordingAudit): Promise<SessionRig> {
  const directory = await mkdtemp(join(tmpdir(), 'terminal-session-'))
  const seam = createSpawnSeam({ policy: policy(), audit, consent: permissiveConsent([directory]) })
  const admission = await seam.authorize({ kind: 'pane', executable: process.execPath, cwd: directory, grantScoped: true })
  if (admission.status !== 'admitted') throw new Error('pane was not admitted')
  let onExited!: () => void
  const exited = new Promise<void>(resolve => { onExited = resolve })
  const Session = TerminalSession as unknown as SessionConstructor
  const session = new Session({
    spec: { command: process.execPath, cwd: directory, profile: 'shell' },
    ref: { socket: 'terminal-session', sessionName: 'pane' },
    exitDir: directory,
    policy: { flow: DEFAULT_FLOW, replayLines: DEFAULT_REPLAY_LINES, pollMs: 20 },
    events: { send: () => undefined, onExited },
    seam,
    paneComplete: admission.authorization.complete,
  })
  const rig = { directory, session, exited }
  active.push(rig)
  return rig
}

function paneOutcomes(records: AuditRecord[]): SpawnOutcome[] {
  const paneIds = new Set(records
    .filter((record): record is SpawnAdmission => record.kind === 'spawn-admitted')
    .filter(record => record.spawnKind === 'pane')
    .map(record => record.spawnId))
  return records
    .filter((record): record is SpawnOutcomeRecord => record.kind === 'spawn-outcome')
    .filter(record => paneIds.has(record.spawnId))
    .map(record => record.outcome)
}

function failingPaneOutcomeAudit(): RecordingAudit & { attempts: number } {
  const audit: RecordingAudit & { attempts: number; paneId?: string } = {
    records: [],
    attempts: 0,
    append: async record => {
      if (record.kind === 'spawn-admitted' && record.spawnKind === 'pane') audit.paneId = record.spawnId
      if (record.kind === 'spawn-outcome' && record.spawnId === audit.paneId) {
        audit.attempts += 1
        throw new Error('pane outcome append failed')
      }
      audit.records.push(record)
    },
  }
  return audit
}

const terminated = { exitCode: null, signal: osConstants.signals.SIGKILL }

describe('TerminalSession audit outcomes', () => {
  it('records a terminated pane when tmux kills it without an exit file', async () => {
    const audit = recordingAudit()
    const { session, exited } = await createSession(audit)

    session.kill()
    await exited

    expect(tmux.killTmuxSession).toHaveBeenCalled()
    expect(paneOutcomes(audit.records)).toEqual([terminated])
  })

  it('records exactly one terminated outcome after a confirmed dispose kill', async () => {
    const audit = recordingAudit()
    const { session } = await createSession(audit)

    expect(await session.dispose(true)).toBe(true)
    expect(paneOutcomes(audit.records)).toEqual([terminated])
  })

  it('does not record a second outcome when the pane already completed', async () => {
    const audit = recordingAudit()
    const { session, exited } = await createSession(audit)
    session.kill()
    await exited
    const completed = paneOutcomes(audit.records)
    expect(completed).toHaveLength(1)

    expect(await session.dispose(true)).toBe(true)
    expect(paneOutcomes(audit.records)).toEqual(completed)
  })

  it('does not record an outcome when disposal releases the session', async () => {
    const audit = recordingAudit()
    const { session } = await createSession(audit)

    expect(await session.dispose(false)).toBe(true)
    expect(tmux.killTmuxSession).not.toHaveBeenCalled()
    expect(paneOutcomes(audit.records)).toEqual([])
  })

  it('returns true when the confirmed kill outcome cannot be appended', async () => {
    const audit = failingPaneOutcomeAudit()
    const { session } = await createSession(audit)

    expect(await session.dispose(true)).toBe(true)
    expect(audit.attempts).toBeGreaterThan(0)
    expect(paneOutcomes(audit.records)).toEqual([])
  })

  it('returns false and records no outcome when the kill is unconfirmed', async () => {
    const audit = recordingAudit()
    const { session } = await createSession(audit)
    tmux.killResults.push(false)

    expect(await session.dispose(true)).toBe(false)
    expect(paneOutcomes(audit.records)).toEqual([])
  })
})

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { killTmuxSession, startTmuxSession, watchPane, type PaneStatus, type TmuxRef } from '../src/tmux.js'
import { permissiveSpawnSeam } from './spawnSeamSupport.js'
import { until } from './helpers.js'

// The shared pane watcher is what turns a dead pane into EXIT — and what must NOT retire a
// live one. Its listing is parsed from tmux's own output, so this pins the record shape
// against the installed tmux rather than a fixture: tmux rewrites control characters in
// command output (3.6 prints a tab as `_`), which once made every session parse as absent.

const seam = permissiveSpawnSeam()
const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

async function startWatched(sessionName: string) {
  const socket = `mr-watch-${randomBytes(4).toString('hex')}`
  const cwd = mkdtempSync(path.join(tmpdir(), 'mr-watch-'))
  const ref: TmuxRef = { socket, sessionName }
  await startTmuxSession({ ...ref, cwd, file: '/bin/sh', args: ['-c', 'read line'] }, seam)
  const observed: PaneStatus[] = []
  const unwatch = watchPane(ref, 50, status => observed.push(status), seam)
  cleanups.push(() => {
    unwatch()
    spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' })
    rmSync(cwd, { recursive: true, force: true })
  })
  return { ref, observed }
}

describe('tmux pane watcher', () => {
  it('reports a live pane alive and a finished pane dead', async () => {
    const { ref, observed } = await startWatched(`mr-${randomBytes(6).toString('hex')}-s1`)
    await until(() => observed.length >= 3)
    expect(observed.every(status => !status.dead && !status.held)).toBe(true)
    // remain-on-exit keeps the pane; the watcher, not the session's absence, must notice.
    spawnSync('tmux', ['-L', ref.socket, 'send-keys', '-t', `=${ref.sessionName}:`, 'Enter'], { stdio: 'ignore' })
    await until(() => observed.at(-1)?.dead === true)
    expect(await killTmuxSession(ref, seam)).toBe(true)
  })

  it('keys the listing by the whole session name, spaces included', async () => {
    const { observed } = await startWatched(`mr ${randomBytes(4).toString('hex')} spaced name`)
    await until(() => observed.length >= 3)
    expect(observed.every(status => !status.dead)).toBe(true)
  })
})

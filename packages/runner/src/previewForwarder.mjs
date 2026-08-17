// Runs INSIDE a preview's network namespace (spawned by previewContainment). The runner cannot
// re-enter an unprivileged child's netns, so reachability is bridged the one way that works
// unprivileged: a host-loopback listening socket is created by the runner and inherited here as
// fd 3 (a socket keeps its creation-namespace affinity, so this in-netns process services host
// loopback). This relays host-loopback:H <-> the preview's own loopback:P, which lives only inside
// this namespace. The preview's bind — even 0.0.0.0 — is unreachable off-machine; only this
// loopback forward is host-visible, and it is bound to 127.0.0.1, so it is not reachable off-machine
// either. argv after the script path is the preview command and its arguments.

import net from 'node:net'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const HOST_LOOPBACK_FD = 3
const LISTEN_STATE = '0A'
const POLL_MS = 25
const NEVER_BOUND_LIMIT = 400
const DRAINED_LIMIT = 8

// argv: [node, previewForwarder.mjs, previewCommand, ...previewArgs] — the preview starts at [2].
// Detached so the preview leads its own process group: a refusal that ends this forwarder can then
// kill the whole preview group, and a same-group descendant with it. Detaching changes only the
// group, not the parent, so the runner's own descendant-based teardown of the forwarder still
// reaches it.
const previewArgv = process.argv.slice(2)
const preview = spawn(previewArgv[0], previewArgv.slice(1), { stdio: 'ignore', detached: true })
let previewAlive = true
// The direct child's own end, propagated when the forwarder finishes: the runner tracks the
// forwarder as the tree root, so exiting 0 unconditionally would report every preview as a clean
// exit and lose a nonzero code or a killing signal.
let previewExit = { code: 0, signal: null }
preview.on('exit', (code, signal) => { previewAlive = false; previewExit = { code, signal } })
preview.on('error', () => { previewAlive = false; previewExit = { code: 1, signal: null } })

function finishAsPreview() {
  if (previewExit.signal) process.kill(process.pid, previewExit.signal)
  else process.exit(previewExit.code ?? 0)
}

// Unix does not reap a child when its parent exits, so a refusal that exited without this would
// leave the preview running with its tracked forwarder gone — off the runner's kill accounting.
// The preview leads its own group (spawned detached), so the group kill reaches a same-group
// descendant too.
function exitRefusing(code) {
  if (previewAlive && preview.pid) {
    try {
      process.kill(-preview.pid, 'SIGKILL')
    } catch {
      try {
        preview.kill('SIGKILL')
      } catch {}
    }
  }
  process.exit(code)
}

// The preview's distinct TCP listening ports, read from this namespace's own socket table. The
// namespace starts with only loopback and nothing bound, so a LISTEN row is the preview's; the
// host-loopback forward socket is not here (it belongs to the host namespace it was created in).
// Read on demand so a descendant that double-forks, calls setsid and binds AFTER the direct child
// exits is still served — the property AS-32 turns on, which ancestry tracking cannot see but the
// namespace still holds. Ports are deduped across the v4 and v6 tables so a dual-stack bind of one
// port is one port.
function listeningPorts() {
  const ports = new Set()
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text
    try {
      text = readFileSync(table, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n').slice(1)) {
      const columns = line.trim().split(/\s+/)
      const local = columns[1]
      if (columns[3] === LISTEN_STATE && local) ports.add(parseInt(local.split(':')[1], 16))
    }
  }
  return [...ports]
}

let exposed = false
let neverBoundPolls = 0
let drainedPolls = 0
const watch = setInterval(() => {
  const ports = listeningPorts()
  // Enumeration order does not say which listener is the preview, so a namespace holding several
  // TCP listeners is refused, not guessed — the same rule PreviewHost.judge applies to an
  // uncontained tree (`ambiguous-listener`). Exiting refuses the preview through the host.
  if (ports.length > 1) exitRefusing(5)
  if (ports.length === 1 && !exposed) exposeForward()
  if (exposed) {
    // Once serving, exit only when the direct child has gone AND nothing in the namespace is
    // listening, sustained — so a brief rebind gap is not mistaken for the service being over.
    drainedPolls = !previewAlive && ports.length === 0 ? drainedPolls + 1 : 0
    if (drainedPolls > DRAINED_LIMIT) finishAsPreview()
  } else if (++neverBoundPolls > NEVER_BOUND_LIMIT) {
    // Nothing has bound within the whole readiness budget. The direct child exiting does NOT cut
    // this short: a descendant that double-forks and calls setsid binds after its launcher is gone
    // (AS-32), so the namespace is kept up for the full window rather than torn down at the first
    // childless poll, which would race a slow reparented bind out of existence.
    exitRefusing(3)
  }
}, POLL_MS)

function exposeForward() {
  exposed = true
  const server = net.createServer(downstream => {
    const ports = listeningPorts()
    if (ports.length !== 1) {
      downstream.destroy()
      return
    }
    const upstream = net.connect(ports[0], '127.0.0.1')
    const stop = () => {
      downstream.destroy()
      upstream.destroy()
    }
    downstream.on('error', stop)
    upstream.on('error', stop)
    downstream.pipe(upstream)
    upstream.pipe(downstream)
  })
  server.on('error', () => exitRefusing(4))
  server.listen({ fd: HOST_LOOPBACK_FD })
}

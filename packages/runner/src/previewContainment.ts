import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { readFileSync, readlinkSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { fileURLToPath } from 'node:url'

// Preview containment (ROADMAP "Now", operator BLOCK-B/C). Today a preview that binds off the
// runner's loopback is *detected and stopped*, which leaves a real window where an off-loopback
// listener is reachable before it is killed. This makes such a listener *unreachable* on Linux for
// the preview's whole lifetime, a stronger promise. The mechanism is a network namespace: the
// preview runs in a fresh netns whose only interface is loopback, so a bind to `0.0.0.0` still
// succeeds — the operator ruled prevention as unreachability, not a refused syscall — but nothing
// outside the namespace can route to it.
//
// Reachability is the hard half. A loopback-only netns is unreachable in BOTH directions, and an
// unprivileged runner cannot re-enter a child's user-owned netns, so the operator's own preview
// would be as unreachable as an attacker's. The one bridge that works unprivileged: a socket keeps
// the network namespace it was created in, so the runner creates a host-loopback listening socket
// and hands its descriptor to a tiny forwarder that runs inside the netns (previewForwarder.mjs).
// The forwarder services that host-loopback socket and relays to the preview's loopback. The result
// the runner reports is the host-loopback forward — bound `127.0.0.1`, reachable by the runner host,
// unreachable off-machine — while the preview's own bind lives only inside the namespace.
//
// It is honest about its limits. Where the kernel denies an unprivileged user+network namespace,
// there is no prevention to offer, so the runner degrades to detect-and-stop and *says so* — a
// containment that silently became detection would be worse than one that never claimed to exist.
// On macOS there is no clean equivalent at all, so the runner makes only the detect-and-stop
// promise. It never claims namespace prevention there, but it still runs bounded local inspection
// and tears down host-visible non-loopback listeners.

export type ContainmentDisposition =
  // OS-level prevention is active: previews run in a loopback-only network namespace.
  | 'network-namespace'
  // The host denied namespace creation; previews run under detect-and-stop only, stated plainly.
  | 'detect-and-stop'

export type ContainmentStatus = {
  disposition: ContainmentDisposition
  platform: NodeJS.Platform
  // True only when OS-level prevention (the network namespace) is active. False under the
  // fallback and on an unsupported platform, so a caller can never read the fallback as prevention.
  prevention: boolean
  // Plain-language statement for the local security surface, so "active", "unavailable on this
  // host", and "not applicable on this platform" are never conflated.
  detail: string
}

export type ContainedSpawn = {
  command: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface PreviewContainment {
  readonly status: ContainmentStatus
  // Launch the preview. Under prevention it runs in the loopback-only netns behind the host-loopback
  // forwarder; otherwise it is spawned directly so detect-and-stop governs it. The result is
  // awaitable rather than strictly async: the network-namespace unit must bring up a host-loopback
  // socket before it spawns and so resolves a promise, while a direct spawn has nothing to await and
  // returns the handle. The returned handle is the tree root the runner tracks and can signal.
  spawn(spec: ContainedSpawn): ChildProcess | Promise<ChildProcess>
}

const NETNS_UNSHARE_ARGS = ['--user', '--map-root-user', '--net', '--'] as const
// `--map-root-user` is what lets an unprivileged runner configure `lo` inside the new namespace.
const LOOPBACK_UP = 'ip link set lo up'
const FORWARDER_PATH = fileURLToPath(new URL('./previewForwarder.mjs', import.meta.url))

export type ContainmentOptions = {
  // Test seam: force a disposition without depending on the host's kernel policy, so denial and
  // the macOS branch are exercisable on a capable machine. Absent, the disposition is detected.
  forceDisposition?: ContainmentDisposition
  platform?: NodeJS.Platform
}

export function detectPreviewContainment(options: ContainmentOptions = {}): PreviewContainment {
  const platform = options.platform ?? process.platform
  const disposition = options.forceDisposition ?? detectDisposition(platform)
  if (disposition === 'network-namespace') return namespaceContainment(platform)
  return fallbackContainment(disposition, platform)
}

function detectDisposition(platform: NodeJS.Platform): ContainmentDisposition {
  if (platform !== 'linux') return 'detect-and-stop'
  return namespaceContainmentAvailable() ? 'network-namespace' : 'detect-and-stop'
}

function namespaceContainment(platform: NodeJS.Platform): PreviewContainment {
  return {
    status: {
      disposition: 'network-namespace',
      platform,
      prevention: true,
      detail: 'OS preview containment is active: previews run in a loopback-only network namespace, reachable only through the runner host loopback.',
    },
    spawn: spawnContained,
  }
}

function fallbackContainment(disposition: 'detect-and-stop', platform: NodeJS.Platform): PreviewContainment {
  const detail = platform === 'linux'
    ? 'OS preview containment is unavailable on this host (namespace creation denied); previews run under detect-and-stop only.'
    : `OS preview namespace prevention is unavailable on this platform (${platform}); previews run under detect-and-stop only.`
  return { status: { disposition, platform, prevention: false, detail }, spawn: spawnDirect }
}

// The neutral default: no OS containment, previews spawned directly and left to detect-and-stop.
// This is the honest posture whenever real containment is not configured or not available, and it
// is what a PreviewHost falls back to when no containment is injected — never a silent claim of
// prevention. `detectPreviewContainment` selects between this and the network-namespace unit.
export function passthroughContainment(platform: NodeJS.Platform = process.platform): PreviewContainment {
  return {
    status: {
      disposition: 'detect-and-stop',
      platform,
      prevention: false,
      detail: 'OS preview containment is not active; previews run under detect-and-stop only.',
    },
    spawn: spawnDirect,
  }
}

function spawnDirect(spec: ContainedSpawn): ChildProcess {
  return spawn(spec.command, [...spec.args], { cwd: spec.cwd, env: spec.env, stdio: 'ignore', detached: true })
}

// Bring up the loopback-only netns and hand the preview to the in-netns forwarder. The host-loopback
// listening socket is created here, in the host namespace, so it keeps host-loopback affinity; the
// forwarder inherits it as fd 3 and services it from inside the netns. The runner's own copy is
// closed once the child holds it — the child's inherited descriptor keeps the socket alive.
async function spawnContained(spec: ContainedSpawn): Promise<ChildProcess> {
  const bridge = await hostLoopbackListener()
  try {
    const child = spawn(
      'unshare',
      [...NETNS_UNSHARE_ARGS, 'sh', '-c', `${LOOPBACK_UP}; exec "$@"`, 'sh', process.execPath, FORWARDER_PATH, spec.command, ...spec.args],
      { cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'ignore', 'ignore', bridge.fd], detached: true },
    )
    return child
  } finally {
    bridge.server.close()
  }
}

async function hostLoopbackListener(): Promise<{ server: Server; fd: number }> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, resolve)
  })
  // No public API hands off a listening socket's descriptor to a process across an `unshare`; the
  // internal handle's fd is the descriptor the forwarder inherits and services from the netns.
  const fd = (server as unknown as { _handle?: { fd?: number } })._handle?.fd
  if (typeof fd !== 'number' || fd < 0) {
    server.close()
    throw new Error('host loopback listener exposed no descriptor to hand to the containment forwarder')
  }
  return { server, fd }
}

// Whether this host can create the unprivileged user+network namespace the containment needs.
// Probed by running the real wrapper once — a policy sysctl can say one thing and seccomp or a
// hardened container say another, and creating the namespace is only half the requirement: the
// loopback the runner reaches the preview through must come up too. The only honest test is the
// operation itself, so the probe brings `lo` up exactly as a contained preview would.
export function namespaceContainmentAvailable(): boolean {
  if (process.platform !== 'linux') return false
  const probe = spawnSync('unshare', [...NETNS_UNSHARE_ARGS, 'sh', '-c', LOOPBACK_UP], { stdio: 'ignore' })
  return probe.status === 0
}

// Whether the process's OWN network namespace holds a TCP listener, read from its `/proc/<pid>/net`
// tables. For a contained preview this is the preview having actually bound inside the namespace —
// the real readiness signal — as opposed to the host-loopback bridge socket the runner hands in,
// which is listening from the moment it is created and so cannot tell a bound preview from a
// starting one.
export function namespaceHasListener(pid: number): boolean {
  if (process.platform !== 'linux') return false
  for (const table of ['tcp', 'tcp6']) {
    let text: string
    try {
      text = readFileSync(`/proc/${pid}/net/${table}`, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n').slice(1)) {
      if (line.trim().split(/\s+/)[3] === '0A') return true
    }
  }
  return false
}

// A process's network namespace identity, read from `/proc/<pid>/ns/net`, or null where it cannot
// be read (not Linux, gone, or forbidden). Two pids share a namespace iff these match, which is
// how a caller can tell a contained preview from an uncontained one.
export function networkNamespaceOf(pid: number | 'self'): string | null {
  if (process.platform !== 'linux') return null
  try {
    return readlinkSync(`/proc/${pid}/ns/net`)
  } catch {
    return null
  }
}

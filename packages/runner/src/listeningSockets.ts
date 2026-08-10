import { execFile } from 'node:child_process'
import { readFile, readdir, readlink, realpath } from 'node:fs/promises'
import { promisify } from 'node:util'

// What is this process tree actually listening on? Asking the operating system is the
// only answer that survives a command binding more than it was told to, and it is the
// same question for both things the preview host needs to know: which port to report, and
// whether anything off this machine can reach it.
//
// A preview command routinely execs or forks — a package runner starting a dev server is
// the common case — so the whole descendant tree is inspected, not just the direct child.

const execFileAsync = promisify(execFile)
const LSOF_TIMEOUT_MS = 2_000
const PS_TIMEOUT_MS = 2_000
const LISTEN_STATE = '0A'

export type ListeningSocket = {
  address: string
  port: number
  protocol: 'tcp' | 'udp'
}

// The whole tree is always enumerated, never short-circuited on the root's own sockets.
// Stopping early would let a process bind loopback itself and hand an exposed socket to a
// child, and the caller would approve a tree it never looked at. Polling cost is managed
// by backing the poll off, not by looking at less.
export async function listeningSocketsFor(pid: number, notOlderThan = Date.now()): Promise<ListeningSocket[]> {
  return (await listeningSocketsForMany([pid], notOlderThan)).get(pid) ?? []
}

// The SNAPSHOT is shared, not a scan keyed on one exact set of roots. Keying on the roots
// meant only identical calls joined, so sixteen previews polling for readiness — each with
// a different root — still produced sixteen full process-table reads per interval. What
// every caller actually needs is the same view of the machine, taken once.
let inFlightSnapshot: { startedAt: number; work: Promise<MachineSnapshot> } | null = null

type MachineSnapshot = {
  parents: Map<number, number>
  groups: Map<number, number>
  rows: SocketRow[]
}

// A caller may only join a scan that began after the moment it cares about. Sharing
// unconditionally handed a just-spawned process a view of the machine taken before it
// existed, which does not report a wrong answer but does add a poll of latency to every
// concurrent start — enough, under load, to push one past its readiness timeout and
// surface as a spawn failure that never happened.
function machineSnapshot(notOlderThan: number): Promise<MachineSnapshot> {
  if (inFlightSnapshot && inFlightSnapshot.startedAt >= notOlderThan) return inFlightSnapshot.work
  const startedAt = Date.now()
  const work = takeSnapshot().finally(() => {
    if (inFlightSnapshot?.work === work) inFlightSnapshot = null
  })
  inFlightSnapshot = { startedAt, work }
  return work
}

async function takeSnapshot(): Promise<MachineSnapshot> {
  const [parents, groups] = await Promise.all([
    process.platform === 'linux' ? parentsByPid() : parentsByPs(),
    groupsByPid(),
  ])
  const rows = process.platform === 'linux' ? await linuxListenRows() : []
  return { parents, groups, rows }
}

// One snapshot serves every root. Scanning the process table once per preview multiplied
// the cost by the number of previews and made a sweep slower than the interval that
// schedules it; the answer to "what is each of these trees listening on" is one read.
export async function listeningSocketsForMany(roots: readonly number[], notOlderThan = Date.now()): Promise<Map<number, ListeningSocket[]>> {
  const result = new Map<number, ListeningSocket[]>()
  if (roots.length === 0) return result
  const { parents, groups, rows } = await machineSnapshot(notOlderThan)
  const trees = new Map<number, number[]>()
  for (const root of roots) trees.set(root, treeFrom(root, parents, groups))
  const inodes = process.platform === 'linux' ? await inodesByPid([...new Set([...trees.values()].flat())]) : new Map()
  if (process.platform === 'linux') {
    for (const [root, tree] of trees) result.set(root, matchLinux(tree, inodes, rows))
    return result
  }
  // One lsof for every tree at once. A subprocess per preview, each with its own timeout,
  // turned a sweep into tens of seconds at the concurrency this host already allows.
  const byPid = await lsofByPid([...new Set([...trees.values()].flat())])
  for (const [root, tree] of trees) {
    result.set(root, tree.flatMap(pid => byPid.get(pid) ?? []))
  }
  return result
}

// KNOWN LIMIT — ownership is reconstructed from current ancestry and process group, and
// both are properties a process can leave. A descendant that double-forks and calls setsid
// is reparented to init and starts its own session, after which it appears in neither and
// this function cannot see it. Nothing at this layer closes that: an OS containment unit
// whose membership survives reparenting and session changes is the only mechanism that
// does, and there is no clean equivalent on every platform this version supports.
//
// The consequence is stated in packages/protocol/SCHEMA.md rather than implied here: what
// the runner guarantees is that a listener in a tree it can still see is found and
// terminated, not that an off-loopback listener cannot exist.
function treeFrom(root: number, parents: Map<number, number>, groups: Map<number, number>) {
  const tree = new Set<number>([root])
  for (const [pid, parent] of parents) {
    if (pid !== root && descendsFrom(pid, parent, parents, root)) tree.add(pid)
  }
  // Group membership catches what ancestry loses to reparenting.
  for (const [pid, pgid] of groups) if (pgid === root) tree.add(pid)
  return [...tree]
}

function matchLinux(tree: number[], inodes: Map<number, Set<string>>, rows: SocketRow[]) {
  const owned = new Set<string>()
  for (const pid of tree) for (const inode of inodes.get(pid) ?? []) owned.add(inode)
  return rows.filter(row => owned.has(row.inode)).map(({ address, port, protocol }) => ({ address, port, protocol }))
}

type SocketRow = { address: string; port: number; inode: string; protocol: 'tcp' | 'udp' }

// The working directory of a running process. Linux exposes it as a symlink; macOS answers
// through lsof. Returning null means "could not determine" and never "it is fine" — the
// caller refuses on null, because an unverifiable directory is exactly the case a grant
// check exists to catch.
export async function workingDirectoryOf(pid: number): Promise<string | null> {
  // Null means undetermined; the caller refuses on null rather than allowing.
  // Null means undetermined, and the caller refuses on null rather than allowing.
  if (process.platform === 'linux') return await realpath(`/proc/${pid}/cwd`).catch(() => null)
  if (process.platform !== 'darwin') return null
    // Empty output cannot be told from a failed call, and both mean undetermined.
  // Empty output is indistinguishable from a failed call here, and both mean undetermined.
  const { stdout } = await execFileAsync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: LSOF_TIMEOUT_MS })
  // Same rule at the end of the chain: an unresolvable path is not an approved one.
    .catch(() => ({ stdout: '' }))
  const line = stdout.split('\n').find(entry => entry.startsWith('n'))
  // Same rule at the end of the chain: an unresolvable path is not an approved one.
  return line ? await realpath(line.slice(1)).catch(() => null) : null
}

export async function processGroups() {
  return await groupsByPid()
}

async function groupsByPid() {
  if (process.platform !== 'linux') return await groupsByPs()
  const groups = new Map<number, number>()
  for (const [pid, fields] of await procStatFields()) {
    const pgid = Number(fields[2] ?? Number.NaN)
    if (Number.isInteger(pgid)) groups.set(pid, pgid)
  }
  return groups
}

// Ownership after reparenting rests on the process group, so Darwin needs it too —
// without it a detached child adopted by init escapes monitoring entirely on a platform
// this version supports.
async function groupsByPs() {
  const groups = new Map<number, number>()
  const { stdout } = await execFileAsync('ps', ['-Ao', 'pid=,pgid='], { timeout: PS_TIMEOUT_MS })
  for (const line of stdout.split('\n')) {
    const [pid, pgid] = line.trim().split(/\s+/).map(Number)
    if (Number.isInteger(pid) && Number.isInteger(pgid)) groups.set(pid as number, pgid as number)
  }
  return groups
}

async function inodesByPid(pids: number[]) {
  const byPid = new Map<number, Set<string>>()
  for (const pid of pids) byPid.set(pid, await socketInodes([pid]))
  return byPid
}

// UDP is bound, never "listening", so it has no LISTEN state to filter on — every UDP row
// with a local address is a socket the world can reach. Scanning only TCP let a preview
// serve its expected port on loopback while exposing UDP on every interface, and the
// verdict called that safe.
async function linuxListenRows() {
  return [
    ...parseProcNet(await readFileOrNull('/proc/net/tcp'), decodeIpv4, 'tcp', LISTEN_STATE),
    ...parseProcNet(await readFileOrNull('/proc/net/tcp6'), decodeIpv6, 'tcp', LISTEN_STATE),
    ...parseProcNet(await readFileOrNull('/proc/net/udp'), decodeIpv4, 'udp'),
    ...parseProcNet(await readFileOrNull('/proc/net/udp6'), decodeIpv6, 'udp'),
  ]
}


export function isLoopbackAddress(address: string) {
  if (address === '::1') return true
  const octets = address.split('.')
  return octets.length === 4 && octets[0] === '127'
}

// Start time distinguishes a pid from the same number handed to a different process. On
// Linux it is field 22 of /proc/<pid>/stat, in clock ticks since boot; elsewhere `ps` reports
// an elapsed time that serves the same purpose.
export async function processStartTimes(): Promise<Map<number, string>> {
  const times = new Map<number, string>()
  if (process.platform === 'linux') {
    for (const [pid, fields] of await procStatFields()) {
      const started = fields[19]
      if (started !== undefined) times.set(pid, started)
    }
    return times
  }
  // `lstart` is the moment the process began and never moves. `etime` counts up, so the
  // same process compared twice looked like a different one — which excluded exactly the
  // escaped descendant this identity check exists to keep targeting.
  const { stdout } = await execFileAsync('ps', ['-Ao', 'pid=,lstart='], { timeout: PS_TIMEOUT_MS })
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const separator = trimmed.indexOf(' ')
    const pid = Number(trimmed.slice(0, separator))
    const started = trimmed.slice(separator + 1).trim()
    if (Number.isInteger(pid) && started) times.set(pid, started)
  }
  return times
}

export async function descendantsOf(root: number) {
  return (await descendantsOfMany([root])).get(root) ?? []
}

// One process-table read answers for every root. Asking per preview turned a sweep into
// O(previews x processes) filesystem work every couple of seconds.
export async function descendantsOfMany(roots: readonly number[]): Promise<Map<number, number[]>> {
  const result = new Map<number, number[]>()
  if (roots.length === 0) return result
  const { parents, groups } = await machineSnapshot(0)
  for (const root of roots) result.set(root, treeFrom(root, parents, groups).filter(pid => pid !== root))
  return result
}

async function processTree(root: number): Promise<number[]> {
  const parents = process.platform === 'linux' ? await parentsByPid() : await parentsByPs()
  const tree = new Set<number>([root])
  for (const [pid, parent] of parents) {
    if (pid !== root && descendsFrom(pid, parent, parents, root)) tree.add(pid)
  }
  // Group membership catches what ancestry loses to reparenting.
  for (const pid of await groupMembers(root)) tree.add(pid)
  return [...tree]
}

// Darwin has no /proc, and a runner that cannot see descendants there would time out on
// every wrapper command — the common shape, since a package runner's server is a child.
async function parentsByPs() {
  const parents = new Map<number, number>()
  // No catch: an enumeration that fails must not look like a process with no children.
  // Fail-open here would let a root with a loopback listener vouch for a child nobody
  // enumerated, which is the exact bypass this walk exists to prevent.
  const { stdout } = await execFileAsync('ps', ['-Ao', 'pid=,ppid='], { timeout: PS_TIMEOUT_MS })
  for (const line of stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (Number.isInteger(pid) && Number.isInteger(ppid) && pid !== undefined && ppid !== undefined) parents.set(pid, ppid)
  }
  return parents
}

function descendsFrom(pid: number, parent: number, parents: Map<number, number>, root: number) {
  let current = parent
  // Bounded by the map size: a cycle in ppid would otherwise spin forever.
  for (let hops = 0; hops <= parents.size; hops += 1) {
    if (current === root) return true
    if (current <= 1) return false
    const next = parents.get(current)
    if (next === undefined) return false
    current = next
  }
  return false
}

async function parentsByPid() {
  const parents = new Map<number, number>()
  for (const [pid, fields] of await procStatFields()) {
    const ppid = Number(fields[1] ?? Number.NaN)
    if (Number.isInteger(ppid)) parents.set(pid, ppid)
  }
  return parents
}

// Parentage does not survive reparenting: a wrapper that spawns a detached child and exits
// leaves that child adopted by init, and no ancestry walk will ever find it again. The
// process GROUP does survive — previews are spawned detached, so the group id equals the
// root pid, and a descendant keeps it unless it deliberately leaves.
//
// Residual, stated rather than papered over: a descendant that calls setsid escapes this
// too. Closing that needs an OS containment unit (a cgroup on Linux; no clean equivalent
// on macOS), which is deferred — see docs/runner-seam.md.
async function groupMembers(pgid: number) {
  const groups = await groupsByPid()
  return [...groups.entries()].filter(([, group]) => group === pgid).map(([pid]) => pid)
}

// The command field can contain spaces and parentheses, so fields are read after the last
// closing parenthesis: ppid is index 1 and pgrp is index 2.
async function procStatFields() {
  const rows: [number, string[]][] = []
  for (const entry of await readdir('/proc')) {
    const pid = Number(entry)
    if (!Number.isInteger(pid) || pid <= 0) continue
    const stat = await readFileOrNull(`/proc/${pid}/stat`)
    if (stat === null) continue
    rows.push([pid, stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)])
  }
  return rows
}


async function socketInodes(pids: number[]) {
  const inodes = new Set<string>()
  for (const pid of pids) {
    const descriptors = await readdirOrNull(`/proc/${pid}/fd`)
    for (const descriptor of descriptors ?? []) {
      // A descriptor closing between listing and reading is a race, not a failure to
      // inspect — but only ENOENT and ESRCH mean that. The catch used to cover every
      // error, so a permission or I/O failure hid a descriptor while the sockets that
      // remained visible vouched for the process. Narrowed to the case the reason
      // actually describes.
      const target = await readlink(`/proc/${pid}/fd/${descriptor}`).catch(error => {
        if (isAbsent(error)) return ''
        throw error
      })
      const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1]
      if (inode) inodes.add(inode)
    }
  }
  return inodes
}

function parseProcNet(contents: string | null, decode: (hex: string) => string, protocol: 'tcp' | 'udp', state?: string) {
  if (contents === null) return []
  return contents
    .split('\n')
    .slice(1)
    .map(line => line.trim().split(/\s+/))
    // For UDP there is no listen state, so "bound and reachable" is distinguished from
    // "connected to something" by the remote address. A connected socket — a DNS lookup, a
    // telemetry ping — has a non-loopback LOCAL endpoint chosen by the kernel, and counting
    // that as an exposed listener killed previews for doing ordinary outbound work.
    .filter(columns => columns.length > 9 && (state === undefined || columns[3] === state))
    .filter(columns => state !== undefined || isUnconnected(columns[2]))
    .flatMap(columns => {
      const [hexAddress, hexPort] = (columns[1] ?? '').split(':')
      const inode = columns[9]
      if (hexAddress === undefined || hexPort === undefined || inode === undefined) return []
      return [{ address: decode(hexAddress), port: parseInt(hexPort, 16), inode, protocol }]
    })
}

function isUnconnected(remote: string | undefined) {
  if (remote === undefined) return false
  const [address, port] = remote.split(':')
  return address !== undefined && port !== undefined && /^0+$/.test(address) && /^0+$/.test(port)
}

// /proc reports addresses as little-endian words, so each 4-byte group is reversed.
function decodeIpv4(hex: string) {
  const bytes = hex.match(/../g) ?? []
  return bytes.reverse().map(byte => parseInt(byte, 16)).join('.')
}

function decodeIpv6(hex: string) {
  const words = hex.match(/.{8}/g) ?? []
  const bytes = words.flatMap(word => (word.match(/../g) ?? []).reverse())
  if (bytes.length !== 16) return hex
  const groups: string[] = []
  for (let index = 0; index < 16; index += 2) groups.push(`${bytes[index] ?? '00'}${bytes[index + 1] ?? '00'}`)
  return compressIpv6(groups)
}

function compressIpv6(groups: string[]) {
  const trimmed = groups.map(group => group.replace(/^0+(?=.)/, ''))
  const joined = trimmed.join(':')
  return joined === '0:0:0:0:0:0:0:1' ? '::1' : joined.replace(/(^|:)(0:){2,}/, '::')
}

// `-Fpn` tags each name with the pid that owns it, so one invocation answers for many
// trees instead of one subprocess per tree.
async function lsofByPid(pids: number[]) {
  const byPid = new Map<number, ListeningSocket[]>()
  if (pids.length === 0) return byPid
  // Two queries, not one bare -i. Dropping the protocol filter to pick up UDP also picked
  // up established and outbound TCP connections, whose remote endpoints are legitimately
  // non-loopback — so an ordinary preview talking to anything would have been judged
  // exposed and killed. TCP is filtered to listeners; UDP has no equivalent state because
  // a bound UDP socket is already reachable.
  const base = ['-nP', '-a', '-p', pids.join(','), '-Fpn']
  const [tcp, udp] = await Promise.all([
    runLsof(['-iTCP', '-sTCP:LISTEN', ...base]),
    // No state filter: this dialect does not report UDP state, and asking for one made
    // lsof exit non-zero — which runLsof reads as "no sockets", quietly removing UDP from
    // the exposure check on a supported platform. Connected sockets are excluded while
    // parsing instead, where the information actually exists.
    runLsof(['-iUDP', ...base]),
  ])
  for (const [protocol, stdout] of [['tcp', tcp], ['udp', udp]] as const) {
    let current = 0
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) {
        current = Number(line.slice(1))
        continue
      }
      if (!line.startsWith('n') || !Number.isInteger(current)) continue
      // lsof renders a connected endpoint as `local->remote`; those are clients, not
      // exposure, and the same rule the Linux path applies by remote address.
      if (protocol === 'udp' && line.includes('->')) continue
      const socket = parseLsofName(line.slice(1), protocol)
      if (socket) byPid.set(current, [...(byPid.get(current) ?? []), socket])
    }
  }
  return byPid
}

// lsof exits 1 both when nothing matched and when the invocation itself was wrong, and
// those must not look alike: an unsupported flag exiting 1 was read as "no sockets", which
// removed UDP from the exposure check on a whole platform while the code read as if it had
// become stricter. The two are told apart by stderr — a genuine empty result says nothing.
async function runLsof(args: string[]) {
  try {
    const { stdout } = await execFileAsync('lsof', args, { timeout: LSOF_TIMEOUT_MS })
    return stdout
  } catch (error) {
    const failure = error as { code?: number; stderr?: string }
    if (failure.code === 1 && !(failure.stderr ?? '').trim()) return ''
    throw error
  }
}


function parseLsofName(name: string, protocol: 'tcp' | 'udp'): ListeningSocket | null {
  const separator = name.lastIndexOf(':')
  if (separator < 0) return null
  const port = Number(name.slice(separator + 1))
  if (!Number.isInteger(port) || port < 1) return null
  const address = name.slice(0, separator).replace(/^\[|\]$/g, '')
  return { address: address === '*' ? '0.0.0.0' : address, port, protocol }
}

// Absent and unreadable are different answers. A process that exited between listing and
// reading is genuinely gone (ENOENT); anything else — a permission error, an I/O failure —
// means this walk does not know what is running, and a walk that does not know must not
// report an empty result that reads as "nothing is listening".
async function readFileOrNull(target: string) {
  try {
    return await readFile(target, 'utf8')
  } catch (error) {
    if (isAbsent(error)) return null
    throw error
  }
}

async function readdirOrNull(target: string) {
  try {
    return await readdir(target)
  } catch (error) {
    if (isAbsent(error)) return null
    throw error
  }
}

function isAbsent(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ESRCH'
}

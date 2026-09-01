import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = process.cwd()
const source = path.join(root, 'packages', 'runner', 'native', 'darwin_runner_home.c')
const committed = path.join(root, 'packages', 'runner', 'native', 'darwin-runner-home-arm64-node-22.0.0.node')
const loader = path.join(root, 'packages', 'runner', 'src', 'darwinRunnerHomeNative.ts')
const include = path.resolve(path.dirname(process.execPath), '..', 'include', 'node')
const deterministicUuid = Buffer.from('00000000000000000000000000000053', 'hex')

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error(`Darwin native verification requires darwin arm64; found ${process.platform} ${process.arch}`)
}

const first = await buildOnce('first')
const second = await buildOnce('second')
try {
  const firstBytes = await readFile(first.output)
  const secondBytes = await readFile(second.output)
  if (!firstBytes.equals(secondBytes)) throw new Error('native addon builds are not byte-identical')
  const committedBytes = await readFile(committed)
  if (!firstBytes.equals(committedBytes)) throw new Error('source-built addon does not match committed addon')
  const digest = sha256(committedBytes)
  const loaderText = await readFile(loader, 'utf8')
  if (!loaderText.includes(`sha256: '${digest}'`)) throw new Error(`loader digest does not match committed addon: ${digest}`)
  const file = run('file', [committed])
  if (!file.stdout.includes('Mach-O 64-bit bundle arm64')) throw new Error(`committed addon is not an arm64 Mach-O bundle: ${file.stdout}`)
  const otool = run('otool', ['-l', committed])
  if (!machOUuid(committedBytes).equals(deterministicUuid)) throw new Error('committed addon does not contain the deterministic Mach-O UUID')
  console.log(JSON.stringify({ status: 'verified', sha256: digest }))
} finally {
  await Promise.all([rm(first.directory, { recursive: true, force: true }), rm(second.directory, { recursive: true, force: true })])
}

async function buildOnce(label) {
  const directory = await mkdtemp(path.join(tmpdir(), `modula-darwin-native-${label}-`))
  const output = path.join(directory, 'darwin-runner-home-arm64-node-22.0.0.node')
  run('clang', [
    '-O2',
    '-bundle',
    '-undefined', 'dynamic_lookup',
    '-I', include,
    '-o', output,
    source,
  ])
  await normalizeMachOUuid(output)
  run('codesign', ['-s', '-', output])
  return { directory, output }
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
  return result
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function normalizeMachOUuid(file) {
  const bytes = await readFile(file)
  machOUuid(bytes).set(deterministicUuid)
  await import('node:fs/promises').then(fs => fs.writeFile(file, bytes))
}

function machOUuid(bytes) {
  if (bytes.readUInt32LE(0) !== 0xfeedfacf) throw new Error('expected little-endian 64-bit Mach-O')
  const commands = bytes.readUInt32LE(16)
  let offset = 32
  for (let index = 0; index < commands; index += 1) {
    const command = bytes.readUInt32LE(offset)
    const size = bytes.readUInt32LE(offset + 4)
    if (command === 0x1b) return bytes.subarray(offset + 8, offset + 24)
    offset += size
  }
  throw new Error('Mach-O LC_UUID command is missing')
}

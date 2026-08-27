import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const binaries = {
  arm64: {
    file: 'fs-ext-linux-arm64-node-22.0.0.node',
    sha256: '80c10393d3698397e35d30f0edca8d05f938c9f5f8be1a747d0bd56cedce6d06',
  },
  x64: {
    file: 'fs-ext-linux-x64-node-22.0.0.node',
    sha256: 'a58e01d64248b487d9c7dafba751d69b7924d16f0e31cedcce9d3226fdfdb514',
  },
}

function loadBinding() {
  if (process.platform !== 'linux' || process.versions.node.split('.')[0] !== '22') {
    throw new Error(`linux file locking requires Node 22 on Linux; found ${process.platform} ${process.versions.node}`)
  }
  const binary = binaries[process.arch]
  if (!binary) throw new Error(`linux file locking does not support architecture ${process.arch}`)
  const url = new URL(`./binaries/${binary.file}`, import.meta.url)
  const digest = createHash('sha256').update(readFileSync(url)).digest('hex')
  if (digest !== binary.sha256) throw new Error('linux file-lock binary integrity check failed')
  return createRequire(import.meta.url)(fileURLToPath(url))
}

const binding = loadBinding()

const modes = {
  exclusiveNonblocking: binding.constants.LOCK_EX | binding.constants.LOCK_NB,
  unlock: binding.constants.LOCK_UN,
}

function flock(fd, mode) {
  return new Promise((resolve, reject) => binding.flock(fd, mode, error => error ? reject(error) : resolve()))
}

export async function tryExclusive(fd) {
  try {
    await flock(fd, modes.exclusiveNonblocking)
    return 'acquired'
  } catch (error) {
    if (error?.code === 'EAGAIN' || error?.code === 'EWOULDBLOCK') return 'contended'
    throw error
  }
}

export async function unlock(fd) {
  await flock(fd, modes.unlock)
}

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const binary = {
  file: 'fs-ext-darwin-arm64-node-22.0.0.node',
  sha256: '3f020304746900a51d130162bfc46fa5277cb1fc27d6137a7dcfc2aec8f83b0b',
}

export function loadBinding() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.versions.node.split('.')[0] !== '22') {
    throw new Error(`Darwin file locking requires Node 22 on darwin arm64; found ${process.platform} ${process.arch} ${process.versions.node}`)
  }
  const url = new URL(`./binaries/${binary.file}`, import.meta.url)
  const digest = createHash('sha256').update(readFileSync(url)).digest('hex')
  if (digest !== binary.sha256) throw new Error('Darwin file-lock binary integrity check failed')
  return createRequire(import.meta.url)(fileURLToPath(url))
}

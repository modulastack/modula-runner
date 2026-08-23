import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AuditLog, AuditRecord } from '../src/index.js'

export type AuditLogFixtureOptions = {
  path: string
  onFailure?: (record: AuditRecord, error: unknown) => void
}

class AppendOnlyAuditFixture implements AuditLog {
  private queue: Promise<unknown> = Promise.resolve()
  private lastSyncedInode: bigint | undefined

  constructor(
    private readonly path: string,
    private readonly onFailure?: (record: AuditRecord, error: unknown) => void,
  ) {}

  append(record: AuditRecord): Promise<void> {
    const run = this.queue.then(() => this.writeDurably(record)).catch(error => {
      this.onFailure?.(record, error)
      throw error
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  private async writeDurably(record: AuditRecord): Promise<void> {
    let handle: FileHandle | undefined
    try {
      handle = await open(this.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600)
      const line = Buffer.from(`${JSON.stringify(record)}\n`)
      let offset = 0
      while (offset < line.length) {
        const { bytesWritten } = await handle.write(line, offset, line.length - offset)
        if (bytesWritten === 0) throw new Error('audit fixture write made no progress')
        offset += bytesWritten
      }
      await handle.sync()
      await this.syncDirectoryFor(handle)
    } finally {
      await handle?.close()
    }
  }

  private async syncDirectoryFor(handle: FileHandle): Promise<void> {
    const { ino } = await handle.stat({ bigint: true })
    if (this.lastSyncedInode === ino) return
    let directory: FileHandle | undefined
    try {
      directory = await open(dirname(this.path), constants.O_RDONLY)
      await directory.sync()
    } finally {
      await directory?.close()
    }
    this.lastSyncedInode = ino
  }
}

export function openAuditLogFixture(options: AuditLogFixtureOptions): AuditLog {
  return new AppendOnlyAuditFixture(options.path, options.onFailure)
}

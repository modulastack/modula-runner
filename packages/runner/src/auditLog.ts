import { open, type FileHandle } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname } from 'node:path'
import type { RefusalReason } from '@modulastack/runner-protocol'
import type { SessionConnectionAuditRecord } from './sessionJobControl.js'
import type { SessionLaunchAuditRecord } from './sessionLaunch.js'

// The local audit log: every command the runner spawns, and every request it refuses, lands
// here — a file the operator owns, on their machine, that the control plane cannot read or
// edit. It is append-only by the runner's own construction (opened with O_APPEND, no method
// that rewrites or truncates) rather than by an OS immutability the supported platforms cannot
// portably promise; against a user who owns the file, OS-enforced immutability would be moot
// anyway. What the log guarantees is that the runner never goes back and changes what it
// already recorded, and never reports an operation as done before the record of it is durable.
//
// Durability is per record: the append is fsync'd before the operation it describes is
// acknowledged, so a crash cannot leave a spawned process with no evidence it ran. And the log
// is on the critical path by design — if it cannot be written, the spawn does not happen
// (fail closed). An execution the runner cannot account for is exactly the execution the
// audit log exists to prevent.

// What a spawn ended as. A terminal record carries one of these so the log accounts for the
// outcome, not just the intent — a reconciliation that stopped at "admitted" could not tell a
// clean exit from a process that never started.
export type SpawnOutcome =
  | { exitCode: number; signal: null }
  | { exitCode: null; signal: number }
  | { spawnFailed: true }

// The record kinds. Two records bracket every accepted spawn — an admission before the process
// exists and an outcome after it ends — correlated by `spawnId`, because an append-only log
// cannot update a single record in place and must not have to. Refusals and kills are single
// records: neither has a later outcome the log needs to wait for.
export type AuditRecord =
  | {
      kind: 'spawn-admitted'
      spawnId: string
      // The executable the runner is about to spawn, or the recipe id for a preview. One of
      // the two is always present so a reader knows what ran without guessing.
      executable: string | null
      recipeId: string | null
      cwd: string
      at: string
    }
  | { kind: 'spawn-outcome'; spawnId: string; outcome: SpawnOutcome; at: string }
  | {
      kind: 'refused'
      // Correlates to the wire request where one exists, so a REFUSED frame and its audit line
      // name the same event.
      requestId: string | null
      executable: string | null
      recipeId: string | null
      cwd: string | null
      reason: RefusalReason
      at: string
    }
  | { kind: 'kill'; confirmed: boolean; details: string; at: string }
  | SessionConnectionAuditRecord
  | SessionLaunchAuditRecord

// The writer. Deliberately narrow: `append` is the only mutation, so there is no rewrite or
// truncate path to reason about — the append-only property is a shape of the interface, not a
// discipline callers must remember. `append` resolves only after the record is on the platter;
// a rejection means the record is not durable and the caller must not proceed as if it were.
export interface AuditLog {
  append(record: AuditRecord): Promise<void>
}

export type AuditLogOptions = {
  path: string
  // Observability for a durability failure the caller cannot otherwise act on: when an append
  // cannot be made durable — a full disk, a revoked permission — this is called before the
  // append rejects, so a broken log surfaces somewhere rather than only failing the one
  // operation that noticed. The append still rejects; this does not swallow the failure.
  onFailure?: (record: AuditRecord, error: unknown) => void
}

// One append at a time, in order, each fsync'd before the next begins and before its own
// promise resolves. Serialization is what keeps concurrent spawns from interleaving bytes in
// the file (a half-written record is not a record), and it is why the queue chains rather than
// races.
class AppendOnlyAuditLog implements AuditLog {
  private queue: Promise<unknown> = Promise.resolve()
  // The inode whose directory entry has been fsync'd. A permanent boolean assumed the path always
  // names the same file, but every append reopens it O_CREAT: if the log is rotated, deleted, or
  // replaced, the next append creates a NEW inode whose directory entry is not yet durable, and a
  // crash would lose an append already reported durable. Tracking the synced inode re-syncs the
  // directory exactly when the file behind the path changed.
  private lastSyncedInode: bigint | undefined
  constructor(
    private readonly path: string,
    private readonly onFailure?: (record: AuditRecord, error: unknown) => void,
  ) {}

  append(record: AuditRecord): Promise<void> {
    const run = this.queue.then(() => this.writeDurably(record)).catch(error => {
      // Surfaced, then re-thrown: the caller still fails closed on the rejection, and the health
      // signal makes a broken log visible past the single operation that hit it.
      this.onFailure?.(record, error)
      throw error
    })
    // The queue only sequences; a failed append reports to its own caller and does not poison
    // the chain for the next writer, which may target a target that has since become writable.
    this.queue = run.catch(() => {})
    return run
  }

  private async writeDurably(record: AuditRecord): Promise<void> {
    let handle: FileHandle | undefined
    try {
      // O_APPEND makes every write land at end-of-file even under concurrency, O_CREAT starts a
      // fresh log where none exists, and there is no O_TRUNC — the file only ever grows. One
      // JSON object per line so the log is append-legible and a partial tail is one broken line,
      // not a corrupt file.
      handle = await open(this.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600)
      // A short write is not a complete record: fsyncing it would durably persist a truncated
      // audit line and let authorization proceed on it. Loop until every byte lands — the queue
      // serializes writers and O_APPEND lands each write at end-of-file, so the record stays
      // contiguous — or reject so the caller fails closed.
      const line = Buffer.from(`${JSON.stringify(record)}\n`)
      let offset = 0
      while (offset < line.length) {
        const { bytesWritten } = await handle.write(line, offset, line.length - offset)
        if (bytesWritten === 0) throw new Error('audit log write made no progress')
        offset += bytesWritten
      }
      await handle.sync()
      await this.syncDirectoryFor(handle)
    } finally {
      await handle?.close()
    }
  }

  // Syncing the file's data does not, on POSIX, durably link a newly created file into its
  // directory — a crash can lose the whole log. Fsync the containing directory whenever the file
  // behind the path is one whose directory entry has not been synced: unchanged across ordinary
  // appends (skipped once synced), but re-run when a rotation/deletion/replacement created a new
  // inode at the path. The inode is read from the open handle we just wrote and synced, not from a
  // racy re-stat of the path. A failure here is a durability failure like any other: it propagates
  // so the append rejects and the caller fails closed, rather than resolving an append whose log
  // the directory entry does not yet durably point to.
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

export function openAuditLog(options: AuditLogOptions): AuditLog {
  return new AppendOnlyAuditLog(options.path, options.onFailure)
}

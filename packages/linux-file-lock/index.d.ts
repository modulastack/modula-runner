export type LinuxFileLeaseResult = 'acquired' | 'contended'

export function tryExclusive(fd: number): Promise<LinuxFileLeaseResult>
export function unlock(fd: number): Promise<void>

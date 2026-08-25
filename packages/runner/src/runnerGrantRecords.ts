import path from 'node:path'
import { hasControlCharacter } from '@modulastack/runner-protocol'
import type { GrantRecord } from './consent.js'

export type GrantImage = { revision: number; records: GrantRecord[] }

export function decodeGrantImage(value: unknown): GrantImage | null {
  if (!exactRecord(value, ['records', 'revision'])) return null
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || !Array.isArray(value.records)) return null
  const records = decodeGrantRecords(value.records)
  return records ? { revision: value.revision as number, records } : null
}

export function decodeGrantRecords(values: readonly unknown[]): GrantRecord[] | null {
  const records: GrantRecord[] = []
  for (const value of values) {
    const record = decodeGrant(value)
    if (!record) return null
    records.push(record)
  }
  const live = records.filter(record => record.revokedAt === undefined)
  const names = live.flatMap(record => record.alias === undefined || record.alias === record.path
    ? [record.path]
    : [record.path, record.alias])
  if (duplicated(names)) return null
  if (duplicated(records.map(grantIdentity))) return null
  return records
}

export function grantIdentity(record: GrantRecord): string {
  return `${record.path}\u0000${record.grantedAt}`
}

function decodeGrant(value: unknown): GrantRecord | null {
  if (!exactRecord(value, ['grantedAt', 'path'], ['alias', 'revokedAt'])) return null
  if (!localPath(value.path) || !timestamp(value.grantedAt)) return null
  if (value.alias !== undefined && !localPath(value.alias)) return null
  if (value.revokedAt !== undefined && (!timestamp(value.revokedAt) || Date.parse(value.revokedAt) < Date.parse(value.grantedAt))) return null
  return {
    path: value.path,
    grantedAt: value.grantedAt,
    ...(value.alias === undefined ? {} : { alias: value.alias }),
    ...(value.revokedAt === undefined ? {} : { revokedAt: value.revokedAt }),
  }
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return false
  const normalized = new Date(parsed).toISOString()
  return value.includes('.') ? normalized === value : normalized.replace('.000Z', 'Z') === value
}

function localPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4_096 && path.isAbsolute(value) && !hasControlCharacter(value)
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const allowed = new Set([...required, ...optional])
  return required.every(key => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value as object).every(key => allowed.has(key))
}

function duplicated(values: readonly string[]): boolean {
  return new Set(values).size !== values.length
}

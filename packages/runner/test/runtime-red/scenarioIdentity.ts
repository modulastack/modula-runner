import { createHash } from 'node:crypto'

export function requestIdFor(obligationId: string): string {
  const area = obligationId.charCodeAt(3).toString(16).padStart(2, '0')
  const number = Number(obligationId.slice(4)).toString(16).padStart(4, '0')
  return `223e4567-e89b-42d3-a456-${`${area}${number}`.padEnd(12, '0')}`
}

export function pairingCodeFor(obligationId: string): string {
  const digest = createHash('sha256').update(obligationId).digest()
  return `${digest.subarray(0, 16).toString('base64url')}.${digest.subarray(16, 30).toString('base64url')}`
}

export function connectionIdFor(obligationId: string): string {
  return `connection-${obligationId.toLowerCase()}`
}

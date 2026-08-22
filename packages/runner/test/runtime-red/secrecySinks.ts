export const pairingSecrecySinks = [
  'frames',
  'argv',
  'environment',
  'logs',
  'errors',
  'listings',
  'artifacts',
] as const

export type PairingSecrecySink = typeof pairingSecrecySinks[number]

export function pairingSecrecySinkMarker(sink: PairingSecrecySink): string {
  return `sink:${sink}:`
}

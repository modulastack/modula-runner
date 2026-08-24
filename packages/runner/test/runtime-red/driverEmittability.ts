import { readFileSync } from 'node:fs'
import type { RuntimeScenario, RuntimeSubject } from './scenarioTypes.js'

const driverFiles: Record<RuntimeSubject, readonly string[]> = {
  application: ['applicationSubject.ts'],
  pairing: ['pairingSubject.ts'],
  runtime: ['runtimeCompositionSubject.ts'],
  'job-control': ['jobControlSubject.ts'],
  launcher: ['launcherSubject.ts', 'launcherEvidence.ts', 'capacityDurabilitySubject.ts'],
  'terminal-host': ['terminalSubject.ts'],
  ledger: ['ledgerSubject.ts'],
  home: ['homeSubject.ts'],
}

export function unemittableOracleFragments(scenario: RuntimeScenario): string[] {
  const source = driverFiles[scenario.subject].map(file => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n')
  const patterns = eventPatterns(source)
  return oracleEventFragments(scenario).filter(fragment => !patterns.some(pattern => patternCanEmit(pattern, fragment)))
}

function oracleEventFragments(scenario: RuntimeScenario): string[] {
  return [...new Set([
    ...scenario.oracle.require,
    ...scenario.oracle.forbid,
    ...Object.keys(scenario.oracle.counts ?? {}),
    ...(scenario.oracle.before?.flatMap(pair => pair) ?? []),
  ])]
}

function eventPatterns(source: string): string[] {
  const patterns: string[] = []
  const calls = source.matchAll(/\b(?:(?:recorder\.)?record|events\.push)\(\s*(`(?:\\.|[^`])*`|'(?:\\.|[^'])*'|"(?:\\.|[^"])*)/g)
  for (const match of calls) {
    const expression = match[1]
    if (!expression) continue
    patterns.push(expression.slice(1, expression.startsWith('`') ? -1 : expression.endsWith(expression[0]!) ? -1 : undefined))
  }
  return patterns
}

function patternCanEmit(pattern: string, fragment: string): boolean {
  if (!pattern.includes('${')) return pattern.includes(fragment)
  const staticParts = pattern.split(/\$\{[^}]*\}/)
  if (staticParts.some(part => part.includes(fragment))) return true
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(fragment) && pattern.includes('requestId')) return true
  const expression = staticParts.map(escapeRegExp).join('.*')
  return new RegExp(`^${expression}$`).test(fragment)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

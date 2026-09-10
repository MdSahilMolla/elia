import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendSecureFile, ensureSecureDirectory } from '../securePersistence.ts'
import type { GapVector } from './types.ts'

/**
 * Durable history of the generator–verifier gap, one `GapVector` per line. The
 * guard compares the newest two; a person reads the trend.
 */

function historyPath(cwd = process.cwd()): string {
  return join(cwd, '.elia', 'gap', 'history.ndjson')
}

export function recordGapVector(vector: GapVector, cwd = process.cwd()): void {
  try {
    ensureSecureDirectory(join(cwd, '.elia', 'gap'))
    appendSecureFile(historyPath(cwd), `${JSON.stringify(vector)}\n`)
  } catch {
    // Recording the scoreboard must never be what fails a run.
  }
}

export function readGapHistory(cwd = process.cwd()): GapVector[] {
  const path = historyPath(cwd)
  if (!existsSync(path)) return []
  const out: GapVector[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed) as GapVector)
    } catch {
      // skip a corrupt line
    }
  }
  return out
}

/** The most recent recorded vector, or undefined when nothing is logged yet. */
export function readLatestGapVector(cwd = process.cwd()): GapVector | undefined {
  return readGapHistory(cwd).at(-1)
}

export function renderGapVector(vector: GapVector, previous?: GapVector): string {
  const lines: string[] = []
  lines.push(`Generator–verifier gap · ${vector.ref} · ${vector.at.slice(0, 19).replace('T', ' ')}`)
  lines.push('')
  lines.push(`  mechanical catch rate   ${bar(vector.mechanicalCatchRate)} ${pct(vector.mechanicalCatchRate)}  (${vector.defectsScored} scored defects)${delta(previous?.mechanicalCatchRate, vector.mechanicalCatchRate)}`)
  lines.push(`  false-positive rate     ${bar(1 - vector.falsePositiveRate)} ${pct(vector.falsePositiveRate)}${delta(previous?.falsePositiveRate, vector.falsePositiveRate, true)}`)
  if (vector.criticFalseAcceptRate !== undefined) {
    lines.push(`  critic false-accept     ${bar(1 - vector.criticFalseAcceptRate)} ${pct(vector.criticFalseAcceptRate)}${delta(previous?.criticFalseAcceptRate, vector.criticFalseAcceptRate, true)}`)
  }
  lines.push(`  calibration contradicts ${pct(vector.calibrationContradictionRate)}`)
  lines.push('')
  for (const [regime, stat] of Object.entries(vector.byRegime)) {
    if (stat.total === 0) continue
    lines.push(`  ${regime.padEnd(11)} ${stat.caught}/${stat.total} caught`)
  }
  if (vector.escapees.length > 0) {
    lines.push('')
    lines.push(`  got through: ${vector.escapees.join(', ')}`)
  }
  return lines.join('\n')
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`.padStart(4)
}

function bar(fraction: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * 10)
  return `[${'#'.repeat(filled)}${'-'.repeat(10 - filled)}]`
}

function delta(before: number | undefined, after: number, lowerIsBetter = false): string {
  if (before === undefined) return ''
  const diff = after - before
  if (Math.abs(diff) < 0.005) return '  (no change)'
  const better = lowerIsBetter ? diff < 0 : diff > 0
  return `  (${diff > 0 ? '+' : ''}${Math.round(diff * 100)}pt ${better ? 'better' : 'worse'})`
}

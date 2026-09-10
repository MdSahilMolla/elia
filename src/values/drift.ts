import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendSecureFile, ensureSecureDirectory } from '../securePersistence.ts'
import type { ValueProbeRun } from './probes.ts'

/**
 * The Value Firewall, as a gate.
 *
 * Any change that reaches the critics, the controller, or the prompts runs the
 * value probes before and after and calls this. A drop in the overall pass rate,
 * or any category going backwards, or a probe that passed before now failing —
 * all fail closed. Value-preservation is not something to trade for a benchmark
 * point.
 */

export interface ValueDriftResult {
  ok: boolean
  regressions: string[]
}

export function checkValueDrift(before: ValueProbeRun, after: ValueProbeRun, epsilon = 0.001): ValueDriftResult {
  const regressions: string[] = []

  if (after.passRate < before.passRate - epsilon) {
    regressions.push(`value-probe pass rate fell ${pct(before.passRate)} → ${pct(after.passRate)}`)
  }

  for (const [category, stat] of Object.entries(after.byCategory)) {
    const prior = before.byCategory[category]
    if (!prior) continue
    const beforeRate = prior.total > 0 ? prior.passed / prior.total : 1
    const afterRate = stat.total > 0 ? stat.passed / stat.total : 1
    if (afterRate < beforeRate - epsilon) {
      regressions.push(`${category}: ${pct(beforeRate)} → ${pct(afterRate)}`)
    }
  }

  const nowFailing = after.results
    .filter((r) => !r.passed)
    .filter((r) => before.results.find((b) => b.id === r.id)?.passed === true)
    .map((r) => r.id)
  if (nowFailing.length > 0) {
    regressions.push(`probe(s) that passed before now fail: ${nowFailing.join(', ')}`)
  }

  return { ok: regressions.length === 0, regressions }
}

export function assertNoValueDrift(before: ValueProbeRun, after: ValueProbeRun): void {
  const result = checkValueDrift(before, after)
  if (!result.ok) {
    throw new Error(`Value drift detected — change rejected:\n${result.regressions.map((r) => `  - ${r}`).join('\n')}`)
  }
}

function historyPath(cwd = process.cwd()): string {
  return join(cwd, '.elia', 'values', 'probe-history.ndjson')
}

export function recordProbeRun(run: ValueProbeRun, label: string, cwd = process.cwd()): void {
  try {
    ensureSecureDirectory(join(cwd, '.elia', 'values'))
    appendSecureFile(historyPath(cwd), `${JSON.stringify({ ...run, label })}\n`)
  } catch {
    // never fail a run over probe bookkeeping
  }
}

export function readLatestProbeRun(cwd = process.cwd()): ValueProbeRun | undefined {
  const path = historyPath(cwd)
  if (!existsSync(path)) return undefined
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]!) as ValueProbeRun
    } catch {
      // keep scanning back
    }
  }
  return undefined
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`
}

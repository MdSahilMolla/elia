import { existsSync, readdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { GenerationRecord } from '../evolve/ledger.ts'
import { funnelScore, readStrategyTrial, strategyPaths } from '../evolve/strategy.ts'

/**
 * Is improvement compounding — do gains make the next gain easier to get?
 *
 * No weights change here; elia compounds through its own harness. Evolve's
 * proposer is an agent loop and its builder is an elia sub-agent, so a promoted
 * change to the loop, the roles, the tools, or the sub-agent prompt is also a
 * change to the improver. And the improver's search strategy is itself trialled
 * and replaced (evolve/strategy.ts). This reads the ledger for the evidence that
 * those channels actually paid off.
 */

/** Files the improver runs on: a promotion here changes how later generations propose and build. */
export const IMPROVER_SHARED = [
  'src/agentLoop.ts',
  'src/subagent.ts',
  'src/autonomy/roles.ts',
  'src/config.ts',
  'src/tools/**',
  'src/speculation/**',
  'src/distill/fragments.generated.json',
]

const SHARED_MATCHERS = IMPROVER_SHARED.map((entry) => {
  if (!entry.includes('*')) return (path: string) => path === entry
  const glob = new Bun.Glob(entry)
  return (path: string) => glob.match(path)
})

export function touchesImprover(files: string[]): boolean {
  return files.some((file) => SHARED_MATCHERS.some((match) => match(file.replace(/\\/g, '/'))))
}

/** Generations compared on each side of an improver-changing promotion. */
const EFFECT_WINDOW = 5

export interface ImproverEffect {
  generation: number
  before: number
  after: number
  afterGenerations: number
}

export interface RecursionSignal {
  promotions: number
  /** Promotions that stood on an earlier promotion — the live tree already carried a win. */
  stacked: number
  /** Promotions that changed what the improver itself runs on, with the search depth either side. */
  improverEffects: ImproverEffect[]
  strategiesAdopted: number
  trial: ReturnType<typeof readStrategyTrial>['verdict']
  /** True once a gain has measurably made later search better — the recursion, observed. */
  compounding: boolean
}

function meanDepth(records: GenerationRecord[]): number {
  return records.length === 0 ? 0 : records.reduce((sum, record) => sum + funnelScore(record), 0) / records.length
}

export function recursionSignal(records: GenerationRecord[], paths = strategyPaths()): RecursionSignal {
  const ordered = [...records].sort((a, b) => a.generation - b.generation)
  const promoted = ordered.filter((record) => record.verdict === 'promoted')

  const improverEffects: ImproverEffect[] = []
  for (const record of promoted) {
    if (!touchesImprover(record.changedFiles)) continue
    const index = ordered.indexOf(record)
    const before = ordered.slice(Math.max(0, index - EFFECT_WINDOW), index)
    const after = ordered.slice(index + 1, index + 1 + EFFECT_WINDOW)
    improverEffects.push({ generation: record.generation, before: meanDepth(before), after: meanDepth(after), afterGenerations: after.length })
  }

  const archiveDir = dirname(paths.challenger)
  const strategiesAdopted = existsSync(archiveDir) ? readdirSync(archiveDir).filter((file) => file.includes('.adopted-')).length : 0

  const improverHelped = improverEffects.some((effect) => effect.afterGenerations >= EFFECT_WINDOW && effect.after > effect.before)
  return {
    promotions: promoted.length,
    stacked: Math.max(0, promoted.length - 1),
    improverEffects,
    strategiesAdopted,
    trial: readStrategyTrial(ordered, paths).verdict,
    compounding: promoted.length >= 2 && (improverHelped || strategiesAdopted > 0),
  }
}

export function renderRecursion(signal: RecursionSignal): string {
  const effects = signal.improverEffects.length === 0
    ? 'no promotion has changed the improver yet'
    : signal.improverEffects
        .map((effect) => `gen ${effect.generation}: search depth ${effect.before.toFixed(2)} → ${effect.after.toFixed(2)}${effect.afterGenerations < EFFECT_WINDOW ? ` (${effect.afterGenerations}/${EFFECT_WINDOW} gens after, still settling)` : ''}`)
        .join('; ')
  return `${signal.promotions} promotion(s), ${signal.stacked} stacked on an earlier win · ${effects} · ${signal.strategiesAdopted} search strateg${signal.strategiesAdopted === 1 ? 'y' : 'ies'} adopted, trial: ${signal.trial}`
}

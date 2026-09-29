import { existsSync, readdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { judgedRecords, landedOnLive, type GenerationRecord } from '../evolve/ledger.ts'
import { ADOPT_MARGIN, funnelScore, readStrategyTrial, strategyPaths } from '../evolve/strategy.ts'

/**
 * Is improvement compounding — do gains make the next gain easier to get?
 *
 * No weights change here; elia compounds through its own harness. Evolve's
 * proposer is an agent loop and its builder is an elia sub-agent, so a promoted
 * change to the loop, the roles, the tools, or the sub-agent prompt is also a
 * change to the improver. And the improver's search strategy is itself trialled
 * and replaced (evolve/strategy.ts). This reads the ledger for the evidence that
 * those channels actually paid off.
 *
 * Three things would make that evidence up, and each is excluded here. A
 * generation the provider cut short says nothing about how deep the search
 * went, so only judged generations are compared. A promotion committed to a
 * branch nobody merged is not in the tree later generations start from, so it
 * cannot have made them better. And a generation that ran on improver code
 * older than a promotion in its own process (`staleImprover`) is a sample of
 * the old improver, not the new one.
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
  beforeGenerations: number
  after: number
  afterGenerations: number
}

export interface RecursionSignal {
  promotions: number
  /** Promotions committed to a branch nobody has merged: proven, but not in the tree later generations start from. */
  awaitingMerge: number
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

export function recursionSignal(records: GenerationRecord[], paths = strategyPaths(), landed: (record: GenerationRecord) => boolean = landedOnLive): RecursionSignal {
  const ordered = judgedRecords(records).sort((a, b) => a.generation - b.generation)
  const promoted = ordered.filter((record) => record.verdict === 'promoted')
  const standing = promoted.filter((record) => landed(record))
  // Search depth is only comparable across generations that ran on the improver
  // in force when they started.
  const clean = ordered.filter((record) => record.staleImprover === undefined)

  const improverEffects: ImproverEffect[] = []
  for (const record of standing) {
    if (!touchesImprover(record.changedFiles)) continue
    const before = clean.filter((other) => other.generation < record.generation).slice(-EFFECT_WINDOW)
    const after = clean.filter((other) => other.generation > record.generation).slice(0, EFFECT_WINDOW)
    improverEffects.push({
      generation: record.generation,
      before: meanDepth(before),
      beforeGenerations: before.length,
      after: meanDepth(after),
      afterGenerations: after.length,
    })
  }

  const archiveDir = dirname(paths.challenger)
  const strategiesAdopted = existsSync(archiveDir) ? readdirSync(archiveDir).filter((file) => file.includes('.adopted-')).length : 0

  // A full window on both sides and the same margin a search strategy has to
  // clear to be adopted: a mean over an empty or one-sided window is not a
  // comparison, and a few hundredths of a step is noise.
  const improverHelped = improverEffects.some(
    (effect) => effect.beforeGenerations >= EFFECT_WINDOW && effect.afterGenerations >= EFFECT_WINDOW && effect.after >= effect.before + ADOPT_MARGIN,
  )
  return {
    promotions: promoted.length,
    awaitingMerge: promoted.length - standing.length,
    stacked: Math.max(0, standing.length - 1),
    improverEffects,
    strategiesAdopted,
    trial: readStrategyTrial(ordered, paths).verdict,
    compounding: standing.length >= 2 && (improverHelped || strategiesAdopted > 0),
  }
}

export function renderRecursion(signal: RecursionSignal): string {
  const settling = (effect: ImproverEffect) =>
    [
      effect.beforeGenerations < EFFECT_WINDOW ? `${effect.beforeGenerations}/${EFFECT_WINDOW} judged gens before` : '',
      effect.afterGenerations < EFFECT_WINDOW ? `${effect.afterGenerations}/${EFFECT_WINDOW} after` : '',
    ].filter(Boolean)
  const effects = signal.improverEffects.length === 0
    ? 'no promotion has changed the improver yet'
    : signal.improverEffects
        .map((effect) => {
          const pending = settling(effect)
          const before = effect.beforeGenerations === 0 ? 'no earlier search to compare' : effect.before.toFixed(2)
          return `gen ${effect.generation}: search depth ${before} → ${effect.after.toFixed(2)}${pending.length > 0 ? ` (${pending.join(', ')}; still settling)` : ''}`
        })
        .join('; ')
  const unmerged = signal.awaitingMerge > 0 ? ` · ${signal.awaitingMerge} proven on a branch nobody has merged, not counted` : ''
  return `${signal.promotions} promotion(s), ${signal.stacked} stacked on an earlier win${unmerged} · ${effects} · ${signal.strategiesAdopted} search strateg${signal.strategiesAdopted === 1 ? 'y' : 'ies'} adopted, trial: ${signal.trial}`
}

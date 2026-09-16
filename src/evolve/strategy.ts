import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from '../statePaths.ts'
import { writeSecureFile } from '../securePersistence.ts'
import type { GenerationRecord } from './ledger.ts'

/**
 * The improver improving itself.
 *
 * `elia evolve` makes elia better at tasks. This makes evolve better at making
 * elia better — the recursive half. What evolve searches *with* is its strategy:
 * the guidance its proposer follows when choosing one change to try. That
 * guidance used to be a constant in engine.ts, which no generation may touch, so
 * however much the loop learned, it searched the same way forever.
 *
 * Now the strategy is state. An incumbent is in force; when the loop stalls, the
 * proposer writes a challenger from the ledger; each generation flips a coin
 * between them and records which one it used; and the challenger replaces the
 * incumbent only when the generations it steered went measurably further
 * through the gates. The gates themselves, the rules about what may not be
 * changed, and the benchmark stay in immutable code — a strategy can only change
 * how the search looks, never how its results are judged.
 */

/** Every step a generation can reach, in order. The furthest one reached is its funnel depth. */
export const FUNNEL = ['proposed', 'built', 'compiled', 'tested', 'measured', 'better', 'confirmed', 'guarded', 'promoted'] as const
export type FunnelStage = (typeof FUNNEL)[number]

/** 0 for a generation that never produced a hypothesis, 1 for a promotion. */
export function funnelScore(record: Pick<GenerationRecord, 'funnel' | 'verdict'>): number {
  if (record.verdict === 'promoted') return 1
  if (!record.funnel) return 0
  return (FUNNEL.indexOf(record.funnel) + 1) / FUNNEL.length
}

export const DEFAULT_STRATEGY_ID = 'default-v1'

export const DEFAULT_STRATEGY = `- Start from the evidence. A task that FAILED tells you far more than any amount of reading — go and understand why it failed before proposing anything.
- Change one thing. A hypothesis touching four files cannot be attributed when the score moves, and it will not be promoted if any part of it regresses.
- Prefer changes to how you *decide* over changes to how you *execute*: the system prompt, the role prompts, the planner's guidance, the tool descriptions the model reads, the loop's policy on when to batch or delegate. These compound, because they also improve the next attempt at improving yourself.
- Tool descriptions are prompt, not documentation. A tool the model misuses is usually a tool whose description does not say when to reach for it.
- Do not propose speculative rewrites, new abstractions for their own sake, or "clean up X". If you cannot name the benchmark task that gets better and say how, it is not a hypothesis.`

export interface Strategy {
  id: string
  text: string
}

const MAX_STRATEGY_CHARS = 4_000

export function strategyPaths(dir = join(stateDir, 'evolve')) {
  return { incumbent: join(dir, 'strategy.md'), challenger: join(dir, 'strategy-challenger.md') }
}

/** `<!-- id: x -->` on the first line, then the guidance. */
function parse(raw: string): Strategy | undefined {
  const match = raw.match(/^<!--\s*id:\s*([\w.-]+)\s*-->\s*\n([\s\S]*)$/)
  if (!match) return undefined
  const text = match[2]!.trim()
  return text ? { id: match[1]!, text: text.slice(0, MAX_STRATEGY_CHARS) } : undefined
}

function load(path: string): Strategy | undefined {
  if (!existsSync(path)) return undefined
  try {
    return parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

export function incumbentStrategy(paths = strategyPaths()): Strategy {
  return load(paths.incumbent) ?? { id: DEFAULT_STRATEGY_ID, text: DEFAULT_STRATEGY }
}

export function challengerStrategy(paths = strategyPaths()): Strategy | undefined {
  return load(paths.challenger)
}

export function writeChallenger(text: string, generation: number, paths = strategyPaths()): Strategy {
  const strategy = { id: `gen${generation}-${Bun.hash(text).toString(36).slice(0, 6)}`, text: text.trim().slice(0, MAX_STRATEGY_CHARS) }
  writeSecureFile(paths.challenger, `<!-- id: ${strategy.id} -->\n${strategy.text}\n`)
  return strategy
}

/** Which strategy steers this generation: a fair coin while a challenger is on trial. */
export function pickStrategy(random = Math.random, paths = strategyPaths()): Strategy {
  const challenger = challengerStrategy(paths)
  if (!challenger) return incumbentStrategy(paths)
  return random() < 0.5 ? challenger : incumbentStrategy(paths)
}

/** Generations each side needs before the trial is read at all. */
export const MIN_TRIAL_GENERATIONS = 4
/** How far ahead (in mean funnel score) a challenger must be to replace the incumbent. */
export const ADOPT_MARGIN = 0.1

export interface StrategyArm {
  id: string
  generations: number
  meanDepth: number
  promotions: number
}

export interface StrategyTrial {
  incumbent: StrategyArm
  challenger?: StrategyArm
  verdict: 'no challenger' | 'running' | 'adopt' | 'reject'
}

function arm(id: string, records: GenerationRecord[]): StrategyArm {
  const mine = records.filter((record) => (record.strategyId ?? DEFAULT_STRATEGY_ID) === id)
  return {
    id,
    generations: mine.length,
    meanDepth: mine.length === 0 ? 0 : mine.reduce((sum, record) => sum + funnelScore(record), 0) / mine.length,
    promotions: mine.filter((record) => record.verdict === 'promoted').length,
  }
}

/**
 * Reads the trial. Only generations that recorded a strategy take part in the
 * incumbent's arm once a challenger exists — older records predate the coin and
 * were not run against this challenger.
 *
 * Adopt: both arms have run enough, and the challenger went clearly further
 * through the gates (or promoted more). Reject: it has run twice the minimum and
 * still is not ahead. Promotions dominate depth: a strategy that promotes is the
 * point, however shallow its other attempts.
 */
export function readStrategyTrial(records: GenerationRecord[], paths = strategyPaths()): StrategyTrial {
  const incumbentId = incumbentStrategy(paths).id
  const challenger = challengerStrategy(paths)
  if (!challenger) return { incumbent: arm(incumbentId, records), verdict: 'no challenger' }
  const trialRecords = records.filter((record) => record.strategyId !== undefined)
  const incumbent = arm(incumbentId, trialRecords)
  const rival = arm(challenger.id, trialRecords)
  if (incumbent.generations < MIN_TRIAL_GENERATIONS || rival.generations < MIN_TRIAL_GENERATIONS) {
    return { incumbent, challenger: rival, verdict: 'running' }
  }
  const promotesMore = rival.promotions / rival.generations > incumbent.promotions / incumbent.generations
  const goesFurther = rival.meanDepth >= incumbent.meanDepth + ADOPT_MARGIN
  const notWorseAtPromoting = rival.promotions / rival.generations >= incumbent.promotions / incumbent.generations
  if (promotesMore || (goesFurther && notWorseAtPromoting)) return { incumbent, challenger: rival, verdict: 'adopt' }
  if (rival.generations >= MIN_TRIAL_GENERATIONS * 2) return { incumbent, challenger: rival, verdict: 'reject' }
  return { incumbent, challenger: rival, verdict: 'running' }
}

/** Act on a finished trial: the winner becomes the incumbent, the loser is archived. Returns what happened. */
export function settleStrategyTrial(records: GenerationRecord[], paths = strategyPaths()): StrategyTrial {
  const trial = readStrategyTrial(records, paths)
  if (trial.verdict !== 'adopt' && trial.verdict !== 'reject') return trial
  const archive = `${paths.challenger}.${trial.verdict === 'adopt' ? 'adopted' : 'rejected'}-${Date.now()}`
  if (trial.verdict === 'adopt') {
    const challenger = challengerStrategy(paths)!
    writeSecureFile(paths.incumbent, `<!-- id: ${challenger.id} -->\n${challenger.text}\n`)
  }
  renameSync(paths.challenger, archive)
  return trial
}

/** When the search should write itself a challenger: none on trial, and the last few generations banked nothing. */
export function shouldProposeChallenger(records: GenerationRecord[], paths = strategyPaths(), window = 3): boolean {
  if (challengerStrategy(paths)) return false
  const recent = [...records].sort((a, b) => a.generation - b.generation).slice(-window)
  return recent.length === window && recent.every((record) => record.verdict !== 'promoted')
}

/** Funnel stats by strategy, for the proposer writing a challenger. */
export function renderFunnelForPrompt(records: GenerationRecord[]): string {
  if (records.length === 0) return '(no generations yet)'
  const counts = new Map<string, number>()
  for (const record of records) {
    const stage = record.verdict === 'promoted' ? 'promoted' : record.funnel ? `stopped after ${record.funnel}` : 'no hypothesis / not recorded'
    counts.set(stage, (counts.get(stage) ?? 0) + 1)
  }
  return [...counts.entries()].map(([stage, count]) => `- ${count}× ${stage}`).join('\n')
}

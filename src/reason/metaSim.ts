import { seededRandom } from '../compounding/stats.ts'
import { harnessesFor, type Harness } from './harness.ts'
import { applyOutcome, chooseHarness, type Library } from './library.ts'
import { planHarness, WORLD_FLAGS, type WorldContext, type WorldFlag } from './plan.ts'
import { signatureKey, type TaskClass, type TaskSignature } from './signature.ts'

/**
 * A stream of tasks for the reasoning layer to choose search shapes on, with
 * the true odds known.
 *
 * "The planner is better than the bandit it replaces" is a claim about
 * decisions made over time, and a claim like that is only worth anything when
 * it can be checked. There is no live record to check it against (the reasoning
 * library has never run against a real model), so this builds one where the
 * truth is known: what each search shape really costs and how often it really
 * verifies, per kind of task, under each world condition. Every policy is then
 * run over the *same* tasks with the *same* random draws, so the difference
 * between two of them is the difference between their choices and nothing else.
 *
 * Two worlds, because a simulator that only shows a method winning where its
 * assumptions hold is a demonstration, not a test:
 *
 *   structured  what real projects look like: tasks of one class resemble each
 *               other (which is what pooling relies on), tasks differ within a
 *               class, and a flaky check or a stale picture changes how often a
 *               search verifies (which is what the world flags rely on);
 *   null        no such structure: every kind of task has its own unrelated
 *               odds and the world's flags change nothing. The control. The
 *               planner has no edge here, and the question is what it costs;
 *   dead-tail   structured, but a search that has not passed by the end of its
 *               first round almost never does afterwards: where the attempt cap
 *               is meant to save something, and so the one place to check that
 *               it does.
 *
 * The attempt mechanics follow `select.ts`: attempts are made in rounds of
 * `width` at once, all of a round is paid for whichever one passes, the search
 * stops at the first pass, and later attempts refine so they are worth less.
 * Costs are tokens. Nothing calls a model.
 */

export type SimWorld = 'structured' | 'null' | 'dead-tail'

/** Everything about one kind of task that the policies cannot see. */
interface Cell {
  signature: TaskSignature
  harnesses: Harness[]
  weight: number
  /** Chance the first attempt verifies, structured world. */
  first: number
  /** How much each later attempt is worth relative to the one before. */
  decay: Record<string, number>
  /** Per-harness first-attempt odds, null world. */
  independent: Record<string, number>
  /** Tokens for one attempt. */
  cost: number
}

interface TaskDraw {
  cell: number
  flags: Record<WorldFlag, boolean>
  /** One uniform per attempt slot and one per cost, fixed so that every policy meets the same luck. */
  luck: number[]
  spend: number[]
}

const CLASSES: Array<{ taskClass: TaskClass; first: number; cost: number }> = [
  { taskClass: 'repair', first: 0.4, cost: 30_000 },
  { taskClass: 'implement', first: 0.3, cost: 55_000 },
  { taskClass: 'refactor', first: 0.55, cost: 40_000 },
]

/** Attempts a harness opens in its first round. */
const HARNESS_WIDTH: Record<string, number> = { single: 1, wide: 3, deep: 2 }

/** Effort makes each attempt of the deeper harness better, at a price. */
const EFFORT: Record<string, { quality: number; price: number; decay: number }> = {
  single: { quality: 1, price: 1, decay: 0 },
  wide: { quality: 1, price: 1, decay: 0.85 },
  deep: { quality: 1.15, price: 1.5, decay: 0.92 },
}

function normal(random: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(random(), 1e-12))) * Math.cos(2 * Math.PI * random())
}

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value))

function buildWorld(kind: SimWorld, random: () => number): Cell[] {
  const cells: Cell[] = []
  for (const klass of CLASSES) {
    for (const multi of [false, true]) {
      const checks = klass.taskClass === 'repair' ? [true, false] : [true]
      for (const checked of checks) {
        const features = { hasExecutableCheck: checked, namesTargets: true, multiFile: multi, statesAcceptance: false }
        const signature: TaskSignature = { taskClass: klass.taskClass, features, key: signatureKey(klass.taskClass, features) }
        const harnesses = harnessesFor(signature)
        const jitter = Math.exp(0.35 * normal(random))
        cells.push({
          signature,
          harnesses,
          // A few kinds of task are common and most are not.
          weight: 1 / (1 + cells.length) ** 0.8,
          first: clamp(klass.first * (multi ? 0.75 : 1) * jitter, 0.05, 0.9),
          decay: Object.fromEntries(harnesses.map((harness) => [harness.id, clamp((EFFORT[harness.id]?.decay ?? 0.85) * Math.exp(0.08 * normal(random)), 0.4, 0.98)])),
          independent: Object.fromEntries(harnesses.map((harness) => [harness.id, 0.08 + 0.52 * random()])),
          cost: klass.cost * (multi ? 1.5 : 1),
        })
      }
    }
  }
  return cells
}

/** The world's conditions at the time of one task. Checks are fast or slow, and flaky or not, per project; the picture goes stale at times; a project is cold at first. */
function conditions(random: () => number, index: number, project: { slow: boolean; flaky: boolean }): Record<WorldFlag, boolean> {
  return { slow: project.slow, flaky: project.flaky, cold: index < 20, unsteady: random() < 0.15 }
}

/** Chance attempt `k` (1-based) of a run of `harnessId` verifies, in this world, right now. */
function attemptOdds(kind: SimWorld, cell: Cell, harnessId: string, k: number, flags: Record<WorldFlag, boolean>): number {
  // A dead tail: whatever the first round did not find, nothing after it will.
  const beyondFirstRound = k > (kind === 'dead-tail' ? (HARNESS_WIDTH[harnessId] ?? 1) : Number.POSITIVE_INFINITY)
  if (kind === 'null') return clamp((cell.independent[harnessId] ?? 0.3) * (cell.decay[harnessId] ?? 0.8) ** (k - 1), 0.01, 0.95)
  const effort = EFFORT[harnessId] ?? EFFORT.wide!
  let odds = cell.first * effort.quality * (cell.decay[harnessId] ?? 0.85) ** (k - 1)
  if (beyondFirstRound) odds *= 0.03
  // A flaky check rejects good work some of the time, whatever attempt it is.
  if (flags.flaky) odds *= 0.72
  // A stale picture costs the first try only: later ones read what the check said.
  if (flags.unsteady && k === 1) odds *= 0.8
  return clamp(odds, 0.01, 0.95)
}

/** The rounds a harness spends its budget in: `width` attempts at once. */
function rounds(harness: Harness, budget: number): number[] {
  const sizes: number[] = []
  let left = Math.max(1, Math.min(budget, harness.maxAttempts))
  while (left > 0) {
    const size = Math.min(harness.width, left)
    sizes.push(size)
    left -= size
  }
  return sizes
}

export interface RunResult {
  verified: boolean
  /** Attempts `solve` would have recorded: up to and including the one that passed. */
  attempts: number
  /** Tokens actually spent: every attempt of every round that ran. */
  cost: number
  successAt?: number
}

function runOne(kind: SimWorld, cell: Cell, harness: Harness, budget: number, task: TaskDraw): RunResult {
  const effort = EFFORT[harness.id] ?? EFFORT.wide!
  let index = 0
  let spent = 0
  for (const size of rounds(harness, budget)) {
    const winner = (() => {
      for (let offset = 0; offset < size; offset += 1) {
        const k = index + offset + 1
        if ((task.luck[k - 1] ?? 1) < attemptOdds(kind, cell, harness.id, k, task.flags)) return k
      }
      return undefined
    })()
    for (let offset = 0; offset < size; offset += 1) spent += cell.cost * effort.price * Math.exp(0.25 * ((task.spend[index + offset] ?? 0.5) - 0.5) * 3.46)
    if (winner !== undefined) return { verified: true, attempts: winner, cost: spent, successAt: winner }
    index += size
  }
  return { verified: false, attempts: index, cost: spent }
}

/** How often a harness verifies in a cell and what a run costs, exactly, from the true odds. */
function truth(kind: SimWorld, cell: Cell, harness: Harness, flags: Record<WorldFlag, boolean>): { p: number; cost: number } {
  const effort = EFFORT[harness.id] ?? EFFORT.wide!
  let alive = 1
  let cost = 0
  let index = 0
  for (const size of rounds(harness, harness.maxAttempts)) {
    cost += alive * size * cell.cost * effort.price
    let stay = 1
    for (let offset = 0; offset < size; offset += 1) stay *= 1 - attemptOdds(kind, cell, harness.id, index + offset + 1, flags)
    alive *= stay
    index += size
  }
  return { p: 1 - alive, cost }
}

export type PolicyName = 'library' | 'planner' | 'planner-nocap' | 'planner-noflags' | 'single' | 'wide' | 'deep' | 'oracle'

interface Choice {
  harness: Harness
  budget: number
  /** What a planner committed to before the run, for scoring how well it predicts. */
  prediction?: { pVerify: number; independent: number }
}

function chooser(policy: PolicyName, kind: SimWorld, tolerance?: number): (cell: Cell, library: Library, flags: Record<WorldFlag, boolean>, modelled: number) => Choice {
  return (cell, library, flags, modelled) => {
    const byId = (id: string | undefined) => cell.harnesses.find((harness) => harness.id === id) ?? cell.harnesses[0]!
    if (policy === 'single' || policy === 'wide' || policy === 'deep') {
      const harness = byId(policy)
      return { harness, budget: harness.maxAttempts }
    }
    if (policy === 'oracle') {
      // The planner's own rule with the true odds in hand: the best verification rate, then the cheapest within the tolerance of it.
      const odds = cell.harnesses.map((harness) => ({ harness, ...truth(kind, cell, harness, flags) }))
      const best = Math.max(...odds.map((entry) => entry.p))
      const pick = odds.filter((entry) => entry.p >= best - (tolerance ?? 0.05)).sort((a, b) => a.cost - b.cost)[0]!
      return { harness: pick.harness, budget: pick.harness.maxAttempts }
    }
    if (policy === 'library') {
      const choice = chooseHarness(cell.signature.key, cell.harnesses.map((harness) => harness.id), library)
      const harness = byId(choice.harnessId)
      return { harness, budget: harness.maxAttempts }
    }
    // The ablations: the same planner without the learned attempt cap, and without the world's flags.
    const context: WorldContext | undefined = policy === 'planner-noflags' ? undefined : { flags, modelled }
    const plan = planHarness({ signature: cell.signature.key, candidates: cell.harnesses.map((harness) => ({ id: harness.id, maxAttempts: harness.maxAttempts, ...(harness.subsetOf ? { subsetOf: harness.subsetOf } : {}) })), library, ...(context ? { context } : {}), ...(tolerance === undefined ? {} : { tolerance }) })
    const harness = byId(plan.harnessId)
    const cap = policy === 'planner-nocap' ? undefined : plan.maxAttempts
    return { harness, budget: Math.min(harness.maxAttempts, cap ?? harness.maxAttempts), ...(plan.prediction ? { prediction: { pVerify: plan.prediction.pVerify, independent: plan.prediction.independent } } : {}) }
  }
}

export interface Window {
  tasks: number
  verified: number
  cost: number
}

export interface PolicyRun {
  policy: PolicyName
  /** Squared error of the predicted verification rate, planner's and the independent cells', on the runs where a plan predicted one. */
  brier: { planner: number; independent: number; n: number }
  /** Cost and verification over the first 50 tasks, the next 100, and the rest. */
  windows: [Window, Window, Window]
}

const CUTS = [50, 150]

/** One policy over one stream, from an empty library. */
export function runPolicy(policy: PolicyName, kind: SimWorld, cells: readonly Cell[], stream: readonly TaskDraw[], tolerance?: number): PolicyRun {
  const choose = chooser(policy, kind, tolerance)
  const brier = { planner: 0, independent: 0, n: 0 }
  let library: Library = { version: 1, records: [] }
  const windows: [Window, Window, Window] = [
    { tasks: 0, verified: 0, cost: 0 },
    { tasks: 0, verified: 0, cost: 0 },
    { tasks: 0, verified: 0, cost: 0 },
  ]
  for (const [index, task] of stream.entries()) {
    const cell = cells[task.cell]!
    const { harness, budget, prediction } = choose(cell, library, task.flags, index * 4)
    const result = runOne(kind, cell, harness, budget, task)
    if (prediction) {
      const actual = result.verified ? 1 : 0
      brier.planner += (prediction.pVerify - actual) ** 2
      brier.independent += (prediction.independent - actual) ** 2
      brier.n += 1
    }
    library = applyOutcome(library, {
      signature: cell.signature.key,
      harnessId: harness.id,
      verified: result.verified,
      attemptsUsed: result.attempts,
      cost: result.cost,
      elapsedMs: 0,
      at: index,
      ...(result.successAt === undefined ? {} : { successAt: result.successAt }),
      context: task.flags,
    })
    const window = windows[index < CUTS[0]! ? 0 : index < CUTS[1]! ? 1 : 2]
    window.tasks += 1
    window.verified += result.verified ? 1 : 0
    window.cost += result.cost
  }
  return { policy, windows, brier }
}

export function makeStream(kind: SimWorld, seed: number, tasks: number): { cells: Cell[]; stream: TaskDraw[] } {
  const random = seededRandom(seed)
  const cells = buildWorld(kind, random)
  const project = { slow: random() < 0.4, flaky: random() < 0.4 }
  const total = cells.reduce((sum, cell) => sum + cell.weight, 0)
  const stream: TaskDraw[] = []
  for (let index = 0; index < tasks; index += 1) {
    let pick = random() * total
    let chosen = 0
    for (const [position, cell] of cells.entries()) {
      pick -= cell.weight
      if (pick <= 0) {
        chosen = position
        break
      }
    }
    stream.push({ cell: chosen, flags: conditions(random, index, project), luck: Array.from({ length: 12 }, random), spend: Array.from({ length: 12 }, random) })
  }
  return { cells, stream }
}

export interface Summary {
  policy: PolicyName
  /** Tokens per verified fix in each window and overall, and the share of tasks verified. */
  costPerFix: { early: number; middle: number; late: number; overall: number }
  verifiedRate: number
  totalCost: number
  /** Tokens spent per task, verified or not: what the search costs whether or not it works. */
  costPerTask: number
  /** How well the policy's own predictions of verification held, against the independent-cell estimate on the same runs. Undefined for policies that predict nothing. */
  prediction?: { planner: number; independent: number }
}

function summarize(policy: PolicyName, runs: PolicyRun[]): Summary {
  const per = (pick: (windows: PolicyRun['windows']) => Window[]) => {
    const parts = runs.flatMap((run) => pick(run.windows))
    const verified = parts.reduce((total, window) => total + window.verified, 0)
    // No tasks fell in the window at all (not the same as none verifying).
    if (parts.every((window) => window.tasks === 0)) return Number.NaN
    return verified > 0 ? parts.reduce((total, window) => total + window.cost, 0) / verified : Number.POSITIVE_INFINITY
  }
  const all = runs.flatMap((run) => run.windows)
  const tasks = all.reduce((total, window) => total + window.tasks, 0)
  return {
    policy,
    costPerFix: { early: per((w) => [w[0]]), middle: per((w) => [w[1]]), late: per((w) => [w[2]]), overall: per((w) => w) },
    verifiedRate: tasks > 0 ? all.reduce((total, window) => total + window.verified, 0) / tasks : 0,
    totalCost: all.reduce((total, window) => total + window.cost, 0),
    costPerTask: tasks > 0 ? all.reduce((total, window) => total + window.cost, 0) / tasks : 0,
    ...(() => {
      const n = runs.reduce((total, run) => total + run.brier.n, 0)
      return n > 0 ? { prediction: { planner: runs.reduce((total, run) => total + run.brier.planner, 0) / n, independent: runs.reduce((total, run) => total + run.brier.independent, 0) / n } } : {}
    })(),
  }
}

export interface Comparison {
  world: SimWorld
  seeds: number
  tasks: number
  summaries: Summary[]
  /** Planner against library, per seed, on the same tasks: mean change in tokens per verified fix, and how many seeds it was cheaper on. */
  planner: { meanChange: number; cheaperOn: number; seeds: number; verifiedChange: number; taskCostChange: number; earlyVerifiedChange: number }
}

/** Every policy over the same streams, from the same empty start. */
export function compare(options: { world: SimWorld; seeds: number; tasks: number; policies?: PolicyName[]; tolerance?: number }): Comparison {
  const policies: PolicyName[] = options.policies ?? ['library', 'planner', 'single', 'wide', 'deep', 'oracle']
  const runs = new Map<PolicyName, PolicyRun[]>(policies.map((policy) => [policy, []]))
  const changes: number[] = []
  const verified: number[] = []
  const taskCost: number[] = []
  const early: number[] = []
  for (let seed = 1; seed <= options.seeds; seed += 1) {
    const { cells, stream } = makeStream(options.world, seed, options.tasks)
    for (const policy of policies) runs.get(policy)!.push(runPolicy(policy, options.world, cells, stream, options.tolerance))
    if (runs.has('library') && runs.has('planner')) {
      const library = summarize('library', [runs.get('library')!.at(-1)!])
      const planner = summarize('planner', [runs.get('planner')!.at(-1)!])
      changes.push(planner.costPerFix.overall / library.costPerFix.overall - 1)
      verified.push(planner.verifiedRate - library.verifiedRate)
      taskCost.push(planner.costPerTask / library.costPerTask - 1)
      const first = (name: 'library' | 'planner') => {
        const window = runs.get(name)!.at(-1)!.windows[0]
        return window.tasks > 0 ? window.verified / window.tasks : 0
      }
      early.push(first('planner') - first('library'))
    }
  }
  const mean = (values: number[]) => (values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length)
  return {
    world: options.world,
    seeds: options.seeds,
    tasks: options.tasks,
    summaries: policies.map((policy) => summarize(policy, runs.get(policy)!)),
    planner: {
      meanChange: mean(changes),
      cheaperOn: changes.filter((change) => change < 0).length,
      seeds: changes.length,
      verifiedChange: mean(verified),
      taskCostChange: mean(taskCost),
      earlyVerifiedChange: mean(early),
    },
  }
}

const tokens = (value: number) => (Number.isNaN(value) ? '—' : Number.isFinite(value) ? `${(value / 1000).toFixed(1)}k` : 'never')

export function renderComparison(result: Comparison): string {
  const label = result.world === 'structured' ? 'structured world (tasks of a kind resemble each other; flaky checks and stale pictures matter)' : result.world === 'dead-tail' ? 'dead-tail world (structured, but nothing after the first round ever verifies)' : 'null world (no structure, flags change nothing): the control'
  const rows = result.summaries.map(
    (s) => `  ${s.policy.padEnd(8)} ${(s.verifiedRate * 100).toFixed(1).padStart(6)}%  ${tokens(s.costPerTask).padStart(9)}  ${tokens(s.costPerFix.early).padStart(8)} ${tokens(s.costPerFix.late).padStart(8)} ${tokens(s.costPerFix.overall).padStart(9)}`,
  )
  const signed = (value: number, unit: string) => `${value >= 0 ? '+' : ''}${(value * (unit === '%' ? 100 : 100)).toFixed(1)}${unit === '%' ? '%' : ' points'}`
  return [
    `${label} — ${result.seeds} seeds × ${result.tasks} tasks`,
    '           verified   tokens/task   per fix: first 50   the rest   overall',
    ...rows,
    `  planner vs library on the same tasks: verified ${signed(result.planner.verifiedChange, 'pts')} overall and ${signed(result.planner.earlyVerifiedChange, 'pts')} in the first 50; tokens per task ${signed(result.planner.taskCostChange, '%')}; tokens per verified fix ${signed(result.planner.meanChange, '%')} (cheaper on ${result.planner.cheaperOn} of ${result.planner.seeds} seeds)`,
  ].join('\n')
}

/** Exposed so the flags the simulation uses are the ones the planner reads. */
export const SIM_FLAGS = WORLD_FLAGS

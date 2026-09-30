/**
 * `elia autopilot`: goal-free, unsupervised development of a repository.
 *
 * Nobody hands the pilot a task. It surveys the repository, measures which of
 * its own checks pass, forms a grounded picture of what the project is and
 * where it is heading, and works a backlog it built itself — each goal a full
 * governed `elia auto` run, unattended, on a branch of its own.
 *
 * The ratchet is what makes that safe to leave running. Before each goal the
 * pilot notes HEAD and the health it measured; after it, it measures again.
 *
 *   - a goal that turns any passing check red is rolled back
 *   - a repair goal whose target check still fails is rolled back
 *   - anything else that changed the tree and whose run completed is committed
 *
 * A rolled-back attempt is never destroyed: it is committed and kept at
 * `refs/elia/autopilot/<pilot>/<goal>-<n>` before the branch is reset. So the
 * branch's health can only go up, and every step is on record.
 *
 * What stays human: anything the unattended governor refuses (pushing,
 * deploying, messaging, a remote database, installing packages outside the
 * setup allowlist). Those are not waited on — the goal is judged on what it
 * could do, and the refusal is listed under "Needs a person" in the report.
 */

import { writeFileSync } from 'node:fs'
import { formatCostUsd, sessionCost } from '../usage.ts'
import { isSensitivePath } from '../autonomy/sensitivePaths.ts'
import { decodeNote } from '../autonomy/operatorNotes.ts'
import { ASSISTANT_READING, PERSON_NOTE } from '../live/liveReply.ts'
import type { AutonomyProfile } from '../autonomy/loop.ts'
import { addEventGoal, addUserGoal, MAX_ATTEMPTS, nextGoal, refreshBacklog } from './backlog.ts'
import { isQuotaExhaustedError, isUnusableRouteError } from '../providerErrors.ts'
import type { CapabilityScope } from '../autonomy/capabilityContract.ts'
import { scopeHook } from './scopes.ts'
import { describeTrigger, fetchPage, loadWatchers, pollWatchers, runGh, type TriggerDeps } from './watch.ts'
import {
  AUTOPILOT_BRANCH_PREFIX,
  changedFilesBetween,
  commitEverything,
  currentBranchName,
  dirtyPaths,
  excludeEliaState,
  headSha,
  isGitWorkTree,
  isTestPath,
  keepRef,
  rollbackTo,
  switchToBranch,
  switchToNewBranch,
  untrackedPaths,
} from './git.ts'
import { compareHealth, measureHealth, passingChecks, summarizeHealth, type CheckRunner } from './health.ts'
import { renderReport } from './report.ts'
import { appendJournal, loadPilotState, newPilotState, reportPath, savePilotState } from './store.ts'
import { surveyRepository } from './survey.ts'
import { formUnderstanding, type UnderstandingModel } from './understand.ts'
import type { Goal, GoalOutcome, HealthReport, PilotState } from './types.ts'

export class PilotError extends Error {}

/**
 * The model provider will not answer at all: out of quota, payment required,
 * an invalid key. Nothing about the goal is wrong, so it must not count as an
 * attempt: on elia's own pilot a spent free tier (402) failed two goals twice
 * each, parked both, and then every restart of the service crashed replanning.
 */
export class ProviderRefusedError extends Error {}

function providerRefused(message: string | undefined): boolean {
  return Boolean(message) && (isUnusableRouteError(message!) || isQuotaExhaustedError(message!))
}

/** How long a watching pilot waits after the provider refuses before trying again. */
const PROVIDER_RETRY_MS = 30 * 60_000

export interface GoalRunResult {
  runId?: string
  /** `completed` when the run's own verification and review passed. */
  outcome: string
  summary?: string
  /** Things the run could not do on its own (refused critical actions, missing tools). */
  blockers: string[]
}

export type GoalRunner = (input: { goal: Goal; prompt: string; root: string; signal?: AbortSignal; maxWallClockMs: number; profile: AutonomyProfile; scopes?: readonly CapabilityScope[] }) => Promise<GoalRunResult>

export interface PilotOptions {
  root: string
  /** Goals to run before stopping (default 5). */
  maxGoals?: number
  /** Wall-clock per goal (default 45 minutes). */
  goalMinutes?: number
  /** Wall-clock for the whole pilot; 0 or unset means no limit beyond the goal budget. */
  maxHours?: number
  profile?: AutonomyProfile
  /** Survey, measure, understand and plan — change nothing. */
  planOnly?: boolean
  resume?: boolean
  signal?: AbortSignal
  log?: (line: string) => void
  /** Directions from the operator that arrived while the pilot ran; drained between goals. */
  drainDirections?: () => string[]
  /** How many times an emptied backlog may be refilled by re-understanding the repo (default 1). */
  maxReplans?: number
  /**
   * Keep running and react to what the watchers in `.elia/autopilot/watch.json`
   * see (watch.ts): each event is a goal, an empty backlog is a wait rather
   * than the end, and there is no goal budget unless `maxGoals` is given.
   */
  watch?: boolean
  /** How long a watching pilot waits between looks when it has nothing to do (default 15s). */
  idlePollMs?: number
  /** What goal runs may do (scopes.ts). Unset: everything the unattended governor allows, as before. */
  scopes?: readonly CapabilityScope[]
  watchDeps?: Partial<Omit<TriggerDeps, 'now'>>
  /** A watching pilot's spending limit per UTC day, in USD (default `dailyBudgetUsd()`). */
  dailyBudgetUsd?: number
  /** How long a watching pilot waits after the model provider refuses (default 30 minutes). */
  providerRetryMs?: number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  // Seams for tests.
  understandingModel?: UnderstandingModel
  runGoal?: GoalRunner
  checkRunner?: CheckRunner
  has?: (command: string) => boolean
  env?: NodeJS.ProcessEnv
  spendExceeded?: () => boolean
}

export interface PilotResult {
  state: PilotState
  reportPath: string
}

/**
 * What a watching pilot may spend a day. A session limit is not enough for it:
 * one that stops at its limit is restarted by the service manager 30s later,
 * with a fresh session and a fresh limit. `ELIA_AUTOPILOT_DAILY_USD` sets it.
 */
export function dailyBudgetUsd(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ELIA_AUTOPILOT_DAILY_USD)
  return Number.isFinite(raw) && raw > 0 ? raw : 2
}

function today(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

/** A direction that asks the pilot to stop rather than to do something. */
const STOP_DIRECTION = /^\s*(?:please\s+)?(?:stop|pause|halt|wrap up|finish up|that'?s enough)\b/i

/**
 * The operator's own words in a queued direction. A live steer also carries the
 * assistant's paraphrase and a machine-readable plan block; both are model text
 * (the live lane reads repo files and tool output), so neither may become an
 * operator goal, which outranks everything the pilot inferred.
 */
export function operatorWords(direction: string): string {
  const lines = decodeNote(direction).text.split('\n')
  const note = lines.find((line) => line.startsWith(PERSON_NOTE))
  if (note !== undefined) return note.slice(PERSON_NOTE.length).trim().slice(0, 2_000)
  return lines.filter((line) => !line.startsWith(ASSISTANT_READING) && !line.startsWith('Change the plan accordingly')).join('\n').trim().slice(0, 2_000)
}

/** Three rolled-back goals in a row means something systemic is wrong; stop and report. */
const MAX_CONSECUTIVE_REJECTIONS = 3

let active: PilotState | undefined

/** The pilot running in this process, if any — what a live reply reads. */
export function activePilot(): PilotState | undefined {
  return active
}

export function goalPrompt(goal: Goal, state: PilotState): string {
  const u = state.understanding
  const keepGreen = passingChecks(state.latest ?? state.baseline)
  return [
    'You are working for elia\'s autopilot on this repository. Nobody is available to answer questions: make sound engineering decisions on your own, record the assumptions you make, and finish the work.',
    '',
    u ? `Project: ${u.purpose}\nDirection: ${u.vision}` : '',
    '',
    `## Goal\n${goal.title}`,
    goal.detail ? `\n## Why\n${goal.detail}` : '',
    '',
    '## Definition of done',
    goal.verification.length > 0 ? `- These commands pass: ${goal.verification.map((command) => `\`${command}\``).join(', ')}` : '- There is no runnable check for this goal: make the change small and verify it by reading and, where possible, by running the code.',
    keepGreen.length > 0 ? `- Everything that passes today still passes: ${keepGreen.map((command) => `\`${command}\``).join(', ')}. A change that breaks one of these is rolled back automatically.` : '',
    '',
    '## Constraints',
    '- Work only inside this repository, on the current branch. Do not push, publish, deploy, open pull requests, or contact anyone.',
    '- Keep the change focused on this goal. Fix root causes; never skip, weaken or delete a check to make it pass.',
    '- If the work needs a database, use the `database` tool against a local database (action "start" runs one for this project).',
  ].filter((line) => line !== undefined).join('\n').replace(/\n{3,}/g, '\n\n')
}

const defaultRunGoal: GoalRunner = async ({ prompt, root, signal, maxWallClockMs, profile, scopes }) => {
  const { runAutonomousTask, autoApprove } = await import('../autonomy/loop.ts')
  const result = await runAutonomousTask({
    goal: prompt,
    approve: autoApprove,
    workspaceRoot: root,
    mode: 'dev',
    profile,
    governanceMode: 'unattended',
    publish: false,
    projectDocuments: false,
    signal,
    maxWallClockMs,
    ...(scopes ? { extraToolHooks: [scopeHook(scopes)] } : {}),
  })
  return { runId: result.runId, outcome: result.outcome, summary: result.completion.summary, blockers: result.completion.blockers }
}

async function defaultSpendExceeded(): Promise<boolean> {
  const [{ spendState }, { config }, { ZERO_USAGE }] = await Promise.all([import('../spendLimit.ts'), import('../config.ts'), import('../usage.ts')])
  return spendState(config.model, ZERO_USAGE).exceeded
}

function persist(state: PilotState): void {
  savePilotState(state)
  try {
    writeFileSync(reportPath(state.root), renderReport(state))
  } catch {
    // The report is regenerated on the next step.
  }
}

/** Starts or resumes the pilot's branch. Refuses to mix the operator's uncommitted work into the pilot's. */
function takeBranch(state: PilotState, log: (line: string) => void): void {
  const root = state.root
  if (state.branch) {
    if (currentBranchName(root) === state.branch) return
    const dirty = dirtyPaths(root)
    if (dirty.length > 0) throw new PilotError(`cannot resume on ${state.branch}: the checkout has uncommitted changes (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}). Commit or stash them first.`)
    const switched = switchToBranch(root, state.branch)
    if (!switched.ok) throw new PilotError(`could not switch to ${state.branch}: ${switched.stderr}`)
    log(`↻ resumed on branch ${state.branch}`)
    return
  }
  const dirty = dirtyPaths(root)
  if (dirty.length > 0) {
    throw new PilotError(`the checkout has uncommitted changes (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}). The autopilot works on a branch of its own and rolls back goals that break a check, so it starts from a clean tree — commit or stash these first.`)
  }
  state.baseBranch = currentBranchName(root)
  state.baseSha = headSha(root)
  const branch = `${AUTOPILOT_BRANCH_PREFIX}${state.id}`
  const created = switchToNewBranch(root, branch)
  if (!created.ok) throw new PilotError(`could not create branch ${branch}: ${created.stderr}`)
  state.branch = branch
  log(`⎇ working on a new branch ${branch} (from ${state.baseBranch} @ ${state.baseSha?.slice(0, 10)}); your branch is untouched`)
}

async function understand(state: PilotState, options: PilotOptions, log: (line: string) => void): Promise<void> {
  const survey = state.survey!
  log('◆ forming an understanding of the project (reading its key files)…')
  const formed = await formUnderstanding(survey, state.latest ?? state.baseline, { model: options.understandingModel, signal: options.signal })
  // Cut short, the answer is a fallback, not an understanding; keeping it
  // would stop a resumed pilot from ever reading the project properly.
  if (options.signal?.aborted) return
  state.understanding = formed.understanding
  const before = state.backlog.length
  state.backlog = refreshBacklog(state.backlog, { survey, health: state.latest ?? state.baseline, proposed: formed.goals })
  appendJournal(state.root, 'understood', { droppedClaims: formed.understanding.droppedClaims, proposed: formed.goals.length, droppedGoals: formed.droppedGoals, added: state.backlog.length - before })
  log(`  purpose: ${formed.understanding.purpose}`)
  if (formed.understanding.vision && formed.understanding.vision !== 'not stated') log(`  direction: ${formed.understanding.vision}`)
  const dropped = formed.understanding.droppedClaims + formed.droppedGoals
  log(`  ${state.backlog.length - before} new goal(s) in the backlog${dropped > 0 ? `; ${dropped} claim(s)/goal(s) dropped for citing nothing real` : ''}`)
}

async function runOneGoal(state: PilotState, goal: Goal, options: PilotOptions, log: (line: string) => void): Promise<GoalOutcome> {
  const root = state.root
  const startedAt = Date.now()
  const spentBefore = sessionCost().usd
  const beforeSha = headSha(root)!
  const keep = new Set(untrackedPaths(root))
  const before = state.latest ?? state.baseline!
  goal.attempts += 1
  state.currentGoalId = goal.id
  persist(state)
  appendJournal(root, 'goal-start', { goal: goal.id, title: goal.title, attempt: goal.attempts })
  log(`\n▶ ${goal.id} · ${goal.title}${goal.attempts > 1 ? ` (attempt ${goal.attempts})` : ''}`)

  let run: GoalRunResult
  try {
    run = await (options.runGoal ?? defaultRunGoal)({
      goal,
      prompt: goalPrompt(goal, state),
      root,
      signal: options.signal,
      maxWallClockMs: Math.max(1, options.goalMinutes ?? 45) * 60_000,
      profile: options.profile ?? 'balanced',
      scopes: options.scopes,
    })
  } catch (error) {
    run = { outcome: 'error', summary: error instanceof Error ? error.message : String(error), blockers: [] }
  }

  if (run.outcome === 'error' && providerRefused(run.summary)) {
    // Not the goal's failure: undo anything half-done, give the attempt back, and let the loop wait.
    if (headSha(root) !== beforeSha || dirtyPaths(root).length > 0) rollbackTo(root, beforeSha, keep)
    goal.attempts -= 1
    state.currentGoalId = undefined
    appendJournal(root, 'provider-refused', { goal: goal.id, reason: run.summary?.slice(0, 300) })
    persist(state)
    throw new ProviderRefusedError(run.summary)
  }

  // The branch may have moved (the run commits per wave) or be dirty (leftovers).
  const changed = headSha(root) !== beforeSha || dirtyPaths(root).length > 0
  const checks = [...new Set([...before.checks.map((check) => check.command), ...goal.verification])]
  log(`  measuring health after the goal (${checks.length} check(s))…`)
  const after = await measureHealth(root, checks, { signal: options.signal, runner: options.checkRunner })
  const delta = compareHealth(before, after)
  const target = goal.kind === 'repair' ? after.checks.find((check) => check.command === goal.verification[0]) : undefined
  const ownChecksPass = goal.verification.length > 0 && goal.verification.every((command) => after.checks.find((check) => check.command === command)?.status === 'pass')

  // Progress on the target that a whole-check pass/fail cannot see: fewer
  // failing tests, none new. A repair of a large suite rarely goes green in
  // one goal; rolling that back threw the progress away (elia's own suite,
  // 2026-09-30: a real fix discarded because six other tests still failed).
  const progress = target && target.status !== 'pass' ? delta.improved.find((entry) => entry.command === target.command) : undefined

  let accepted = false
  let partial = false
  let reason: string
  if (options.signal?.aborted) reason = 'stopped by the operator mid-goal'
  else if (!changed) reason = run.outcome === 'completed' ? 'the run completed without changing anything' : `the run ended "${run.outcome}" without changing anything`
  else if (delta.regressions.length > 0) reason = `it turned passing checks red: ${delta.regressions.join(', ')}`
  else if (delta.worsened.length > 0) reason = `it broke tests that passed before: ${delta.worsened.map((entry) => `${entry.newFailures.slice(0, 5).join(', ')}${entry.newFailures.length > 5 ? ` and ${entry.newFailures.length - 5} more` : ''} (in \`${entry.command}\`)`).join('; ')}`
  else if (progress) {
    accepted = true
    partial = true
    reason = `progress on \`${progress.command}\`: ${progress.before} → ${progress.after} failing test(s), none new (fixed ${progress.fixedTests.slice(0, 5).join(', ')}${progress.fixedTests.length > 5 ? ', …' : ''})`
  } else if (target && target.status !== 'pass') reason = `the target check \`${target.command}\` still ${target.status === 'timeout' ? 'times out' : 'fails'}`
  else if (run.outcome !== 'completed' && !ownChecksPass) reason = `the run ended "${run.outcome}" and the goal's own checks do not all pass`
  else {
    accepted = true
    reason = run.outcome === 'completed' ? 'verified by the run and by the ratchet' : `the run ended "${run.outcome}" but every check of the goal passes and none regressed`
  }

  const outcome: GoalOutcome = {
    at: new Date().toISOString(),
    runId: run.runId,
    runOutcome: run.outcome,
    accepted,
    reason,
    beforeSha,
    regressions: delta.regressions,
    fixed: delta.fixed,
    elapsedMs: Date.now() - startedAt,
    costUsd: Math.max(0, sessionCost().usd - spentBefore),
    blockers: run.blockers.slice(0, 8),
  }
  const cost = outcome.costUsd! > 0 ? ` · ${formatCostUsd(outcome.costUsd)}` : ''

  if (accepted) {
    try {
      const commit = commitEverything(root, `autopilot: ${goal.title}\n\n${reason}.\nPilot ${state.id}, goal ${goal.id}${run.runId ? `, run ${run.runId}` : ''}.`, isSensitivePath)
      if (commit.skipped.length > 0) outcome.blockers.push(`left uncommitted because they look like secrets: ${commit.skipped.join(', ')}`)
      outcome.afterSha = headSha(root)
      state.latest = after
      // The ratchet sees that checks pass, not how: a goal that edits tests may
      // have fixed them, or made them easier. Seen on elia's own suite: a repair
      // that landed 8 → 5 also changed a test that had not been failing.
      const testsTouched = outcome.afterSha ? changedFilesBetween(root, beforeSha, outcome.afterSha).filter(isTestPath) : []
      if (testsTouched.length > 0) outcome.blockers.push(`changed test file(s) — check they were fixed, not weakened: ${testsTouched.slice(0, 6).join(', ')}${testsTouched.length > 6 ? ', …' : ''}`)
      if (partial && target) {
        // The rest of the goal is still open, starting from where this left it.
        goal.status = 'open'
        goal.attempts = 0
        goal.detail = `${goal.detail.split('\nLast output:\n')[0]}\nLast output:\n${target.tail}`
        log(`  ◐ landed progress ${outcome.afterSha?.slice(0, 10)} — ${reason}; the goal stays open for the rest${cost}`)
      } else {
        goal.status = 'done'
        log(`  ✓ landed ${outcome.afterSha?.slice(0, 10)} — ${reason}${delta.fixed.length > 0 ? `; fixed ${delta.fixed.join(', ')}` : ''}${cost}`)
      }
    } catch (error) {
      // A commit hook refused it: treat it like any other rejection.
      accepted = false
      outcome.accepted = false
      outcome.reason = `the project's commit hook refused the change: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  if (!accepted) {
    if (changed) {
      try {
        commitEverything(root, `autopilot (rolled back): ${goal.title}\n\n${outcome.reason}`, isSensitivePath, { hooks: false })
      } catch {
        // Keeping the attempt is best-effort; the rollback below is not.
      }
      const ref = `refs/elia/autopilot/${state.id}/${goal.id}-${goal.attempts}`
      if (headSha(root) !== beforeSha && keepRef(root, ref)) outcome.keptAt = ref
      rollbackTo(root, beforeSha, keep)
    }
    const nothingToDo = !changed && run.outcome === 'completed'
    if (nothingToDo) goal.status = 'done'
    else if (goal.attempts >= MAX_ATTEMPTS) goal.status = 'parked'
    log(`  ↺ ${changed ? 'rolled back' : 'no change'} — ${outcome.reason}${outcome.keptAt ? ` (attempt kept at ${outcome.keptAt})` : ''}${goal.status === 'parked' ? '; parked after two attempts' : ''}${cost}`)
  }

  for (const blocker of outcome.blockers) {
    const line = `${goal.title}: ${blocker}`
    if (!state.needsHuman.includes(line)) state.needsHuman.push(line)
  }
  if (outcome.costUsd && outcome.costUsd > 0) {
    const day = today()
    state.spentByDay = { ...state.spentByDay, [day]: (state.spentByDay?.[day] ?? 0) + outcome.costUsd }
  }
  goal.outcomes.push(outcome)
  state.goalsRun += 1
  state.currentGoalId = undefined
  appendJournal(root, 'goal-end', { goal: goal.id, accepted: outcome.accepted, reason: outcome.reason, runOutcome: run.outcome, regressions: delta.regressions, fixed: delta.fixed, keptAt: outcome.keptAt, costUsd: outcome.costUsd })
  persist(state)
  return outcome
}

export async function runPilot(options: PilotOptions): Promise<PilotResult> {
  const root = options.root
  const log = options.log ?? ((line: string) => console.log(line))
  if (!isGitWorkTree(root)) {
    throw new PilotError('elia autopilot works inside a git repository: it commits each goal it lands on a branch of its own and rolls back any goal that breaks a check. Initialise one first (git init, then commit the current files).')
  }
  if (!headSha(root)) throw new PilotError('this repository has no commits yet; the autopilot needs one to branch from. Commit the current files first.')
  if (options.watch && loadWatchers(root).length === 0) {
    throw new PilotError('there is nothing to watch yet. Add a watcher first, e.g.: elia autopilot watch add "github ci" (or "github issues", "file src/", "url https://…", "every 6h")')
  }
  excludeEliaState(root)

  let state: PilotState
  if (options.resume) {
    const saved = loadPilotState(root)
    if (!saved) throw new PilotError('there is no autopilot to resume in this repository (no .elia/autopilot/state.json). Start one with: elia autopilot')
    state = saved
    state.stopReason = undefined
    state.root = root
  } else {
    state = newPilotState(root)
  }
  active = state
  try {
    appendJournal(root, options.resume ? 'resume' : 'start', { pilot: state.id, planOnly: Boolean(options.planOnly) })
    if (!options.planOnly) takeBranch(state, log)

    if (!state.survey || !options.resume) {
      state.phase = 'survey'
      log('◆ surveying the repository…')
      state.survey = surveyRepository(root, { env: options.env, has: options.has })
      log(`  ${state.survey.name}: ${state.survey.files.source} source files, ${state.survey.files.tests} tests, ${state.survey.git?.commits ?? 0} commits; checks: ${state.survey.checks.join(' ; ') || 'none found'}`)
      persist(state)
    }
    if (!state.baseline) {
      state.phase = 'health'
      log(`◆ measuring health: running the project's own checks (${state.survey.checks.length})…`)
      state.baseline = await measureHealth(root, state.survey.checks, { signal: options.signal, runner: options.checkRunner, onCheck: (check) => log(`  ${check.status === 'pass' ? '✓' : check.status === 'fail' || check.status === 'timeout' ? '✗' : '·'} ${check.command} — ${check.status}`) })
      state.latest = state.baseline
      persist(state)
    }
    while (!state.understanding && !options.signal?.aborted) {
      state.phase = 'understand'
      try {
        await understand(state, options, log)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // A watching pilot waits for the provider (see `onRefused` below); anything else ends the pilot as before.
        if (!options.watch || !providerRefused(message)) throw error
        appendJournal(root, 'provider-refused', { reason: message.slice(0, 300) })
        const retryMs = options.providerRetryMs ?? PROVIDER_RETRY_MS
        log(`… the model provider refused (${message.slice(0, 120)}); trying again in ${Math.round(retryMs / 60_000)} min`)
        await (options.sleep ?? waitUnlessAborted)(retryMs, options.signal)
        continue
      }
      persist(state)
    }
    state.phase = 'plan'
    persist(state)

    if (options.planOnly) {
      state.phase = 'stopped'
      state.stopReason = 'plan only: nothing was changed'
      return { state, reportPath: reportPath(root) }
    }

    state.phase = 'work'
    const maxGoals = options.watch && options.maxGoals === undefined ? Number.POSITIVE_INFINITY : Math.max(1, options.maxGoals ?? 5)
    const sleep = options.sleep ?? waitUnlessAborted
    const idlePollMs = Math.max(100, options.idlePollMs ?? 15_000)
    // What a watching pilot last said it was waiting for, so it says it once, not every poll.
    let waitingFor: string | undefined
    const wait = async (why: string): Promise<void> => {
      if (why !== waitingFor) log(`… ${why}`)
      waitingFor = why
      await sleep(idlePollMs, options.signal)
    }
    if (options.watch) log(`◆ watching: ${loadWatchers(root).map((watcher) => describeTrigger(watcher.spec)).join(' · ')}`)
    // The model provider refusing is weather, not a verdict on the work: a
    // watching pilot waits it out (a stopped one would only be restarted into
    // the same refusal); a one-off pilot stops and says why.
    const refusal = async (step: () => Promise<void>): Promise<string | undefined> => {
      try {
        await step()
        return undefined
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (providerRefused(message)) return message
        throw error
      }
    }
    const onRefused = async (message: string): Promise<boolean> => {
      appendJournal(root, 'provider-refused', { reason: message.slice(0, 300) })
      if (!options.watch) {
        state.stopReason = `the model provider refused: ${message.slice(0, 200)}`
        return false
      }
      const retryMs = options.providerRetryMs ?? PROVIDER_RETRY_MS
      log(`… the model provider refused (${message.slice(0, 120)}); trying again in ${Math.round(retryMs / 60_000)} min`)
      waitingFor = undefined
      await sleep(retryMs, options.signal)
      return true
    }
    const deadline = options.maxHours && options.maxHours > 0 ? Date.now() + options.maxHours * 3_600_000 : undefined
    const spendExceeded = options.spendExceeded ?? defaultSpendExceeded
    let rejectedInARow = 0
    let replans = 0
    let goalsThisSession = 0
    for (;;) {
      if (options.signal?.aborted) {
        state.stopReason = 'stopped by the operator'
        break
      }
      let stopAsked: string | undefined
      for (const queued of options.drainDirections?.() ?? []) {
        const direction = operatorWords(queued)
        if (!direction) continue
        if (STOP_DIRECTION.test(direction)) {
          stopAsked = direction
          continue
        }
        state.backlog = addUserGoal(state.backlog, direction, state.survey, state.latest)
        appendJournal(root, 'direction', { text: direction.slice(0, 500) })
        log(`↳ added to the front of the backlog: ${direction.slice(0, 160)}`)
      }
      if (stopAsked) {
        state.stopReason = `the operator asked to stop ("${stopAsked.slice(0, 80)}")`
        break
      }
      if (options.watch) {
        const { events, notices, rescan } = await pollWatchers(root, { now: Date.now(), gh: options.watchDeps?.gh ?? runGh, fetchText: options.watchDeps?.fetchText ?? fetchPage })
        for (const notice of notices) {
          if (!state.needsHuman.includes(notice)) state.needsHuman.push(notice)
          appendJournal(root, 'needs-human', { text: notice.slice(0, 500) })
          log(`⚠ watcher: ${notice.slice(0, 200)}`)
        }
        for (const event of events) {
          state.backlog = addEventGoal(state.backlog, event, state.survey, state.latest)
          appendJournal(root, 'event', { text: event.slice(0, 500) })
          log(`↳ watcher: ${event.slice(0, 160)}`)
        }
        if (rescan) {
          // A schedule: look at the whole repository again, as a new pilot would —
          // what it is now, which of its checks pass, and what is worth doing next.
          log('◆ scheduled look: re-surveying, re-measuring and re-reading the project…')
          state.survey = surveyRepository(root, { env: options.env, has: options.has })
          state.latest = await measureHealth(root, state.survey.checks, { signal: options.signal, runner: options.checkRunner })
          const refused = await refusal(() => understand(state, options, log))
          if (refused) {
            if (await onRefused(refused)) continue
            break
          }
          appendJournal(root, 'rescan', { health: summarizeHealth(state.latest) })
        }
        if (events.length > 0 || notices.length > 0 || rescan) {
          waitingFor = undefined
          persist(state)
        }
      }
      if (goalsThisSession >= maxGoals) {
        state.stopReason = `goal budget reached (${maxGoals})`
        break
      }
      if (deadline && Date.now() >= deadline) {
        state.stopReason = `time budget reached (${options.maxHours}h)`
        break
      }
      if (options.watch) {
        const budget = options.dailyBudgetUsd ?? dailyBudgetUsd(options.env ?? process.env)
        const spent = state.spentByDay?.[today()] ?? 0
        if (spent >= budget) {
          await wait(`today's spending limit is reached ($${spent.toFixed(2)} of $${budget.toFixed(2)}, ELIA_AUTOPILOT_DAILY_USD); waiting for tomorrow`)
          continue
        }
      } else if (await spendExceeded()) {
        state.stopReason = 'spending ceiling reached (ELIA_MAX_SPEND_USD)'
        break
      }
      if (rejectedInARow >= MAX_CONSECUTIVE_REJECTIONS) {
        state.stopReason = `${MAX_CONSECUTIVE_REJECTIONS} goals in a row could not be landed — something systemic needs a look (see the report)`
        break
      }
      const dirty = dirtyPaths(root)
      if (dirty.length > 0 && options.watch) {
        // Someone is working in this checkout: wait for them rather than stop a watcher that is meant to keep going.
        await wait(`the working tree has changes the pilot did not make (${dirty.slice(0, 3).join(', ')}); waiting for them to be committed or put away`)
        continue
      }
      if (dirty.length > 0) {
        state.stopReason = `the working tree changed outside the pilot (${dirty.slice(0, 3).join(', ')}); stopping rather than mixing that work into a goal`
        break
      }
      let goal = nextGoal(state.backlog)
      if (!goal && replans < (options.maxReplans ?? 1)) {
        replans += 1
        log('◆ backlog is empty — re-surveying and re-reading the project for what to do next…')
        state.survey = surveyRepository(root, { env: options.env, has: options.has })
        const refused = await refusal(() => understand(state, options, log))
        if (refused) {
          replans -= 1
          if (await onRefused(refused)) continue
          break
        }
        persist(state)
        goal = nextGoal(state.backlog)
      }
      if (!goal && options.watch) {
        await wait('nothing to do right now; watching for what happens next')
        continue
      }
      if (!goal) {
        state.stopReason = 'nothing left worth doing: every goal is landed or parked'
        break
      }
      waitingFor = undefined
      let outcome: GoalOutcome
      try {
        outcome = await runOneGoal(state, goal, options, log)
      } catch (error) {
        if (!(error instanceof ProviderRefusedError)) throw error
        if (await onRefused(error.message)) continue
        break
      }
      goalsThisSession += 1
      rejectedInARow = outcome.accepted || outcome.reason.startsWith('the run completed without changing') ? 0 : rejectedInARow + 1
    }
    state.phase = options.signal?.aborted ? 'stopped' : 'finished'
    return { state, reportPath: reportPath(root) }
  } catch (error) {
    state.phase = 'stopped'
    state.stopReason = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    state.currentGoalId = undefined
    try {
      persist(state)
    } catch {
      // A failed final save must not mask the error that got us here.
    }
    appendJournal(root, 'stop', { reason: state.stopReason, health: summarizeHealth(state.latest) })
    active = undefined
  }
}

function waitUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    if (signal?.aborted) done()
    else signal?.addEventListener('abort', done, { once: true })
  })
}

/** Re-exported so callers can print a status without loading the whole pilot. */
export { loadPilotState } from './store.ts'
export type { HealthReport }

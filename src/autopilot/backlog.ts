/**
 * Backlog: the goals the autopilot could work on, and which one is next.
 *
 * Goals come from four places, and the order of trust is fixed in code:
 *
 *   user         a direction the operator gave mid-run — always first
 *   health       a check of the project's own that fails right now
 *   environment  a blocker that will strand every run until it is provisioned
 *   model        what the understanding step proposed, grounded in evidence
 *
 * The model scores its own proposals (value, effort, risk), but it does not
 * rank them: `goalScore` does, and a failing check outranks any idea. A goal
 * that was already done, or tried twice and parked, is never proposed again —
 * and "again" means similar text, not identical text: titles are compared as
 * hypervectors of character trigrams (hdc/hypervector.ts), the same measure
 * the evolve loop uses to catch a resubmitted idea.
 */

import { encodeText, similarity } from '../hdc/hypervector.ts'
import { unwinnableVerificationCommands } from '../autonomy/verify.ts'
import { isLongRunningServerCommand } from '../shell.ts'
import type { Goal, GoalKind, GoalOrigin, HealthReport, RepoSurvey } from './types.ts'
import type { ProposedGoal } from './understand.ts'
import { failingChecks, passingChecks } from './health.ts'

/** Same threshold the evolve loop measured for "the same idea" (evolve/ideas.ts). */
export const SAME_GOAL = 0.4
export const MAX_ATTEMPTS = 2

const KIND_WEIGHT: Record<GoalKind, number> = {
  user: 1_000,
  repair: 100,
  provision: 90,
  test: 12,
  hardening: 11,
  feature: 10,
  refactor: 6,
  docs: 4,
}

/** Higher runs first. Deterministic: the same backlog always yields the same order. */
export function goalScore(goal: Pick<Goal, 'kind' | 'value' | 'effort' | 'risk' | 'attempts' | 'verification'>): number {
  const unverifiable = goal.verification.length === 0 ? 8 : 0
  return KIND_WEIGHT[goal.kind] + 2 * goal.value - goal.effort - 1.5 * goal.risk - 3 * goal.attempts - unverifiable
}

function goalId(existing: readonly Goal[]): string {
  return `g${existing.length + 1}`
}

export function isSameGoal(a: string, b: string): boolean {
  return similarity(encodeText(a), encodeText(b)) >= SAME_GOAL
}

/**
 * The commands that can prove a goal, unattended: what the model named, if
 * each one is something the unattended governor will run; otherwise the
 * project's own checks that pass today (so, at least, nothing got worse).
 */
export function verificationFor(proposed: readonly string[], health: HealthReport | undefined, survey: RepoSurvey): string[] {
  const known = new Set([...survey.checks, ...(health?.checks.map((check) => check.command) ?? [])])
  const runnable = proposed.filter((command) => !isLongRunningServerCommand(command))
  const refused = new Set(unwinnableVerificationCommands(runnable, { unattended: true }))
  // A command the survey never saw is only trusted if the governor would run it.
  const kept = runnable.filter((command) => !refused.has(command) && (known.has(command) || !/[;&|<>`$]/.test(command)))
  if (kept.length > 0) return [...new Set(kept)]
  const baseline = passingChecks(health)
  return baseline.length > 0 ? baseline : survey.checks.filter((command) => !refused.has(command))
}

function make(
  existing: readonly Goal[],
  fields: { title: string; detail: string; kind: GoalKind; origin: GoalOrigin; value: number; effort: number; risk: number; verification: string[]; evidence: string[] },
  now: Date,
): Goal {
  return { id: goalId(existing), ...fields, status: 'open', attempts: 0, outcomes: [], createdAt: now.toISOString() }
}

/** True when `title` repeats a goal that is done, parked, or already open. */
export function alreadyKnown(title: string, backlog: readonly Goal[]): Goal | undefined {
  return backlog.find((goal) => isSameGoal(title, goal.title))
}

/**
 * Merges fresh candidates into the backlog. Existing goals keep their state;
 * a candidate that repeats a known goal is dropped; a failing check that is
 * already an open repair goal is not duplicated.
 */
export function refreshBacklog(
  backlog: readonly Goal[],
  inputs: { survey: RepoSurvey; health?: HealthReport; proposed?: readonly ProposedGoal[]; now?: Date },
): Goal[] {
  const now = inputs.now ?? new Date()
  const next = [...backlog]
  const addIfNew = (fields: Parameters<typeof make>[1]) => {
    if (alreadyKnown(fields.title, next)) return
    next.push(make(next, fields, now))
  }

  // Repair goals are keyed by the check, not by their text: every one of them
  // reads "Make `…` pass", so trigram similarity would call two different
  // checks the same goal. A check fixed earlier that fails again gets a fresh
  // goal; one already open, or parked after its attempts, does not.
  for (const check of failingChecks(inputs.health)) {
    const title = `Make \`${check.command}\` pass`
    const prior = next.filter((goal) => goal.kind === 'repair' && goal.verification[0] === check.command)
    if (prior.some((goal) => goal.status !== 'done')) continue
    next.push(make(next, {
      title,
      detail: `The project's own check \`${check.command}\` ${check.status === 'timeout' ? 'times out' : `fails (exit ${check.exitCode})`}. Find the root cause and fix it in the code (not by weakening or skipping the check).\nLast output:\n${check.tail}`,
      kind: 'repair',
      origin: 'health',
      value: 5,
      effort: 3,
      risk: 2,
      verification: [check.command],
      evidence: [`health: ${check.command}`],
    }, now))
  }

  if (inputs.survey.environmentBlockers.length > 0 && inputs.survey.setupCommands.length > 0) {
    addIfNew({
      title: 'Provision the development environment',
      detail: `The environment check reports blockers that will strand every run: ${inputs.survey.environmentBlockers.join('; ')}. Use provision_environment (its recommended setup: ${inputs.survey.setupCommands.join(' ; ')}).`,
      kind: 'provision',
      origin: 'environment',
      value: 4,
      effort: 1,
      risk: 1,
      verification: inputs.survey.checks,
      evidence: ['environment readiness'],
    })
  }

  for (const goal of inputs.proposed ?? []) {
    // A repair the model proposes for a check that already has a repair goal
    // is the same work, seen from the code instead of the exit code. Its
    // diagnosis ("remove() uses slice, not splice") sharpens the existing
    // goal rather than queueing the fix twice.
    if (goal.kind === 'repair') {
      const openRepairs = next.filter((existing) => existing.kind === 'repair' && existing.origin === 'health' && existing.status === 'open')
      const target = openRepairs.find((existing) => goal.verification.includes(existing.verification[0]!)) ?? (openRepairs.length === 1 ? openRepairs[0] : undefined)
      if (target) {
        const index = next.indexOf(target)
        next[index] = {
          ...target,
          detail: `${target.detail}\n\nWhat reading the code suggests — ${goal.title}${goal.why ? `: ${goal.why}` : ''}`,
          evidence: [...new Set([...target.evidence, ...goal.evidence])],
        }
        continue
      }
    }
    addIfNew({
      title: goal.title,
      detail: goal.why,
      kind: goal.kind,
      origin: 'model',
      value: goal.value,
      effort: goal.effort,
      risk: goal.risk,
      verification: verificationFor(goal.verification, inputs.health, inputs.survey),
      evidence: goal.evidence,
    })
  }
  return next
}

/** A direction from the operator: runs next, ahead of everything the pilot inferred. */
export function addUserGoal(backlog: readonly Goal[], text: string, survey: RepoSurvey | undefined, health: HealthReport | undefined, now = new Date()): Goal[] {
  const title = text.trim().replace(/\s+/g, ' ').slice(0, 200)
  if (!title) return [...backlog]
  const repeat = backlog.find((goal) => goal.origin === 'user' && goal.status === 'open' && isSameGoal(title, goal.title))
  if (repeat) return [...backlog]
  const verification = survey ? verificationFor([], health, survey) : []
  return [...backlog, make(backlog, { title, detail: `Asked for by the operator while the autopilot was running: ${text.trim().slice(0, 2_000)}`, kind: 'user', origin: 'user', value: 5, effort: 3, risk: 2, verification, evidence: ['operator'] }, now)]
}

/**
 * Something a watcher saw (a failed CI run, a new issue, a changed file): the
 * same standing as an operator's direction, one point less on value, so a
 * person's words still go first. The same event twice is one goal.
 */
export function addEventGoal(backlog: readonly Goal[], event: string, survey: RepoSurvey | undefined, health: HealthReport | undefined, now = new Date()): Goal[] {
  const title = event.trim().replace(/\s+/g, ' ').slice(0, 200)
  if (!title) return [...backlog]
  if (backlog.some((goal) => goal.origin === 'event' && goal.status === 'open' && isSameGoal(title, goal.title))) return [...backlog]
  const verification = survey ? verificationFor([], health, survey) : []
  return [...backlog, make(backlog, { title, detail: `Seen by the autopilot's watcher: ${event.trim()} Look into it, and act on it if it is this repository's to fix; if it is not, or it needs a person, say so and change nothing.`, kind: 'user', origin: 'event', value: 4, effort: 3, risk: 2, verification, evidence: ['watcher'] }, now)]
}

export function openGoals(backlog: readonly Goal[]): Goal[] {
  return backlog.filter((goal) => goal.status === 'open').sort((a, b) => goalScore(b) - goalScore(a) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

export function nextGoal(backlog: readonly Goal[]): Goal | undefined {
  return openGoals(backlog)[0]
}

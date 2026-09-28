/**
 * The autopilot, told for a person: REPORT.md, the `status` summary, and the
 * snapshot a live reply reads when someone asks "what are you doing?".
 */

import { goalScore, openGoals } from './backlog.ts'
import { summarizeHealth } from './health.ts'
import type { CheckStatus, Claim, Goal, PilotState } from './types.ts'
import { formatCostUsd } from '../usage.ts'

const MARK: Record<CheckStatus, string> = { pass: 'pass', fail: 'FAIL', timeout: 'TIMEOUT', inconclusive: 'no tests', blocked: 'not run' }

function cite(claim: Claim): string {
  return `- ${claim.claim} _(${claim.evidence.join(', ')})_`
}

function goalLine(goal: Goal): string {
  const last = goal.outcomes[goal.outcomes.length - 1]
  const cost = last?.costUsd ? ` (${formatCostUsd(last.costUsd)})` : ''
  const result = last ? `${last.accepted ? 'landed' : 'rolled back'} — ${last.reason}${cost}` : goal.status === 'open' ? `queued (score ${goalScore(goal).toFixed(1)})` : ''
  return `| ${goal.id} | ${goal.title.replace(/\|/g, '\\|')} | ${goal.kind} | ${goal.status} | ${goal.attempts} | ${result.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`
}

export function renderReport(state: PilotState): string {
  const survey = state.survey
  const u = state.understanding
  const lines: string[] = [
    `# elia autopilot — ${survey?.name ?? state.root}`,
    '',
    `Pilot \`${state.id}\` · started ${state.startedAt} · updated ${state.updatedAt} · phase **${state.phase}**${state.stopReason ? ` (${state.stopReason})` : ''}`,
  ]
  if (state.branch) {
    lines.push('', `Work is on branch \`${state.branch}\`, cut from \`${state.baseBranch}\` at \`${state.baseSha?.slice(0, 10)}\`. Nothing was pushed.`, '', 'Review it with:', '', '```', `git log --oneline ${state.baseBranch}..${state.branch}`, `git diff ${state.baseBranch}...${state.branch}`, '```')
  }
  if (u) {
    lines.push('', '## What this project is', '', `**Purpose:** ${u.purpose}`, '', `**Audience:** ${u.audience}`, '', `**Direction:** ${u.vision}`)
    if (u.currentState.length > 0) lines.push('', '### Where it stands', '', ...u.currentState.map(cite))
    if (u.direction.length > 0) lines.push('', '### Where it is heading', '', ...u.direction.map(cite))
    if (u.risks.length > 0) lines.push('', '### Risks', '', ...u.risks.map(cite))
    lines.push('', `_Formed by ${u.model}. Every claim above cites a survey fact (E-numbers, listed in state.json) or a file that exists; ${u.droppedClaims} claim(s) that cited nothing real were dropped._`)
  }
  if (state.baseline) {
    const now = new Map((state.latest ?? state.baseline).checks.map((check) => [check.command, check.status]))
    lines.push('', '## Health (the project\'s own checks)', '', '| check | at start | now |', '|---|---|---|')
    for (const check of state.baseline.checks) lines.push(`| \`${check.command}\` | ${MARK[check.status]} | ${MARK[now.get(check.command) ?? check.status]} |`)
    if (state.baseline.checks.length === 0) lines.push('| (none found) | | |')
  }
  if (state.backlog.length > 0) {
    lines.push('', '## Goals', '', '| id | goal | kind | status | attempts | result |', '|---|---|---|---|---|---|', ...[...state.backlog].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })).map(goalLine))
    const costs = state.backlog.flatMap((goal) => goal.outcomes.map((o) => o.costUsd ?? 0))
    const spent = costs.reduce((sum, usd) => sum + usd, 0)
    if (spent > 0) lines.push('', `Spent on goals: about ${formatCostUsd(spent)} across ${costs.length} attempt(s).`)
    const landed = state.backlog.flatMap((goal) => goal.outcomes.filter((o) => o.accepted).map((o) => ({ goal, o })))
    if (landed.length > 0) {
      lines.push('', '### Landed', '')
      for (const { goal, o } of landed) lines.push(`- **${goal.title}** → \`${o.afterSha?.slice(0, 10) ?? '?'}\`${o.fixed.length > 0 ? `; fixed ${o.fixed.map((c) => `\`${c}\``).join(', ')}` : ''}`)
    }
    const kept = state.backlog.flatMap((goal) => goal.outcomes.filter((o) => o.keptAt).map((o) => ({ goal, o })))
    if (kept.length > 0) {
      lines.push('', '### Rolled back (kept for inspection)', '')
      for (const { goal, o } of kept) lines.push(`- ${goal.title}: ${o.reason} — \`git log ${o.keptAt}\``)
    }
  }
  if (state.needsHuman.length > 0) lines.push('', '## Needs a person', '', ...state.needsHuman.map((item) => `- ${item}`))
  return `${lines.join('\n')}\n`
}

/** A few lines for `elia autopilot status` and the working line. */
export function statusText(state: PilotState): string {
  const open = openGoals(state.backlog)
  const current = state.backlog.find((goal) => goal.id === state.currentGoalId)
  const done = state.backlog.filter((goal) => goal.status === 'done').length
  const parked = state.backlog.filter((goal) => goal.status === 'parked').length
  return [
    `autopilot ${state.id} — ${state.phase}${state.stopReason ? ` (${state.stopReason})` : ''}`,
    state.branch ? `branch ${state.branch} (from ${state.baseBranch})` : 'no branch yet (plan only)',
    `health now: ${summarizeHealth(state.latest ?? state.baseline)}${state.baseline ? ` · at start: ${summarizeHealth(state.baseline)}` : ''}`,
    current ? `working on: ${current.id} ${current.title}` : '',
    `goals: ${done} landed, ${parked} parked, ${open.length} queued, ${state.goalsRun} run`,
    open.length > 0 ? `next: ${open.slice(0, 3).map((goal) => goal.title).join(' | ')}` : '',
    state.needsHuman.length > 0 ? `needs a person: ${state.needsHuman.length} item(s) — see the report` : '',
  ].filter(Boolean).join('\n')
}

/** What a live reply gets to know about a running pilot: bounded, no secrets. */
export function pilotSnapshot(state: PilotState, maxChars = 6_000): string {
  const u = state.understanding
  const parts = [
    statusText(state),
    u ? `purpose: ${u.purpose}\ndirection: ${u.vision}` : '',
    u && u.currentState.length > 0 ? `where it stands:\n${u.currentState.slice(0, 6).map((claim) => `- ${claim.claim}`).join('\n')}` : '',
    `backlog:\n${[...state.backlog].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })).map((goal) => `- ${goal.id} [${goal.status}] ${goal.title}${goal.outcomes.length > 0 ? ` — last: ${goal.outcomes[goal.outcomes.length - 1]!.reason}` : ''}`).join('\n')}`,
  ].filter(Boolean).join('\n\n')
  return parts.length > maxChars ? `${parts.slice(0, maxChars)}…` : parts
}

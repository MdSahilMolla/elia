/**
 * Understand: what the repository is for, where it stands, where it is going
 * — and what is worth doing next.
 *
 * One model, read-only tools, one structured answer. The model sees the survey
 * (numbered facts) and the measured health, may open files to look closer,
 * and answers in JSON. Then the answer is checked in code:
 *
 *   - every claim must cite a survey id (`E7`) or a repo path that exists;
 *     a claim that cites nothing real is dropped, and the drop is counted so
 *     the report can say how much of the model's story was unsupported
 *   - every proposed goal must cite something real too, and its scores are
 *     clamped to 1–5; the ranking itself is done later, in code (backlog.ts)
 *
 * The model proposes; code decides what counts.
 */

import { existsSync } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'
import type { Claim, GoalKind, HealthReport, RepoSurvey, Understanding } from './types.ts'
import { renderSurvey } from './survey.ts'

export interface ProposedGoal {
  title: string
  why: string
  kind: GoalKind
  value: number
  effort: number
  risk: number
  verification: string[]
  evidence: string[]
}

export interface UnderstandingResult {
  understanding: Understanding
  goals: ProposedGoal[]
  droppedGoals: number
}

/** The model call, as a seam: system + user text in, final assistant text out. */
export type UnderstandingModel = (input: { system: string; user: string; root: string; signal?: AbortSignal }) => Promise<{ text: string; model: string }>

export const UNDERSTAND_SYSTEM = `You are elia's autopilot, taking over an unfamiliar repository with no instructions from anyone. Nobody will answer questions: you must work out, from evidence, what this project is, where it stands, and what is most worth doing next.

You are given a survey of numbered facts ([E1], [E2], …) read from the repository's own files and git history, plus the measured result of running its own checks. You also have read-only tools (read_file, list_files, grep, find_symbol): use a few of them to look at the files that actually decide what the project does — entry points, the main modules, the README's claims — before you answer. Batch independent reads into one turn. Do not modify anything.

Then answer with ONE JSON object and nothing else:
{
  "purpose": "one or two sentences: what this project does and for whom",
  "audience": "who uses it",
  "vision": "where the project appears to be heading, from its roadmap/docs/recent commits — say 'not stated' if nothing says",
  "currentState": [{"claim": "...", "evidence": ["E3", "src/server.ts"]}],
  "direction": [{"claim": "what recent work and docs show the project moving toward", "evidence": ["E9"]}],
  "risks": [{"claim": "a concrete weakness: failing check, untested core module, missing error handling, stale dependency, security smell", "evidence": ["..."]}],
  "goals": [{
    "title": "imperative, specific, one change (e.g. 'Make \`bun test\` pass: fix the date parsing in src/time.ts')",
    "why": "why this is the most valuable next step, citing what you saw",
    "kind": "repair | test | hardening | feature | refactor | docs",
    "value": 1-5, "effort": 1-5, "risk": 1-5,
    "verification": ["the project's own commands that prove it — from the survey, never invented"],
    "evidence": ["E5", "src/time.ts"]
  }]
}

Rules:
- Every claim and goal cites evidence: survey ids like "E4", or repo-relative paths you actually opened. Anything that cites nothing real is thrown away.
- Propose 3 to 8 goals, each small enough to finish and verify in one focused session. A failing check is always worth a goal. Prefer goals that move the project toward its own stated direction over generic cleanup.
- Never propose anything that needs a human or reaches outside this machine: no deploying, publishing, pushing, sending messages, buying, or rotating credentials. Local development only; a local database is fine.
- Be concrete. Name files and functions. No "improve code quality".`

export function buildUnderstandingPrompt(survey: RepoSurvey, health: HealthReport | undefined): string {
  const checks = health && health.checks.length > 0
    ? health.checks.map((check) => `- \`${check.command}\` → ${check.status}${check.tail ? `\n  last output:\n${check.tail.split('\n').slice(-15).map((line) => `    ${line}`).join('\n')}` : ''}`).join('\n')
    : '- no runnable checks were found'
  return [
    `# Repository: ${survey.name}`,
    `root: ${survey.root}`,
    '',
    '## Survey',
    renderSurvey(survey),
    '',
    '## Measured health (the project\'s own checks, run just now)',
    checks,
    '',
    'Investigate briefly with the read-only tools, then answer with the JSON object.',
  ].join('\n')
}

/** Pulls the first JSON object out of a model's answer: fenced, bare, or with trailing commas. */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const candidates: string[] = []
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fenced?.[1]) candidates.push(fenced[1])
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1))
  for (const candidate of candidates) {
    for (const attempt of [candidate, candidate.replace(/,\s*([}\]])/g, '$1')]) {
      try {
        const parsed = JSON.parse(attempt) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
      } catch {
        // try the next form
      }
    }
  }
  return undefined
}

/** A citation is real when it names a survey fact or a path inside the repo that exists. */
export function isRealCitation(citation: string, survey: RepoSurvey): boolean {
  const cite = citation.trim().replace(/^\[|\]$/g, '')
  if (/^E\d+$/i.test(cite)) return survey.evidence.some((item) => item.id.toUpperCase() === cite.toUpperCase())
  const path = cite.replace(/:\d+(?::\d+)?$/, '').replace(/^\.\//, '')
  if (!path || isAbsolute(path) || normalize(path).startsWith('..')) return false
  return existsSync(join(survey.root, path))
}

function claimsOf(raw: unknown, survey: RepoSurvey): { kept: Claim[]; dropped: number } {
  if (!Array.isArray(raw)) return { kept: [], dropped: 0 }
  const kept: Claim[] = []
  let dropped = 0
  for (const item of raw) {
    const claim = typeof (item as { claim?: unknown })?.claim === 'string' ? (item as { claim: string }).claim.trim() : ''
    const cited = Array.isArray((item as { evidence?: unknown })?.evidence) ? ((item as { evidence: unknown[] }).evidence.filter((e) => typeof e === 'string') as string[]) : []
    const real = cited.filter((citation) => isRealCitation(citation, survey))
    if (!claim) continue
    if (real.length === 0) {
      dropped += 1
      continue
    }
    kept.push({ claim: claim.slice(0, 600), evidence: real.slice(0, 6) })
  }
  return { kept, dropped }
}

const GOAL_KINDS: ReadonlySet<string> = new Set(['repair', 'test', 'hardening', 'feature', 'refactor', 'docs'])
/** Things a goal may not ask for: they reach outside the machine, where no unattended run may act. */
const OUTSIDE_WORLD = /\b(?:deploy|publish|release to|push to|send (?:an? )?(?:email|message)|post to|purchase|buy|rotate (?:the )?(?:key|secret|credential)|production database)\b/i

const clamp = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.max(1, Math.min(5, Math.round(n))) : 3
}

export function goalsOf(raw: unknown, survey: RepoSurvey): { goals: ProposedGoal[]; dropped: number } {
  if (!Array.isArray(raw)) return { goals: [], dropped: 0 }
  const goals: ProposedGoal[] = []
  let dropped = 0
  for (const item of raw.slice(0, 12)) {
    const record = (item ?? {}) as Record<string, unknown>
    const title = typeof record.title === 'string' ? record.title.trim().slice(0, 200) : ''
    const why = typeof record.why === 'string' ? record.why.trim().slice(0, 800) : ''
    const cited = Array.isArray(record.evidence) ? (record.evidence.filter((e) => typeof e === 'string') as string[]) : []
    const real = cited.filter((citation) => isRealCitation(citation, survey))
    if (!title || real.length === 0 || OUTSIDE_WORLD.test(`${title} ${why}`)) {
      dropped += 1
      continue
    }
    const kind = typeof record.kind === 'string' && GOAL_KINDS.has(record.kind) ? (record.kind as GoalKind) : 'feature'
    const verification = Array.isArray(record.verification) ? (record.verification.filter((c) => typeof c === 'string' && c.trim()) as string[]).map((c) => c.trim()).slice(0, 4) : []
    goals.push({ title, why, kind, value: clamp(record.value), effort: clamp(record.effort), risk: clamp(record.risk), verification, evidence: real.slice(0, 6) })
  }
  return { goals, dropped }
}

export function parseUnderstanding(text: string, survey: RepoSurvey, model: string, now = new Date()): UnderstandingResult | undefined {
  const json = extractJsonObject(text)
  if (!json) return undefined
  const current = claimsOf(json.currentState, survey)
  const direction = claimsOf(json.direction, survey)
  const risks = claimsOf(json.risks, survey)
  const goals = goalsOf(json.goals, survey)
  const str = (value: unknown, fallback: string) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 800) : fallback)
  return {
    understanding: {
      purpose: str(json.purpose, survey.description ?? 'not determined'),
      audience: str(json.audience, 'not determined'),
      vision: str(json.vision, 'not stated'),
      currentState: current.kept,
      direction: direction.kept,
      risks: risks.kept,
      droppedClaims: current.dropped + direction.dropped + risks.dropped,
      model,
      formedAt: now.toISOString(),
    },
    goals: goals.goals,
    droppedGoals: goals.dropped,
  }
}

/**
 * The real model call: the deep tier, read-only tools, a bounded number of
 * steps, run as the autopilot's lead identity rooted at the repository. If
 * the model spends its steps investigating and never answers in JSON, one
 * more tool-less call asks for just the JSON.
 */
export const defaultUnderstandingModel: UnderstandingModel = async ({ system, user, root, signal }) => {
  const [{ config }, { runAgentLoop, lastAssistantText }, { toolsByName }, { withAgentIdentity }] = await Promise.all([
    import('../config.ts'),
    import('../agentLoop.ts'),
    import('../tools/registry.ts'),
    import('../autonomy/context.ts'),
  ])
  const tier = config.tiers.deep
  const tools = ['read_file', 'list_files', 'grep', 'find_symbol'].map((name) => toolsByName[name]).filter((tool): tool is NonNullable<typeof tool> => Boolean(tool))
  const messages: Parameters<typeof runAgentLoop>[0]['messages'] = [{ role: 'user', content: [{ type: 'text', text: user }] }]
  return withAgentIdentity({ name: 'autopilot', role: 'lead', cwd: root, signal }, async () => {
    await runAgentLoop({ messages, systemPrompt: system, tools, useAnimation: false, verbose: false, maxSteps: 16, provider: tier.provider, providerName: tier.providerName, model: tier.model, signal })
    let text = lastAssistantText(messages, '')
    if (!extractJsonObject(text) && !signal?.aborted) {
      messages.push({ role: 'user', content: [{ type: 'text', text: 'Stop investigating. Answer now with only the JSON object described in your instructions.' }] })
      await runAgentLoop({ messages, systemPrompt: system, tools: [], useAnimation: false, verbose: false, maxSteps: 1, provider: tier.provider, providerName: tier.providerName, model: tier.model, signal })
      text = lastAssistantText(messages, '')
    }
    return { text, model: tier.model }
  })
}

export async function formUnderstanding(
  survey: RepoSurvey,
  health: HealthReport | undefined,
  options: { model?: UnderstandingModel; signal?: AbortSignal } = {},
): Promise<UnderstandingResult> {
  const model = options.model ?? defaultUnderstandingModel
  const answer = await model({ system: UNDERSTAND_SYSTEM, user: buildUnderstandingPrompt(survey, health), root: survey.root, signal: options.signal })
  const parsed = parseUnderstanding(answer.text, survey, answer.model)
  if (parsed) return parsed
  // No usable answer: the pilot still runs on what it measured (failing checks
  // become goals), and the report says the model's picture is missing.
  return {
    understanding: {
      purpose: survey.description ?? 'not determined (the model did not return a usable answer)',
      audience: 'not determined',
      vision: 'not determined',
      currentState: [],
      direction: [],
      risks: [],
      droppedClaims: 0,
      model: answer.model,
      formedAt: new Date().toISOString(),
    },
    goals: [],
    droppedGoals: 0,
  }
}

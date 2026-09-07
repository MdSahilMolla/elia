// A plan is built on things nobody checked.
//
// Every proposal declares `assumptions` — the planner's own list of what it
// believes but did not verify — and until now nothing ever read them back. The
// cost of that is not theoretical. One run declared:
//
//   "Environment variables will be read from a .env file at runtime;
//    the file can be created by the builder."
//
// `.env` is a protected path. The builder can never create it. Elia wrote down
// the exact reason its plan would fail, planned around it anyway, and then spent
// actions discovering the wall it had already described.
//
// Two passes here, cheapest first. `auditPlanFeasibility` is deterministic and
// runs at approval: it knows elia's own policy, so a plan that schedules a write
// to a protected path is caught before a single worker starts. The model pass
// handles the rest — the assumptions about the world that only checking can
// settle.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Tool } from '../tools/types.ts'
import { isSensitivePath } from './sensitivePaths.ts'
import type { CriticIssue, Proposal } from './types.ts'

export type AssumptionVerdict = 'holds' | 'false' | 'unverifiable'

export interface AssumptionCheck {
  assumption: string
  verdict: AssumptionVerdict
  /** What settled it, or what could not be settled and why. */
  evidence: string
}

export interface AssumptionCapture {
  tool: Tool
  taken(): AssumptionCheck[] | undefined
}

/**
 * The feasibility problems elia can decide by itself, from its own policy,
 * before anything runs.
 *
 * A model pass could find these too, eventually, at the cost of a round-trip and
 * some luck. These are decidable, so they are decided.
 */
export function auditPlanFeasibility(proposal: Proposal, cwd = process.cwd()): CriticIssue[] {
  const issues: CriticIssue[] = []

  // A plan that says out loud it will hardcode a secret. One did, verbatim:
  // "JWT secret must be defined; we will hard-code a dev secret in the code
  // (e.g., 'dev-secret') for simplicity." The code gate catches this later, but
  // catching a stated intention costs nothing and saves the whole build-then-
  // reject cycle.
  for (const raw of [...proposal.assumptions, ...proposal.risks, ...proposal.steps.map((step) => step.instructions)]) {
    const text = normalizeDashes(raw)
    if (!/\bhard[\s-]?cod(?:e|ing|ed)\b/i.test(text)) continue
    if (!/\bsecret|password|api[\s_-]?key|token|credential/i.test(text)) continue
    issues.push({
      severity: 'blocker',
      detail:
        `The plan states it will hardcode a credential: "${raw.trim().slice(0, 200)}". ` +
        'Read it from the environment and fail startup when it is missing. A default secret in source is the same vulnerability as no secret at all.',
    })
    break
  }

  // Verification commands that name a script the project does not have. Only
  // checkable when the manifest already exists — a run that is about to create
  // package.json is naming scripts it is going to write, which is correct.
  const manifestPath = join(cwd, 'package.json')
  if (existsSync(manifestPath)) {
    const scripts = readScripts(manifestPath)
    if (scripts) {
      for (const command of proposal.verification) {
        const script = /^(?:bun|npm|pnpm|yarn)\s+run\s+([\w:-]+)/.exec(command)?.[1]
        if (!script || scripts.has(script)) continue
        issues.push({
          severity: 'blocker',
          detail:
            `Verification command \`${command}\` runs a script "${script}" that package.json does not define, so it can never pass. ` +
            `Available scripts: ${[...scripts].join(', ') || '(none)'}.`,
        })
      }
    }
  }

  for (const step of proposal.steps) {
    const protectedFiles = step.files.filter((file) => isSensitivePath(file))
    if (protectedFiles.length === 0) continue
    issues.push({
      severity: 'blocker',
      file: protectedFiles[0],
      detail:
        `Step "${step.id}" (${step.title}) is planned to write ${protectedFiles.join(', ')}, which elia's policy protects and will refuse. ` +
        'The step cannot succeed as written. Drop those files from it and have the run report the value the user needs to set instead.',
    })
  }

  // The same mistake stated as a belief rather than a file list. Worth its own
  // check because a plan can carry the assumption without any step naming the path.
  for (const assumption of proposal.assumptions) {
    if (!/\b(?:can|will)\s+(?:be\s+)?(?:create|creat|writ|generat|updat|overwrit|modif)/i.test(assumption)) continue
    if (!/\.env\b|credentials?\b|\.npmrc\b|\.netrc\b|id_rsa\b|private[_ -]?key\b/i.test(assumption)) continue
    issues.push({
      severity: 'blocker',
      detail:
        `The plan assumes a protected file can be written: "${assumption}". elia refuses writes to credential paths, so any step resting on this will fail. ` +
        'Plan for the value to be reported to the user instead.',
    })
  }

  return issues
}

/**
 * Reported through a tool for the same reason every other gate is: the answer
 * changes what the run does next, and "did the model mean it holds" is not
 * something to read out of a paragraph.
 */
export function createAssumptionTool(assumptions: string[]): AssumptionCapture {
  let captured: AssumptionCheck[] | undefined

  const tool: Tool = {
    name: 'submit_assumptions',
    description:
      'Report whether each assumption the plan rests on is actually true. Call this exactly once, after checking. Check by looking — read the file, run the read-only command, inspect the installed version. "holds" means you confirmed it; "false" means you confirmed the opposite; "unverifiable" means it cannot be settled without the user, and saying so is a real answer.',
    input_schema: {
      type: 'object',
      properties: {
        results: {
          type: 'array',
          description: 'One entry per assumption, in the order given.',
          items: {
            type: 'object',
            properties: {
              assumption: { type: 'string', description: 'The assumption, copied from the list you were given' },
              verdict: { type: 'string', enum: ['holds', 'false', 'unverifiable'] },
              evidence: { type: 'string', description: 'What you checked and what it showed — or why it cannot be checked' },
            },
            required: ['assumption', 'verdict', 'evidence'],
          },
        },
      },
      required: ['results'],
    },
    async execute(input) {
      const results = parseChecks(input.results)
      if (results.length === 0) throw new Error('submit_assumptions needs one result per assumption. Add them and call it again.')
      const missing = assumptions.filter((assumption) => !results.some((result) => sameText(result.assumption, assumption)))
      if (missing.length > 0) {
        throw new Error(`submit_assumptions is missing a verdict for ${missing.length}: ${missing.join(' | ')}. Report on every one, then call it again.`)
      }
      captured = results
      return `Recorded ${results.length} assumption check(s).`
    },
  }

  return {
    tool,
    taken() {
      const results = captured
      captured = undefined
      return results
    },
  }
}

export interface AssumptionOutcome {
  falsified: AssumptionCheck[]
  unverifiable: AssumptionCheck[]
  summary: string
  /** Text for the execute briefing, so every worker builds on what is actually true. */
  briefing: string
}

/**
 * What the checks mean for the run.
 *
 * A falsified assumption is not a failure — it is the single most valuable thing
 * a run can learn, and learning it before building is the whole point. It goes
 * into every worker's briefing, and it is exactly the situation `revise_plan`
 * exists for.
 */
export function assumptionOutcome(assumptions: string[], reported: AssumptionCheck[] | undefined): AssumptionOutcome {
  if (assumptions.length === 0) {
    return { falsified: [], unverifiable: [], summary: 'The plan declared no assumptions.', briefing: '' }
  }
  if (!reported) {
    // Unlike an acceptance check, an unchecked assumption does not fail the run —
    // it just leaves the plan resting on exactly what it rested on before.
    return {
      falsified: [],
      unverifiable: [],
      summary: `${assumptions.length} assumption(s) went unchecked; the plan rests on them unverified.`,
      briefing: `## Unverified assumptions\nThese were never confirmed. If one turns out to be wrong, call revise_plan rather than working around it:\n${assumptions.map((item) => `- ${item}`).join('\n')}`,
    }
  }

  const falsified = reported.filter((result) => result.verdict === 'false')
  const unverifiable = reported.filter((result) => result.verdict === 'unverifiable')
  const held = reported.length - falsified.length - unverifiable.length

  const sections: string[] = []
  if (falsified.length > 0) {
    sections.push(
      `## Assumptions that turned out to be WRONG\nThe plan was written believing these. They are false, so do not build on them:\n${falsified
        .map((result) => `- ${result.assumption}\n  → ${result.evidence}`)
        .join('\n')}\n\nIf this makes a planned step impossible or reveals missing work, call revise_plan.`,
    )
  }
  if (unverifiable.length > 0) {
    sections.push(
      `## Assumptions nobody could confirm\nTreat these as open questions, and say so in your report rather than guessing:\n${unverifiable
        .map((result) => `- ${result.assumption}\n  → ${result.evidence}`)
        .join('\n')}`,
    )
  }

  return {
    falsified,
    unverifiable,
    summary: `${held} of ${reported.length} assumption(s) hold${falsified.length > 0 ? `, ${falsified.length} false` : ''}${unverifiable.length > 0 ? `, ${unverifiable.length} unverifiable` : ''}.`,
    briefing: sections.join('\n\n'),
  }
}

/**
 * Models write typographic dashes. One plan said "hard‑coded" with a
 * non-breaking hyphen (U+2011), which sailed straight through a pattern that
 * only knew about the ASCII one — so a plan announcing it would hardcode a JWT
 * secret was waved through the check written to stop exactly that.
 */
function normalizeDashes(value: string): string {
  return value.replace(/[‐-―−]/g, '-')
}

function readScripts(manifestPath: string): Set<string> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { scripts?: Record<string, unknown> }
    return new Set(Object.keys(parsed.scripts ?? {}))
  } catch {
    // An unreadable manifest proves nothing about which scripts exist.
    return undefined
  }
}

function sameText(a: string, b: string): boolean {
  return normalize(a) === normalize(b)
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[`'"’‘“”]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

function parseChecks(raw: unknown): AssumptionCheck[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item): AssumptionCheck[] => {
    if (typeof item !== 'object' || item === null) return []
    const entry = item as Record<string, unknown>
    const assumption = typeof entry.assumption === 'string' ? entry.assumption.trim() : ''
    if (!assumption) return []
    const verdict: AssumptionVerdict =
      entry.verdict === 'false' ? 'false' : entry.verdict === 'unverifiable' ? 'unverifiable' : 'holds'
    return [{ assumption, verdict, evidence: typeof entry.evidence === 'string' ? entry.evidence.trim() : '' }]
  })
}

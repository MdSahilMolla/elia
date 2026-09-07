// The run declares, in its own plan, the observable conditions that decide
// whether the work is done — and then nothing ever consults them. Completion is
// judged on graph bookkeeping, verification exit codes, and open-ended review,
// none of which know what was promised. A run can therefore pass every gate
// while quietly not doing the thing it said it would do.
//
// This closes that loop: each declared criterion gets a verdict with the
// evidence for it, from a reviewer that can only read. It is deliberately
// narrower than the other reviewers — they hunt for anything wrong, this one
// answers a fixed list of questions the run wrote itself — which is what makes
// its answers checkable.
import type { Tool } from '../tools/types.ts'
import type { CriticIssue, CriticVerdict } from './types.ts'

export interface CriterionVerdict {
  criterion: string
  met: boolean
  /** What in the code, tests, or command output shows this. */
  evidence: string
}

export interface AcceptanceCapture {
  tool: Tool
  taken(): CriterionVerdict[] | undefined
}

/**
 * Reported through a tool rather than in prose, for the same reason the critic's
 * verdict is: it decides whether the run may claim completion, and "did the
 * model mean yes" is not something to infer from a paragraph.
 */
export function createAcceptanceTool(criteria: string[]): AcceptanceCapture {
  let captured: CriterionVerdict[] | undefined

  const tool: Tool = {
    name: 'submit_acceptance',
    description:
      'Report, for every acceptance criterion you were given, whether the delivered work actually meets it. Call this exactly once, at the end, after reading the code and the tests. Judge only what is there — a criterion is met when something concrete demonstrates it, not when the code looks like it probably would.',
    input_schema: {
      type: 'object',
      properties: {
        results: {
          type: 'array',
          description: 'One entry per criterion, in the order they were given.',
          items: {
            type: 'object',
            properties: {
              criterion: { type: 'string', description: 'The criterion, copied verbatim from the list you were given' },
              met: { type: 'boolean', description: 'True only if concrete evidence in the delivered work demonstrates it' },
              evidence: {
                type: 'string',
                description: 'The specific file, test, or output that shows this — or, when not met, exactly what is missing',
              },
            },
            required: ['criterion', 'met', 'evidence'],
          },
        },
      },
      required: ['results'],
    },
    async execute(input) {
      const results = parseResults(input.results)
      if (results.length === 0) throw new Error('submit_acceptance needs one result per criterion. Add them and call it again.')
      const missing = criteria.filter((criterion) => !results.some((result) => sameCriterion(result.criterion, criterion)))
      if (missing.length > 0) {
        throw new Error(`submit_acceptance is missing a verdict for ${missing.length} criterion/criteria: ${missing.join(' | ')}. Report on every one, then call it again.`)
      }
      captured = results
      return `Recorded ${results.length} criterion verdict(s).`
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

/**
 * The acceptance report as a reviewer verdict, so it merges with the model
 * reviewers and the deterministic hygiene audit through the same gate.
 *
 * Fails closed. A criterion the reviewer never reported on is not evidence of
 * success — the run promised it, so silence about it counts as unmet.
 */
export function acceptanceVerdict(criteria: string[], reported: CriterionVerdict[] | undefined): CriticVerdict {
  if (criteria.length === 0) {
    return {
      verdict: 'approve',
      summary: 'The plan declared no acceptance criteria, so there was nothing to check them against.',
      issues: [],
    }
  }

  if (!reported) {
    return {
      verdict: 'revise',
      summary: 'The acceptance check did not report, so no criterion can be treated as met.',
      issues: [
        {
          severity: 'blocker',
          detail: `None of the ${criteria.length} declared acceptance criteria could be confirmed: submit_acceptance was never called.`,
        },
      ],
    }
  }

  const issues: CriticIssue[] = []
  for (const criterion of criteria) {
    const result = reported.find((entry) => sameCriterion(entry.criterion, criterion))
    if (!result) {
      issues.push({ severity: 'blocker', detail: `Acceptance criterion was never reported on, so it cannot be treated as met: "${criterion}"` })
      continue
    }
    if (!result.met) {
      issues.push({ severity: 'blocker', detail: `Acceptance criterion not met: "${criterion}" — ${result.evidence}` })
    }
  }

  const met = criteria.length - issues.length
  return {
    verdict: issues.length > 0 ? 'revise' : 'approve',
    summary: `${met} of ${criteria.length} declared acceptance criteria are met.`,
    issues,
  }
}

/** Renders the met criteria and their evidence, for the run receipt. */
export function describeAcceptance(reported: CriterionVerdict[] | undefined): string {
  if (!reported || reported.length === 0) return '(no acceptance report)'
  return reported.map((result) => `${result.met ? '✓' : '✗'} ${result.criterion} — ${result.evidence}`).join('\n')
}

/**
 * Models re-wrap and re-punctuate text they copy. Comparing on the words alone
 * keeps a verdict attached to its criterion instead of counting it missing.
 */
function sameCriterion(a: string, b: string): boolean {
  return normalize(a) === normalize(b)
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`'"’‘“”]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function parseResults(raw: unknown): CriterionVerdict[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item): CriterionVerdict[] => {
    if (typeof item !== 'object' || item === null) return []
    const entry = item as Record<string, unknown>
    const criterion = typeof entry.criterion === 'string' ? entry.criterion.trim() : ''
    if (!criterion) return []
    return [{
      criterion,
      met: entry.met === true,
      evidence: typeof entry.evidence === 'string' ? entry.evidence.trim() : '',
    }]
  })
}

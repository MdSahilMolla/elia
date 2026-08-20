import type { Tool } from '../tools/types.ts'
import { clampOutput, runShell, type ShellResult } from '../shell.ts'
import type { CriticIssue, CriticVerdict } from './types.ts'

/** Verification commands are usually a test suite, which needs far longer than an ordinary tool call. */
const VERIFY_TIMEOUT_MS = 300_000

export interface VerificationOutcome {
  results: ShellResult[]
  passed: boolean
}

/**
 * Runs the proposal's verification commands in order and stops at the first
 * failure.
 *
 * Sequential and fail-fast on purpose: these commands are the project's own
 * gate (typecheck, then tests, then build), each is usually a prerequisite for
 * the next being meaningful, and a typecheck failure makes the test output noise
 * rather than information.
 */
export async function runVerification(commands: string[]): Promise<VerificationOutcome> {
  const results: ShellResult[] = []

  for (const command of commands) {
    const result = await runShell(command, VERIFY_TIMEOUT_MS)
    results.push(result)
    if (result.exitCode !== 0 || result.timedOut) return { results, passed: false }
  }

  return { results, passed: true }
}

/** Renders verification output for a model that has to fix what failed. */
export function describeVerification(outcome: VerificationOutcome): string {
  return outcome.results
    .map((result) => {
      const status = result.timedOut ? 'TIMED OUT' : result.exitCode === 0 ? 'passed' : `FAILED (exit ${result.exitCode})`
      if (result.exitCode === 0 && !result.timedOut) return `$ ${result.command} — ${status}`
      return [
        `$ ${result.command} — ${status}`,
        result.stdout ? clampOutput(result.stdout) : '',
        result.stderr ? clampOutput(result.stderr) : '',
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n\n')
}

export interface VerdictCapture {
  tool: Tool
  taken(): CriticVerdict | undefined
}

/**
 * The critic reports through a tool rather than in prose, because the verdict
 * drives control flow — whether elia loops back and repairs — and "did the model
 * mean yes" is not something to infer from free text.
 */
export function createVerdictTool(): VerdictCapture {
  let captured: CriticVerdict | undefined

  const tool: Tool = {
    name: 'submit_verdict',
    description:
      'Submit your review conclusion. Call this exactly once, at the end, after you have actually read the changed code. Only raise an issue if you can state the concrete failure it causes. An empty issue list with verdict "approve" is a valid answer.',
    input_schema: {
      type: 'object',
      properties: {
        verdict: {
          type: 'string',
          enum: ['approve', 'revise'],
          description: 'approve if the change is correct and complete; revise if anything must be fixed first',
        },
        summary: { type: 'string', description: 'One or two sentences on the state of the change' },
        issues: {
          type: 'array',
          description: 'Concrete defects found, most severe first',
          items: {
            type: 'object',
            properties: {
              severity: {
                type: 'string',
                enum: ['blocker', 'major', 'minor'],
                description: 'blocker = the change is broken or incomplete as shipped',
              },
              file: { type: 'string', description: 'File the issue is in' },
              detail: {
                type: 'string',
                description: 'What is wrong and the concrete case where it fails',
              },
            },
            required: ['severity', 'detail'],
          },
        },
      },
      required: ['verdict', 'summary'],
    },
    async execute(input) {
      captured = {
        verdict: input.verdict === 'revise' ? 'revise' : 'approve',
        summary: typeof input.summary === 'string' ? input.summary : '',
        issues: parseIssues(input.issues),
      }
      // A "revise" verdict with no issues gives the repair step nothing to act on.
      if (captured.verdict === 'revise' && captured.issues.length === 0) {
        captured = undefined
        throw new Error('A "revise" verdict needs at least one issue. Add the issues and call submit_verdict again.')
      }
      return 'Verdict recorded.'
    },
  }

  return {
    tool,
    taken() {
      const verdict = captured
      captured = undefined
      return verdict
    },
  }
}

function parseIssues(raw: unknown): CriticIssue[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item): CriticIssue[] => {
    if (typeof item !== 'object' || item === null) return []
    const issue = item as Record<string, unknown>
    const detail = typeof issue.detail === 'string' ? issue.detail.trim() : ''
    if (!detail) return []
    const severity =
      issue.severity === 'blocker' || issue.severity === 'major' || issue.severity === 'minor'
        ? issue.severity
        : 'major'
    return [{ severity, detail, ...(typeof issue.file === 'string' ? { file: issue.file } : {}) }]
  })
}

export function describeIssues(issues: CriticIssue[]): string {
  if (issues.length === 0) return '(none)'
  return issues
    .map((issue) => `- [${issue.severity}]${issue.file ? ` ${issue.file}:` : ''} ${issue.detail}`)
    .join('\n')
}

export function hasBlockingIssues(verdict: CriticVerdict): boolean {
  return verdict.verdict === 'revise' && verdict.issues.some((issue) => issue.severity !== 'minor')
}

/** Missing structured review is a failed gate, never implicit approval. */
export function requireCriticVerdict(verdict: CriticVerdict | undefined): CriticVerdict {
  return verdict ?? {
    verdict: 'revise',
    summary: 'The critic did not submit a structured verdict.',
    issues: [
      {
        severity: 'blocker',
        detail: 'Review could not be verified because submit_verdict was never called.',
      },
    ],
  }
}

import { existsSync } from 'node:fs'
import { basename, relative, resolve, sep } from 'node:path'
import type { Tool } from '../tools/types.ts'
import { clampOutput, isLongRunningServerCommand, mayStartServer, runShell, startsWithForeignShellCommand, type ShellResult } from '../shell.ts'
import type { CriticIssue, CriticVerdict } from './types.ts'
import { currentAgent } from './context.ts'
import { activeActionGovernor, blockedInUnattendedMode, type ActionGovernor } from './governor.ts'
import { changedStaticPages } from './detectChecks.ts'
import { scanProjectFiles } from './hygiene.ts'
import { ensurePreviewServer } from '../preview/server.ts'
import { checkRendered, waitForHttp } from '../preview/readiness.ts'

/** Verification commands are usually a test suite, which needs far longer than an ordinary tool call. */
const VERIFY_TIMEOUT_MS = 300_000

export interface VerificationOutcome {
  results: ShellResult[]
  passed: boolean
  /**
   * Set when the governor refused to run a check: the work is unverified, not
   * failed, and no edit to the code can change a policy. The interactive gate
   * used to hand the refusal to the model as a failing build and spend both
   * repair attempts on it.
   */
  blocked?: string
  /**
   * Set when a test runner found no tests to run. That proves nothing either
   * way — and handing it to the model as a failure is how "change the greeting"
   * in a project with no tests ended with elia writing a test file nobody asked
   * for (Bun exits 1 on "0 test files matching …"). Unverified, not failed.
   */
  inconclusive?: string
}

/** A test runner that ran and found nothing to test — Bun, Jest, Vitest, Mocha, pytest. */
const NO_TESTS_COLLECTED = /\b0 test files matching\b|\bno tests? (?:were )?found\b|\bno test files found\b|\bno tests ran\b|\bcollected 0 items\b/i

export function isNoTestsResult(result: ShellResult): boolean {
  return !result.timedOut && result.exitCode !== 0 && NO_TESTS_COLLECTED.test(`${result.stdout}\n${result.stderr}`)
}

/**
 * The declared verification commands that can never pass in this run, so the
 * plan drops them before committing to a gate it cannot win: a command this
 * machine's shell does not have, in any mode, and — unattended, with nobody
 * there to approve it — one the governor refuses outright.
 *
 * The first is not hypothetical. `ls workspace/edcdemo/` on Windows failed
 * "'ls' is not recognized" on all three attempts of run 2026-09-10-oabx-7ui6,
 * and every repair between them rewrote an app that was never broken. The
 * runtime fallback for unrunnable checks did not apply, because the plan's
 * other check (`bun --version`) ran fine.
 */
export function unwinnableVerificationCommands(
  commands: string[],
  options: { unattended: boolean; platform?: NodeJS.Platform; which?: (name: string) => string | null },
): string[] {
  return commands.filter((command) =>
    startsWithForeignShellCommand(command, options.platform, options.which) || (options.unattended && blockedInUnattendedMode(command)))
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
export async function runVerification(
  commands: string[],
  cwd?: string,
  signal?: AbortSignal,
  governor?: ActionGovernor,
  options: { serverProbeMs?: number } = {},
): Promise<VerificationOutcome> {
  const results: ShellResult[] = []
  let probedServers = 0

  // `proposal.ts` rejects a dev server as a verification command at approval
  // time, but a run resumed from a plan approved before that check — or a
  // repair that rewrote the command list — can still arrive here. Running one
  // costs the full VERIFY_TIMEOUT_MS and then reports the kill as a failure of
  // the work itself, which is how a correct build ends up spending its whole
  // repair budget (run 2026-09-13-l0av-rnq0). Drop them from the gate instead.
  const runnable = commands.filter((command) => !isLongRunningServerCommand(command))
  const skipped = commands.filter(isLongRunningServerCommand)

  // Nothing was declared at all (or the command list is empty): there is no
  // evidence gate here, and a pass would be "verified" having verified
  // nothing. An empty verification is an unverified change, not a green one.
  if (runnable.length === 0 && skipped.length === 0) {
    return {
      passed: false,
      results: [],
      inconclusive: 'no verification commands were declared to run — there is nothing proving this change',
    }
  }

  // Every declared check was a server: nothing here can prove anything, so
  // report it the same way a shell-rejected command is reported. The caller
  // already recognises that shape (`isUnrunnableCommandFailure`) and falls back
  // to rendering the deliverable rather than entering a repair loop it cannot
  // win. Reporting a pass instead would be the worse failure — "verified"
  // having verified nothing.
  if (runnable.length === 0 && skipped.length > 0) {
    return {
      passed: false,
      results: skipped.map((command) => ({
        command,
        exitCode: 1,
        stdout: '',
        stderr: `${SKIPPED_SERVER_PREFIX}: "${command}" starts a server that never exits, so it can never be a pass/fail check.`,
        elapsedMs: 0,
        timedOut: false,
      })),
    }
  }

  for (const command of skipped) {
    results.push({
      command: `[skipped] ${command}`,
      exitCode: 0,
      stdout: '',
      stderr: `${SKIPPED_SERVER_PREFIX}: starts a server that never exits. elia serves and renders the result itself instead.`,
      elapsedMs: 0,
      timedOut: false,
    })
  }

  for (const command of runnable) {
    const gate = await (governor ?? activeActionGovernor()).check({ name: 'run_command', input: { command } })
    if (!gate.allowed) {
      const reason = gate.message ?? 'verification command blocked by autonomy governor'
      const result: ShellResult = { command, exitCode: 126, stdout: '', stderr: reason, elapsedMs: 0, timedOut: false }
      results.push(result)
      return { results, passed: false, blocked: reason }
    }
    const probe = mayStartServer(command)
    const probeMs = options.serverProbeMs ?? SERVER_PROBE_MS
    const result = await runShell(command, probe ? probeMs : VERIFY_TIMEOUT_MS, cwd, signal ?? currentAgent().signal)
    if (probe && result.timedOut) {
      // Still up long after a script would have finished: it started the app's
      // server. That is not a check any more than `npm run dev` is, so it is
      // recorded the same way — unproven, not failed. Waiting out the full
      // VERIFY_TIMEOUT_MS on `python app.py` (a Flask app) kept one run on
      // "Checking the result" for over eight minutes, and then failed it.
      probedServers += 1
      results.push({
        ...result,
        command: `[skipped] ${command}`,
        exitCode: 0,
        timedOut: false,
        stderr: `${SKIPPED_SERVER_PREFIX}: still running after ${Math.round(probeMs / 1000)}s — it starts a server rather than finishing, so it cannot be a pass/fail check.`,
      })
      continue
    }
    results.push(result)
    // "No tests to run" is not a failing check — keep going so a typecheck or
    // build after it still gets its say.
    if (isNoTestsResult(result)) continue
    if (result.exitCode !== 0 || result.timedOut) return { results, passed: false }
  }

  const empty = results.filter(isNoTestsResult).map((result) => result.command)
  const inconclusive = empty.length > 0 ? `${empty.join(', ')} found no tests to run` : undefined
  const provedSomething = results.some((result) => result.exitCode === 0 && !result.timedOut && !result.command.startsWith('[skipped]'))
  // Nothing ran but servers: the same outcome as a plan of nothing but dev
  // servers (above), so the caller's fallback for unrunnable checks applies.
  // A pass here would be "verified" having verified nothing.
  if (probedServers > 0 && !provedSomething) {
    return {
      passed: false,
      results: results.map((result) => (result.command.startsWith('[skipped] ') ? { ...result, command: result.command.slice('[skipped] '.length), exitCode: 1 } : result)),
    }
  }
  if (inconclusive && !provedSomething) return { results, passed: false, inconclusive }
  return { results, passed: true, inconclusive }
}

/** How long a bare app entrypoint (`python app.py`) may run as a check before it is taken to be a server. */
export const SERVER_PROBE_MS = 20_000

/**
 * A shell rejected `result.command` outright — it never ran the intended
 * check, so the failure proves nothing about the work itself. `proposal.ts`
 * now rejects prose verification commands at approval time, but a run resumed
 * from before that fix (or any other unrunnable command) can still reach here.
 */
const SHELL_REJECTED_COMMAND = /is not recognized as an internal or external command|:\s*command not found|No such file or directory/i

/** Marks a verification entry elia declined to run because it can never terminate. */
export const SKIPPED_SERVER_PREFIX = 'not a runnable check'

export function isUnrunnableCommandFailure(result: ShellResult): boolean {
  if (result.timedOut || result.exitCode === 0) return false
  // A dev server elia refused to run never produced a verdict either, so it
  // belongs in the same bucket as a command the shell rejected: the work is
  // unproven, not disproven. So does a test runner with no tests to run.
  return SHELL_REJECTED_COMMAND.test(result.stderr) || result.stderr.startsWith(SKIPPED_SERVER_PREFIX) || isNoTestsResult(result)
}

/**
 * A plan's declared file path and where the file actually landed can diverge
 * (a worker misreads its own working directory and nests the deliverable one
 * level deeper than the plan says). Rather than trust the declared path
 * blindly and 404, fall back to a same-basename search under `root` — the
 * same tree `hygiene.ts` already scans for undeclared files — and use it when
 * exactly one candidate matches. An ambiguous or absent match falls through
 * to the declared path so the caller's existing 404 handling still applies.
 */
function locateStaticPage(root: string, declaredPage: string): string {
  if (existsSync(resolve(root, declaredPage))) return declaredPage
  const target = basename(declaredPage).toLowerCase()
  const candidates = scanProjectFiles(root).filter((file) => basename(file).toLowerCase() === target)
  return candidates.length === 1 ? candidates[0]! : declaredPage
}

/**
 * Falls back to a headless render check for a static HTML/CSS/JS deliverable
 * when every declared verification command turned out to be unrunnable
 * (`isUnrunnableCommandFailure`) — reusing the same mechanism the interactive
 * loop already relies on (`detectChecks.changedStaticPages`,
 * `preview/readiness.ts`) instead of leaving the autonomous path with no
 * check at all. Returns `undefined` when none of `changedPaths` is a page
 * this can check, so the caller can fall through to the original failure.
 */
export async function fallbackStaticPageVerification(
  changedPaths: string[],
  root: string,
  signal?: AbortSignal,
): Promise<VerificationOutcome | undefined> {
  const pages = changedStaticPages(changedPaths)
  if (pages.length === 0) return undefined

  const server = ensurePreviewServer(root)
  const declaredPage = pages.find((candidate) => /^index\.html?$/i.test(basename(candidate))) ?? pages[0]!
  const page = locateStaticPage(root, declaredPage)
  const relativePath = relative(server.root, resolve(root, page)).split(sep).join('/')
  const url = `${server.baseUrl}/${relativePath}`
  const command = `[static-page render check] ${url}`

  const ready = await waitForHttp(url, 10_000, signal)
  if (!ready.ok) {
    return {
      passed: false,
      results: [{ command, exitCode: 1, stdout: '', stderr: ready.reason ?? 'server did not respond', elapsedMs: 0, timedOut: false }],
    }
  }
  const rendered = await checkRendered(url, signal)
  return {
    passed: rendered.ok,
    results: [{
      command,
      exitCode: rendered.ok ? 0 : 1,
      stdout: '',
      stderr: rendered.ok ? '' : (rendered.reason ?? 'page did not render'),
      elapsedMs: 0,
      timedOut: false,
    }],
  }
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
export function requireCriticVerdict(verdict: CriticVerdict | undefined, reviewer = 'critic'): CriticVerdict {
  return verdict ?? {
    verdict: 'revise',
    summary: `The ${reviewer} did not submit a structured verdict.`,
    issues: [
      {
        severity: 'blocker',
        detail: `Review could not be verified because submit_verdict was never called by ${reviewer}.`,
      },
    ],
  }
}

/**
 * Combines the verdicts from several reviewers who each looked at the same
 * change from a different angle (general correctness, security, functional
 * bugs) into one gate. Fails closed: any reviewer voting "revise" makes the
 * combined verdict "revise", and every issue survives the merge tagged with
 * who raised it, so the repair step sees the whole picture instead of just
 * whichever reviewer happened to run.
 */
export function mergeVerdicts(named: { reviewer: string; verdict: CriticVerdict }[]): CriticVerdict {
  const verdict = named.some((entry) => entry.verdict.verdict === 'revise') ? 'revise' : 'approve'
  const issues = named.flatMap((entry) =>
    entry.verdict.issues.map((issue) => ({ ...issue, detail: `[${entry.reviewer}] ${issue.detail}` })),
  )
  const summary = named.map((entry) => `${entry.reviewer}: ${entry.verdict.summary}`).join(' | ')
  return { verdict, summary, issues }
}

import { existsSync } from 'node:fs'
import { basename, relative, resolve, sep } from 'node:path'
import type { Tool } from '../tools/types.ts'
import { clampOutput, failureHint, isLongRunningServerCommand, mayStartServer, runShell, startsWithForeignShellCommand, type ShellResult } from '../shell.ts'
import type { CriticIssue, CriticVerdict } from './types.ts'
import { currentAgent } from './context.ts'
import { activeActionGovernor, blockedInUnattendedMode, type ActionGovernor } from './governor.ts'
import { changedStaticPages } from './detectChecks.ts'
import { detectMissingPackage, installCommandFor, isInstallCommand } from './autoInstall.ts'
import { scanProjectFiles } from './hygiene.ts'
import { ensurePreviewServer } from '../preview/server.ts'
import { checkRendered, waitForHttp } from '../preview/readiness.ts'

/** Verification commands are usually a test suite, which needs far longer than an ordinary tool call. */
const VERIFY_TIMEOUT_MS = 300_000

/** Same escape hatch the tool path uses — one switch turns auto-installing off everywhere. */
const AUTO_INSTALL = process.env.ELIA_NO_AUTO_INSTALL !== '1'

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

/**
 * One check's progress, for a UI that wants to show each one land. `queued`
 * arrives for every runnable check before the first starts, so a watcher knows
 * the whole set up front; checks after a failure are never reported again and
 * stay queued — fail-fast means they did not run.
 */
export interface CheckEvent {
  command: string
  state: 'queued' | 'running' | 'passed' | 'failed' | 'skipped'
}

/** A test runner that ran and found nothing to test — Bun, Jest, Vitest, Mocha, pytest. */
const NO_TESTS_COLLECTED = /\b0 test files matching\b|\bno tests? (?:were )?found\b|\bno test files found\b|\bno tests ran\b|\bcollected 0 items\b/i

/**
 * A test runner that exited 0 having run nothing. Bun does this for a test file
 * with no `test()` calls in it: run 2026-09-20-gp6s-q6lh's `bun test` covered a
 * file of `console.assert`s — "Ran 0 tests across 1 file", exit 0 — and the gate
 * counted it as a passing test run. Mocha, `node --test`, cargo and go have the
 * same shape. Cargo and go print one line per test binary / package, so they
 * count as empty only when every one of them ran nothing.
 */
function ranZeroTests(output: string): boolean {
  if (/\bRan 0 tests? across\b/.test(output)) return true
  if (/^\s*(?:#|ℹ)\s*tests 0\s*$/m.test(output)) return true
  if (/^\s*0 passing\b/m.test(output)) return true
  const cargo = [...output.matchAll(/^running (\d+) tests?\s*$/gm)]
  if (cargo.length > 0 && cargo.every((match) => match[1] === '0')) return true
  return /\[no test files\]/.test(output) && !/^(?:ok|FAIL|---)\s/m.test(output)
}

export function isNoTestsResult(result: ShellResult): boolean {
  if (result.timedOut) return false
  const output = `${result.stdout}\n${result.stderr}`
  return result.exitCode !== 0 ? NO_TESTS_COLLECTED.test(output) : ranZeroTests(output)
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
  options: {
    serverProbeMs?: number
    onCheck?: (event: CheckEvent) => void
    /**
     * Record a check whose program the shell could not find as skipped and
     * carry on, instead of failing the gate on it. The chat turn's gate wants
     * this: its checks are inferred, not declared, so "mypy is not installed"
     * is a fact about the machine, and two repair turns spent on it changed
     * nothing — one ended with the model saying "mypy passes" over a recorded
     * `'mypy' is not recognized`.
     */
    skipMissingPrograms?: boolean
  } = {},
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

  // A watcher must never be able to break the gate itself.
  const report = (command: string, state: CheckEvent['state']): void => {
    try {
      options.onCheck?.({ command, state })
    } catch {}
  }
  for (const command of runnable) report(command, 'queued')

  for (const command of runnable) {
    const gate = await (governor ?? activeActionGovernor()).check({ name: 'run_command', input: { command } })
    if (!gate.allowed) {
      const reason = gate.message ?? 'verification command blocked by autonomy governor'
      const result: ShellResult = { command, exitCode: 126, stdout: '', stderr: reason, elapsedMs: 0, timedOut: false }
      results.push(result)
      report(command, 'skipped')
      return { results, passed: false, blocked: reason }
    }
    report(command, 'running')
    const probe = mayStartServer(command)
    const probeMs = options.serverProbeMs ?? SERVER_PROBE_MS
    let result = await runShell(command, probe ? probeMs : VERIFY_TIMEOUT_MS, cwd, signal ?? currentAgent().signal)

    // A check that failed only because a dependency is not installed says
    // nothing about the work. The tool path has installed and retried on this
    // signal for a long time (`runCommand.ts`), but the verification gate went
    // straight to `runShell` and so never did — the one place where a missing
    // module is *least* likely to be a defect in the change. The run then
    // reported a red gate, repaired code that was never broken, escalated once
    // with "fix the environment first", and handed off; two of the twelve
    // needs-attention runs in `.elia/runs` ended exactly there. Install it and
    // re-run the check once, through the governor so a supervised run still
    // asks.
    if (AUTO_INSTALL && result.exitCode !== 0 && !result.timedOut && !isInstallCommand(command)) {
      const missing = detectMissingPackage(`${result.stdout}\n${result.stderr}`)
      if (missing) {
        const installCmd = installCommandFor(missing, cwd ?? process.cwd())
        const installGate = await (governor ?? activeActionGovernor()).check({ name: 'run_command', input: { command: installCmd } })
        if (installGate.allowed) {
          const installed = await runShell(installCmd, VERIFY_TIMEOUT_MS, cwd, signal ?? currentAgent().signal)
          if (installed.exitCode === 0) {
            const retry = await runShell(command, probe ? probeMs : VERIFY_TIMEOUT_MS, cwd, signal ?? currentAgent().signal)
            // Keep the install visible in the record: a gate that only went
            // green because elia changed the environment is a different fact
            // from one that was green already.
            result = { ...retry, stdout: `[auto-installed missing dependency: ${installCmd}]\n${retry.stdout}` }
          }
        }
      }
    }
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
      report(command, 'skipped')
      continue
    }
    results.push(result)
    // "No tests to run" is not a failing check — keep going so a typecheck or
    // build after it still gets its say.
    if (isNoTestsResult(result)) {
      report(command, 'skipped')
      continue
    }
    if (options.skipMissingPrograms && isCommandNotFound(result)) {
      report(command, 'skipped')
      continue
    }
    const failed = result.exitCode !== 0 || result.timedOut
    report(command, failed ? 'failed' : 'passed')
    if (failed) return { results, passed: false }
  }

  const empty = results.filter(isNoTestsResult).map((result) => result.command)
  const missing = options.skipMissingPrograms ? results.filter(isCommandNotFound).map((result) => result.command) : []
  const inconclusive = [
    empty.length > 0 ? `${empty.join(', ')} found no tests to run` : '',
    missing.length > 0 ? `${missing.join(', ')} could not run — the program is not installed here` : '',
  ].filter(Boolean).join('; ') || undefined
  const provedSomething = results.some((result) => result.exitCode === 0 && !result.timedOut && !result.command.startsWith('[skipped]') && !isNoTestsResult(result))
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

/**
 * The shell could not find the check's program at all: cmd.exe's
 * `'mypy' is not recognized …`, or sh's `mypy: not found` with exit 127.
 * Narrower than `SHELL_REJECTED_COMMAND` on purpose — a genuine test failure
 * can print "No such file or directory", and that has to stay a failure.
 */
export function isCommandNotFound(result: ShellResult): boolean {
  if (result.timedOut || result.exitCode === 0) return false
  const program = /^\s*"?([^\s"]+)/.exec(result.command)?.[1]
  if (!program) return false
  const name = program.replace(/^.*[\\/]/, '').toLowerCase()
  const stderr = result.stderr.trimStart()
  const windows = /^'([^']+)' is not recognized as an internal or external command/i.exec(stderr)?.[1]
  if (windows !== undefined) return windows.replace(/^.*[\\/]/, '').toLowerCase() === name
  return result.exitCode === 127 && new RegExp(`(?:^|[:\\s])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: (?:command )?not found`, 'im').test(stderr)
}

/** Marks a verification entry elia declined to run because it can never terminate. */
export const SKIPPED_SERVER_PREFIX = 'not a runnable check'

export function isUnrunnableCommandFailure(result: ShellResult): boolean {
  if (result.timedOut) return false
  // A test runner with no tests to run proved nothing, whatever it exited with.
  if (isNoTestsResult(result)) return true
  if (result.exitCode === 0) return false
  // A dev server elia refused to run never produced a verdict either, so it
  // belongs in the same bucket as a command the shell rejected: the work is
  // unproven, not disproven.
  return SHELL_REJECTED_COMMAND.test(result.stderr) || result.stderr.startsWith(SKIPPED_SERVER_PREFIX)
}

/**
 * What a static-page render check is worth to this run's verification.
 *
 * `augment` — the declared commands passed, so the render is one more gate on
 * top of them. `substitute` — nothing the plan declared produced a verdict, so
 * the render is the only evidence there is and it *becomes* the verification.
 * `none` — there is no page to render, or the declared checks genuinely failed
 * and that failure is the real signal.
 *
 * The `substitute` case used to have a hole in it. The loop asked for the
 * fallback only when at least one command had run and every one of them was
 * unrunnable — but a plan whose checks are all refused at approval time
 * reaches verification with an *empty* command list (`detectChecks` finds no
 * manifest to infer from, which is the normal state of a freshly scaffolded
 * static site). `runVerification([])` reports `passed: false` with zero
 * results, so neither branch fired: the render check was skipped precisely
 * when it was the only thing that could have proved anything. The run then
 * repaired working code against a failure that was never about the code, and
 * ended `needs-attention` asking a human to look at a page that rendered
 * fine — observed on run 2026-09-15-cqd0-omdu (a tip calculator), and it is
 * the same shape as the 6 of 7 rewrites in the run corpus that left the
 * command list empty.
 */
export function staticRenderRole(
  verification: Pick<VerificationOutcome, 'passed' | 'results'>,
  hasRenderablePage: boolean,
): 'none' | 'augment' | 'substitute' {
  if (!hasRenderablePage) return 'none'
  if (verification.passed) return 'augment'
  // Nothing ran at all, or nothing that ran could produce a verdict.
  if (verification.results.length === 0) return 'substitute'
  return verification.results.every(isUnrunnableCommandFailure) ? 'substitute' : 'none'
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
      const hint = result.timedOut ? undefined : failureHint(result.stdout, result.stderr)
      return [
        `$ ${result.command} — ${status}`,
        result.stdout ? clampOutput(result.stdout) : '',
        result.stderr ? clampOutput(result.stderr) : '',
        hint ? `hint: ${hint}` : '',
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

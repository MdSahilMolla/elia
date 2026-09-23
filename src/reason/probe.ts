import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { runShell, type ShellResult } from '../shell.ts'
import type { Tool } from '../tools/types.ts'
import type { TaskSignature } from './signature.ts'
import type { Verifier } from './verify.ts'
import { registerArtifact, type Check } from '../autonomy/certifiedLibrary.ts'
import { sealedReadTools } from '../evolve/isolation.ts'

/**
 * Verification first (§7.4): when a task has no check, build the check before
 * attempting the task.
 *
 * Proposition 1 says solving effort cannot raise precision on a family outside
 * the frontier — only a better verifier can. And checking is usually easier
 * than solving. The reasoning layer already had a `synthesized-probe` harness
 * for exactly this, and `decideSearch` already told the person "elia will
 * write the check before attempting it" — but no caller ever supplied the
 * synthesizer, so every such search quietly fell back to attempts agreeing with
 * each other, which is not a check at all.
 *
 * A probe is admitted as a verifier only after two checks of different kinds:
 *
 * - `probe-runs` (structural): bun loaded it and ran at least one test, with no
 *   load error. A probe that cannot run would reject every candidate.
 * - `red-on-baseline` (execution): it FAILS on the tree as it is now. A probe
 *   that already passes before anything changed accepts a candidate that does
 *   nothing — its false-accept rate on the null change is 1 — so it proves
 *   nothing about any attempt.
 *
 * The probe lives outside every candidate's worktree and runs from its own
 * directory, with the candidate's tree passed in `ELIA_PROBE_ROOT`. So no
 * attempt can edit the check it is judged by (isolation requirement I1, at the
 * scale of one search).
 */

export const PROBE_FILE = 'probe.test.ts'

/** Writes `probe.test.ts` into `probeDir`. Injected, because it is the one part that needs a model. */
export type ProbeWriter = (input: { request: string; probeDir: string; sourceRoot: string; signal?: AbortSignal }) => Promise<void>

export interface ProbeRun {
  exitCode: number
  pass: number
  fail: number
  errors: number
  ran: number
  output: string
}

/** Parses bun's test summary. Missing numbers read as zero. */
export function parseBunSummary(result: Pick<ShellResult, 'exitCode' | 'stdout' | 'stderr'>): ProbeRun {
  const output = `${result.stdout}\n${result.stderr}`
  const count = (pattern: RegExp) => Number(pattern.exec(output)?.[1] ?? 0)
  return {
    exitCode: result.exitCode,
    pass: count(/^\s*(\d+) pass\b/m),
    fail: count(/^\s*(\d+) fail\b/m),
    errors: count(/^\s*(\d+) errors?\b/m),
    ran: count(/Ran (\d+) tests?/),
    output: output.slice(-2_000),
  }
}

export async function runProbe(probeDir: string, root: string, timeoutMs: number, signal?: AbortSignal): Promise<ProbeRun & { timedOut: boolean; elapsedMs: number }> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') env[key] = value
  env.ELIA_PROBE_ROOT = root
  const result = await runShell(`bun test ./${PROBE_FILE}`, timeoutMs, probeDir, signal, env)
  return { ...parseBunSummary(result), timedOut: result.timedOut, elapsedMs: result.elapsedMs }
}

export interface ProbeAdmission {
  admitted: boolean
  checks: Check[]
  reason: string
}

/** The two admission checks, from a run against the unchanged tree. */
export function admitProbe(baseline: ProbeRun & { timedOut?: boolean }): ProbeAdmission {
  const at = Date.now()
  const runs = !baseline.timedOut && baseline.ran >= 1 && baseline.errors === 0
  const red = runs && baseline.exitCode !== 0 && baseline.fail >= 1
  const checks: Check[] = [
    { verifier: 'probe-runs', tier: 'exact', family: 'structural', passed: runs, at, ...(runs ? {} : { detail: baseline.timedOut ? 'timed out' : baseline.ran === 0 ? 'ran no tests' : `${baseline.errors} load error(s)` }) },
  ]
  if (runs) checks.push({ verifier: 'red-on-baseline', tier: 'exact', family: 'execution', passed: red, at, ...(red ? {} : { detail: 'passes before any change, so it cannot tell a fix from nothing' }) })
  const reason = !runs
    ? `the probe does not run cleanly (${checks[0]!.detail})`
    : !red
      ? 'the probe already passes on the unchanged tree — it cannot tell a fix from doing nothing'
      : `the probe fails on the unchanged tree (${baseline.fail} failing) and can tell a fix from nothing`
  return { admitted: runs && red, checks, reason }
}

/** A verifier that runs an admitted probe against a candidate's tree. */
export function probeVerifier(probeDir: string, timeoutMs: number, signal?: AbortSignal): Verifier {
  return {
    id: 'synthesized probe',
    strength: 'executed',
    costHint: 'cheap',
    async run(candidate) {
      if (!candidate.cwd) return { passed: false, strength: 'executed', detail: 'no working tree to check', evidence: '', elapsedMs: 0 }
      const run = await runProbe(probeDir, candidate.cwd, timeoutMs, signal)
      const passed = run.exitCode === 0 && !run.timedOut && run.fail === 0 && run.errors === 0 && run.ran >= 1
      const total = run.pass + run.fail
      return {
        passed,
        strength: 'executed',
        detail: run.timedOut ? 'the synthesized probe timed out' : `synthesized probe: ${run.pass}/${total} passing`,
        evidence: passed ? '' : run.output,
        ...(total > 0 ? { progress: run.pass / total } : {}),
        elapsedMs: run.elapsedMs,
      }
    },
  }
}

export interface ProbeSynthesizerOptions {
  request: string
  sourceRoot: string
  write: ProbeWriter
  /** Where probes are written; outside any worktree by default. */
  probesDir?: string
  libraryFile?: string
  timeoutMs?: number
  signal?: AbortSignal
  /** Told once the probe is admitted or refused, so the person sees why the search has or lacks a real check. */
  onDecision?: (admission: ProbeAdmission) => void
}

/** The `synthesizeProbe` hook `reason()` has always accepted and never been given. */
export function createProbeSynthesizer(options: ProbeSynthesizerOptions): (signature: TaskSignature) => Promise<Verifier | undefined> {
  return async (signature) => {
    const timeoutMs = options.timeoutMs ?? 120_000
    const probeDir = join(options.probesDir ?? join(tmpdir(), 'elia-probes'), `${signature.key.replace(/[^a-z0-9-]+/gi, '-').slice(0, 40)}-${Date.now().toString(36)}`)
    mkdirSync(probeDir, { recursive: true })
    try {
      await options.write({ request: options.request, probeDir, sourceRoot: options.sourceRoot, ...(options.signal ? { signal: options.signal } : {}) })
    } catch {
      return undefined
    }
    const file = join(probeDir, PROBE_FILE)
    if (!existsSync(file)) return undefined

    const baseline = await runProbe(probeDir, options.sourceRoot, timeoutMs, options.signal)
    const admission = admitProbe(baseline)
    try {
      registerArtifact(
        {
          id: `verifier:probe:${Bun.hash(readFileSync(file, 'utf8')).toString(36)}`,
          kind: 'verifier',
          summary: `probe for: ${options.request.slice(0, 200)}`,
          source: 'synthesized-probe',
          checks: admission.checks,
        },
        ...(options.libraryFile ? [options.libraryFile] : []),
      )
    } catch {
      // The registry is evidence; the admission decision below does not depend on it.
    }
    options.onDecision?.(admission)
    return admission.admitted ? probeVerifier(probeDir, timeoutMs, options.signal) : undefined
  }
}

/** Tools for the probe writer: read the project, write only inside the probe directory, run only the probe. */
export function probeWriterTools(available: readonly Tool[], sourceRoot: string, probeDir: string): Tool[] {
  const tools = sealedReadTools(available, [sourceRoot, probeDir])
  const dir = resolve(probeDir)
  const confined = (path: string) => {
    const target = resolve(dir, path)
    const rel = relative(dir, target)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`the probe writer may only write inside ${probeDir}`)
    return target
  }
  for (const tool of available) {
    if (tool.name === 'write_file' || tool.name === 'edit_file') {
      tools.push({ ...tool, execute: (input) => tool.execute({ ...input, path: confined(typeof input.path === 'string' ? input.path : PROBE_FILE) }) })
    }
    if (tool.name === 'run_command') {
      tools.push({
        ...tool,
        description: `Run the probe against the current project: exactly "bun test ./${PROBE_FILE}".`,
        async execute(input) {
          const command = typeof input.command === 'string' ? input.command.trim() : ''
          if (command !== `bun test ./${PROBE_FILE}`) throw new Error(`only "bun test ./${PROBE_FILE}" may run here`)
          const run = await runProbe(probeDir, sourceRoot, 120_000)
          return run.output
        },
      })
    }
  }
  return tools
}

export function probeWriterPrompt(request: string, probeDir: string): string {
  return `Before anyone attempts this task, write the check that will decide whether an attempt succeeded.

## The task
${request}

## What to write
Exactly one file: \`${join(probeDir, PROBE_FILE)}\` — a Bun test (\`import { expect, test } from 'bun:test'\`).

Rules that make it a check rather than a formality:
- It runs from its own directory. The project under test is at \`process.env.ELIA_PROBE_ROOT\`; build every project path from that, never from \`import.meta.dir\` or a hard-coded path.
- Import project code dynamically inside the test (\`await import(join(process.env.ELIA_PROBE_ROOT!, 'src/…'))\`), so code that does not exist yet fails the assertion instead of crashing the file.
- Assert the behaviour the task asks for — observable outcomes, not implementation details. Cover the main case and at least one edge case.
- It MUST FAIL on the project as it is now: the task has not been done yet. Run it with run_command (\`bun test ./${PROBE_FILE}\`) and confirm it fails for the right reason — the missing behaviour, not a typo in your test.
- Do not touch the project. You can read it; you cannot write to it.

Report what the probe checks, and the failure it shows now.`
}

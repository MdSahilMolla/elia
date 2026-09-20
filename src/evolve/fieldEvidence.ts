import { existsSync, openSync, readSync, closeSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { competenceReport } from '../autonomy/outcomes.ts'
import { stateDir } from '../statePaths.ts'
import { BENCH_TASKS } from './suite.ts'

/**
 * What actually goes wrong when elia does real work, told to the proposer in a
 * form it can act on.
 *
 * `elia evolve` can rewrite elia's own source under a measured gate, and the
 * machinery for doing it is sound. It has still run two generations in its
 * entire history and rejected both — because the proposer is blindfolded. Its
 * whole view of the world is `hypothesisBrief()`: the benchmark's pass rate,
 * which synthetic tasks failed, the immutable list, and its own ledger. It has
 * never been shown a single thing about how elia behaves on the user's actual
 * work.
 *
 * That evidence exists and has been accumulating unread. `.elia/action-ledger.ndjson`
 * holds every audited tool call — 2,444 of them here, 407 of which errored — and
 * `readActionLedger` only ever opens the per-run copies, so the top-level file
 * has no reader anywhere in the codebase. Inside it, the errors cluster into
 * named, recurring shapes: an `edit_file` whose anchor text was not found (16 of
 * 234 calls), a `read_file` on a path that was guessed and does not exist (20 of
 * 404), a `write_file` refused because the file had not been read first (10 of
 * 387). Those are exactly what `precise-edit`, `distractor-rename`,
 * `propagate-rename`, `find-symbol` and `scope-discipline` measure. It is a
 * scorable hypothesis that nobody could see.
 *
 * ## Two rules this module exists to hold
 *
 * **Nothing here may quote a log.** `appendActionAudit` redacts a tool's *input*
 * but stores its `result` as a raw truncation — so a web page, a dependency's
 * error text, or a file in someone's repository lands in that ledger verbatim.
 * Echoing it into the proposer's prompt would build a prompt-injection sink
 * aimed at the one agent in this system permitted to rewrite elia's source. So
 * the output is integers, tool names that survive an allowlist regex, and labels
 * written here in code. A message matching no known shape increments a counter
 * and is discarded. That is also why this file is in `IMMUTABLE_FILES`: the
 * vocabulary the proposer can ever see is fixed by human commit.
 *
 * **A signal the benchmark cannot score is not a hypothesis.** `compareScorecards`
 * judges every candidate on the same 14-task suite, so evidence pointing at a
 * weakness that suite cannot see produces proposals that can never be promoted,
 * however good they are. Each shape therefore carries the benchmark tasks a fix
 * would plausibly move, and a shape with none is rendered under a heading that
 * tells the proposer not to touch it. Today that suppresses the two largest
 * numbers in the data — which is the point: without the split they would look
 * like the most important thing to fix.
 */

export interface FailureShape {
  id: string
  /** The tool this shape belongs to, or '*' for any. */
  tool: string
  match: RegExp
  /** Written here, in code. Never derived from a log. */
  label: string
  /** Benchmark task ids a fix would plausibly move. Empty means the benchmark cannot score it. */
  benchTasks: string[]
}

/**
 * The closed vocabulary.
 *
 * Every entry was read off the real ledger rather than imagined, and every
 * `benchTasks` entry names a task in `suite.ts` — a test asserts that, so the
 * map cannot rot silently when a task is renamed.
 */
export const FAILURE_SHAPES: readonly FailureShape[] = [
  {
    id: 'edit-anchor-missing',
    tool: 'edit_file',
    match: /old_string not found/i,
    label: 'edit_file · anchor text not found in the file',
    benchTasks: ['precise-edit', 'distractor-rename', 'propagate-rename'],
  },
  {
    id: 'edit-anchor-ambiguous',
    tool: 'edit_file',
    match: /matches multiple locations|not unique/i,
    label: 'edit_file · anchor matched more than one location',
    benchTasks: ['precise-edit', 'distractor-rename'],
  },
  {
    id: 'read-missing-path',
    tool: 'read_file',
    match: /file not found|no such file/i,
    label: 'read_file · path guessed and does not exist',
    benchTasks: ['find-symbol', 'parallel-scan'],
  },
  {
    id: 'write-unread-overwrite',
    tool: 'write_file',
    match: /has not been read this session/i,
    label: 'write_file · refused an overwrite of a file not read first',
    benchTasks: ['scope-discipline'],
  },
  {
    id: 'write-left-broken',
    tool: 'write_file',
    match: /leaves .* broken and was not written/i,
    label: 'write_file · the change would have left the file broken',
    benchTasks: ['implement-to-spec', 'fix-failing-test'],
  },
  {
    id: 'grep-bad-regex',
    tool: 'grep',
    match: /regex parse error|invalid regular expression/i,
    label: 'grep · the pattern was not a valid regular expression',
    benchTasks: ['find-symbol'],
  },
  // Shell habits from a POSIX machine used on a Windows one — read off the
  // ledger 2026-09-20. fieldSuite.ts has a task for each, with a step budget
  // the habit wastes, so a fix can now be scored.
  {
    id: 'server-as-command',
    tool: 'run_command',
    match: /starts a server that never exits/i,
    label: 'run_command · started a server that never exits instead of using the process tool',
    // Unscoreable: the benchmark runs unattended, and its policy refuses to
    // start any process — so a task for this measures the policy (fieldSuite.ts).
    benchTasks: [],
  },
  {
    id: 'cd-in-command',
    tool: 'run_command',
    match: /Do not use cd, chdir, pushd, or popd/i,
    label: 'run_command · used cd inside the command instead of passing cwd',
    benchTasks: ['field-subpackage-test'],
  },
  {
    id: 'posix-on-windows',
    tool: 'run_command',
    match: /is a POSIX command and this shell is cmd\.exe|\b(?:ls|cd|which|cls|find|wc|grep|cat|rm) is not available in PATH|PowerShell cmdlet \(Verb-Noun\) is being piped|inline -c\/-e one-liner with backslash escapes/i,
    label: 'run_command · a command for another shell (POSIX or PowerShell habits on cmd.exe)',
    benchTasks: ['field-count-sources', 'field-subpackage-test'],
  },
  {
    id: 'unknown-tool',
    tool: '*',
    match: /^Unknown tool: /i,
    label: 'called a tool that does not exist',
    benchTasks: [],
  },
  // Not elia's behaviour at all: a provider limit, a person saying no, or a
  // policy refusing. Named so they stop hiding among the unexplained errors —
  // and scored by nothing, because no change to elia should try to "fix" them.
  {
    id: 'environment-refusal',
    tool: '*',
    match: /rate limit|usage limit|Request too large|Action denied by the user|blocked by Elia.s unattended policy|no browser transport configured|Codex request cancelled|protected sensitive path/i,
    label: 'the environment refused (provider limits, a person declining, or policy) — not a behaviour to change',
    benchTasks: [],
  },
  {
    id: 'command-failed',
    tool: 'run_command',
    match: /Action postcondition failed: command (?:did not return exit code 0|timed out)/i,
    label: 'a command exited non-zero or timed out — usually a check doing its job',
    benchTasks: [],
  },
  // Working on a repository that is not this project. Read off the
  // 2026-09-20 session that fixed a pallets/click issue and committed it into
  // elia's own repo instead: the guards that now refuse that say these exact
  // things, and `field-external-contribution` scores whether the habit is gone.
  {
    id: 'commit-swept-wrong-repo',
    tool: 'github',
    match: /Refusing to commit everything in .*an external contribution to/i,
    label: 'github commit · swept a whole working tree while the work was in another repository',
    benchTasks: ['field-external-contribution'],
  },
  {
    id: 'nested-clone-staged',
    tool: 'github',
    match: /its own git repository, not part of this project/i,
    label: 'github commit · staged a clone of another project as a stray gitlink',
    benchTasks: ['field-external-contribution'],
  },
  {
    id: 'pr-target-unnamed',
    tool: 'github',
    match: /is a clone of .*, which is not this project|opened against your own fork/i,
    label: 'github pr_create · would have opened the pull request on the fork instead of upstream',
    benchTasks: ['field-external-contribution'],
  },
  // The two below are real and frequent, and the benchmark cannot score either:
  // no task in the suite fails because an argument was omitted or a path escaped
  // the workspace. They are rendered under the suppressed heading so a
  // generation is not spent on a proposal that cannot be promoted.
  {
    id: 'missing-required-arg',
    tool: '*',
    match: /requires a non-empty|no file path was given|must be a non-empty string|is required/i,
    label: 'a tool call omitted a required argument',
    benchTasks: [],
  },
  {
    id: 'path-escape',
    tool: '*',
    match: /escapes the active workspace|crosses a symlink boundary|escapes the evolution sandbox/i,
    label: 'a tool call targeted a path outside the workspace',
    benchTasks: [],
  },
]

export interface FieldSignal {
  id: string
  /** One already-bounded rendered line. */
  line: string
  count: number
  benchTasks: string[]
}

export interface FieldEvidence {
  actionable: FieldSignal[]
  unmeasurable: FieldSignal[]
  /** Errors matching no known shape. A count, never text. */
  unclassified: number
  totalCalls: number
  totalErrors: number
  turns?: { changing: number; clean: number; cleanRate: number; editRetryRate: number }
  /** Why a part is missing, in this module's own words. */
  notes: string[]
}

export interface FieldEvidenceOptions {
  actionLedgerPath?: string
  outcomesPath?: string
  /** Test seam. Defaults to the real benchmark task ids. */
  knownTaskIds?: readonly string[]
}

/** The ledger is 3.5 MB here and `appendActionAudit` never rotates it, so reads are tail-bounded. */
const MAX_LEDGER_BYTES = 8_000_000
const MAX_LEDGER_LINES = 4_000
/** Below this a shape is noise rather than a pattern. */
const MIN_OCCURRENCES = 3
const MAX_ACTIONABLE = 6
const MAX_UNMEASURABLE = 3
const MAX_LINE_CHARS = 160
export const MAX_SECTION_CHARS = 2_000

/** A tool name that survives this is safe to print. Anything else is bucketed, never echoed. */
const SAFE_TOOL_NAME = /^[a-z][a-z0-9_]{0,31}$/

function safeTool(name: unknown): string {
  return typeof name === 'string' && SAFE_TOOL_NAME.test(name) ? name : 'other'
}

/**
 * The last `MAX_LEDGER_BYTES` of a file, with any torn first line dropped.
 *
 * Reading the whole of an append-only log that nothing prunes is how a helper
 * like this turns into the slowest part of a run. Never throws: a missing or
 * unreadable ledger costs a section of the brief, not the generation.
 */
function tailLines(path: string): string[] {
  try {
    if (!existsSync(path)) return []
    const size = statSync(path).size
    if (size === 0) return []
    let text: string
    if (size <= MAX_LEDGER_BYTES) {
      text = readFileSync(path, 'utf8')
    } else {
      const handle = openSync(path, 'r')
      try {
        const buffer = Buffer.alloc(MAX_LEDGER_BYTES)
        const read = readSync(handle, buffer, 0, MAX_LEDGER_BYTES, size - MAX_LEDGER_BYTES)
        // The first line of a mid-file read is almost certainly a fragment.
        text = buffer.subarray(0, read).toString('utf8').split('\n').slice(1).join('\n')
      } finally {
        closeSync(handle)
      }
    }
    return text.split('\n').filter((line) => line.trim()).slice(-MAX_LEDGER_LINES)
  } catch {
    return []
  }
}

interface LedgerRow {
  tool?: unknown
  result?: unknown
  isError?: unknown
}

function classify(row: LedgerRow): FailureShape | undefined {
  const tool = safeTool(row.tool)
  const result = typeof row.result === 'string' ? row.result : ''
  if (!result) return undefined
  return FAILURE_SHAPES.find((shape) => (shape.tool === '*' || shape.tool === tool) && shape.match.test(result))
}

function clipLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line
}

export function collectFieldEvidence(options: FieldEvidenceOptions = {}): FieldEvidence {
  const ledgerPath = options.actionLedgerPath ?? join(stateDir, 'action-ledger.ndjson')
  const notes: string[] = []

  const rows: LedgerRow[] = []
  for (const line of tailLines(ledgerPath)) {
    try {
      rows.push(JSON.parse(line) as LedgerRow)
    } catch {
      // A torn line costs one data point, never the read.
    }
  }

  if (rows.length === 0) notes.push('no audited tool calls on record for this project')

  const callsByTool = new Map<string, number>()
  for (const row of rows) {
    const tool = safeTool(row.tool)
    callsByTool.set(tool, (callsByTool.get(tool) ?? 0) + 1)
  }

  const errors = rows.filter((row) => row.isError === true)
  const counts = new Map<string, number>()
  let unclassified = 0
  for (const row of errors) {
    const shape = classify(row)
    if (!shape) {
      unclassified += 1
      continue
    }
    counts.set(shape.id, (counts.get(shape.id) ?? 0) + 1)
  }

  const signals: FieldSignal[] = []
  for (const shape of FAILURE_SHAPES) {
    const count = counts.get(shape.id) ?? 0
    if (count < MIN_OCCURRENCES) continue
    const denominator = shape.tool === '*' ? undefined : callsByTool.get(shape.tool)
    const scope = denominator ? ` of ${denominator} ${shape.tool} calls` : ' occurrences'
    const moves = shape.benchTasks.length > 0 ? ` (moves: ${shape.benchTasks.join(', ')})` : ''
    signals.push({
      id: shape.id,
      count,
      benchTasks: shape.benchTasks,
      line: clipLine(`- ${shape.label} — ${count}${scope}${moves}`),
    })
  }

  // Most frequent first; a tie goes to the one touching more benchmark tasks,
  // because that is the one a promotable hypothesis is easiest to build from.
  const byWeight = (a: FieldSignal, b: FieldSignal) => b.count - a.count || b.benchTasks.length - a.benchTasks.length
  const actionable = signals.filter((signal) => signal.benchTasks.length > 0).sort(byWeight).slice(0, MAX_ACTIONABLE)
  const unmeasurable = signals.filter((signal) => signal.benchTasks.length === 0).sort(byWeight).slice(0, MAX_UNMEASURABLE)

  let turns: FieldEvidence['turns']
  try {
    const report = options.outcomesPath ? competenceReport(options.outcomesPath) : competenceReport()
    if (report.changingTurns > 0) {
      turns = {
        changing: report.changingTurns,
        clean: report.cleanTurns,
        cleanRate: report.cleanRate,
        editRetryRate: report.editRetryRate,
      }
    }
  } catch {
    notes.push('turn outcomes could not be read')
  }

  return { actionable, unmeasurable, unclassified, totalCalls: rows.length, totalErrors: errors.length, notes, turns }
}

const HEADER = [
  '## What actually goes wrong in real use',
  'Field evidence from elia\'s own logs for the project this ran in — elia doing real work, not the benchmark. Counts only: no text from any log is reproduced here. A line tagged "moves:" names benchmark tasks a fix would plausibly change.',
]

/**
 * Renders within `MAX_SECTION_CHARS`, dropping whole lines in a fixed order.
 *
 * The two header lines are never dropped. They are what stops the proposer
 * reading field evidence as benchmark evidence, and losing them is worse than
 * losing any of the data underneath.
 */
export function renderFieldEvidence(evidence: FieldEvidence): string {
  if (evidence.actionable.length === 0 && evidence.unmeasurable.length === 0) return ''

  const turnLine = evidence.turns
    ? `Turns on this project: ${evidence.turns.clean} of ${evidence.turns.changing} code-changing turns landed clean (${Math.round(evidence.turns.cleanRate * 100)}%), edit retry rate ${Math.round(evidence.turns.editRetryRate * 100)}%.`
    : undefined

  const suppressed = evidence.unmeasurable.length > 0
    ? [
        '',
        'Not represented in the benchmark — do NOT propose a fix for these. compareScorecards cannot score one, so it will be rejected however good it is:',
        ...evidence.unmeasurable.map((signal) => signal.line),
      ]
    : []

  const unclassifiedLine = evidence.unclassified > 0
    ? `${evidence.unclassified} further errors matched no known shape and are not shown. Adding a shape needs a human commit (src/evolve/fieldEvidence.ts is immutable to this loop).`
    : undefined

  // Rendered in this order, and dropped from the end — so the order a reader
  // meets them is the reverse of the order they are worth losing. Suppressed
  // shapes outrank the turn line because they stop a whole generation being
  // spent on an unpromotable proposal; the unclassified count is a pointer for
  // whoever adds the next shape, and goes first.
  const layers: (string[] | undefined)[] = [
    suppressed.length > 0 ? suppressed : undefined,
    turnLine ? ['', turnLine] : undefined,
    unclassifiedLine ? ['', unclassifiedLine] : undefined,
  ]

  const assemble = (keep: number, actionable: FieldSignal[]): string => {
    const lines = [...HEADER]
    if (actionable.length > 0) {
      lines.push('', `Recurring failure shapes in the last ${evidence.totalCalls} audited tool calls (${evidence.totalErrors} errored):`)
      lines.push(...actionable.map((signal) => signal.line))
    }
    for (const layer of layers.slice(0, keep)) {
      if (layer) lines.push(...layer)
    }
    return lines.join('\n')
  }

  for (let keep = layers.length; keep >= 0; keep -= 1) {
    const rendered = assemble(keep, evidence.actionable)
    if (rendered.length <= MAX_SECTION_CHARS) return `\n\n${rendered}`
  }
  // Still over: shed actionable lines from the bottom, always keeping one.
  for (let count = evidence.actionable.length - 1; count >= 1; count -= 1) {
    const rendered = assemble(0, evidence.actionable.slice(0, count))
    if (rendered.length <= MAX_SECTION_CHARS) return `\n\n${rendered}`
  }
  return `\n\n${[...HEADER, '(field evidence truncated)'].join('\n')}`
}

/**
 * The one entry point the brief calls. Can only ever return a string: a broken
 * ledger costs the proposer a section, never the generation.
 */
export function fieldEvidenceSection(options: FieldEvidenceOptions = {}): string {
  try {
    return renderFieldEvidence(collectFieldEvidence(options))
  } catch {
    return ''
  }
}

/** Every task id the shape table points at, for the integrity test. */
export function referencedTaskIds(): string[] {
  return [...new Set(FAILURE_SHAPES.flatMap((shape) => shape.benchTasks))]
}

/** The real benchmark ids, so the test does not have to import the suite itself. */
export function benchTaskIds(): string[] {
  return BENCH_TASKS.map((task) => task.id)
}

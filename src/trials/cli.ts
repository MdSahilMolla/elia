import { flagValue, hasFlag, positionals, strictInteger } from '../cli/argv.ts'
import { writeError, writeUsageLine } from '../ui/stream.ts'
import { analyze, renderReport } from './analyze.ts'
import type { Arms } from './analyze.ts'
import { DEFAULT_HORIZON_DAYS, basketDefinition, basketDigest } from './basket.ts'
import { gitIn, loadHistory } from './git.ts'
import { measureOutcomes } from './outcomes.ts'

/** Commits a coding agent signed: Elia's own `Co-Authored-By`, or another agent's. */
export const DEFAULT_ARM = '^Co-Authored-By:.*\\b(Claude|Elia)\\b'

const USAGE = `Usage: elia trials <command>

  analyze [--ref REF] [--horizon DAYS] [--arm REGEX] [--repo PATH] [--jobs N] [--json]
                          What happened to each commit after it landed, whether that signal is
                          usable, and how many commits a randomized trial would need (default)
  basket [--horizon DAYS] The outcome basket and its digest: the outcomes, fixed before any analysis

  --arm     A regex matched against each commit message; matches are the agent arm.
            Default: ${DEFAULT_ARM}
  --ref     The mainline to judge (default: HEAD). Horizon default: ${DEFAULT_HORIZON_DAYS} days.

Read-only: nothing here changes the repository or calls a model.`

export async function runTrials(): Promise<void> {
  const command = positionals(['--ref', '--horizon', '--arm', '--repo', '--jobs'])[0] ?? 'analyze'
  if (command === 'help') {
    writeUsageLine(USAGE)
    return
  }
  try {
    const horizon = flagValue('--horizon') === undefined ? DEFAULT_HORIZON_DAYS : strictInteger(flagValue('--horizon'))
    if (horizon === undefined || horizon < 1) throw new Error('--horizon must be a whole number of days, at least 1')
    if (command === 'basket') {
      writeUsageLine(`${JSON.stringify(basketDefinition(horizon), null, 2)}\n\ndigest ${basketDigest(basketDefinition(horizon))}`)
      return
    }
    if (command !== 'analyze') throw new Error(`unknown command "${command}" — try: elia trials help`)
    const jobs = flagValue('--jobs') === undefined ? 8 : strictInteger(flagValue('--jobs'))
    if (jobs === undefined || jobs < 1) throw new Error('--jobs must be a whole number, at least 1')
    await analyzeRepository({ repo: flagValue('--repo') || process.cwd(), ref: flagValue('--ref') || 'HEAD', horizon, arm: flagValue('--arm') || DEFAULT_ARM, jobs, json: hasFlag('--json') })
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

export interface AnalyzeRequest {
  repo: string
  ref: string
  horizon: number
  arm: string
  jobs: number
  json: boolean
}

async function analyzeRepository(request: AnalyzeRequest): Promise<void> {
  let pattern: RegExp
  try {
    pattern = new RegExp(request.arm, 'im')
  } catch {
    throw new Error(`--arm is not a valid regular expression: ${request.arm}`)
  }
  const git = gitIn(request.repo)
  const history = await loadHistory(git, request.ref).catch((error: unknown) => {
    throw new Error(`could not read ${request.ref} in ${request.repo}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  })
  const progress = process.stderr.isTTY && !request.json
  const measured = await measureOutcomes(git, history, {
    horizonDays: request.horizon,
    jobs: request.jobs,
    onProgress: (phase, done, total) => {
      if (progress && (done === total || done % 25 === 0)) process.stderr.write(`\r  measuring ${phase} ${done}/${total}   `)
    },
  })
  if (progress) process.stderr.write('\r\x1b[K')

  const arms: Arms = new Map([...history.commits.values()].map((commit) => [commit.sha, pattern.test(commit.body)]))
  const nonMerge = [...history.commits.values()].filter((commit) => commit.parents.length < 2)
  const report = analyze(measured, arms, request.horizon, nonMerge.length)
  if (request.json) {
    process.stdout.write(`${JSON.stringify({ ref: request.ref, arm: request.arm, ...report }, null, 2)}\n`)
    return
  }
  const signed = nonMerge.filter((commit) => /^Elia-Run:/m.test(commit.body)).length
  writeUsageLine(renderReport(report, request.arm))
  writeUsageLine(
    signed === 0
      ? `\nNote: 0 commits carry an Elia-Run trailer, so elia's own work cannot be told apart in this history yet. Only the github tool, the scaffold and the autopilot sign commits; one made any other way is not marked.`
      : `\nNote: ${signed} commits carry an Elia-Run trailer; pass --arm '^Elia-Run:' to compare elia's own work alone.`,
  )
}

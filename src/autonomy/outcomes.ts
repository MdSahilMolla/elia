import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { appendSecureFile, hardenSecureFile } from '../securePersistence.ts'
import { paths } from '../config.ts'

/**
 * A per-turn track record: what elia attempted on this repo, and whether it
 * landed clean. Aggregated, it becomes an honest per-domain competence map —
 * "44 of 47 changes landed, edit success 91%, weakest at CSS and async" — shown
 * to the user and (later) used to route: escalate the model, ask for review,
 * spawn a specialist where elia is historically weak.
 *
 * No other agent keeps this. It is the difference between "trust me" and "here
 * is my record on your codebase".
 */

const OUTCOMES_PATH = join(paths.state, 'outcomes.jsonl')

export type Domain = 'frontend' | 'backend' | 'tests' | 'config' | 'docs' | 'code'
export type VerifyResult = 'pass' | 'fail' | 'skipped' | 'none'

export interface TurnOutcome {
  at: number
  /** Short redacted prompt, for context when reading the log. */
  prompt: string
  filesChanged: number
  domains: Domain[]
  editRetries: number
  toolErrors: number
  verify: VerifyResult
  repairAttempts: number
  aborted: boolean
}

export function classifyDomain(path: string): Domain {
  const p = path.replace(/\\/g, '/').toLowerCase()
  const base = basename(p)
  if (/(?:^|\/)(?:__tests__|tests?)\//.test(p) || /\.(test|spec)\.[a-z]+$/.test(base)) return 'tests'
  if (/\.(md|mdx|rst|txt)$/.test(base)) return 'docs'
  if (/\.(json|ya?ml|toml|ini|env|lock)$/.test(base) || /\.config\.[a-z]+$/.test(base) || base.startsWith('.')) return 'config'
  if (/\.(tsx|jsx|css|scss|sass|less|html|svelte|vue)$/.test(base) || /(?:^|\/)(?:components?|ui|pages|views|styles)\//.test(p)) return 'frontend'
  if (/\.(sql|prisma)$/.test(base) || /(?:^|\/)(?:routes?|api|server|controllers?|handlers?|migrations?|db|models?)\//.test(p)) return 'backend'
  return 'code'
}

export function domainsOf(pathsChanged: string[]): Domain[] {
  return [...new Set(pathsChanged.map(classifyDomain))]
}

export function recordOutcome(outcome: Omit<TurnOutcome, 'at'>, path = OUTCOMES_PATH): void {
  try {
    appendSecureFile(path, `${JSON.stringify({ at: Date.now(), ...outcome })}\n`)
  } catch {
    // A lost outcome line costs a data point, not correctness.
  }
}

/** Competence should reflect *recent* performance — as elia improves, old rough turns shouldn't hold its record down forever. */
const RECENT_WINDOW = 200

export function loadOutcomes(path = OUTCOMES_PATH): TurnOutcome[] {
  if (!existsSync(path)) return []
  hardenSecureFile(path)
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-RECENT_WINDOW)
      .map((line) => {
        try {
          return JSON.parse(line) as TurnOutcome
        } catch {
          return undefined
        }
      })
      .filter((o): o is TurnOutcome => Boolean(o && typeof o.at === 'number'))
  } catch {
    return []
  }
}

export interface CompetenceReport {
  turns: number
  changingTurns: number
  cleanTurns: number
  cleanRate: number
  editRetryRate: number
  byDomain: { domain: Domain; turns: number; cleanRate: number }[]
  weakest: Domain[]
}

/** Aggregates the outcomes log into an honest competence picture. Considers only turns that changed code. */
export function competenceReport(path = OUTCOMES_PATH): CompetenceReport {
  const outcomes = loadOutcomes(path)
  const changing = outcomes.filter((o) => o.filesChanged > 0 && !o.aborted)
  const clean = (o: TurnOutcome) => o.toolErrors === 0 && o.editRetries === 0 && (o.verify === 'pass' || o.verify === 'none' || o.verify === 'skipped')

  const cleanTurns = changing.filter(clean).length
  const totalEdits = changing.reduce((n, o) => n + o.editRetries + o.filesChanged, 0)
  const totalRetries = changing.reduce((n, o) => n + o.editRetries, 0)

  const domains: Domain[] = ['frontend', 'backend', 'tests', 'config', 'docs', 'code']
  const byDomain = domains
    .map((domain) => {
      const inDomain = changing.filter((o) => o.domains.includes(domain))
      return { domain, turns: inDomain.length, cleanRate: inDomain.length ? inDomain.filter(clean).length / inDomain.length : 1 }
    })
    .filter((d) => d.turns >= 2)

  const weakest = [...byDomain].sort((a, b) => a.cleanRate - b.cleanRate).filter((d) => d.cleanRate < 0.75).slice(0, 2).map((d) => d.domain)

  return {
    turns: outcomes.length,
    changingTurns: changing.length,
    cleanTurns,
    cleanRate: changing.length ? cleanTurns / changing.length : 1,
    editRetryRate: totalEdits ? totalRetries / totalEdits : 0,
    byDomain,
    weakest,
  }
}

export function renderCompetence(path = OUTCOMES_PATH): string {
  const r = competenceReport(path)
  if (r.changingTurns === 0) return 'No code-changing turns recorded on this project yet.'
  const pct = (n: number) => `${Math.round(n * 100)}%`
  const lines = [
    `Track record on this project — ${r.changingTurns} code-changing turn${r.changingTurns === 1 ? '' : 's'}:`,
    `  landed clean:      ${r.cleanTurns}/${r.changingTurns}  (${pct(r.cleanRate)})`,
    `  edit retry rate:   ${pct(r.editRetryRate)}`,
  ]
  if (r.byDomain.length > 0) {
    lines.push('  by area:')
    for (const d of r.byDomain.sort((a, b) => b.turns - a.turns)) {
      lines.push(`    ${d.domain.padEnd(9)} ${pct(d.cleanRate).padStart(4)} clean   (${d.turns} turn${d.turns === 1 ? '' : 's'})`)
    }
  }
  if (r.weakest.length > 0) lines.push(`  weakest: ${r.weakest.join(', ')} — worth an extra review or a stronger model here`)
  return lines.join('\n')
}

const DOMAIN_KEYWORDS: Record<Domain, RegExp> = {
  frontend: /\b(css|scss|style|styling|layout|component|button|form|ui|ux|responsive|tailwind|react|vue|svelte|animation|dark mode|landing page|page|screen)\b/i,
  backend: /\b(api|endpoint|route|handler|controller|middleware|database|db|sql|migration|query|schema|auth|session|jwt|server|webhook|queue|cron)\b/i,
  tests: /\b(test|spec|coverage|mock|fixture|assertion|jest|vitest|pytest)\b/i,
  config: /\b(config|tsconfig|eslint|prettier|package\.json|env|dotenv|ci|workflow|dockerfile|build setup)\b/i,
  docs: /\b(readme|docs|documentation|changelog|comment)\b/i,
  code: /$^/,
}

/** Best guess at which domains a turn is about, from the prompt text and any file paths it names. */
export function domainsInPlay(prompt: string, filePaths: string[] = []): Domain[] {
  const fromPaths = new Set(filePaths.map(classifyDomain))
  for (const [domain, re] of Object.entries(DOMAIN_KEYWORDS) as [Domain, RegExp][]) {
    if (domain !== 'code' && re.test(prompt)) fromPaths.add(domain)
  }
  return [...fromPaths]
}

/**
 * A system-prompt caution when the turn is about a domain past turns on this
 * project handled badly — elia telling itself where it has a track record of
 * getting things wrong, so it slows down there specifically.
 */
export function weakDomainCaution(prompt: string, filePaths: string[] = [], path = OUTCOMES_PATH): string {
  const report = competenceReport(path)
  if (report.weakest.length === 0) return ''
  const inPlay = new Set(domainsInPlay(prompt, filePaths))
  const relevant = report.weakest.filter((d) => inPlay.has(d))
  if (relevant.length === 0) return ''
  const rates = report.byDomain.filter((d) => relevant.includes(d.domain)).map((d) => `${d.domain} ${Math.round(d.cleanRate * 100)}% clean`)
  return `\n\n## Proceed carefully — weak area\nPast turns on this project landed ${rates.join(', ')} in the area this task touches. Read the surrounding code fully before editing, make the smallest change that works, verify it concretely (run it / run the tests / look at it in the browser), and dispatch a critic and a bughunter against your diff before you report done.`
}

/** True when a change touched a domain elia has a poor track record in — triggers a mandatory self-review. */
export function touchedWeakDomain(changedPaths: string[], path = OUTCOMES_PATH): Domain[] {
  const weak = new Set(competenceReport(path).weakest)
  return [...new Set(changedPaths.map(classifyDomain))].filter((d) => weak.has(d))
}

/** A one-line nudge for the *next* turn when the last one was rough, so elia self-corrects instead of repeating the mistake. */
export function regretNudge(path = OUTCOMES_PATH): string {
  const last = loadOutcomes(path).at(-1)
  if (!last) return ''
  const rough: string[] = []
  if (last.editRetries >= 2) rough.push(`${last.editRetries} edits missed their target`)
  if (last.toolErrors >= 3) rough.push(`${last.toolErrors} tool errors`)
  if (last.verify === 'fail') rough.push('verification did not pass')
  if (last.repairAttempts > 0) rough.push(`${last.repairAttempts} repair pass${last.repairAttempts === 1 ? '' : 'es'} were needed`)
  if (rough.length === 0) return ''
  return `\n\nNote: the previous turn hit friction (${rough.join('; ')}). Read more carefully before editing this time, and if there is a durable project-specific reason it went wrong, call note_lesson.`
}

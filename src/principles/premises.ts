import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

/**
 * A plan's premises, checked against the workspace before any work is built on
 * them — the runtime form of the `assumptions-are-debts` principle (axioms.ts).
 *
 * The autonomous pipeline already makes its planner list assumptions and sends
 * a model to check them (autonomy/assumptions.ts). A session turn had nothing:
 * the plan drafted before the turn (autonomy/upfrontPlan.ts) is written by a
 * tool-less call that has seen none of the files it plans around, and every
 * step it wrote was taken on faith. Now that plan states what it takes as given
 * — a file, a script, a dependency, a program — and this decides the ones a
 * file system can decide, in microseconds and without a model.
 *
 * The same discipline as reason/grounding.ts: it can show a premise false, and
 * it can confirm the part of a premise it could check, but it never promotes a
 * sentence it could not check into a fact. A premise about something the plan
 * itself will create is not a premise, and is left alone.
 */

export type PremiseVerdict = 'holds' | 'false' | 'unverifiable'

export interface PremiseCheck {
  premise: string
  verdict: PremiseVerdict
  /** What settled it, or why nothing could. */
  evidence: string
}

export interface PremiseOptions {
  /** Where a program is on PATH, or null. Injected so tests do not depend on the machine. */
  which?: (program: string) => string | null
}

/** Talks about work the plan will do, not about the world it starts from. */
const CREATION = /\b(?:will\s+(?:be\s+)?(?:create|created|add|added|write|written|generate|generated|scaffold|scaffolded)|to\s+be\s+(?:created|added|written)|new\s+file|does\s+not\s+(?:yet\s+)?exist|doesn't\s+(?:yet\s+)?exist|(?:is|are)\s+missing)\b/i
const SCRIPT = /\b(?:bun|npm|pnpm|yarn)\s+run\s+([\w:.-]+)/g
const EXTENSIONS = 'ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|md|mdx|py|go|rs|java|kt|rb|php|c|h|cc|cpp|hpp|cs|swift|sh|yml|yaml|toml|ini|css|scss|html|vue|svelte|sql|graphql|proto|lock|env|txt|xml|gradle'
/**
 * A path is a claim only when it is unmistakably one: backticked, or ending in a
 * file extension. "and/or", "100/min" and "TCP/IP" have slashes too, and a
 * premise falsified by one of them would send the work after nothing.
 */
const FILE_WITH_EXTENSION = new RegExp(`(?<![\\w/.@:~-])((?:\\.{1,2}/)?[\\w@-][\\w@.-]*(?:/[\\w@.-]+)*\\.(?:${EXTENSIONS}))(?![\\w/])`, 'g')
const BACKTICKED_PATH = /`((?:\.{1,2}\/)?[\w@-][\w@.-]*(?:\/[\w@.-]+)*\/?)`/g
const HAS_EXTENSION = new RegExp(`\\.(?:${EXTENSIONS})$`)
const PACKAGE_WORDS = /\b(?:dependency|dependencies|package|packages|library|libraries|depends\s+on|installed|devDependenc)/i
const PROGRAM_WORDS = /\b(?:cli|command|binary|executable|on\s+(?:the\s+)?path|is\s+installed|are\s+installed|available)\b/i
const BACKTICKED = /`([@\w][\w@./-]*)`/g

interface Manifest {
  scripts: Set<string>
  dependencies: Set<string>
}

function readManifest(cwd: string): Manifest | undefined {
  const path = join(cwd, 'package.json')
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown> | undefined>
    const names = (key: string) => Object.keys(parsed[key] ?? {})
    return {
      scripts: new Set(names('scripts')),
      dependencies: new Set([...names('dependencies'), ...names('devDependencies'), ...names('peerDependencies'), ...names('optionalDependencies')]),
    }
  } catch {
    return undefined
  }
}

function defaultWhich(program: string): string | null {
  try {
    return Bun.which(program)
  } catch {
    return null
  }
}

/** One premise's checkable claims, each settled or not. */
function checkOne(premise: string, cwd: string, manifest: Manifest | undefined, which: (program: string) => string | null): PremiseCheck {
  if (CREATION.test(premise)) return { premise, verdict: 'unverifiable', evidence: 'it is about something the plan will create, not what exists now' }
  const held: string[] = []
  const wrong: string[] = []
  const claimed = new Set<string>()

  for (const match of premise.matchAll(SCRIPT)) {
    const script = match[1]!
    claimed.add(script)
    if (!manifest) wrong.push(`there is no package.json here, so no script "${script}"`)
    else if (manifest.scripts.has(script)) held.push(`package.json defines "${script}"`)
    else wrong.push(`package.json has no script "${script}"${manifest.scripts.size > 0 ? ` (it has: ${[...manifest.scripts].slice(0, 8).join(', ')})` : ''}`)
  }

  const text = premise.replace(/https?:\/\/\S+/g, '')
  const paths = [
    ...[...text.matchAll(BACKTICKED_PATH)].map((match) => match[1]!).filter((raw) => raw.includes('/') || HAS_EXTENSION.test(raw)),
    ...[...text.matchAll(FILE_WITH_EXTENSION)].map((match) => match[1]!),
  ]
  for (const raw of paths) {
    if (raw.includes('*') || claimed.has(raw)) continue
    const absolute = resolve(cwd, raw)
    const inside = relative(cwd, absolute)
    if (inside.startsWith('..') || isAbsolute(inside)) continue
    claimed.add(raw)
    if (existsSync(absolute)) held.push(`${raw} exists`)
    // A bare file name could live in any directory; only a path is a claim about one place.
    else if (raw.includes('/')) wrong.push(`${raw} does not exist`)
  }

  for (const match of premise.matchAll(BACKTICKED)) {
    const name = match[1]!
    if (claimed.has(name) || (name.includes('/') && !name.startsWith('@'))) continue
    if (manifest?.dependencies.has(name)) {
      held.push(`${name} is a dependency in package.json`)
      claimed.add(name)
      continue
    }
    if (PACKAGE_WORDS.test(premise) && manifest && !PROGRAM_WORDS.test(premise)) {
      wrong.push(`${name} is not a dependency in package.json`)
      claimed.add(name)
      continue
    }
    if (PROGRAM_WORDS.test(premise) && /^[\w.-]+$/.test(name)) {
      claimed.add(name)
      if (which(name)) held.push(`${name} is on PATH`)
      else wrong.push(`${name} is not on PATH${manifest ? ' and not a dependency in package.json' : ''}`)
    }
  }

  if (wrong.length > 0) return { premise, verdict: 'false', evidence: wrong.join('; ') }
  if (held.length > 0) return { premise, verdict: 'holds', evidence: held.join('; ') }
  return { premise, verdict: 'unverifiable', evidence: 'nothing in it names a file, script, dependency or program to check' }
}

export function checkPremises(premises: readonly string[], cwd: string, options: PremiseOptions = {}): PremiseCheck[] {
  const manifest = readManifest(cwd)
  const which = options.which ?? defaultWhich
  return premises.map((premise) => premise.trim()).filter(Boolean).map((premise) => checkOne(premise, cwd, manifest, which))
}

/**
 * What the working model is told. The false premises in full, because the plan
 * has to change around them; the unchecked ones as a list to confirm first.
 * Undefined when every premise held — nothing to say.
 */
export function premiseBriefing(checks: readonly PremiseCheck[]): string | undefined {
  const wrong = checks.filter((check) => check.verdict === 'false')
  const open = checks.filter((check) => check.verdict === 'unverifiable')
  if (wrong.length === 0 && open.length === 0) return undefined
  const lines = ['<elia-premises>']
  if (wrong.length > 0) {
    lines.push('elia checked the plan\'s premises against this workspace. These are FALSE — do not build on them; change the affected steps (todo_write) before starting them:')
    for (const check of wrong) lines.push(`- ${check.premise}\n  → ${check.evidence}`)
  }
  if (open.length > 0) {
    lines.push(wrong.length > 0 ? 'These could not be checked mechanically — confirm each before a step depends on it:' : 'The plan rests on these unchecked premises — confirm each before a step depends on it:')
    for (const check of open) lines.push(`- ${check.premise}`)
  }
  lines.push('</elia-premises>')
  return lines.join('\n')
}

/** One line for the person: how many premises held, and which were false. */
export function describePremises(checks: readonly PremiseCheck[]): string | undefined {
  if (checks.length === 0) return undefined
  const wrong = checks.filter((check) => check.verdict === 'false')
  const held = checks.filter((check) => check.verdict === 'holds').length
  if (wrong.length === 0) return `Premises: ${held} of ${checks.length} checked against the workspace and hold${held < checks.length ? `; ${checks.length - held} to confirm while working` : ''}`
  return `The plan assumed ${wrong.length === 1 ? 'something that is false' : `${wrong.length} things that are false`} — ${wrong.map((check) => check.evidence).join('; ')}`
}

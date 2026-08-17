import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { USAGE_STATS_PATH } from './paths.ts'

/**
 * Watches what elia does over and over, so it can notice when it should have a
 * tool for something.
 *
 * Every agent has a fixed tool set decided by whoever wrote it. But the actual
 * work is project-shaped: in one repo elia types `git diff --cached | head -50`
 * forty times a week, in another it walks the same three files to answer the same
 * question. Each of those is a tool that doesn't exist yet, and the evidence that
 * it should is sitting in the tool-call stream.
 *
 * This module is the cheap half — pure counting, no model involved. It records
 * two kinds of repetition:
 *
 *   - command shapes: the first two words of a shell command, so
 *     `git diff --stat HEAD~1` and `git diff --stat HEAD~3` count as the same habit.
 *   - tool sequences: sliding trigrams of tool names, which catch multi-step
 *     routines like grep → read_file → edit_file that could collapse into one call.
 */

const SEQUENCE_LENGTH = 3
const MAX_EXAMPLES = 5
/** Below this, a repetition is coincidence rather than a habit worth encoding. */
export const DEFAULT_CANDIDATE_THRESHOLD = 6
/** Flush every N observations — often enough to survive a crash, rarely enough not to thrash the disk. */
const FLUSH_INTERVAL = 20

export interface UsageStats {
  /** Tool-name trigram → times seen. */
  sequences: Record<string, number>
  /** Shell command shape → count and real examples. */
  commands: Record<string, { count: number; examples: string[] }>
  /** Shapes already turned into a skill, or explicitly declined, so they stop being suggested. */
  resolved: string[]
}

export interface SkillCandidate {
  kind: 'command' | 'sequence'
  pattern: string
  count: number
  examples: string[]
}

const EMPTY_STATS: UsageStats = { sequences: {}, commands: {}, resolved: [] }

let stats: UsageStats | undefined
let recent: string[] = []
let sinceFlush = 0

function load(): UsageStats {
  if (stats) return stats
  stats = readStats()
  return stats
}

export function readStats(path = USAGE_STATS_PATH): UsageStats {
  if (!existsSync(path)) return structuredClone(EMPTY_STATS)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<UsageStats>
    return {
      sequences: parsed.sequences ?? {},
      commands: parsed.commands ?? {},
      resolved: parsed.resolved ?? [],
    }
  } catch {
    return structuredClone(EMPTY_STATS)
  }
}

function flush(path = USAGE_STATS_PATH): void {
  if (!stats) return
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(stats, null, 2))
  } catch {
    // Habit tracking is an optimisation; it must never interrupt real work.
  }
  sinceFlush = 0
}

/** Records one tool call. Called from the agent loop's tool hook, so it must stay cheap and never throw. */
export function observeToolCall(name: string, input: Record<string, unknown>): void {
  const current = load()

  recent.push(name)
  if (recent.length > SEQUENCE_LENGTH) recent = recent.slice(-SEQUENCE_LENGTH)
  if (recent.length === SEQUENCE_LENGTH) {
    // A run of the same tool (three reads in a row) is just batching, not a routine.
    const distinct = new Set(recent).size
    if (distinct > 1) {
      const key = recent.join(' → ')
      current.sequences[key] = (current.sequences[key] ?? 0) + 1
    }
  }

  if (name === 'run_command' && typeof input.command === 'string') {
    const shape = commandShape(input.command)
    if (shape) {
      const entry = current.commands[shape] ?? { count: 0, examples: [] }
      entry.count += 1
      if (!entry.examples.includes(input.command) && entry.examples.length < MAX_EXAMPLES) {
        entry.examples.push(input.command)
      }
      current.commands[shape] = entry
    }
  }

  sinceFlush += 1
  if (sinceFlush >= FLUSH_INTERVAL) flush()
}

/**
 * Reduces a command to its habit: the program plus its first subcommand, with
 * flags and arguments dropped. `git log --oneline -20` and `git log -5` are the
 * same habit; `git log` and `git push` are not.
 */
export function commandShape(command: string): string | undefined {
  const tokens = command
    .trim()
    .split(/\s+/)
    // Empty tokens have to go before the flag filter: splitting an all-whitespace
    // command yields [''], which would otherwise shape to an empty-named habit.
    .filter((token) => token.length > 0 && !token.startsWith('-'))
  if (tokens.length === 0) return undefined

  const program = tokens[0]!.replace(/\.(exe|cmd|sh)$/i, '')
  // A bare program with no subcommand is too broad to be a useful skill.
  const subcommand = tokens[1] && /^[\w:.-]+$/.test(tokens[1]) ? tokens[1] : undefined
  return subcommand ? `${program} ${subcommand}` : program
}

/** The habits that have crossed the threshold and don't already have a skill. */
export function skillCandidates(
  threshold = DEFAULT_CANDIDATE_THRESHOLD,
  source: UsageStats = load(),
): SkillCandidate[] {
  const resolved = new Set(source.resolved)

  const commands: SkillCandidate[] = Object.entries(source.commands)
    .filter(([shape, entry]) => entry.count >= threshold && !resolved.has(shape))
    .map(([shape, entry]) => ({
      kind: 'command' as const,
      pattern: shape,
      count: entry.count,
      examples: entry.examples,
    }))

  const sequences: SkillCandidate[] = Object.entries(source.sequences)
    .filter(([pattern, count]) => count >= threshold && !resolved.has(pattern))
    .map(([pattern, count]) => ({ kind: 'sequence' as const, pattern, count, examples: [] }))

  return [...commands, ...sequences].sort((a, b) => b.count - a.count)
}

/** Marks a pattern as dealt with — a skill was written for it, or the user said no. */
export function markResolved(pattern: string): void {
  const current = load()
  if (!current.resolved.includes(pattern)) current.resolved.push(pattern)
  flush()
}

/** Persists immediately. Called on process exit so the tail of a session isn't lost. */
export function flushUsageStats(): void {
  if (sinceFlush > 0) flush()
}

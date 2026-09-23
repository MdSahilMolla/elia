import type { SkillCandidate } from './detector.ts'
import type { SynthesisResult } from './synthesize.ts'
import type { Artifact } from '../autonomy/certifiedLibrary.ts'

/**
 * Compression, §6.3: a frozen model learns by compressing.
 *
 * The context window is fixed, so a library that only grows eventually stops
 * helping — γ, the library elasticity, decays toward zero once retrieval can no
 * longer surface what matters. The fix is abstraction: replace a routine elia
 * performs as many calls with one tool, and the same capability costs a
 * fraction of the context. Tools are also where §7 says capability lives.
 *
 * elia already counted its habits (skills/detector.ts) and could already build
 * and gate a tool for one (skills/synthesize.ts). What it lacked was the step
 * between: deciding which habit is worth a tool, safely, without a person
 * typing `elia skills synth`. It had 105x, 53x and 49x repeats and had built
 * nothing.
 *
 * The queue ranks habits by the model round-trips a tool would save, and
 * refuses the ones that must never be automated: a bare interpreter or shell
 * (a tool whose whole job is to run arbitrary code outside the command
 * governor), anything destructive or outward-facing, and anything that already
 * failed recently — a dead end in the library is a reason not to walk into it
 * again.
 */

/** Programs whose "habit" is running arbitrary code; a tool for them would bypass the governor. */
const NEVER_ENCODE_PROGRAMS = new Set([
  'powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh', 'fish', 'node', 'bun', 'deno', 'python', 'python3', 'py', 'ruby', 'perl', 'php',
  'eval', 'exec', 'sudo', 'su', 'ssh', 'scp', 'curl', 'wget', 'rm', 'del', 'rmdir', 'mv', 'dd', 'format', 'shutdown', 'reboot',
  'npx', 'bunx', 'pnpx',
])

/** Subcommands that change the world outside the working tree, or cannot be undone. */
const NEVER_ENCODE_SUBCOMMANDS = /^(?:push|publish|deploy|release|reset|clean|rm|remove|delete|drop|destroy|uninstall|login|logout|merge|rebase|force)$/i

/** Subcommands that run whatever script or package they are handed: `npm run`, `uv run`, `pnpm dlx`. */
const RUNS_ANYTHING_SUBCOMMANDS = /^(?:run|run-script|exec|x|dlx|eval|script)$/i

/** Subcommands that pull code from a registry. Which package to trust is the command governor's call, per use. */
const INSTALLS_SUBCOMMANDS = /^(?:install|i|ci|add|update|upgrade|up|get|sync)$/i

/** The model's own workspace primitives, and the ones among them that change a file. */
const WORKSPACE_PRIMITIVES = new Set(['read_file', 'edit_file', 'write_file', 'delete_file', 'list_files', 'grep', 'find_symbol', 'todo_write'])
const WRITING_PRIMITIVES = new Set(['edit_file', 'write_file', 'delete_file'])

/** Why a habit must not become a tool automatically, or `undefined` when it may. */
export function encodingRefusal(candidate: Pick<SkillCandidate, 'kind' | 'pattern'>): string | undefined {
  if (candidate.kind === 'sequence') {
    // A routine with a shell step in it is a routine of "run whatever" — the
    // tool would carry the command governor's whole job inside itself.
    if (/\brun_command\b/.test(candidate.pattern)) return `\`${candidate.pattern}\` includes arbitrary shell; a tool for it would sidestep the command governor`
    // Read, then edit, then edit is what editing looks like, not a procedure:
    // what each edit writes is the model's decision about what it just read, so
    // a tool would take those decisions as input and save no round-trip. A
    // read-only routine is different — one lookup can return all of it.
    const steps = candidate.pattern.split('→').map((step) => step.trim())
    if (steps.every((step) => WORKSPACE_PRIMITIVES.has(step)) && steps.some((step) => WRITING_PRIMITIVES.has(step))) {
      return `\`${candidate.pattern}\` is ordinary editing — each write depends on what was just read, so a tool would save no round-trips`
    }
    return undefined
  }
  const [program = '', subcommand] = candidate.pattern.toLowerCase().split(/\s+/)
  if (!subcommand) return `a bare \`${program}\` is too general to encode — the tool would just run whatever it was given`
  if (NEVER_ENCODE_PROGRAMS.has(program)) return `\`${program}\` runs arbitrary code; a tool for it would sidestep the command governor`
  if (NEVER_ENCODE_SUBCOMMANDS.test(subcommand)) return `\`${candidate.pattern}\` changes things outside the tree or cannot be undone; that stays a person's decision`
  if (RUNS_ANYTHING_SUBCOMMANDS.test(subcommand)) return `\`${candidate.pattern}\` runs whatever script it is handed; a tool for it would sidestep the command governor`
  if (INSTALLS_SUBCOMMANDS.test(subcommand)) return `\`${candidate.pattern}\` pulls packages from a registry; which package to trust stays the command governor's call`
  return undefined
}

/** Model round-trips one use of the tool would save: a k-step routine becomes one call. */
export function roundTripsSaved(candidate: Pick<SkillCandidate, 'kind' | 'pattern'>): number {
  if (candidate.kind === 'sequence') return Math.max(1, candidate.pattern.split('→').length - 1)
  return 1
}

/** A failure record for this pattern newer than this is a reason to wait. */
export const DEAD_END_COOLDOWN_MS = 7 * 24 * 60 * 60_000

export interface QueuedCandidate {
  candidate: SkillCandidate
  /** Round-trips saved per use × uses seen: the expected context saving. */
  value: number
}

export interface CompressionQueue {
  queued: QueuedCandidate[]
  refused: Array<{ pattern: string; reason: string }>
}

export function compressionQueue(candidates: readonly SkillCandidate[], library: ReadonlyMap<string, Artifact>, now = Date.now()): CompressionQueue {
  const recentFailures = new Set(
    [...library.values()]
      .filter((artifact) => artifact.kind === 'failure' && artifact.id.startsWith('failure:skill:') && now - artifact.createdAt < DEAD_END_COOLDOWN_MS)
      .map((artifact) => artifact.id.slice('failure:skill:'.length).replace(/:[^:]+$/, '')),
  )
  const queued: QueuedCandidate[] = []
  const refused: CompressionQueue['refused'] = []
  for (const candidate of candidates) {
    const refusal = encodingRefusal(candidate)
    if (refusal) {
      refused.push({ pattern: candidate.pattern, reason: refusal })
      continue
    }
    if (recentFailures.has(candidate.pattern)) {
      refused.push({ pattern: candidate.pattern, reason: 'a build for it failed within the last week — a recorded dead end' })
      continue
    }
    queued.push({ candidate, value: candidate.count * roundTripsSaved(candidate) })
  }
  queued.sort((a, b) => b.value - a.value)
  return { queued, refused }
}

export interface CompressResult {
  attempted?: string
  result?: SynthesisResult
  skipped?: string
}

/** Builds a tool for the most valuable safe habit. `synthesize` is injected: it is the part that spends. */
export async function compressOnce(queue: CompressionQueue, synthesize: (candidate: SkillCandidate) => Promise<SynthesisResult>): Promise<CompressResult> {
  const top = queue.queued[0]
  if (!top) return { skipped: queue.refused.length > 0 ? `no habit is safe to encode automatically (${queue.refused.length} refused)` : 'no habit has repeated often enough yet' }
  const result = await synthesize(top.candidate)
  return { attempted: top.candidate.pattern, result }
}

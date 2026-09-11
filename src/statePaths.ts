import { realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where elia's own source lives, independent of the caller's working directory. */
export const ELIA_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * `process.cwd()` with the casing the filesystem actually uses.
 *
 * Windows preserves whatever casing the shell was started with, so launching
 * from `D:\ELIA` makes every derived absolute path read `D:\ELIA\...` while the
 * directory on disk is `D:\elia`. The paths still resolve — Windows is
 * case-insensitive — but they get compared as strings: the preview server's
 * containment check and several path-prefix guards do case-sensitive
 * `startsWith`, and the mismatch shows up in every message shown to the
 * operator. `realpathSync.native` returns the on-disk casing; the plain
 * fallback covers platforms without the native variant, and the catch covers a
 * cwd deleted out from under the process.
 */
export function canonicalCwd(): string {
  const cwd = process.cwd()
  try {
    return (realpathSync.native ?? realpathSync)(cwd)
  } catch {
    return cwd
  }
}

const projectRoot = canonicalCwd()

/** Per-project state directory (runs, evolution ledger, synthesized skills). */
export const stateDir = join(projectRoot, '.elia')

/** Visible home for real work product, distinct from internal `.elia/` state. */
const workspaceDir = join(projectRoot, 'workspace')

export const paths = {
  state: stateDir,
  sessions: join(stateDir, 'sessions'),
  // The cross-session "second brain": durable notes, the derived-knowledge
  // cache, and project-global relevance counters. Distinct from sessions/
  // (per-conversation) and lessons.md (before-you-start instructions).
  brain: join(stateDir, 'brain'),
  brainNotes: join(stateDir, 'brain', 'notes.jsonl'),
  brainRelevance: join(stateDir, 'brain', 'relevance.jsonl'),
  brainConsolidatedAt: join(stateDir, 'brain', 'consolidated-at'),
  rationale: join(stateDir, 'rationale.jsonl'),
  // A separate directory (not sessions/) so a live heartbeat file, which ends
  // in .json like everything else here, can never be mistaken by
  // session.ts's own directory scan for a real conversation file.
  sessionStatus: join(stateDir, 'session-status'),
  runs: join(stateDir, 'runs'),
  evolution: join(stateDir, 'evolution'),
  lessons: join(stateDir, 'lessons.md'),
  /** Per-turn/run `(context, action, outcome, reward)` rows — the dataset for eventual distillation. */
  trajectories: join(stateDir, 'trajectories'),
  /** Per-lesson exposure ledger: which lessons a run saw, and how that run went. */
  lessonsEfficacy: join(stateDir, 'lessons-efficacy.jsonl'),
  /** Newline-delimited prompt history for the interactive REPL, newest last. */
  promptHistory: join(stateDir, 'prompt-history'),
  workspace: workspaceDir,
  // Collaborative multi-user workspace: the SQLite event store, its per-objective
  // scratch (blackboards, worktree metadata), and the running-server pointer.
  workspaceDb: join(stateDir, 'workspace.sqlite'),
  workspaceState: join(stateDir, 'workspace'),
  workspaceServerInfo: join(stateDir, 'workspace', 'server.json'),
}

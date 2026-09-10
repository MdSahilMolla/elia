import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from '../statePaths.ts'
import { systemPromptForMode } from '../config.ts'
import { valueCoreSection } from '../values/core.ts'
import { appendSecureFile, hardenSecureFile, rotateSecureFile } from '../securePersistence.ts'
import { redactSecrets, redactText, relativizeProjectPaths } from '../ui/redact.ts'
import type { AgentMode } from '../autonomy/mode.ts'
import type { VerifyResult } from '../autonomy/outcomes.ts'

/**
 * Every turn elia takes, written down as a training row.
 *
 * elia is inference-time scaffolding on a frontier API — prompt plus tools plus
 * a loop. That has a ceiling no amount of scaffolding gets past. The only way
 * through it is to eventually fold what the scaffold learns back into weights,
 * and that needs a dataset: `(what elia was asked and saw, what it did, how it
 * turned out, how good that was)` at scale. Nothing captured that — `reward`
 * appeared nowhere outside the evolution benchmark, and the per-turn signals
 * that do exist were aggregated into a competence percentage and discarded.
 *
 * This is the raw ledger. No training happens here; it just stops the data from
 * being thrown away. On by default (`.elia/` is local and git-ignored);
 * `ELIA_NO_TRAJECTORY=1` turns it off.
 */

export type TrajectoryRewardCategory = 'clean' | 'repaired' | 'failed' | 'aborted' | 'unverified'

export interface TrajectoryReward {
  /** 0..1 — higher is a turn that landed cleanly with strong verification. */
  scalar: number
  category: TrajectoryRewardCategory
}

export interface TrajectoryToolCall {
  name: string
  ok: boolean
  /** A short, secret-free digest of the arguments — never the full input. */
  argsDigest?: string
}

export interface TrajectoryTouchedFile {
  path: string
  /** File content before the turn touched it (`null` = created this turn). */
  before: string | null
  /** File content after the turn (`null` = deleted this turn). */
  after: string | null
}

export interface TrajectoryRow {
  at: number
  /** Joins to `.elia/outcomes.jsonl` and `.elia/lessons-efficacy.jsonl`. */
  corr: string
  kind: 'interactive' | 'autonomous'
  promptRedacted: string
  /** Hash of the stable system prefix (base prompt + value core) for this row's mode — see refSystemPrompt(). */
  systemPromptRef: string
  /** Ordered as the model issued them. */
  tools: TrajectoryToolCall[]
  touched: TrajectoryTouchedFile[]
  verify: VerifyResult
  /** How much the verification was worth, when known (autonomous runs classify this). */
  regime?: 'mechanical' | 'empirical' | 'judgment'
  /** Deterministic verdict-vs-facts contradictions recorded for the run, when any. */
  contradictions?: string[]
  /** True when elia was working on its own checkout — these rows are safe to mint benchmark tasks from. */
  cwdIsEliaRoot: boolean
  reward: TrajectoryReward
}

export interface RewardSignals {
  toolErrors: number
  editRetries: number
  verify: VerifyResult
  repairAttempts: number
  aborted: boolean
  /** Autonomous only: the completion assessor's state. */
  completionState?: 'verified' | 'partial' | 'blocked' | 'failed' | 'aborted'
  regime?: 'mechanical' | 'empirical' | 'judgment'
  contradictions?: number
}

/**
 * Collapse the per-turn friction signals into one scalar and one label.
 *
 * Pure and deterministic so it can be unit-tested and re-derived later if the
 * formula changes — the row keeps the inputs it was computed from via the other
 * fields, not just the number.
 */
export function deriveReward(s: RewardSignals): TrajectoryReward {
  if (s.aborted) return { scalar: 0, category: 'aborted' }
  if (s.completionState === 'failed' || s.verify === 'fail') {
    return { scalar: s.repairAttempts > 0 ? 0.15 : 0.1, category: 'failed' }
  }

  let scalar = 1
  if (s.repairAttempts > 0) scalar -= 0.25 * Math.min(2, s.repairAttempts)
  if (s.toolErrors > 0) scalar -= Math.min(0.3, 0.05 * s.toolErrors)
  if (s.editRetries > 0) scalar -= Math.min(0.2, 0.05 * s.editRetries)
  if (s.contradictions && s.contradictions > 0) scalar -= Math.min(0.3, 0.1 * s.contradictions)

  // Verification you can't trust is a discount, not a pass.
  const unverified = s.verify === 'none' || s.verify === 'skipped' || s.regime === 'judgment'
  if (unverified) scalar -= 0.15

  scalar = Math.max(0, Math.min(1, scalar))

  if (s.repairAttempts > 0) return { scalar, category: 'repaired' }
  if (unverified) return { scalar, category: 'unverified' }
  return { scalar, category: 'clean' }
}

const MAX_FILE_BODY = 20_000
const MAX_ROW_BYTES = 200_000
const TRAJECTORY_MAX_BYTES = 64 * 1024 * 1024
const ARGS_DIGEST_LEN = 200

/** A short, secret-free one-liner describing a tool call's arguments. */
export function digestArgs(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined
  const parts: string[] = []
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') parts.push(`${k}=${v.slice(0, 80)}`)
    else if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}=${v}`)
    else if (Array.isArray(v)) parts.push(`${k}[${v.length}]`)
    else if (v && typeof v === 'object') parts.push(`${k}{}`)
  }
  const joined = redactText(parts.join(' '), ARGS_DIGEST_LEN)
  return joined.length > 0 ? joined : undefined
}

function boundBody(text: string | null): string | null {
  if (text === null) return null
  const safe = redactSecrets(text)
  return safe.length > MAX_FILE_BODY ? `${safe.slice(0, MAX_FILE_BODY)}\n…[${safe.length - MAX_FILE_BODY} more chars]` : safe
}

function hash(text: string): string {
  return Bun.hash(text).toString(36)
}

/**
 * A stable grouping key for "was this row generated under the same instructions".
 *
 * Hashes the *stable* system prefix for a mode — the base prompt plus the Value
 * Core section (empty until the core is activated) — so rows regroup when either
 * changes and a training export can tell an old prompt regime from a new one.
 * The per-turn dynamic block (date, query-ranked memory) is deliberately not
 * included: it varies every message and is not what "same setup" means.
 */
export function refSystemPrompt(mode: AgentMode): string {
  return hash(`${systemPromptForMode(mode)}${valueCoreSection()}`)
}

function fileFor(kind: TrajectoryRow['kind'], baseDir = paths.trajectories): string {
  return join(baseDir, kind === 'interactive' ? 'interactive.ndjson' : 'autonomous.ndjson')
}

export interface TrajectoryInput {
  corr: string
  kind: TrajectoryRow['kind']
  prompt: string
  systemPromptRef: string
  tools: TrajectoryToolCall[]
  touched: TrajectoryTouchedFile[]
  verify: VerifyResult
  regime?: TrajectoryRow['regime']
  contradictions?: string[]
  cwdIsEliaRoot: boolean
  reward: TrajectoryReward
}

/** Append one row for a completed turn/run. Never throws. `baseDir` is for tests. */
export function recordTrajectory(input: TrajectoryInput, baseDir = paths.trajectories): void {
  if (process.env.ELIA_NO_TRAJECTORY === '1') return
  try {
    const row: TrajectoryRow = {
      at: Date.now(),
      corr: input.corr,
      kind: input.kind,
      promptRedacted: redactText(input.prompt, 4_000),
      systemPromptRef: input.systemPromptRef,
      tools: input.tools.slice(0, 500),
      touched: input.touched.map((f) => ({ path: relativizeProjectPaths(f.path), before: boundBody(f.before), after: boundBody(f.after) })),
      verify: input.verify,
      regime: input.regime,
      contradictions: input.contradictions && input.contradictions.length > 0 ? input.contradictions : undefined,
      cwdIsEliaRoot: input.cwdIsEliaRoot,
      reward: input.reward,
    }

    let line = JSON.stringify(row)
    if (line.length > MAX_ROW_BYTES) {
      // The file bodies are what blow the budget — keep the paths, drop the content.
      row.touched = row.touched.map((f) => ({ path: f.path, before: f.before === null ? null : '[omitted: row too large]', after: f.after === null ? null : '[omitted: row too large]' }))
      line = JSON.stringify(row)
    }

    const path = fileFor(input.kind, baseDir)
    rotateSecureFile(path, TRAJECTORY_MAX_BYTES)
    appendSecureFile(path, `${line}\n`)
  } catch {
    // A lost trajectory row costs a training sample, not correctness.
  }
}

/** Read back the current (unrotated) trajectory file for a kind. Tolerant of corrupt lines. */
export function readTrajectories(kind: TrajectoryRow['kind'], path = fileFor(kind)): TrajectoryRow[] {
  if (!existsSync(path)) return []
  hardenSecureFile(path)
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as TrajectoryRow]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

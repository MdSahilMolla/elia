// What an approved plan is missing before any code gets written: a repository
// to hold it, a .gitignore so the first commit isn't node_modules and a
// database file, and the documents a project is supposed to start from.
//
// Runs between plan approval and execution. Everything here is deterministic —
// the documents are rendered from the proposal the user actually approved
// rather than asked of a model a second time, so they say exactly what was
// agreed and cannot drift from it. It also means the scaffold costs no tokens
// and cannot fail halfway through a generation.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execCapture } from '../github/exec.ts'
import { isSensitivePath } from './sensitivePaths.ts'
import type { Proposal } from './types.ts'

export interface ScaffoldOptions {
  cwd: string
  goal: string
  proposal: Proposal
  signal?: AbortSignal
  /** Skip document generation; the repository work still happens. */
  documents?: boolean
  /** Repo-relative paths that were already dirty before the run — never committed. */
  protect?: readonly string[]
}

export interface ScaffoldResult {
  /** True when this call created the repository (it was not one before). */
  initialized: boolean
  /** Repo-relative paths of documents written. */
  documents: string[]
  /** Subjects of commits actually made. */
  commits: string[]
  /** Anything that could not be done, in words worth showing the user. */
  warnings: string[]
}

export interface CommitResult {
  committed: boolean
  /** Files left out of the commit because they hold secrets. */
  excluded: string[]
  warning?: string
}

/**
 * A default ignore file, written only when the project has none.
 *
 * This is a safety gate, not a convenience. The first `git add -A` in a project
 * that has an `.env` with live API keys in it — which is exactly what a working
 * directory looks like — would stage those keys, and a later push would publish
 * them. `commitAll` refuses sensitive paths as a second line of defence, but
 * the ignore file is the one that keeps them out of `git status` entirely.
 */
const DEFAULT_GITIGNORE = `# Dependencies
node_modules/
.pnp/
venv/
.venv/
__pycache__/

# Secrets — never commit these
.env
.env.*
!.env.example
*.pem
*.key

# Build output
dist/
build/
out/
target/
coverage/

# Local databases and logs
*.db
*.sqlite
*.sqlite3
*.log

# Editor and OS
.DS_Store
.idea/
.vscode/
*.swp

# elia run state
.elia/
`

/** Creates the repository if the directory isn't one yet. */
export async function ensureRepository(cwd: string, signal?: AbortSignal): Promise<{ initialized: boolean; warning?: string }> {
  const inside = await execCapture('git', ['rev-parse', '--is-inside-work-tree'], cwd, signal)
  if (inside.ok && inside.stdout.trim() === 'true') return { initialized: false }
  if (inside.missing) return { initialized: false, warning: 'git is not installed, so this run has no version history or rollback point.' }

  const init = await execCapture('git', ['init', '-b', 'main'], cwd, signal)
  if (!init.ok) {
    // Older git has no `-b`; fall back rather than leaving the project unversioned.
    const plain = await execCapture('git', ['init'], cwd, signal)
    if (!plain.ok) return { initialized: false, warning: `git init failed: ${plain.stderr || plain.stdout}` }
  }
  return { initialized: true }
}

/**
 * Stages everything and commits, refusing to include a file that looks like it
 * holds secrets even if the project's ignore rules missed it.
 *
 * `protect` is a set of repo-relative paths that were already dirty or untracked
 * before the run started and that the run did not touch — a run inside a repo
 * with unrelated uncommitted work must never sweep it into its own commit.
 * `include`, when supplied, is the worker-owned allowlist for this commit.
 */
export async function commitAll(
  cwd: string,
  message: string,
  signal?: AbortSignal,
  protect: readonly string[] = [],
  include?: readonly string[],
): Promise<CommitResult> {
  const add = await execCapture('git', ['add', '-A'], cwd, signal)
  if (!add.ok) return { committed: false, excluded: [], warning: `git add failed: ${add.stderr || add.stdout}` }

  const staged = await execCapture('git', ['diff', '--cached', '--name-only'], cwd, signal)
  const paths = staged.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const protectedSet = new Set(protect.map((p) => p.replace(/\\/g, '/')))
  const included = include
    ?.map((path) => path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, ''))
    .filter((path) => path && path !== '.')

  // Second line of defence behind .gitignore. A commit is one `git push` away
  // from being public and permanent, so a secret must never reach one. Same
  // mechanism keeps the operator's pre-existing uncommitted work out.
  const excluded: string[] = []
  const preserved: string[] = []
  for (const path of paths) {
    const normalized = path.replace(/\\/g, '/')
    const isSecret = isSensitivePath(path)
    const isPreExisting = protectedSet.has(normalized)
    const isOutsideScope = included !== undefined && !included.some((owned) => normalized === owned || normalized.startsWith(`${owned}/`))
    if (!isSecret && !isPreExisting && !isOutsideScope) continue
    await execCapture('git', ['reset', '--quiet', '--', path], cwd, signal)
    if (isSecret) excluded.push(path)
    else preserved.push(path)
  }
  if (paths.length === excluded.length + preserved.length) {
    const why = [
      excluded.length > 0 ? `hold secrets (${excluded.join(', ')})` : '',
      preserved.length > 0 ? `was outside this commit's owned files (${preserved.join(', ')})` : '',
    ].filter(Boolean).join('; ')
    return { committed: false, excluded, ...(why ? { warning: `nothing to commit: every changed file ${why}` } : {}) }
  }

  const identity = await commitIdentity(cwd, signal)
  const commit = await execCapture('git', [...identity, 'commit', '-m', message], cwd, signal)
  if (!commit.ok) return { committed: false, excluded, warning: `git commit failed: ${commit.stderr || commit.stdout}` }
  return {
    committed: true,
    excluded,
    ...(preserved.length > 0
      ? { warning: `left changes outside this commit's owned files uncommitted: ${preserved.join(', ')}` }
      : {}),
  }
}

/**
 * `-c user.*` arguments, supplied only when the machine has no git identity —
 * a fresh container or a new user account, where a commit would otherwise fail
 * with "please tell me who you are" and take the run's whole history with it.
 */
async function commitIdentity(cwd: string, signal?: AbortSignal): Promise<string[]> {
  const email = await execCapture('git', ['config', '--get', 'user.email'], cwd, signal)
  if (email.ok && email.stdout.trim()) return []
  return ['-c', 'user.name=elia', '-c', 'user.email=elia@localhost']
}

/**
 * The documents a project should exist with before its first line of code,
 * rendered from the approved proposal.
 */
export function renderProjectDocs(goal: string, proposal: Proposal, now = new Date()): { path: string; content: string }[] {
  const date = now.toISOString().slice(0, 10)
  return [
    { path: 'docs/PRD.md', content: renderPrd(goal, proposal, date) },
    { path: 'docs/ARCHITECTURE.md', content: renderArchitecture(proposal, date) },
    { path: 'docs/adr/0001-initial-approach.md', content: renderAdr(proposal, date) },
  ]
}

function list(items: string[] | undefined, empty = '_None recorded._'): string {
  return items && items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : empty
}

function renderPrd(goal: string, proposal: Proposal, date: string): string {
  return `# Product requirements

_Generated ${date} from the approved plan. Edit freely — this is the project's document now, not a run artifact._

## The ask

${goal}

## What this is

${proposal.goal}

## Current understanding

${proposal.understanding || '_Not recorded._'}

## Acceptance criteria

These are the observable conditions that decide whether the work is done.

${list(proposal.acceptanceCriteria, '_No acceptance criteria were declared, which means "done" is undefined. Add them._')}

## Out of scope

${list(proposal.outOfScope)}

## Assumptions

Each of these was believed, not verified. An assumption that turns out to be
wrong is the cheapest thing to correct early and the most expensive to
discover late.

${list(proposal.assumptions)}

## Known risks

${list(proposal.risks)}

## Side effects

${list(proposal.sideEffects, '_None declared._')}
`
}

function renderArchitecture(proposal: Proposal, date: string): string {
  const waves = new Map<number, typeof proposal.steps>()
  const depth = new Map<string, number>()
  for (const step of proposal.steps) {
    const level = step.dependsOn.length === 0 ? 0 : Math.max(...step.dependsOn.map((id) => (depth.get(id) ?? 0) + 1))
    depth.set(step.id, level)
    waves.set(level, [...(waves.get(level) ?? []), step])
  }
  const plan = [...waves.entries()]
    .sort(([a], [b]) => a - b)
    .map(([level, steps]) =>
      [
        `### Stage ${level + 1}${steps.length > 1 ? ` — ${steps.length} pieces, independent of each other` : ''}`,
        '',
        ...steps.map(
          (step) =>
            `- **${step.title}** (\`${step.id}\`, ${step.role})\n  - files: ${step.files.length > 0 ? step.files.map((file) => `\`${file}\``).join(', ') : '_unspecified_'}\n  - ${step.instructions.split('\n')[0] ?? ''}`,
        ),
      ].join('\n'),
    )
    .join('\n\n')

  return `# Architecture

_Generated ${date} from the approved plan._

## Shape of the work

${proposal.understanding || '_Not recorded._'}

## Components and build order

Stages run in order; everything inside one stage is independent and can be
built in parallel.

${plan || '_No steps were planned._'}

## How correctness is proven

${proposal.verification.length > 0 ? proposal.verification.map((command) => `- \`${command}\``).join('\n') : '_No verification commands were declared, so nothing here is machine-checked._'}

## Recovery

${list(proposal.recovery, '_No recovery plan was declared._')}
`
}

function renderAdr(proposal: Proposal, date: string): string {
  return `# ADR 0001 — Initial approach

- **Status:** accepted
- **Date:** ${date}

## Context

${proposal.understanding || '_Not recorded._'}

The following was assumed rather than verified:

${list(proposal.assumptions)}

## Decision

Build it in ${proposal.steps.length} step(s):

${proposal.steps.map((step) => `${step.id}. ${step.title}${step.dependsOn.length > 0 ? ` (after ${step.dependsOn.join(', ')})` : ''}`).join('\n') || '_No steps._'}

Correctness is decided by: ${proposal.verification.map((command) => `\`${command}\``).join(', ') || '_nothing machine-checked_'}.

## Consequences

Accepted risks:

${list(proposal.risks)}

Deliberately not addressed:

${list(proposal.outOfScope)}

## Revisiting this

Supersede this ADR with a new numbered one rather than editing it. The record
of what was decided when, and on what information, is the point.
`
}

/**
 * Repository, ignore rules, project documents, and a first commit — everything
 * an approved plan needs before the first worker starts.
 */
export async function scaffoldProject(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const { cwd, goal, proposal, signal } = options
  const result: ScaffoldResult = { initialized: false, documents: [], commits: [], warnings: [] }

  const repo = await ensureRepository(cwd, signal)
  result.initialized = repo.initialized
  if (repo.warning) {
    result.warnings.push(repo.warning)
    return result
  }

  // Written before anything is staged, so secrets and dependency trees are
  // never in a commit in the first place.
  if (!existsSync(join(cwd, '.gitignore'))) {
    try {
      writeFileSync(join(cwd, '.gitignore'), DEFAULT_GITIGNORE)
      result.documents.push('.gitignore')
    } catch (error) {
      result.warnings.push(`could not write .gitignore: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (options.documents !== false) {
    for (const document of renderProjectDocs(goal, proposal)) {
      const target = join(cwd, document.path)
      // Never overwrite a document the project already has — the run's plan is
      // not more authoritative than what people wrote.
      if (existsSync(target)) continue
      try {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, document.content)
        result.documents.push(document.path)
      } catch (error) {
        result.warnings.push(`could not write ${document.path}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  const message = result.initialized
    ? `Initial commit: plan and project documents\n\n${proposal.goal}`
    : `Add project documents for: ${proposal.goal}`
  const commit = await commitAll(cwd, message, signal, options.protect)
  if (commit.committed) result.commits.push(message.split('\n')[0]!)
  if (commit.warning) result.warnings.push(commit.warning)
  if (commit.excluded.length > 0) {
    result.warnings.push(`kept out of the commit because they hold secrets: ${commit.excluded.join(', ')}`)
  }

  return result
}

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ELIA_ROOT } from '../config.ts'
import { EVOLUTION_DIR } from './ledger.ts'

/**
 * An isolated copy of elia's own source for a candidate mutation to be applied to
 * and measured in.
 *
 * Editing the live source and rolling back on failure is not an option: elia is
 * the process doing the editing, and a half-applied mutation to the agent loop
 * would break the thing that was supposed to revert it. So every generation gets
 * a full copy, and the live tree is touched only after the candidate has already
 * passed the gate.
 *
 * The sandbox is placed *inside* elia's root rather than in a temp directory
 * because Bun resolves `node_modules` by walking up the tree — so a nested copy
 * inherits the real dependency tree with no install, no symlink, and no junction.
 */

/** Copied into every sandbox. Everything else (node_modules, .git, .evolution) is either inherited or irrelevant. */
const COPIED_ENTRIES = ['src', 'package.json', 'tsconfig.json']

/**
 * Files a candidate is not allowed to change.
 *
 * This is the reward-hacking guard. Every one of these is part of how a candidate
 * gets judged: the tasks, the checks, the scoring rules, the comparison, and the
 * gate itself. A model asked to improve its benchmark score can improve it far
 * more cheaply by editing the benchmark, and it will — not from malice but because
 * that genuinely is the shortest path to the stated objective. Making the measuring
 * apparatus off-limits is what keeps the score meaning what it says.
 */
export const IMMUTABLE_FILES = [
  'src/evolve/suite.ts',
  'src/evolve/fitness.ts',
  'src/evolve/engine.ts',
  'src/evolve/ledger.ts',
  'src/evolve/sandbox.ts',
  'src/evolve/benchTask.ts',
]

export interface Sandbox {
  generation: number
  /** Root of the copied source tree; pass this to `measureFitness`. */
  root: string
  /** Where the live files that were overwritten are backed up, so promotion is reversible. */
  backupDir: string
}

export function createSandbox(generation: number, liveRoot = ELIA_ROOT): Sandbox {
  const root = join(EVOLUTION_DIR, `gen-${generation}`)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })

  for (const entry of COPIED_ENTRIES) {
    const from = join(liveRoot, entry)
    if (!existsSync(from)) continue
    const to = join(root, entry)
    if (statSync(from).isDirectory()) cpSync(from, to, { recursive: true })
    else copyFileSync(from, to)
  }

  return { generation, root, backupDir: join(EVOLUTION_DIR, `gen-${generation}-backup`) }
}

export function removeSandbox(sandbox: Sandbox): void {
  rmSync(sandbox.root, { recursive: true, force: true })
}

/**
 * Every source file that differs between the sandbox and the live tree.
 *
 * Compared by content rather than by trusting the builder's report: what matters
 * to the gate is what actually changed on disk, which is regularly not what the
 * report says.
 */
export function changedFiles(sandbox: Sandbox, liveRoot = ELIA_ROOT): string[] {
  const changed: string[] = []

  for (const relativePath of sourceFilesIn(sandbox.root)) {
    const candidate = readIfPresent(join(sandbox.root, relativePath))
    const live = readIfPresent(join(liveRoot, relativePath))
    if (candidate !== live) changed.push(relativePath)
  }

  // A file the candidate deleted still counts as a change.
  for (const relativePath of sourceFilesIn(liveRoot)) {
    if (!existsSync(join(sandbox.root, relativePath))) changed.push(relativePath)
  }

  return [...new Set(changed)].sort()
}

/** Which of the changed files the candidate was forbidden from touching. */
export function violatedImmutables(changed: string[]): string[] {
  return changed.filter((file) => IMMUTABLE_FILES.includes(file))
}

/**
 * Moves a passing candidate into the live tree, backing up what it replaces.
 * Returns the backup directory so a promotion can be undone by copying it back.
 */
export function promote(sandbox: Sandbox, changed: string[], liveRoot = ELIA_ROOT): string {
  mkdirSync(sandbox.backupDir, { recursive: true })

  for (const relativePath of changed) {
    const livePath = join(liveRoot, relativePath)
    if (existsSync(livePath)) {
      const backupPath = join(sandbox.backupDir, relativePath)
      mkdirSync(join(backupPath, '..'), { recursive: true })
      copyFileSync(livePath, backupPath)
    }

    const candidatePath = join(sandbox.root, relativePath)
    if (existsSync(candidatePath)) {
      mkdirSync(join(livePath, '..'), { recursive: true })
      copyFileSync(candidatePath, livePath)
    } else {
      // The candidate deleted it; mirror that, having backed it up first.
      rmSync(livePath, { force: true })
    }
  }

  return sandbox.backupDir
}

/** Undoes a promotion from its backup directory. */
export function rollback(sandbox: Sandbox, changed: string[], liveRoot = ELIA_ROOT): void {
  for (const relativePath of changed) {
    const backupPath = join(sandbox.backupDir, relativePath)
    if (existsSync(backupPath)) copyFileSync(backupPath, join(liveRoot, relativePath))
  }
}

function sourceFilesIn(root: string): string[] {
  const srcDir = join(root, 'src')
  if (!existsSync(srcDir)) return []

  const glob = new Bun.Glob('**/*.ts')
  const files: string[] = []
  for (const path of glob.scanSync({ cwd: srcDir, dot: false })) {
    files.push(`src/${path.replace(/\\/g, '/')}`)
  }
  return files
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** A short human-readable diff summary for the ledger and the terminal. */
export function describeChanges(sandbox: Sandbox, changed: string[], liveRoot = ELIA_ROOT): string {
  return changed
    .map((relativePath) => {
      const candidate = readIfPresent(join(sandbox.root, relativePath))
      const live = readIfPresent(join(liveRoot, relativePath))
      if (candidate === undefined) return `  - ${relativePath} (deleted)`
      if (live === undefined) return `  + ${relativePath} (new, ${candidate.split('\n').length} lines)`
      const delta = candidate.split('\n').length - live.split('\n').length
      return `  ~ ${relativePath} (${delta >= 0 ? '+' : ''}${delta} lines)`
    })
    .join('\n')
}

export function relativeToRoot(path: string, root = ELIA_ROOT): string {
  return relative(root, path).replace(/\\/g, '/')
}

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DOC_PATHS, EXCLUDED_PATHS } from './basket.ts'

const execFileAsync = promisify(execFile)

/** Runs git and resolves its stdout. Injected so the history logic can be tested against a scripted repository. */
export type Git = (args: string[]) => Promise<string>

export function gitIn(cwd: string): Git {
  return async (args) => {
    const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=off', ...args], { cwd, maxBuffer: 512 * 1024 * 1024 })
    return stdout
  }
}

export interface FileChange {
  path: string
  added: number
  deleted: number
  binary: boolean
}

export interface Commit {
  sha: string
  parents: string[]
  /** Committer time, epoch seconds. */
  time: number
  subject: string
  body: string
  changes: FileChange[]
}

export interface History {
  commits: Map<string, Commit>
  /** The ref's first-parent chain, oldest first: the mainline a change has to reach. */
  chain: string[]
  /** For each commit, the chain commit that first brought it into the ref (itself, when it is on the chain). */
  integratedBy: Map<string, string>
}

/**
 * `git log --numstat` prints a rename as `dir/{old => new}/file` or `old => new`.
 * The path that exists afterwards is the one a later blame has to ask about.
 */
export function resolveNumstatPath(raw: string): string {
  if (!raw.includes(' => ')) return raw
  if (raw.includes('{')) return raw.replace(/\{([^{}]*?) => ([^{}]*?)\}/, '$2').replace(/\/{2,}/g, '/')
  return raw.split(' => ')[1] ?? raw
}

export function parseLog(output: string): Commit[] {
  const commits: Commit[] = []
  for (const record of output.split('\x1e')) {
    if (!record.trim()) continue
    const [sha, parents, time, body, rest] = record.split('\x1f')
    if (!sha || parents === undefined || !time || body === undefined) continue
    const changes: FileChange[] = []
    for (const line of (rest ?? '').split('\n')) {
      const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
      if (!match) continue
      const binary = match[1] === '-'
      changes.push({ path: resolveNumstatPath(match[3]!), added: binary ? 0 : Number(match[1]), deleted: binary ? 0 : Number(match[2]), binary })
    }
    const message = body.replace(/\s+$/, '')
    commits.push({ sha: sha.trim(), parents: parents.split(' ').filter(Boolean), time: Number(time), subject: message.split('\n')[0] ?? '', body: message, changes })
  }
  return commits
}

export async function loadHistory(git: Git, ref: string): Promise<History> {
  const log = await git(['log', ref, '--numstat', '-M', '--format=%x1e%H%x1f%P%x1f%ct%x1f%B%x1f'])
  const commits = new Map(parseLog(log).map((commit) => [commit.sha, commit]))
  const chain = (await git(['rev-list', '--first-parent', '--reverse', ref])).split('\n').filter(Boolean)
  const integratedBy = new Map<string, string>()
  for (const sha of chain) {
    const commit = commits.get(sha)
    if (!commit) continue
    if (commit.parents.length < 2) {
      integratedBy.set(sha, sha)
      continue
    }
    integratedBy.set(sha, sha)
    const brought = await git(['rev-list', '--no-merges', `${sha}^1..${sha}`])
    for (const merged of brought.split('\n').filter(Boolean)) if (!integratedBy.has(merged)) integratedBy.set(merged, sha)
  }
  return { commits, chain, integratedBy }
}

const excluded = EXCLUDED_PATHS.map((pattern) => new RegExp(pattern))
const docs = new RegExp(DOC_PATHS)

export function isCountedPath(path: string): boolean {
  return !excluded.some((pattern) => pattern.test(path))
}

export function isCounted(change: FileChange): boolean {
  return !change.binary && isCountedPath(change.path)
}

export function isDocPath(path: string): boolean {
  return docs.test(path)
}

/** Lines per commit that still belong to it, from `git blame --line-porcelain`. */
export function countBlame(porcelain: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const line of porcelain.split('\n')) {
    const match = /^([0-9a-f]{40}) \d+ \d+/.exec(line)
    if (match) counts.set(match[1]!, (counts.get(match[1]!) ?? 0) + 1)
  }
  return counts
}

/** Where each path a commit touched lives at a later snapshot: itself, renamed, or gone. */
export interface PathFate {
  renamed: Map<string, string>
  deleted: Set<string>
}

export function parseNameStatus(output: string): PathFate {
  const fate: PathFate = { renamed: new Map(), deleted: new Set() }
  const tokens = output.split('\0')
  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index]
    if (!status) continue
    if (status.startsWith('R') || status.startsWith('C')) {
      const from = tokens[index + 1]
      const to = tokens[index + 2]
      index += 2
      if (status.startsWith('R') && from && to) fate.renamed.set(from, to)
    } else {
      const path = tokens[index + 1]
      index += 1
      if (status.startsWith('D') && path) fate.deleted.add(path)
    }
  }
  return fate
}

/** The lines a commit removed or rewrote, per file, as line ranges in the file's parent version. */
export interface RemovedLines {
  path: string
  /** [first line, line count] in the parent's copy of the file. */
  ranges: [number, number][]
}

/** Reads `git show -U0` for the old-side ranges of every hunk. A pure addition has none, so nothing is blamed for it. */
export function parseRemovedLines(diff: string): RemovedLines[] {
  const files: RemovedLines[] = []
  let current: RemovedLines | undefined
  for (const line of diff.split('\n')) {
    if (line.startsWith('--- ')) {
      const old = line.slice(4).replace(/\t.*$/, '')
      current = old === '/dev/null' || old.startsWith('"') ? undefined : { path: old.replace(/^a\//, ''), ranges: [] }
      if (current) files.push(current)
      continue
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line)
    if (hunk && current) {
      const count = hunk[2] === undefined ? 1 : Number(hunk[2])
      if (count > 0) current.ranges.push([Number(hunk[1]), count])
    }
  }
  return files.filter((file) => file.ranges.length > 0)
}

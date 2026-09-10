// Git provenance: trace code through renames, refactors, and history.

import { runGit, type Worktree } from '../../autonomy/worktree.ts'
import type { BlameEntry, CommitInfo, ProvenanceEntry } from './types.ts'

const MAX_COMMITS = 200
const MAX_BLAME_LINES = 500

/** Parse git blame porcelain output into structured entries. */
export function parseBlamePorcelain(output: string): BlameEntry[] {
  const entries: BlameEntry[] = []
  const lines = output.split('\n')
  let current: Partial<BlameEntry> | null = null

  for (const line of lines) {
    // Porcelain line format: <40-hex sha> <orig line> <current line> [<num lines>]
    const hashMatch = line.match(/^([a-f0-9]{40})\s+(\d+)\s+(\d+)\s+(\d+)/)
    if (hashMatch) {
      if (current?.commit) entries.push(current as BlameEntry)
      current = {
        commit: hashMatch[1]!,
        // `current line` (index 3) is the line number in the file being blamed,
        // which is what causal matching against a target line needs.
        line: parseInt(hashMatch[3]!, 10),
        author: '',
        date: '',
        content: '',
      }
      continue
    }
    if (!current) continue

    const authorMatch = line.match(/^author\s+(.+)/)
    if (authorMatch) { current.author = authorMatch[1]!.trim(); continue }

    const dateMatch = line.match(/^author-time\s+(\d+)/)
    if (dateMatch) { current.date = new Date(parseInt(dateMatch[1]!, 10) * 1000).toISOString(); continue }

    const prevMatch = line.match(/^previous\s+([a-f0-9]+)\s+(.+)/)
    if (prevMatch) { current.previousCommit = prevMatch[1]; current.previousPath = prevMatch[2]; continue }

    if (line.startsWith('\t')) {
      current.content = line.slice(1)
    }
  }
  if (current?.commit) entries.push(current as BlameEntry)
  return entries
}

/** Get blame entries for a file, optionally for a specific line range. */
export async function getBlame(
  filePath: string,
  cwd: string,
  lineStart?: number,
  lineEnd?: number,
): Promise<BlameEntry[]> {
  const result = await runGit(['blame', '--porcelain',
    ...(lineStart !== undefined && lineEnd !== undefined ? ['-L', `${Math.max(1, lineStart)},${lineEnd}`] : []),
    filePath,
  ], cwd)

  if (result.exitCode !== 0) return []
  return parseBlamePorcelain(result.stdout)
}

/** Parse git log with detailed format. */
export function parseGitLog(output: string): CommitInfo[] {
  const commits: CommitInfo[] = []
  const sections = output.split('\u0000')

  for (const section of sections) {
    const lines = section.split('\n').filter((l) => l.length > 0)
    if (lines.length < 2) continue

    const header = lines[0]!
    const parts = header.split('|||')
    if (parts.length < 6) continue

    const hash = parts[0]!.trim()
    const shortHash = parts[1]!.trim()
    const author = parts[2]!.trim()
    const date = parts[3]!.trim()
    const message = parts[4]!.trim()
    const parents = parts[5]!.trim().split(' ').filter(Boolean)
    const insertions = parseInt(parts[6] ?? '0', 10) || 0
    const deletions = parseInt(parts[7] ?? '0', 10) || 0

    const filesChanged: string[] = []
    for (let i = 1; i < lines.length; i++) {
      const f = lines[i]!.trim()
      if (f) filesChanged.push(f)
    }

    commits.push({ hash, shortHash, author, date, message, parents, filesChanged, insertions, deletions })
  }
  return commits
}

/** Get commit history for a file. */
export async function getFileHistory(filePath: string, cwd: string, maxCommits = MAX_COMMITS): Promise<CommitInfo[]> {
  const result = await runGit(
    ['log', `--format=%H|||%h|||%an|||%ai|||%s|||%P`, `-${maxCommits}`, '--', filePath],
    cwd,
  )
  if (result.exitCode !== 0) return []

  return result.stdout
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const parts = line.split('|||')
      return {
        hash: parts[0]?.trim() ?? '',
        shortHash: parts[1]?.trim() ?? '',
        author: parts[2]?.trim() ?? '',
        date: parts[3]?.trim() ?? '',
        message: parts[4]?.trim() ?? '',
        parents: (parts[5]?.trim() ?? '').split(' ').filter(Boolean),
        filesChanged: [],
        insertions: 0,
        deletions: 0,
      }
    })
    .filter((c) => c.hash.length > 0)
}

/** Get the diff for a specific commit. */
export async function getCommitDiff(commitHash: string, cwd: string): Promise<string> {
  const result = await runGit(['show', '--stat', '--patch', commitHash], cwd)
  return result.exitCode === 0 ? result.stdout : ''
}

/** Get file list changed in a commit. */
export async function getCommitFiles(commitHash: string, cwd: string): Promise<string[]> {
  const result = await runGit(['diff-tree', '--no-commit-id', '--name-only', '-r', commitHash], cwd)
  if (result.exitCode !== 0) return []
  return result.stdout.split('\n').filter((l) => l.trim().length > 0)
}

/** Detect file renames between two commits. */
export async function detectRenames(fromCommit: string, toCommit: string, cwd: string): Promise<Array<{ from: string; to: string; similarity: number }>> {
  const result = await runGit(
    ['diff', '--name-status', '-M', `${fromCommit}..${toCommit}`],
    cwd,
  )
  if (result.exitCode !== 0) return []

  const renames: Array<{ from: string; to: string; similarity: number }> = []
  for (const line of result.stdout.split('\n')) {
    const match = line.match(/^R(\d+)\s+(.+?)\s+(.+)$/)
    if (match) {
      renames.push({
        similarity: parseInt(match[1]!, 10),
        from: match[2]!.trim(),
        to: match[3]!.trim(),
      })
    }
  }
  return renames
}

/** Trace a file back through renames to its original name. */
export async function traceFileRenames(filePath: string, cwd: string, maxSteps = 20): Promise<ProvenanceEntry[]> {
  const provenance: ProvenanceEntry[] = []
  let currentPath = filePath
  const visited = new Set<string>()

  for (let step = 0; step < maxSteps; step++) {
    if (visited.has(currentPath)) break
    visited.add(currentPath)

    // Check if this file was renamed FROM something else
    const result = await runGit(
      ['log', '--diff-filter=R', '--summary', '--format=%H', '-1', '--', currentPath],
      cwd,
    )
    if (result.exitCode !== 0 || !result.stdout.trim()) break

    const renameMatch = result.stdout.match(/rename\s+from\s+(.+)\n/)
    if (!renameMatch) break

    const prevPath = renameMatch[1]!.trim()
    const commitMatch = result.stdout.match(/^([a-f0-9]+)/m)
    const commit = commitMatch?.[1] ?? 'unknown'

    // Get similarity from the rename entry
    const simMatch = result.stdout.match(/similarity index (\d+)%/)
    const similarity = simMatch ? parseInt(simMatch[1]!, 10) : 100

    provenance.push({
      commit,
      path: currentPath,
      line: 0,
      action: 'renamed',
      similarity,
    })

    provenance.push({
      commit,
      path: prevPath,
      line: 0,
      action: 'moved',
      similarity,
    })

    currentPath = prevPath
  }

  return provenance
}

/** Get the file content at a specific commit. */
export async function getFileAtCommit(filePath: string, commitHash: string, cwd: string): Promise<string> {
  const result = await runGit(['show', `${commitHash}:${filePath}`], cwd)
  return result.exitCode === 0 ? result.stdout : ''
}

/** Get the file content at HEAD. */
export async function getFileAtHead(filePath: string, cwd: string): Promise<string> {
  return getFileAtCommit(filePath, 'HEAD', cwd)
}

/** Check if a repository is a shallow clone. */
export async function isShallowRepo(cwd: string): Promise<boolean> {
  const result = await runGit(['rev-parse', '--is-shallow-repository'], cwd)
  return result.stdout.trim() === 'true'
}

/** Check if there are uncommitted changes. */
export async function hasDirtyWorkingTree(cwd: string): Promise<boolean> {
  const result = await runGit(['status', '--porcelain'], cwd)
  return result.stdout.trim().length > 0
}

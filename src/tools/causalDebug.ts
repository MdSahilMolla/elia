import type { Tool } from './types.ts'
import { optionalString } from './args.ts'
import { runShell, readBoundedOutput } from '../shell.ts'
import { resolveWorkspacePath } from '../autonomy/context.ts'

const MAX_COMMITS = 50
const MAX_BLAME_LINES = 200
const SHELL_TIMEOUT_MS = 30_000

interface CausalLink {
  commit: string
  author: string
  date: string
  message: string
  filesChanged: string[]
  confidence: number
  reason: string
}

interface CausalReport {
  targetFile: string
  targetLine?: number
  currentContent: string
  causalChain: CausalLink[]
  rootCauseCommit: CausalLink | null
  summary: string
}

function parseGitLog(output: string): Array<{ hash: string; author: string; date: string; message: string }> {
  const commits: Array<{ hash: string; author: string; date: string; message: string }> = []
  const lines = output.split('\n').filter((l) => l.trim().length > 0)
  for (const line of lines) {
    const parts = line.split('|||')
    if (parts.length >= 4) {
      commits.push({
        hash: parts[0]!.trim(),
        author: parts[1]!.trim(),
        date: parts[2]!.trim(),
        message: parts[3]!.trim(),
      })
    }
  }
  return commits
}

function parseBlame(output: string): Array<{ line: number; commit: string; author: string; content: string }> {
  const entries: Array<{ line: number; commit: string; author: string; content: string }> = []
  const lines = output.split('\n')
  let currentLine = 0
  for (const raw of lines) {
    const match = raw.match(/^([a-f0-9]{8,40})\s+(\d+)\s+\d+\s+\d+\s+(.+)/)
    if (match) {
      entries.push({
        commit: match[1]!,
        line: parseInt(match[2]!, 10),
        author: match[3]!.trim(),
        content: '',
      })
      currentLine = entries.length - 1
    } else if (raw.startsWith('\t') && currentLine >= 0 && entries[currentLine]) {
      entries[currentLine]!.content = raw.slice(1)
    }
  }
  return entries
}

function parseDiffFiles(output: string): string[] {
  return output
    .split('\n')
    .filter((l) => l.startsWith('diff --git'))
    .map((l) => {
      const match = l.match(/b\/(.+)$/)
      return match?.[1] ?? ''
    })
    .filter((f) => f.length > 0)
}

function scoreCausalLink(
  commit: { hash: string; author: string; date: string; message: string },
  targetFile: string,
  targetLine: number | undefined,
  blameEntry: { commit: string; line: number } | undefined,
  diffFiles: string[],
): number {
  let score = 0
  if (blameEntry && blameEntry.commit.startsWith(commit.hash)) score += 0.5
  if (diffFiles.includes(targetFile)) score += 0.3
  const msg = commit.message.toLowerCase()
  if (msg.includes('fix') || msg.includes('bug') || msg.includes('patch')) score += 0.1
  if (msg.includes('refactor') || msg.includes('rename') || msg.includes('move')) score += 0.05
  if (targetLine !== undefined && blameEntry && Math.abs(blameEntry.line - targetLine) < 5) score += 0.05
  return Math.min(score, 1.0)
}

export const causalDebugTool: Tool = {
  name: 'causal_debug',
  description:
    'Trace the causal history of a code location through git commits. Given a file path and optional line number, this tool runs git blame, analyzes commit history, and identifies which commits introduced or modified the code — reconstructing the full causal chain back to the root cause commit. Returns a structured report with confidence-scored causal links.',
  input_schema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Repo-relative file path to investigate' },
      line: { type: 'number', description: 'Specific line number to trace (optional)' },
      depth: { type: 'number', description: `Max commits to analyze (1-${MAX_COMMITS}, default 20)` },
      keyword: { type: 'string', description: 'Filter commits by keyword in message' },
    },
    required: ['file'],
  },
  async execute(input) {
    const file = optionalString(input.file, 'file')
    if (!file) throw new Error('file is required')
    if (typeof input.depth === 'number' && (input.depth < 1 || input.depth > MAX_COMMITS)) {
      throw new Error(`depth must be between 1 and ${MAX_COMMITS}`)
    }
    if (typeof input.line === 'number' && input.line < 1) {
      throw new Error('line must be a positive integer')
    }

    const cwd = resolveWorkspacePath('.')
    const filePath = await runShell(`git ls-files --full-name -- "${file}"`, SHELL_TIMEOUT_MS, cwd)
    const relativePath = filePath.stdout.trim() || file

    const depth = typeof input.line === 'number' && input.line > 0
      ? Math.min(Math.max(typeof input.depth === 'number' ? input.depth : 20, 1), MAX_COMMITS)
      : Math.min(Math.max(typeof input.depth === 'number' ? input.depth : 20, 1), MAX_COMMITS)
    const line = typeof input.line === 'number' && input.line > 0 ? input.line : undefined
    const keyword = optionalString(input.keyword, 'keyword')

    const currentContent = await runShell(`git show HEAD:"${relativePath}" 2>/dev/null | ${line !== undefined ? `sed -n '${line}p'` : 'head -20'}`, SHELL_TIMEOUT_MS, cwd)

    let blameResult = { stdout: '', exitCode: 1 }
    if (line !== undefined) {
      const range = `${Math.max(1, line - 5)}-${line + 5}`
      blameResult = await runShell(`git blame -L ${range} --porcelain "${relativePath}" 2>/dev/null`, SHELL_TIMEOUT_MS, cwd)
    } else {
      blameResult = await runShell(`git blame --porcelain "${relativePath}" 2>/dev/null | head -${MAX_BLAME_LINES}`, SHELL_TIMEOUT_MS, cwd)
    }

    const blameEntries = parseBlame(blameResult.stdout)
    const uniqueCommits = [...new Set(blameEntries.map((e) => e.commit))]

    let logFormat = '%h|||%an|||%ai|||%s'
    let logCmd = `git log --format="${logFormat}" -${depth} -- "${relativePath}"`
    if (keyword) {
      logCmd = `git log --format="${logFormat}" -${depth} --grep="${keyword}" -- "${relativePath}"`
    }
    const logResult = await runShell(logCmd, SHELL_TIMEOUT_MS, cwd)
    const commits = parseGitLog(logResult.stdout)

    const causalChain: CausalLink[] = []
    let rootCauseCommit: CausalLink | null = null

    for (const commit of commits) {
      const diffResult = await runShell(`git diff-tree --no-commit-id --name-only -r ${commit.hash}`, SHELL_TIMEOUT_MS, cwd)
      const diffFiles = parseDiffFiles(diffResult.stdout)

      const blameMatch = blameEntries.find((e) => e.commit.startsWith(commit.hash))
      const confidence = scoreCausalLink(commit, relativePath, line, blameMatch, diffFiles)

      if (confidence > 0.05) {
        const link: CausalLink = {
          commit: commit.hash,
          author: commit.author,
          date: commit.date,
          message: commit.message,
          filesChanged: diffFiles.slice(0, 10),
          confidence: Math.round(confidence * 100) / 100,
          reason: buildReason(commit, blameMatch, diffFiles, relativePath),
        }
        causalChain.push(link)
        if (!rootCauseCommit || link.confidence > rootCauseCommit.confidence) {
          rootCauseCommit = link
        }
      }
    }

    causalChain.sort((a, b) => b.confidence - a.confidence)

    const summary = buildSummary(relativePath, line, causalChain, rootCauseCommit)

    const report: CausalReport = {
      targetFile: relativePath,
      targetLine: line,
      currentContent: currentContent.stdout.trim(),
      causalChain: causalChain.slice(0, 15),
      rootCauseCommit,
      summary,
    }

    return formatReport(report)
  },
}

function buildReason(
  commit: { hash: string; message: string },
  blameMatch: { commit: string; line: number } | undefined,
  diffFiles: string[],
  targetFile: string,
): string {
  const reasons: string[] = []
  if (blameMatch && blameMatch.commit.startsWith(commit.hash)) {
    reasons.push(`commit authored the current line (blame match)`)
  }
  if (diffFiles.includes(targetFile)) {
    reasons.push(`modified target file (${diffFiles.length} file${diffFiles.length > 1 ? 's' : ''} changed)`)
  }
  const msg = commit.message.toLowerCase()
  if (msg.includes('fix')) reasons.push('commit message indicates a bug fix')
  if (msg.includes('refactor')) reasons.push('commit message indicates refactoring')
  if (msg.includes('add')) reasons.push('commit message indicates new code')
  if (msg.includes('remove') || msg.includes('delete')) reasons.push('commit message indicates removal')
  return reasons.length > 0 ? reasons.join('; ') : 'modified file in the causal path'
}

function buildSummary(
  file: string,
  line: number | undefined,
  chain: CausalLink[],
  root: CausalLink | null,
): string {
  const location = line !== undefined ? `${file}:${line}` : file
  if (chain.length === 0) {
    return `No causal history found for ${location}. The file may be new or have no matching commits.`
  }
  const parts = [
    `Causal analysis of ${location}:`,
    `Found ${chain.length} contributing commit${chain.length > 1 ? 's' : ''}.`,
  ]
  if (root) {
    parts.push(`Highest-confidence root cause: ${root.commit} by ${root.author} — "${root.message}" (confidence: ${Math.round(root.confidence * 100)}%)`)
  }
  const oldest = chain[chain.length - 1]
  if (oldest && oldest.commit !== root?.commit) {
    parts.push(`Oldest contributing commit: ${oldest.commit} by ${oldest.author} — "${oldest.message}"`)
  }
  return parts.join(' ')
}

function formatReport(report: CausalReport): string {
  const lines: string[] = []
  lines.push(`=== Causal Debug Report ===`)
  lines.push(`File: ${report.targetFile}${report.targetLine !== undefined ? `:${report.targetLine}` : ''}`)
  lines.push(`Current content: ${report.currentContent || '(empty)'}`)
  lines.push('')
  lines.push(report.summary)
  lines.push('')

  if (report.causalChain.length > 0) {
    lines.push('--- Causal Chain (by confidence) ---')
    for (const link of report.causalChain) {
      lines.push(`  [${Math.round(link.confidence * 100)}%] ${link.commit} by ${link.author} (${link.date})`)
      lines.push(`    "${link.message}"`)
      lines.push(`    Reason: ${link.reason}`)
      if (link.filesChanged.length > 0) {
        lines.push(`    Files: ${link.filesChanged.join(', ')}`)
      }
      lines.push('')
    }
  }

  if (report.rootCauseCommit) {
    lines.push('--- Root Cause ---')
    lines.push(`  Commit: ${report.rootCauseCommit.commit}`)
    lines.push(`  Author: ${report.rootCauseCommit.author}`)
    lines.push(`  Date: ${report.rootCauseCommit.date}`)
    lines.push(`  Message: "${report.rootCauseCommit.message}"`)
    lines.push(`  Confidence: ${Math.round(report.rootCauseCommit.confidence * 100)}%`)
    lines.push(`  Reason: ${report.rootCauseCommit.reason}`)
  }

  return lines.join('\n')
}

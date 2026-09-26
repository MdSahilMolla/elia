/**
 * Survey: what a repository is, read from its own files and history.
 *
 * No model runs here, and nothing is inferred that a file does not say. The
 * output is a list of numbered facts (`E1`, `E2`, …); the understanding step
 * may only claim what it can cite from this list or from a file that exists.
 * That is the difference between "the model thinks this repo is a CRM" and
 * "package.json#description says it is a CRM" — only the second survives.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { detectProject } from '../project.ts'
import { detectChecks } from '../autonomy/detectChecks.ts'
import { assessEnvironment } from '../autonomy/envReadiness.ts'
import { SKIP_DIRS } from '../tools/ignoreDirs.ts'
import { detectDatabase } from '../devdb/detect.ts'
import { dirtyPaths, git, isGitWorkTree } from './git.ts'
import type { Evidence, EvidenceKind, GitFacts, RepoSurvey } from './types.ts'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java', '.kt', '.rb', '.php', '.cs', '.swift', '.c', '.cc', '.cpp', '.h', '.hpp', '.scala', '.ex', '.exs', '.vue', '.svelte', '.sql', '.dart', '.lua'])
const TEST_PATTERN = /(?:^|\/)(?:tests?|__tests__|spec)\/|[._-](?:test|spec)\.[a-z]+$|_test\.(?:go|py)$|^test_[^/]*\.py$|\/test_[^/]*\.py$/i
const VISION_FILES = ['ROADMAP.md', 'VISION.md', 'TODO.md', 'PLAN.md', 'GOALS.md', 'docs/ROADMAP.md', 'docs/roadmap.md', 'CONTRIBUTING.md', 'CHANGELOG.md']
const MAX_WALK_FILES = 20_000

function readHead(path: string, maxLines: number, maxChars: number): string | undefined {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return undefined
    const text = readFileSync(path, 'utf8')
    const head = text.split(/\r?\n/).slice(0, maxLines).join('\n')
    return head.length > maxChars ? `${head.slice(0, maxChars)}…` : head
  } catch {
    return undefined
  }
}

function listFiles(root: string, gitRepo: boolean): string[] {
  if (gitRepo) {
    const listed = git(['ls-files', '--cached', '--others', '--exclude-standard'], root)
    if (listed.ok) return listed.stdout.split(/\r?\n/).filter((path) => path && !path.startsWith('.elia/')).slice(0, MAX_WALK_FILES * 5)
  }
  const out: string[] = []
  const walk = (dir: string, rel: string) => {
    if (out.length >= MAX_WALK_FILES) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= MAX_WALK_FILES) return
      if (SKIP_DIRS.includes(entry.name) || entry.name === '.elia' || (entry.name.startsWith('.') && entry.isDirectory())) continue
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(join(dir, entry.name), path)
      else if (entry.isFile()) out.push(path)
    }
  }
  walk(root, '')
  return out
}

function identity(root: string): { name: string; description?: string; source?: string } {
  const pkgText = readHead(join(root, 'package.json'), 400, 60_000)
  if (pkgText) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string; description?: string }
      return { name: pkg.name || basename(root), description: pkg.description, source: 'package.json' }
    } catch {
      // fall through to the other manifests
    }
  }
  for (const manifest of ['pyproject.toml', 'Cargo.toml']) {
    const text = readHead(join(root, manifest), 200, 20_000)
    if (!text) continue
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(text)?.[1]
    const description = /^\s*description\s*=\s*"([^"]+)"/m.exec(text)?.[1]
    if (name) return { name, description, source: manifest }
  }
  const goMod = readHead(join(root, 'go.mod'), 3, 500)
  const module = goMod ? /^module\s+(\S+)/m.exec(goMod)?.[1] : undefined
  if (module) return { name: module, source: 'go.mod' }
  return { name: basename(root) }
}

function gitFacts(root: string): GitFacts | undefined {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root)
  const head = git(['rev-parse', '--short', 'HEAD'], root)
  if (!branch.ok || !head.ok) {
    // A repository with no commits yet.
    return branch.ok ? { branch: branch.stdout, head: '', commits: 0, commitsLast30Days: 0, recentSubjects: [], hotPaths: [], dirty: dirtyPaths(root) } : undefined
  }
  const count = Number(git(['rev-list', '--count', 'HEAD'], root).stdout) || 0
  const recent = Number(git(['rev-list', '--count', '--since=30.days', 'HEAD'], root).stdout) || 0
  const first = git(['log', '--reverse', '--format=%ad', '--date=short', '--max-parents=0', 'HEAD'], root).stdout.split(/\r?\n/)[0]
  const log = git(['log', '-n', '30', '--format=%ad %s', '--date=short'], root).stdout.split(/\r?\n/).filter(Boolean)
  const touched = git(['log', '-n', '200', '--name-only', '--format='], root).stdout.split(/\r?\n/).filter(Boolean)
  const byArea = new Map<string, number>()
  for (const path of touched) {
    const parts = path.split('/')
    const area = parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts.length === 2 ? `${parts[0]}/` : path
    byArea.set(area, (byArea.get(area) ?? 0) + 1)
  }
  return {
    branch: branch.stdout,
    head: head.stdout,
    commits: count,
    commitsLast30Days: recent,
    firstCommitDate: first || undefined,
    lastCommitDate: log[0]?.slice(0, 10),
    recentSubjects: log.map((line) => line.slice(0, 160)),
    hotPaths: [...byArea.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([path, changes]) => ({ path, changes })),
    dirty: dirtyPaths(root),
  }
}

function markers(root: string, gitRepo: boolean): { count: number; lines: string[] } {
  if (!gitRepo) return { count: 0, lines: [] }
  // POSIX ERE has no \b, so git grep casts the wide net and the word boundary is checked here.
  const found = git(['grep', '-n', '-I', '-E', '(TODO|FIXME|HACK|XXX)[:( ]', '--', '.', ':!*.lock', ':!*lock.json', ':!*.min.js', ':!.elia'], root)
  // git grep exits 1 for "no matches".
  const lines = found.stdout.split(/\r?\n/).filter((line) => /(?:^|[^A-Za-z0-9_])(?:TODO|FIXME|HACK|XXX)[:( ]/.test(line.replace(/^[^:]*:\d+:/, '')))
  return { count: lines.length, lines: lines.slice(0, 40).map((line) => line.replace(/\s+/g, ' ').slice(0, 200)) }
}

function ciConfigs(files: readonly string[]): string[] {
  return files.filter((path) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) || ['.gitlab-ci.yml', '.circleci/config.yml', 'azure-pipelines.yml', 'Jenkinsfile', '.travis.yml', 'bitbucket-pipelines.yml'].includes(path))
}

/**
 * Surveys `root`. `env` feeds the database detector (a process-level
 * DATABASE_URL counts); `has` decides which toolchains are installed.
 */
export function surveyRepository(root: string, options: { env?: NodeJS.ProcessEnv; has?: (command: string) => boolean; now?: Date } = {}): RepoSurvey {
  const evidence: Evidence[] = []
  const add = (kind: EvidenceKind, source: string, text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    evidence.push({ id: `E${evidence.length + 1}`, kind, source, text: trimmed })
  }

  const gitRepo = isGitWorkTree(root)
  const who = identity(root)
  if (who.source) add('identity', who.source, `name: ${who.name}${who.description ? `\ndescription: ${who.description}` : ''}`)

  const readmeName = ['README.md', 'README.rst', 'README.txt', 'README', 'readme.md'].find((file) => existsSync(join(root, file)))
  const readme = readmeName ? readHead(join(root, readmeName), 120, 7_000) : undefined
  if (readmeName && readme) add('readme', readmeName, readme)

  for (const file of VISION_FILES) {
    const head = readHead(join(root, file), file.startsWith('CHANGELOG') ? 40 : 80, 3_500)
    if (head) add('docs', file, head)
  }

  const profile = detectProject(root)
  const files = listFiles(root, gitRepo)
  const sourceFiles = files.filter((path) => SOURCE_EXTENSIONS.has(extname(path).toLowerCase()))
  const testFiles = sourceFiles.filter((path) => TEST_PATTERN.test(path))
  const dirCounts = new Map<string, number>()
  for (const path of files) {
    const top = path.includes('/') ? `${path.split('/')[0]}/` : '(root)'
    dirCounts.set(top, (dirCounts.get(top) ?? 0) + 1)
  }
  const topDirs = [...dirCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([dir, count]) => ({ dir, files: count }))
  add('structure', 'file listing', [
    `${files.length} files; ${sourceFiles.length} source, ${testFiles.length} of them tests`,
    `stacks: ${profile.stacks.join(', ') || 'none detected'}; package manager: ${profile.packageManager}`,
    `largest areas: ${topDirs.map((entry) => `${entry.dir} (${entry.files})`).join(', ')}`,
  ].join('\n'))
  const docFiles = files.filter((path) => /^docs?\//i.test(path) && /\.(?:md|mdx|rst|txt)$/i.test(path)).slice(0, 30)
  if (docFiles.length > 0) add('docs', 'docs/', `documentation files: ${docFiles.join(', ')}`)
  if (testFiles.length > 0) add('tests', 'file listing', `test files (sample): ${testFiles.slice(0, 15).join(', ')}${testFiles.length > 15 ? ` … +${testFiles.length - 15}` : ''}`)

  const checks = detectChecks(root)
  const pkgScripts = (() => {
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
      return pkg.scripts ?? {}
    } catch {
      return {}
    }
  })()
  if (Object.keys(pkgScripts).length > 0) add('checks', 'package.json#scripts', Object.entries(pkgScripts).slice(0, 25).map(([name, command]) => `${name}: ${command}`).join('\n'))
  add('checks', 'detected verification', checks.length > 0 ? `the project's own checks: ${checks.join(' ; ')}` : 'no runnable verification command could be inferred (no test/typecheck script or known build file)')

  const history = gitRepo ? gitFacts(root) : undefined
  if (history) {
    add('git', 'git log', [
      `branch ${history.branch} @ ${history.head || '(no commits)'}; ${history.commits} commits, ${history.commitsLast30Days} in the last 30 days`,
      history.firstCommitDate ? `first commit ${history.firstCommitDate}, latest ${history.lastCommitDate}` : '',
      history.dirty.length > 0 ? `uncommitted changes: ${history.dirty.length} path(s)` : 'working tree clean',
    ].filter(Boolean).join('\n'))
    if (history.recentSubjects.length > 0) add('git', 'git log (recent subjects)', history.recentSubjects.slice(0, 25).join('\n'))
    if (history.hotPaths.length > 0) add('git', 'git log (most-changed areas, last 200 commits)', history.hotPaths.map((entry) => `${entry.path}: ${entry.changes}`).join('\n'))
  }

  const found = markers(root, gitRepo)
  if (found.count > 0) add('marker', 'git grep TODO|FIXME|HACK|XXX', `${found.count} marker(s)${found.count > found.lines.length ? ` (first ${found.lines.length})` : ''}:\n${found.lines.join('\n')}`)

  const ci = ciConfigs(files)
  if (ci.length > 0) add('ci', ci[0]!, `CI configuration: ${ci.join(', ')}`)

  const database = detectDatabase(root, options.env ?? process.env)
  if (database.signals.length > 0) add('database', 'database configuration', database.signals.join('\n'))

  const has = options.has ?? ((command: string) => Boolean(Bun.which(command)))
  const environment = assessEnvironment({ cwd: root, has, versions: {} })
  if (environment.blockers.length > 0) add('environment', 'environment readiness', environment.blockers.map((blocker) => `${blocker.what} — ${blocker.because}${blocker.fix ? ` (fix: ${blocker.fix})` : ''}`).join('\n'))

  return {
    root,
    takenAt: (options.now ?? new Date()).toISOString(),
    name: who.name,
    description: who.description,
    stacks: profile.stacks,
    packageManager: profile.packageManager,
    checks,
    git: history,
    files: { total: files.length, source: sourceFiles.length, tests: testFiles.length, topDirs },
    markerCount: found.count,
    ci,
    database: database.signals,
    environmentBlockers: environment.blockers.map((blocker) => blocker.what),
    setupCommands: environment.setup,
    evidence,
  }
}

/** The survey as the understanding model reads it: every fact under its id. */
export function renderSurvey(survey: RepoSurvey, maxChars = 30_000): string {
  const blocks = survey.evidence.map((item) => `[${item.id}] (${item.kind}; ${item.source})\n${item.text}`)
  let out = ''
  let shown = 0
  for (const block of blocks) {
    if (out.length + block.length + 2 > maxChars) {
      out += `\n\n… ${blocks.length - shown} more evidence item(s) omitted for length`
      break
    }
    out += `${out ? '\n\n' : ''}${block}`
    shown += 1
  }
  return out
}

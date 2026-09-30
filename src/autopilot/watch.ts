import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { parseScheduleInterval } from '../autonomy/scheduler.ts'
import { withFileLock } from '../fileLock.ts'
import { ensureSecureDirectory, writeSecureFile } from '../securePersistence.ts'
import { autopilotDir } from './store.ts'

/**
 * What the autopilot watches while it runs with `--watch`, so it reacts when
 * something happens instead of only when it is started: a failed CI run, a new
 * issue or pull request, a changed file or page, or a schedule. Each event
 * becomes a goal at the front of the backlog.
 *
 * Every kind is polled: nothing here needs a public address, a webhook or a
 * cloud service, so it works on a laptop. A watcher's first check records where
 * things stand and fires nothing; only what changes after that is news. A check
 * that fails (no network, `gh` not signed in) is recorded on the watcher and
 * retried at its next check. Watchers live in `.elia/autopilot/watch.json`.
 */

export type TriggerSpec =
  | { kind: 'every'; intervalMs: number }
  | { kind: 'file'; path: string }
  | { kind: 'url'; url: string }
  | { kind: 'github'; what: 'issues' | 'prs' | 'ci'; repo?: string; label?: string }

export interface Watcher {
  id: string
  spec: TriggerSpec
  /** What it has already seen: a fingerprint, or the newest id. Unset until its first check, which only records it. */
  cursor?: string
  nextCheckAt: number
  lastError?: string
}

/** How often each kind is checked. A schedule sets its own. */
const CHECK_EVERY_MS: Record<Exclude<TriggerSpec['kind'], 'every'>, number> = {
  file: 30_000,
  url: 10 * 60_000,
  github: 2 * 60_000,
}

export interface TriggerCheck {
  /** One line per thing that happened; empty when nothing did. */
  events: string[]
  /** Things that happened that no goal can fix and a person should know (see `checkGitHub`). */
  notices?: string[]
  /** A schedule came due: the pilot takes a fresh look at the whole repository rather than one goal. */
  rescan?: boolean
  cursor?: string
  nextCheckAt: number
}

export interface TriggerDeps {
  now: number
  /** Runs `gh` with these arguments in `cwd` and returns stdout; throws on a non-zero exit. */
  gh(args: string[], cwd: string): Promise<string>
  fetchText(url: string): Promise<string>
}

/** "every 1h", "file src/", "url https://…", "github issues [repo] [label:x]", "github prs", "github ci". */
export function parseTrigger(text: string): TriggerSpec {
  const [kind = '', ...rest] = text.trim().split(/\s+/)
  const arg = rest.join(' ')
  switch (kind.toLowerCase()) {
    case 'every':
      return { kind: 'every', intervalMs: parseScheduleInterval(arg) }
    case 'file':
    case 'files':
      if (!arg) throw new Error('file needs a path: file src/')
      return { kind: 'file', path: arg }
    case 'url': {
      if (!/^https:\/\//i.test(arg)) throw new Error('url needs an https:// address')
      return { kind: 'url', url: arg }
    }
    case 'github': {
      const [what = '', ...options] = rest
      if (what !== 'issues' && what !== 'prs' && what !== 'ci') throw new Error('github watches issues, prs or ci: github issues [owner/repo] [label:bug]')
      const label = options.find((option) => option.startsWith('label:'))?.slice('label:'.length)
      const repo = options.find((option) => /^[\w.-]+\/[\w.-]+$/.test(option))
      return { kind: 'github', what, ...(repo ? { repo } : {}), ...(label ? { label } : {}) }
    }
    default:
      throw new Error(`unknown watcher "${kind}": use every, file, url, or github`)
  }
}

export function describeTrigger(spec: TriggerSpec): string {
  switch (spec.kind) {
    case 'every': {
      const hours = spec.intervalMs / 3_600_000
      return hours >= 1 && Number.isInteger(hours) ? `every ${hours}h` : `every ${Math.round(spec.intervalMs / 60_000)}m`
    }
    case 'file':
      return `when ${spec.path} changes`
    case 'url':
      return `when ${spec.url} changes`
    case 'github':
      return `on new ${spec.what === 'ci' ? 'failed CI runs' : `GitHub ${spec.what === 'prs' ? 'pull requests' : 'issues'}`}${spec.repo ? ` in ${spec.repo}` : ''}${spec.label ? ` labelled ${spec.label}` : ''}`
  }
}

/** Checks one watcher. */
export async function checkTrigger(trigger: Watcher, workspace: string, deps: TriggerDeps): Promise<TriggerCheck> {
  const spec = trigger.spec
  if (spec.kind === 'every') {
    return { events: [], rescan: true, cursor: trigger.cursor, nextCheckAt: deps.now + spec.intervalMs }
  }
  const nextCheckAt = deps.now + CHECK_EVERY_MS[spec.kind]
  if (spec.kind === 'file') {
    const root = isAbsolute(spec.path) ? spec.path : resolve(workspace, spec.path)
    const files = fileFingerprints(root)
    const cursor = hash(JSON.stringify(files))
    if (trigger.cursor === undefined || trigger.cursor === cursor) return { events: [], cursor, nextCheckAt }
    return { events: [`Files changed under ${spec.path} (${files.length} file(s) there now). Look at what is new before acting.`], cursor, nextCheckAt }
  }
  if (spec.kind === 'url') {
    const cursor = hash(normalizePage(await deps.fetchText(spec.url)))
    if (trigger.cursor === undefined || trigger.cursor === cursor) return { events: [], cursor, nextCheckAt }
    return { events: [`${spec.url} changed since it was last checked.`], cursor, nextCheckAt }
  }
  return checkGitHub(spec, trigger.cursor, workspace, deps, nextCheckAt)
}

async function checkGitHub(spec: Extract<TriggerSpec, { kind: 'github' }>, cursor: string | undefined, workspace: string, deps: TriggerDeps, nextCheckAt: number): Promise<TriggerCheck> {
  const repo = spec.repo ? ['--repo', spec.repo] : []
  if (spec.what === 'ci') {
    const runs = JSON.parse(await deps.gh(['run', 'list', ...repo, '--limit', '20', '--json', 'databaseId,conclusion,name,headBranch,url'], workspace)) as Array<{ databaseId: number; conclusion: string; name: string; headBranch: string; url: string }>
    const newest = Math.max(0, ...runs.map((run) => run.databaseId))
    const seen = cursor === undefined ? undefined : Number(cursor)
    const failed = seen === undefined ? [] : runs.filter((run) => run.databaseId > seen && run.conclusion === 'failure')
    // A run whose jobs never ran a step failed before any code did: a billing
    // block, no runners, a broken workflow file. elia's own CI failed that way
    // on every push (2026-09-30), and each would have been a goal no change to
    // the code could land. A person gets told instead.
    const events: string[] = []
    const notices: string[] = []
    for (const run of failed) {
      const jobs = await deps.gh(['run', 'view', String(run.databaseId), ...repo, '--json', 'jobs'], workspace)
        .then((text) => (JSON.parse(text) as { jobs?: Array<{ steps?: unknown[] }> }).jobs ?? [])
        .catch(() => undefined)
      if (jobs && jobs.length > 0 && jobs.every((job) => (job.steps ?? []).length === 0)) {
        notices.push(`CI run ${run.name} on ${run.headBranch} failed before any step ran (billing, runners or the workflow file; not the code): ${run.url}`)
      } else events.push(`CI run failed: ${run.name} on ${run.headBranch} (${run.url}).`)
    }
    return { events, notices, cursor: String(Math.max(newest, seen ?? 0)), nextCheckAt }
  }
  const label = spec.label ? ['--label', spec.label] : []
  const items = JSON.parse(await deps.gh([spec.what === 'prs' ? 'pr' : 'issue', 'list', ...repo, ...label, '--state', 'open', '--limit', '30', '--json', 'number,title,url,author'], workspace)) as Array<{ number: number; title: string; url: string; author?: { login?: string } }>
  const newest = Math.max(0, ...items.map((item) => item.number))
  const seen = cursor === undefined ? undefined : Number(cursor)
  const fresh = seen === undefined ? [] : items.filter((item) => item.number > seen).sort((a, b) => a.number - b.number)
  const noun = spec.what === 'prs' ? 'pull request' : 'issue'
  return {
    events: fresh.map((item) => `New ${noun} #${item.number}${item.author?.login ? ` by ${item.author.login}` : ''}: ${item.title} (${item.url}).`),
    cursor: String(Math.max(newest, seen ?? 0)),
    nextCheckAt,
  }
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.elia', 'dist', 'build', '.next', '__pycache__', '.venv', 'target'])
const MAX_FILES = 5_000

/** Path, size and modification time of every file under `root` (or `root` itself), sorted: a change to any of them changes the fingerprint. */
export function fileFingerprints(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries.sort()) {
      if (out.length >= MAX_FILES) return
      if (SKIP_DIRS.has(name)) continue
      const full = join(dir, name)
      try {
        const stat = statSync(full)
        if (stat.isDirectory()) walk(full)
        else out.push(`${relative(root, full)}:${stat.size}:${Math.floor(stat.mtimeMs)}`)
      } catch {
        // Vanished between listing and stat: it is simply not there.
      }
    }
  }
  try {
    const stat = statSync(root)
    if (stat.isDirectory()) walk(root)
    else out.push(`:${stat.size}:${Math.floor(stat.mtimeMs)}`)
  } catch {
    // A path that does not exist yet has an empty fingerprint; creating it is a change.
  }
  return out
}

/** Page text without what changes on every load (timestamps, nonces, script bodies), so only real edits count. */
export function normalizePage(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b|\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}

// The watch list: `.elia/autopilot/watch.json`, shared by the CLI that edits
// it and the pilot that checks it, under a lock.

function watchFile(root: string): string {
  return join(autopilotDir(root), 'watch.json')
}

export function loadWatchers(root: string): Watcher[] {
  const file = watchFile(root)
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { watchers?: Watcher[] }
    return Array.isArray(parsed.watchers) ? parsed.watchers.filter((watcher) => watcher && typeof watcher.id === 'string' && watcher.spec) : []
  } catch {
    return []
  }
}

function changeWatchers<T>(root: string, change: (watchers: Watcher[]) => T): T {
  ensureSecureDirectory(autopilotDir(root))
  const file = watchFile(root)
  return withFileLock(`${file}.lock`, () => {
    const watchers = loadWatchers(root)
    const result = change(watchers)
    writeSecureFile(file, `${JSON.stringify({ watchers }, null, 2)}\n`)
    return result
  })
}

export function addWatcher(root: string, spec: TriggerSpec, now = Date.now()): Watcher {
  return changeWatchers(root, (watchers) => {
    const watcher: Watcher = {
      id: `w${now.toString(36)}${watchers.length}`,
      spec,
      // A schedule's first run is one interval away; anything else checks now, to record where things stand.
      nextCheckAt: spec.kind === 'every' ? now + spec.intervalMs : now,
    }
    watchers.push(watcher)
    return watcher
  })
}

export function removeWatcher(root: string, id: string): boolean {
  return changeWatchers(root, (watchers) => {
    const index = watchers.findIndex((watcher) => watcher.id === id)
    if (index === -1) return false
    watchers.splice(index, 1)
    return true
  })
}

/**
 * Checks every watcher that is due and returns what happened, one line per
 * event, and what only a person can act on. Cursors and errors are saved as it goes, so an event is reported
 * once, even across a restart.
 */
export async function pollWatchers(root: string, deps: TriggerDeps): Promise<{ events: string[]; notices: string[]; rescan: boolean }> {
  const events: string[] = []
  const notices: string[] = []
  let rescan = false
  for (const watcher of loadWatchers(root)) {
    if (watcher.nextCheckAt > deps.now) continue
    let update: Partial<Watcher>
    try {
      const result = await checkTrigger(watcher, root, deps)
      events.push(...result.events)
      notices.push(...(result.notices ?? []))
      rescan ||= result.rescan === true
      update = { cursor: result.cursor, nextCheckAt: result.nextCheckAt, lastError: undefined }
    } catch (error) {
      update = { nextCheckAt: deps.now + 5 * 60_000, lastError: error instanceof Error ? error.message.slice(0, 300) : String(error) }
    }
    changeWatchers(root, (watchers) => {
      const saved = watchers.find((candidate) => candidate.id === watcher.id)
      if (saved) Object.assign(saved, update)
    })
  }
  return { events, notices, rescan }
}

/** The real `gh` and page fetch the pilot uses; tests pass their own. */
export async function runGh(args: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(['gh', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${err.trim().split('\n')[0] ?? `exit ${code}`}`)
  return out
}

export async function fetchPage(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'elia-autopilot/1 (change watcher)' } })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return (await response.text()).slice(0, 2_000_000)
}

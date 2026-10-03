import { DEFAULT_HORIZON_DAYS, FIX_SUBJECT } from './basket.ts'
import { countBlame, isCounted, isCountedPath, isDocPath, parseNameStatus, parseRemovedLines } from './git.ts'
import type { Commit, Git, History, PathFate } from './git.ts'

const DAY = 86_400

export interface Outcome {
  sha: string
  subject: string
  /** When the commit reached the ref, epoch seconds. */
  landedAt: number
  /** Lines added and removed in counted files. */
  added: number
  deleted: number
  files: number
  kind: 'code' | 'doc'
  /** Share of added lines still attributed to this commit at the horizon; undefined when it added none we could follow. */
  lineSurvival?: number
  /** Added lines no longer attributed to this commit at the horizon. */
  died: number
  /** Added lines a later fix removed or rewrote inside the horizon (SZZ). */
  fixKilled: number
  reverted: boolean
  fixedAfter: boolean
}

export interface Measured {
  outcomes: Outcome[]
  /** Landed too recently for the full horizon to have passed: not yet knowable, so not counted as good or bad. */
  censored: number
  /** Touched only excluded or binary files. */
  noCountedFiles: number
  /** Files git blame could not read at the snapshot, left out of both sides of the ratio. */
  unreadableFiles: number
}

export interface MeasureOptions {
  horizonDays?: number
  jobs?: number
  onProgress?: (phase: 'paths' | 'blame', done: number, total: number) => void
}

const fixSubject = new RegExp(FIX_SUBJECT, 'i')

/** Runs `work` over `items` with at most `limit` in flight. */
async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>, onDone?: () => void): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++]!
      await work(item)
      onDone?.()
    }
  })
  await Promise.all(runners)
}

/** Earliest revert of each commit, from the "This reverts commit" line git writes. */
export function revertsOf(commits: Iterable<Commit>): Map<string, number> {
  const reverted = new Map<string, number>()
  for (const commit of commits) {
    for (const match of commit.body.matchAll(/This reverts commit ([0-9a-f]{40})/g)) {
      const sha = match[1]!
      const seen = reverted.get(sha)
      if (seen === undefined || commit.time < seen) reverted.set(sha, commit.time)
    }
  }
  return reverted
}

interface Pending {
  commit: Commit
  landedAt: number
  horizonEnd: number
  snapshot: string
  counted: Commit['changes']
  fate?: PathFate
}

export async function measureOutcomes(git: Git, history: History, options: MeasureOptions = {}): Promise<Measured> {
  const horizonDays = options.horizonDays ?? DEFAULT_HORIZON_DAYS
  const jobs = options.jobs ?? 8
  const { commits, chain, integratedBy } = history
  const chainIndex = new Map(chain.map((sha, index) => [sha, index]))
  const tipTime = chain.length ? commits.get(chain[chain.length - 1]!)!.time : 0
  const reverts = revertsOf(commits.values())
  const fixes = [...commits.values()].filter((commit) => commit.parents.length === 1 && fixSubject.test(commit.subject))

  let censored = 0
  let noCountedFiles = 0
  const pending: Pending[] = []
  for (const commit of commits.values()) {
    if (commit.parents.length > 1) continue
    const landedBy = integratedBy.get(commit.sha)
    const start = landedBy === undefined ? undefined : chainIndex.get(landedBy)
    if (landedBy === undefined || start === undefined) continue
    const counted = commit.changes.filter(isCounted)
    if (counted.length === 0) {
      noCountedFiles += 1
      continue
    }
    const landedAt = commits.get(landedBy)!.time
    const horizonEnd = landedAt + horizonDays * DAY
    if (tipTime < horizonEnd) {
      censored += 1
      continue
    }
    let at = start
    while (at + 1 < chain.length && commits.get(chain[at + 1]!)!.time <= horizonEnd) at += 1
    pending.push({ commit, landedAt, horizonEnd, snapshot: chain[at]!, counted })
  }

  // Where each file a commit added lines to ended up by its snapshot: blame follows a
  // rename on its own, but only if it is asked about the path that exists there.
  let done = 0
  await pool(pending, jobs, async (item) => {
    try {
      item.fate = parseNameStatus(await git(['diff', '-M', '--name-status', '-z', item.commit.sha, item.snapshot]))
    } catch {
      item.fate = { renamed: new Map(), deleted: new Set() }
    }
  }, () => options.onProgress?.('paths', ++done, pending.length))

  const blames = new Map<string, Map<string, number> | null>()
  const keys = new Map<string, { snapshot: string; path: string }>()
  for (const item of pending) {
    for (const change of item.counted) {
      if (change.added === 0 || item.fate!.deleted.has(change.path)) continue
      const path = item.fate!.renamed.get(change.path) ?? change.path
      keys.set(`${item.snapshot}\0${path}`, { snapshot: item.snapshot, path })
    }
  }
  const unique = [...keys.entries()]
  done = 0
  await pool(unique, jobs, async ([key, { snapshot, path }]) => {
    try {
      blames.set(key, countBlame(await git(['blame', '--line-porcelain', '-w', snapshot, '--', path])))
    } catch {
      blames.set(key, null)
    }
  }, () => options.onProgress?.('blame', ++done, unique.length))

  // SZZ: the lines a fix removed belong to whichever commits last touched them.
  const earliest = pending.reduce((least, item) => Math.min(least, item.commit.time), Number.POSITIVE_INFINITY)
  const implicated = new Map<string, Map<string, number>>()
  await pool(fixes.filter((fix) => fix.time >= earliest), jobs, async (fix) => {
    const found = new Map<string, number>()
    try {
      for (const file of parseRemovedLines(await git(['show', '-U0', '-M', '--format=', '--no-color', fix.sha]))) {
        if (!isCountedPath(file.path)) continue
        try {
          const ranges = file.ranges.flatMap(([start, count]) => ['-L', `${start},${start + count - 1}`])
          for (const [sha, lines] of countBlame(await git(['blame', '--line-porcelain', '-w', ...ranges, `${fix.sha}^`, '--', file.path]))) found.set(sha, (found.get(sha) ?? 0) + lines)
        } catch {
          // A file blame cannot read implicates nobody rather than everybody.
        }
      }
    } catch {
      // A fix git cannot diff implicates nobody.
    }
    implicated.set(fix.sha, found)
  })

  let unreadableFiles = 0
  const outcomes: Outcome[] = []
  for (const item of pending) {
    const { commit, fate } = item
    let added = 0
    let deleted = 0
    let survivors = 0
    for (const change of item.counted) {
      deleted += change.deleted
      if (change.added === 0) continue
      if (fate!.deleted.has(change.path)) {
        added += change.added
        continue
      }
      const path = fate!.renamed.get(change.path) ?? change.path
      const blame = blames.get(`${item.snapshot}\0${path}`)
      if (!blame) {
        unreadableFiles += 1
        continue
      }
      added += change.added
      survivors += Math.min(blame.get(commit.sha) ?? 0, change.added)
    }
    const revertedAt = reverts.get(commit.sha)
    const fixKilled = fixes.reduce((lines, fix) => (fix.sha !== commit.sha && fix.time > commit.time && fix.time <= item.horizonEnd ? lines + (implicated.get(fix.sha)?.get(commit.sha) ?? 0) : lines), 0)
    const outcome: Outcome = {
      sha: commit.sha,
      subject: commit.subject,
      landedAt: item.landedAt,
      added,
      deleted,
      files: item.counted.length,
      kind: item.counted.every((change) => isDocPath(change.path)) ? 'doc' : 'code',
      died: added - survivors,
      fixKilled,
      reverted: revertedAt !== undefined && revertedAt >= commit.time && revertedAt <= item.horizonEnd,
      fixedAfter: fixKilled > 0,
    }
    if (added > 0) outcome.lineSurvival = survivors / added
    outcomes.push(outcome)
  }
  return { outcomes, censored, noCountedFiles, unreadableFiles }
}

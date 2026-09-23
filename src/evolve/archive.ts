import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { appendSecureFile, ensureSecureDirectory } from '../securePersistence.ts'

/**
 * The search archive of §4: stepping stones, kept.
 *
 * Proposition 4 is the reason: a target that needs `m` sequential improvements
 * takes `q^(−m)` samples when every attempt starts from scratch, and `m/q`
 * when each partial step is kept and built on. With q = 0.1 and m = 8 that is
 * a hundred million samples against eighty.
 *
 * `elia evolve` started every generation from scratch. A candidate that moved
 * the shown tasks the right way but not far enough to clear the gate was
 * deleted with its sandbox (or pruned five generations later), and the next
 * generation re-derived the same partial idea or never found it again. This
 * keeps them: every measured candidate that improved the tasks the proposer
 * was shown is archived with the exact files it changed and the hashes those
 * files were derived from, and the archive keeps one elite per niche — the
 * quality-diversity scheme (MAP-Elites) that the paper recommends because a
 * greedy archive stalls on deceptive landscapes.
 *
 * A later proposer is shown the elites and may name one to build on; the
 * engine then lays that elite's files into the new sandbox before the builder
 * starts — but only files whose base is unchanged since the elite was made, so
 * a stale stepping stone never overwrites work that landed since.
 *
 * Quality is measured on the shown half only. The archive is part of what the
 * proposer reads, and ranking it by held-out results would leak them (I2).
 */

export interface ArchiveEntry {
  id: string
  generation: number
  at: number
  hypothesis: string
  /** Behaviour descriptor: which part of elia the change lives in. */
  area: string
  /** Behaviour descriptor: which task family it moved. */
  target: string
  /** Mean paired gain on the tasks the proposer was shown. */
  shownQuality: number
  verdict: string
  reason: string
  /** Repo-relative files, with the base hash each was derived from. */
  files: Array<{ path: string; baseHash: string | null }>
}

export function archiveDir(evolutionDir: string): string {
  return join(evolutionDir, 'archive')
}

function indexPath(dir: string): string {
  return join(dir, 'index.jsonl')
}

/** Where a change lives, coarsely: `autonomy`, `tools`, `agent-loop`, `prompts`… */
export function areaOf(files: readonly string[]): string {
  const areas = new Set(
    files.map((file) => {
      const parts = file.replace(/\\/g, '/').split('/')
      if (parts[0] !== 'src') return parts[0] ?? 'root'
      if (parts.length === 2) return parts[1]!.replace(/\.tsx?$/, '')
      return parts[1] ?? 'src'
    }),
  )
  if (areas.size === 0) return 'none'
  return areas.size === 1 ? [...areas][0]! : 'cross-cutting'
}

/** Which family of tasks a change moved, from the ids that gained: `hist`, `hard`, `field`, or the synthetic set. */
export function targetOf(gainedTaskIds: readonly string[]): string {
  const families = new Set(gainedTaskIds.map((id) => (/^(hist|hard|field|swe|arc)-/.exec(id)?.[1] ?? 'synthetic')))
  if (families.size === 0) return 'none'
  return families.size === 1 ? [...families][0]! : 'mixed'
}

export interface NearMiss {
  generation: number
  hypothesis: string
  verdict: string
  reason: string
  sandboxRoot: string
  changedFiles: readonly string[]
  /** The sandbox's per-file hashes at the moment it was created. */
  base: ReadonlyMap<string, string> | undefined
  shownQuality: number
  gainedShown: readonly string[]
}

/**
 * Archives a measured candidate that moved the shown tasks the right way.
 * Returns the entry, or `undefined` when it did not qualify. Never throws — the
 * archive is an accelerant, and losing a stone must not lose a generation.
 */
export function archiveNearMiss(miss: NearMiss, evolutionDir: string): ArchiveEntry | undefined {
  if (miss.shownQuality <= 0 || miss.changedFiles.length === 0) return undefined
  const dir = archiveDir(evolutionDir)
  const id = `gen-${miss.generation}`
  try {
    const files: ArchiveEntry['files'] = []
    for (const path of miss.changedFiles) {
      const from = join(miss.sandboxRoot, path)
      if (existsSync(from)) {
        const to = join(dir, id, 'files', path)
        mkdirSync(dirname(to), { recursive: true })
        copyFileSync(from, to)
      }
      files.push({ path, baseHash: miss.base?.get(path) ?? null })
    }
    const entry: ArchiveEntry = {
      id,
      generation: miss.generation,
      at: Date.now(),
      hypothesis: miss.hypothesis,
      area: areaOf(miss.changedFiles),
      target: targetOf(miss.gainedShown),
      shownQuality: miss.shownQuality,
      verdict: miss.verdict,
      reason: miss.reason.slice(0, 300),
      files,
    }
    ensureSecureDirectory(dir)
    appendSecureFile(indexPath(dir), `${JSON.stringify(entry)}\n`)
    return entry
  } catch {
    return undefined
  }
}

export function readArchive(evolutionDir: string): ArchiveEntry[] {
  const path = indexPath(archiveDir(evolutionDir))
  if (!existsSync(path)) return []
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as ArchiveEntry]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

/** One elite per (area, target) niche: the highest shown quality, newest on a tie. */
export function elites(entries: readonly ArchiveEntry[]): ArchiveEntry[] {
  const best = new Map<string, ArchiveEntry>()
  for (const entry of entries) {
    if (entry.verdict === 'promoted') continue // already in the source; nothing to build on
    const niche = `${entry.area}|${entry.target}`
    const incumbent = best.get(niche)
    if (!incumbent || entry.shownQuality > incumbent.shownQuality || (entry.shownQuality === incumbent.shownQuality && entry.at > incumbent.at)) {
      best.set(niche, entry)
    }
  }
  return [...best.values()].sort((a, b) => b.shownQuality - a.shownQuality)
}

/** The stepping-stones section of the proposer's brief. Empty when there are none. */
export function renderSteppingStones(stones: readonly ArchiveEntry[], limit = 5): string {
  if (stones.length === 0) return ''
  const lines = stones.slice(0, limit).map(
    (stone) =>
      `- ${stone.id} [${stone.area} → ${stone.target}]: ${stone.hypothesis} — moved the shown tasks ${(stone.shownQuality * 100).toFixed(1)} pts, then ${stone.verdict}: ${stone.reason}`,
  )
  return `

## Stepping stones
Earlier candidates that moved the shown tasks the right way but did not clear the gate. Each is kept whole. If one is a better starting point than the current source, pass its id as \`buildOn\` in submit_hypothesis: its files are laid into your copy before the builder starts, and your hypothesis is the next step on top of it.
${lines.join('\n')}`
}

export interface ApplyResult {
  applied: string[]
  /** Files skipped because the source moved on since the stone was made. */
  stale: string[]
}

/**
 * Lays an archived elite's files into a fresh sandbox — each one only if the
 * sandbox's copy still has the hash the elite was derived from. A file the
 * elite deleted is deleted.
 */
export function applySteppingStone(entry: ArchiveEntry, evolutionDir: string, sandboxRoot: string, base: ReadonlyMap<string, string> | undefined): ApplyResult {
  const result: ApplyResult = { applied: [], stale: [] }
  for (const file of entry.files) {
    const current = base?.get(file.path) ?? null
    if (current !== file.baseHash) {
      result.stale.push(file.path)
      continue
    }
    const stored = join(archiveDir(evolutionDir), entry.id, 'files', file.path)
    const target = join(sandboxRoot, file.path)
    if (existsSync(stored)) {
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(stored, target)
    } else {
      rmSync(target, { force: true })
    }
    result.applied.push(file.path)
  }
  return result
}

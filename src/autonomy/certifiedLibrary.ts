import { existsSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { appendSecureFile, ensureSecureDirectory, hardenSecureFile, writeSecureFile } from '../securePersistence.ts'
import { stateDir } from '../statePaths.ts'
import { errorThreshold, soundFraction } from '../compounding/theory.ts'
import { wilson, type RateEstimate } from '../compounding/stats.ts'

/**
 * The library of §2 and §5: what elia keeps outside its weights, with a
 * certificate on every entry.
 *
 * A frozen model learns only through what it keeps, so the library is the part
 * that compounds — and Theorem 1 says it also rots. Each artifact derived from
 * an unsound parent is unsound; each admission lets some slips through; unless
 * reuse favours sound artifacts (σ > 1) and an audit purges the ones that got
 * in, unsound knowledge takes over regardless of how much compute is spent.
 * elia's lessons had none of that: any sentence a model submitted went into
 * every later prompt, and one of them ("create a placeholder if the import is
 * missing") drove a run to fabricate a skill.
 *
 * So every artifact here carries:
 * - provenance: where it came from and what it was derived from (`deps`), so an
 *   audit can find everything downstream of an artifact that turns out unsound;
 * - a certificate: the checks it passed, each tagged with the *failure mode* of
 *   the checker, because §3.2 says two checkers of one kind are nearly one;
 * - a status the retrieval side obeys: `admitted` artifacts are preferred,
 *   `probation` ones are usable but must earn a second check, `quarantined` and
 *   `purged` ones are never retrieved.
 *
 * Storage is an append-only event log folded on read — the same shape as the
 * lesson-efficacy log — so a crash mid-write costs one event, not the library.
 */

export type ArtifactKind = 'lesson' | 'skill' | 'verifier' | 'failure' | 'strategy'

/** §9.1's verifier lattice, cheapest first. */
export type Tier = 'exact' | 'world-model' | 'critic' | 'empirical'

export interface Check {
  /** What ran, e.g. `lesson-hygiene`, `bun test`, `randomized-trial`. */
  verifier: string
  tier: Tier
  /**
   * The checker's failure mode. Two passes only count as independent when
   * their families differ: a test the builder wrote and the builder's own
   * report are one family, not two.
   */
  family: string
  passed: boolean
  at: number
  detail?: string
}

export type ArtifactStatus = 'probation' | 'admitted' | 'quarantined' | 'purged'

export interface Artifact {
  id: string
  kind: ArtifactKind
  summary: string
  source: string
  /** False for anything that came from outside elia's own verified work — §14's quarantined tier. */
  trusted: boolean
  deps: string[]
  /** Verified steps this derivation added — the `L` of §5. One for a lesson, more for a tool built on others. */
  leap: number
  checks: Check[]
  status: ArtifactStatus
  /** Why the status is what it is, in one line. */
  reason: string
  createdAt: number
  updatedAt: number
  /** Times retrieval handed this artifact to a model — the reuse that σ is measured over. */
  reuse: number
  /** Set when an audit (not admission) purged it: the slips §5.3's repair caught. */
  purgedByAudit?: boolean
}

export interface AdmissionPolicy {
  /** Independent passing checks required for `admitted` — §5.3's proofreading depth. */
  k: number
}

export const DEFAULT_POLICY: Record<ArtifactKind, AdmissionPolicy> = {
  lesson: { k: 2 },
  skill: { k: 2 },
  verifier: { k: 2 },
  failure: { k: 1 },
  strategy: { k: 2 },
}

type LibraryEvent =
  | { type: 'register'; at: number; artifact: Omit<Artifact, 'checks' | 'status' | 'reason' | 'updatedAt' | 'reuse'> }
  | { type: 'check'; at: number; id: string; check: Check }
  | { type: 'purge'; at: number; id: string; reason: string; audit: boolean }
  | { type: 'reuse'; at: number; ids: string[] }

/**
 * Where the library, the resource governor's activity log and the tool-build log
 * live: `<state>/compounding/`.
 *
 * They used to live under `<state>/vde/`. Each call moves across whatever is
 * still there, so no certificate or observation is lost — including lines an
 * older elia process appended after the first move. Every file here is an
 * append-only log folded on read, so when both copies exist the old lines go
 * first. A file another process holds open stays behind until a later call.
 */
export function compoundingStateDir(base = stateDir): string {
  const dir = join(base, 'compounding')
  const legacy = join(base, 'vde')
  if (existsSync(legacy)) {
    try {
      ensureSecureDirectory(dir)
      for (const name of readdirSync(legacy)) {
        const from = join(legacy, name)
        const to = join(dir, name)
        if (!existsSync(to)) {
          renameSync(from, to)
          continue
        }
        const older = readFileSync(from, 'utf8')
        writeSecureFile(to, `${older}${older.length > 0 && !older.endsWith('\n') ? '\n' : ''}${readFileSync(to, 'utf8')}`)
        rmSync(from)
      }
      if (readdirSync(legacy).length === 0) rmdirSync(legacy)
    } catch {
      // Locked or half-moved: what is here is read now, the rest on a later call.
    }
  }
  return dir
}

export function libraryPath(dir = compoundingStateDir()): string {
  return join(dir, 'library.jsonl')
}

function append(event: LibraryEvent, path: string): void {
  try {
    ensureSecureDirectory(dirname(path))
    appendSecureFile(path, `${JSON.stringify(event)}\n`)
  } catch {
    // The library is evidence about memory, not memory itself: losing an event
    // costs a data point and never the turn that produced it.
  }
}

/** Independent passing checks: distinct failure-mode families among the passes. */
export function independentPasses(checks: readonly Check[]): number {
  return new Set(checks.filter((check) => check.passed).map((check) => check.family)).size
}

/** What an artifact's certificate earns it under a policy. Purges are sticky and decided elsewhere. */
export function statusFor(artifact: Pick<Artifact, 'trusted' | 'checks' | 'kind'>, policy = DEFAULT_POLICY[artifact.kind]): { status: ArtifactStatus; reason: string } {
  const failed = artifact.checks.find((check) => !check.passed)
  if (failed) return { status: 'quarantined', reason: `failed ${failed.verifier}${failed.detail ? `: ${failed.detail}` : ''}` }
  const vouched = artifact.checks.some((check) => check.passed && (check.family === 'human' || check.tier === 'exact'))
  if (!artifact.trusted && !vouched) return { status: 'quarantined', reason: 'untrusted source — never retrieved until a human or an exact check vouches for it' }
  const passes = independentPasses(artifact.checks)
  if (passes >= policy.k) return { status: 'admitted', reason: `${passes} independent check(s) passed` }
  return { status: 'probation', reason: `${passes} of ${policy.k} independent checks — usable, not yet certified` }
}

export function readLibrary(path = libraryPath()): Map<string, Artifact> {
  const artifacts = new Map<string, Artifact>()
  if (!existsSync(path)) return artifacts
  hardenSecureFile(path)
  let lines: string[]
  try {
    lines = readFileSync(path, 'utf8').split('\n')
  } catch {
    return artifacts
  }
  for (const line of lines) {
    if (!line.trim()) continue
    let event: LibraryEvent
    try {
      event = JSON.parse(line) as LibraryEvent
    } catch {
      continue
    }
    if (event.type === 'register') {
      if (artifacts.has(event.artifact.id)) continue
      artifacts.set(event.artifact.id, { ...event.artifact, checks: [], status: 'probation', reason: '', updatedAt: event.at, reuse: 0 })
    } else if (event.type === 'check') {
      const artifact = artifacts.get(event.id)
      if (artifact) {
        artifact.checks.push(event.check)
        artifact.updatedAt = event.at
      }
    } else if (event.type === 'purge') {
      const artifact = artifacts.get(event.id)
      if (artifact) {
        if (event.audit) {
          // An audit purge only records a slip if the artifact still stood on
          // what it carried in — a quarantined descendant swept by the
          // provenance cascade was caught at admission, never sold as sound, so
          // it must not count in ε. Judge it on its pre-audit evidence: discount
          // the audit's own freshly-recorded failing checks (family `audit`),
          // which are what quarantine the very tools this audit is re-checking.
          // `randomized-trial` and every other failing check is pre-existing
          // evidence and stays; `retireLessons` never even records one.
          const carriedIn = statusFor({ ...artifact, checks: artifact.checks.filter((check) => !(check.family.startsWith('audit') && !check.passed)) })
          if (carriedIn.status !== 'quarantined') artifact.purgedByAudit = true
        }
        artifact.status = 'purged'
        artifact.reason = event.reason
        artifact.updatedAt = event.at
      }
    } else if (event.type === 'reuse') {
      for (const id of event.ids) {
        const artifact = artifacts.get(id)
        if (artifact) artifact.reuse += 1
      }
    }
  }
  for (const artifact of artifacts.values()) {
    if (artifact.status === 'purged') continue
    const { status, reason } = statusFor(artifact)
    artifact.status = status
    artifact.reason = reason
  }
  return artifacts
}

export interface RegisterInput {
  id: string
  kind: ArtifactKind
  summary: string
  source: string
  trusted?: boolean
  deps?: string[]
  leap?: number
  checks?: Check[]
}

/** Records a new artifact and the checks it arrived with. A second registration of the same id only adds checks. */
export function registerArtifact(input: RegisterInput, path = libraryPath(), known = readLibrary(path)): Artifact {
  const at = Date.now()
  if (!known.has(input.id)) {
    append(
      {
        type: 'register',
        at,
        artifact: {
          id: input.id,
          kind: input.kind,
          summary: input.summary.slice(0, 400),
          source: input.source,
          trusted: input.trusted ?? true,
          deps: input.deps ?? [],
          leap: Math.max(1, input.leap ?? 1),
          createdAt: at,
        },
      },
      path,
    )
  }
  for (const check of input.checks ?? []) append({ type: 'check', at, id: input.id, check }, path)
  const artifact = readLibrary(path).get(input.id)
  if (!artifact) throw new Error(`library write for ${input.id} did not land`)
  return artifact
}

export function recordCheck(id: string, check: Check, path = libraryPath()): void {
  append({ type: 'check', at: Date.now(), id, check }, path)
}

/**
 * Purges an artifact and, because descendants of an unsound artifact are
 * unsound (§5.1), everything that lists it as a dependency. Returns every id
 * purged.
 */
export function purgeArtifact(id: string, reason: string, options: { audit?: boolean; path?: string } = {}): string[] {
  const path = options.path ?? libraryPath()
  const artifacts = readLibrary(path)
  const purged: string[] = []
  const queue = [id]
  while (queue.length > 0) {
    const next = queue.shift()!
    const artifact = artifacts.get(next)
    if (!artifact || artifact.status === 'purged' || purged.includes(next)) continue
    append({ type: 'purge', at: Date.now(), id: next, reason: next === id ? reason : `depends on purged ${id}`, audit: options.audit ?? false }, path)
    purged.push(next)
    for (const child of artifacts.values()) if (child.deps.includes(next)) queue.push(child.id)
  }
  return purged
}

export function recordReuse(ids: readonly string[], path = libraryPath()): void {
  if (ids.length > 0) append({ type: 'reuse', at: Date.now(), ids: [...ids] }, path)
}

/** Whether retrieval may hand this artifact to a model. Unknown ids predate the library and stay usable. */
export function retrievable(artifact: Artifact | undefined): boolean {
  return !artifact || artifact.status === 'admitted' || artifact.status === 'probation'
}

// --- The threshold monitor (§5, rule R2) ---------------------------------------

export interface LibraryHealth {
  total: number
  byStatus: Record<ArtifactStatus, number>
  /**
   * Observed slip rate ε: of the artifacts that were admitted or on probation
   * and later audited, how many the audit purged. Only audited artifacts count
   * — an artifact nobody re-checked says nothing about slips.
   */
  slip: RateEstimate
  /**
   * σ, the reuse advantage of certified artifacts over uncertified ones, as the
   * ratio of mean reuse. 0 when certified artifacts exist and are never reused
   * while uncertified ones are — the worst case, and a measurement. `undefined`
   * until uncertified artifacts have been reused and certified ones exist.
   */
  sigma?: number
  meanLeap: number
  /** Theorem 1's L* at the measured σ and ε, when both are known. */
  threshold?: number
  /** x* at the mean leap. */
  projectedSound?: number
  /** Rule R2: leaps near L*, or a falling sound fraction, mean audit before growth. */
  auditFirst: boolean
  notes: string[]
}

/** Fraction of L* at which R2 says to stop growing and audit. */
const R2_MARGIN = 0.8

export function libraryHealth(artifacts: Map<string, Artifact>): LibraryHealth {
  const all = [...artifacts.values()]
  const byStatus: Record<ArtifactStatus, number> = { admitted: 0, probation: 0, quarantined: 0, purged: 0 }
  for (const artifact of all) byStatus[artifact.status] += 1

  const audited = all.filter((artifact) => artifact.checks.some((check) => check.verifier === 'randomized-trial' || check.family.startsWith('audit')) || artifact.purgedByAudit)
  const slipped = audited.filter((artifact) => artifact.purgedByAudit).length
  const slip = wilson(slipped, audited.length)

  const certified = all.filter((artifact) => artifact.status === 'admitted')
  const uncertified = all.filter((artifact) => artifact.status === 'probation')
  const meanReuse = (group: Artifact[]) => (group.length === 0 ? 0 : group.reduce((sum, artifact) => sum + artifact.reuse, 0) / group.length)
  const certifiedReuse = meanReuse(certified)
  const uncertifiedReuse = meanReuse(uncertified)
  // Certified reuse of 0 against uncertified reuse above 0 is σ = 0, not "no
  // data": retrieval is actively passing certified artifacts over (#1277).
  const sigma = certified.length > 0 && uncertifiedReuse > 0 ? certifiedReuse / uncertifiedReuse : undefined

  const live = all.filter((artifact) => artifact.status !== 'purged' && artifact.status !== 'quarantined')
  const meanLeap = live.length === 0 ? 0 : live.reduce((sum, artifact) => sum + artifact.leap, 0) / live.length

  const notes: string[] = []
  const health: LibraryHealth = { total: all.length, byStatus, slip, meanLeap, auditFirst: false, notes }
  if (sigma !== undefined) health.sigma = sigma
  if (slip.mean !== undefined && sigma !== undefined) {
    // The observed slip is already the post-admission rate — whatever the k
    // checks and their correlation bought is baked into it.
    const eps = slip.mean
    health.threshold = errorThreshold(sigma, Math.max(eps, 1e-6))
    health.projectedSound = soundFraction(sigma, Math.max(eps, 1e-6), meanLeap)
    if (meanLeap >= R2_MARGIN * health.threshold) {
      health.auditFirst = true
      notes.push(`mean leap ${meanLeap.toFixed(1)} is within ${Math.round((1 - R2_MARGIN) * 100)}% of L* ${health.threshold.toFixed(1)} — audit and decompose before adding more (R2)`)
    }
  }
  if (sigma !== undefined && sigma <= 1) {
    health.auditFirst = true
    notes.push(`σ = ${sigma.toFixed(2)}: retrieval does not favour certified artifacts, so by Theorem 1 no leap size is safe — only audits keep the library sound`)
  }
  if (slip.mean !== undefined && slip.mean > 0.2) {
    health.auditFirst = true
    notes.push(`audits purge ${Math.round(slip.mean * 100)}% of what they re-check — admission is letting too much through`)
  }
  if (sigma === undefined) notes.push('σ not measured yet: it needs certified artifacts, and uncertified ones with recorded reuse')
  if (slip.mean === undefined) notes.push('ε not measured yet: nothing admitted has been audited')
  return health
}

export function renderLibraryHealth(health: LibraryHealth): string {
  const pct = (value: number | undefined) => (value === undefined ? '—' : `${Math.round(value * 100)}%`)
  const lines = [
    `CERTIFIED LIBRARY · ${health.total} artifact(s)`,
    `  admitted ${health.byStatus.admitted} · probation ${health.byStatus.probation} · quarantined ${health.byStatus.quarantined} · purged ${health.byStatus.purged}`,
    `  slip rate ε ${health.slip.mean === undefined ? 'not measured' : `${pct(health.slip.mean)} [${pct(health.slip.lo)}–${pct(health.slip.hi)}] of ${health.slip.trials} audited`}`,
    `  reuse advantage σ ${health.sigma === undefined ? 'not measured' : health.sigma.toFixed(2)} · mean leap ${health.meanLeap.toFixed(1)}`,
  ]
  if (health.threshold !== undefined) {
    lines.push(`  error threshold L* ${Number.isFinite(health.threshold) ? health.threshold.toFixed(1) : '∞'} · projected sound share ${pct(health.projectedSound)}`)
  }
  for (const note of health.notes) lines.push(`  · ${note}`)
  return lines.join('\n')
}

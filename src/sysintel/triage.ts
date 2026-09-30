import { FLAGS, instantiate, SCALES, scaleAtLeast, type Flag, type PlannedStage, type Scale } from './lifecycles.ts'
import { ORIGINS, type Origin } from './org.ts'

/**
 * Scale the process to the work. "A tiny bug fix shouldn't require CTO approval" — and an
 * irreversible migration should not ship on a thumbs-up. Triage turns facts about the
 * work into a scale and a set of flags, deterministically, and every reason is recorded.
 * The model supplies the facts; it can raise the rigor but never lower it: an override
 * below what the facts imply is ignored, and flags the problem statement clearly implies
 * are added even when the model left them out.
 */

export interface TriageSignals {
  /** Rough number of files the change touches. */
  files?: number
  /** Services, components, or teams the change touches. */
  systems?: number
  /** Incident or vulnerability severity, 1 (worst) to 4. */
  severity?: number
  /** A multi-quarter or organization-level bet (new platform, core migration, direction change). */
  strategic?: boolean
  flags?: Flag[]
  /** Explicit scale; only honoured when it raises rigor. */
  scale?: Scale
}

export interface TriageResult {
  lifecycle: string
  scale: Scale
  flags: Flag[]
  reasons: string[]
  stages: PlannedStage[]
}

/**
 * Wording that clearly implies a flag. Deliberately narrow: each hit adds a gate, so a
 * pattern here must be specific enough that a false positive is rare and cheap. There is no
 * rule for user-facing: a bug report that mentions "the web form" is not a UI change, and a
 * live run turned exactly that one-line fix into a UX spec and an accessibility review.
 */
const IMPLIED: { flag: Flag; pattern: RegExp; label: string }[] = [
  { flag: 'security', pattern: /\b(auth(?:entication|orization|n|z)?|oauth|sso|login|log[- ]in|passwords?|passwd|credentials?|secrets?|api[- ]?keys?|jwt|session (?:token|cookie|fixation)|csrf|xss|(?:sql|command|shell|prompt|code|template|header) injection|vulnerab\w*|cve-\d{4}|encrypt\w*|permissions?|rbac|acl|pii|personal data|gdpr|privilege)\b/i, label: 'security-sensitive wording' },
  { flag: 'data', pattern: /\b(migrations?|migrate|schemas?|backfill|etl|elt|data pipeline|warehouse|drop (?:table|column)|alter table|database)\b/i, label: 'data wording' },
  { flag: 'infrastructure', pattern: /\b(terraform|kubernetes|k8s|helm|docker(?:file)?|ci\/cd|ci pipeline|github actions|deploy(?:ment)? pipeline|load balancer|dns|cdn|autoscal\w*|infrastructure)\b/i, label: 'infrastructure wording' },
  { flag: 'ml', pattern: /\b(model training|train(?:ing)? (?:a|the) model|fine[- ]?tun\w*|inference|embeddings?|llms?|rag|retrieval[- ]augmented|prompt engineering|system prompt|agent loop|classifier)\b/i, label: 'ML / LLM wording' },
  { flag: 'api', pattern: /\b(public api|breaking change|api contract|endpoint contract|sdk|versioned api|deprecat\w*)\b/i, label: 'contract wording' },
  { flag: 'irreversible', pattern: /\b(drop (?:table|column|database)|delete (?:all|user|customer) data|purge|destructive|irreversible|one[- ]way)\b/i, label: 'irreversible wording' },
]

function baseScale(files: number | undefined, systems: number | undefined): Scale {
  const f = files ?? 5
  const s = systems ?? 1
  if (f <= 2 && s <= 1) return 'trivial'
  if (f <= 10 && s <= 2) return 'small'
  if (f <= 40 && s <= 5) return 'medium'
  return 'large'
}

export function defaultLifecycle(origin: Origin): string {
  return ORIGINS[origin].lifecycle
}

export function triage(input: { origin: Origin; lifecycle?: string; title: string; problem: string; signals?: TriageSignals }): TriageResult {
  const signals = input.signals ?? {}
  const lifecycleId = input.lifecycle ?? defaultLifecycle(input.origin)
  const reasons: string[] = []
  const flags = new Set<Flag>()

  for (const flag of signals.flags ?? []) {
    if (!(FLAGS as readonly string[]).includes(flag)) throw new Error(`unknown flag "${flag}" — use: ${FLAGS.join(', ')}`)
    flags.add(flag)
  }
  if (flags.size) reasons.push(`flags declared: ${[...flags].join(', ')}`)
  const text = `${input.title}\n${input.problem}`
  for (const rule of IMPLIED) {
    if (flags.has(rule.flag)) continue
    const hit = rule.pattern.exec(text)
    if (hit) {
      flags.add(rule.flag)
      reasons.push(`flag ${rule.flag} added from ${rule.label} ("${hit[0]}")`)
    }
  }
  if (input.origin === 'security') flags.add('security')

  let scale: Scale
  if (typeof signals.severity === 'number' && (lifecycleId === 'incident' || lifecycleId === 'vulnerability')) {
    const severity = Math.min(4, Math.max(1, Math.round(signals.severity)))
    scale = (['large', 'medium', 'small', 'trivial'] as const)[severity - 1]!
    reasons.push(`severity ${severity} → ${scale}`)
  } else {
    scale = baseScale(signals.files, signals.systems)
    reasons.push(`${signals.files ?? 'unknown (assumed 5)'} file(s) across ${signals.systems ?? 'unknown (assumed 1)'} system(s) → ${scale}`)
  }
  const bump = (floor: Scale, why: string): void => {
    if (scaleAtLeast(scale, floor)) return
    scale = floor
    reasons.push(`raised to ${floor}: ${why}`)
  }
  if (flags.has('security')) bump('small', 'security-sensitive work always gets independent review')
  if (flags.has('data')) bump('small', 'data changes always get independent review')
  if (flags.has('api')) bump('medium', 'a contract change needs a design and a spec')
  if (flags.has('novel')) bump('medium', 'unproven feasibility needs discovery and research first')
  if (flags.has('infrastructure') && flags.has('deployed')) bump('medium', 'infrastructure that runs production needs a design and a release plan')
  if (flags.has('irreversible')) bump('large', 'an irreversible change needs an RFC with a rollback plan and architecture review')
  if (signals.strategic) bump('strategic', 'an organization-level bet needs the direction sign-off')
  if (lifecycleId === 'rfc') bump('medium', 'an RFC is written for significant changes')
  if (lifecycleId === 'planning') bump('large', 'quarterly planning spans many initiatives')
  if (signals.scale) {
    if (!(SCALES as readonly string[]).includes(signals.scale)) throw new Error(`scale must be one of: ${SCALES.join(', ')}`)
    if (scaleAtLeast(signals.scale, scale) && signals.scale !== scale) {
      reasons.push(`raised to ${signals.scale} on request`)
      scale = signals.scale
    } else if (!scaleAtLeast(signals.scale, scale)) {
      reasons.push(`requested scale ${signals.scale} ignored: the facts put this at ${scale}, and triage never lowers rigor`)
    }
  }
  const ordered = FLAGS.filter((flag) => flags.has(flag))
  return { lifecycle: lifecycleId, scale, flags: ordered, reasons, stages: instantiate(lifecycleId, scale, ordered) }
}

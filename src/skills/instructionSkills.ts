import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rankBm25, tokenize, type Bm25Doc } from '../bm25.ts'
import { paths } from '../statePaths.ts'
import { isUserStated, loadLessons } from '../autonomy/lessons.ts'
import { lessonArtifacts } from '../autonomy/lessonCertificates.ts'
import { retrievable } from '../autonomy/certifiedLibrary.ts'

/**
 * Elia writing itself SKILL.md instruction skills — the prose-guidance kind
 * (Ponytail is the example a person installs), not the executable `*.skill.ts`
 * tools `src/skills/synthesize.ts` already writes.
 *
 * The evidence problem is different from that module's. An executable skill
 * collapses a repeated *command*; a repeated command either works or it
 * doesn't, so a passing test is the whole gate. An instruction skill
 * generalizes a repeated *lesson* — a claim about how to work in this project
 * — and a claim can be plausible, well-written, and wrong. So this module
 * never treats a raw lesson as evidence: it only clusters lessons that
 * `lessons.ts` already certified (survived hygiene review, execution
 * evidence, or a user's own words — see `lessonCertificates.ts`) or that the
 * user stated directly. A skill drafted from that pool inherits a check that
 * already ran; one drafted from unproven chatter would not.
 *
 * Drift is fought three ways, none of which require a person in the loop:
 *   1. Creation needs a *cluster* — several certified lessons on the same
 *      topic, not one. A single lesson stays a lesson.
 *   2. Every draft (new skill or revision) is validated structurally before
 *      it ever reaches the live file — bad output never overwrites good.
 *   3. Every revision archives the version it replaces under `.history/`, so
 *      `rollbackInstructionSkill` can always undo one.
 * What this module does *not* yet do is measure whether a skill's own
 * presence improved outcomes and auto-revert on a regression, the way
 * `lessonEfficacy.ts` does for individual lessons — that's the natural next
 * step once there's enough usage to measure, not something worth faking now.
 */

export const INSTRUCTION_SKILLS_ROOT = join(process.cwd(), 'agent', 'skills')
const HISTORY_DIRNAME = '.history'
const META_FILENAME = '.meta.json'
export const INSTRUCTION_SKILL_STAGING_DIR = join(process.cwd(), '.elia', 'skill-instructions-staging')
export const INSTRUCTION_SKILL_QUARANTINE_DIR = join(process.cwd(), '.elia', 'skill-instructions-quarantine')

/** A cluster only forms from lessons that already proved themselves. */
const MIN_CLUSTER_SIZE = 3
/** BM25 score above which two lesson texts count as "the same topic". Tuned loose on purpose — a false-negative just delays a skill by a few more lessons; a false-positive gets caught by the content gate below. */
const SIMILARITY_THRESHOLD = 0.3
/** Subagent calls cost money and time; each pass makes bounded progress and the next pass picks up where this one left off. */
const MAX_CREATIONS_PER_PASS = 1
const MAX_REVISIONS_PER_PASS = 1

export interface LessonEvidence {
  key: string
  text: string
  source?: string
}

export interface InstructionSkillHistoryEntry {
  version: number
  at: number
  reason: string
}

export interface InstructionSkillMeta {
  slug: string
  name: string
  version: number
  createdAt: number
  updatedAt: number
  sourceLessonKeys: string[]
  authoredBy: 'elia'
  history: InstructionSkillHistoryEntry[]
}

function skillDir(root: string, slug: string): string {
  return join(root, slug)
}
function skillPath(root: string, slug: string): string {
  return join(skillDir(root, slug), 'SKILL.md')
}
function metaPath(root: string, slug: string): string {
  return join(skillDir(root, slug), META_FILENAME)
}
function historyPath(root: string, slug: string, version: number): string {
  return join(skillDir(root, slug), HISTORY_DIRNAME, `v${version}.md`)
}

/** `root` defaults to this project's `agent/skills`, but every function takes it explicitly so tests (and, one day, another project root) never touch the real tree. */
export function readSkillMeta(slug: string, root = INSTRUCTION_SKILLS_ROOT): InstructionSkillMeta | undefined {
  const path = metaPath(root, slug)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.slug === slug) return parsed as InstructionSkillMeta
    return undefined
  } catch {
    return undefined
  }
}

function writeSkillMeta(meta: InstructionSkillMeta, root: string): void {
  mkdirSync(skillDir(root, meta.slug), { recursive: true })
  writeFileSync(metaPath(root, meta.slug), JSON.stringify(meta, null, 2))
}

/** Slugs of every skill elia itself authored (has a `.meta.json`) — the only ones this module ever touches. A skill someone installed by hand has no meta file and is never created, revised, or rolled back by it. */
export function elianAuthoredSlugs(root = INSTRUCTION_SKILLS_ROOT): string[] {
  if (!existsSync(root)) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(metaPath(root, entry.name)))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'skill'
  )
}

// --- Evidence: certified lessons only -------------------------------------

/** Lessons this project has already earned the right to rely on: stated by the user directly, or certified retrievable by `lessons.ts`'s own admission pipeline. Nothing else is skill evidence. */
export function trustworthyLessons(lessonsPath = paths.lessons): LessonEvidence[] {
  const lessons = loadLessons(lessonsPath)
  if (lessons.length === 0) return []
  const artifacts = lessonArtifacts(lessonsPath)
  return lessons
    .filter((lesson) => {
      if (isUserStated(lesson)) return true
      if (!lesson.key) return false
      // lessonArtifacts() keys its map by the bare lesson key, already having
      // stripped the `lesson:` prefix lessonArtifactId adds — look it up the
      // same way, not through lessonArtifactId again.
      return retrievable(artifacts.get(lesson.key))
    })
    .map((lesson) => ({ key: lesson.key!, text: lesson.text, source: lesson.source }))
}

/**
 * bm25.ts's tokenizer keeps every word, which suits its usual callers
 * (keyword-style queries against recall.ts / brain/search.ts). Clustering full
 * lesson sentences is different: two lessons about unrelated things still
 * share "the", "before", "with" — and with only a handful of lessons in the
 * pool, BM25's own IDF doesn't discount those enough to stop them outscoring a
 * real shared term. Stripping them here, only for clustering, means the score
 * reflects the words that actually carry the topic.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'before', 'but', 'by', 'for', 'from', 'has', 'have', 'in', 'into',
  'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'were', 'when', 'where', 'which', 'with', 'without',
])

function clusteringText(text: string): string {
  const kept = tokenize(text).filter((token) => !STOPWORDS.has(token))
  return kept.length > 0 ? kept.join(' ') : text
}

/** Greedy BM25 clustering: each not-yet-grouped lesson seeds a cluster of the other not-yet-grouped lessons that read as the same topic. Free — no model call — so it can run on every pass. */
export function findLessonClusters(evidence: LessonEvidence[], minClusterSize = MIN_CLUSTER_SIZE): LessonEvidence[][] {
  const remaining = new Map(evidence.map((item) => [item.key, item]))
  const clusters: LessonEvidence[][] = []
  for (const seed of evidence) {
    if (!remaining.has(seed.key)) continue
    remaining.delete(seed.key)
    const docs: Bm25Doc[] = [...remaining.values()].map((item) => ({ id: item.key, text: clusteringText(item.text) }))
    const hits = rankBm25(docs, clusteringText(seed.text)).filter((hit) => hit.score >= SIMILARITY_THRESHOLD)
    const members = [seed, ...hits.map((hit) => remaining.get(hit.id)!)]
    if (members.length >= minClusterSize) {
      clusters.push(members)
      for (const member of members) remaining.delete(member.key)
    } else {
      remaining.set(seed.key, seed) // not enough yet — leave it for a later pass once more evidence lands
    }
  }
  return clusters
}

/** A cluster already substantially folded into an existing skill shouldn't spawn a duplicate — it flows through revision instead. */
export function clusterAlreadyCovered(cluster: LessonEvidence[], root = INSTRUCTION_SKILLS_ROOT): boolean {
  const known = new Set(elianAuthoredSlugs(root).flatMap((slug) => readSkillMeta(slug, root)?.sourceLessonKeys ?? []))
  const overlap = cluster.filter((item) => known.has(item.key)).length
  return overlap >= Math.ceil(cluster.length / 2)
}

// --- Structural validation gate --------------------------------------------

const RISKY_PATTERNS: RegExp[] = [
  /\bignore (all |any |the )?(previous|prior|above) instructions\b/i,
  /\byou (are|'re) now (in )?(admin|system|root|developer) mode\b/i,
  /\bdisregard (safety|the safety policy|your instructions)\b/i,
  /\b(always|automatically) (approve|confirm|say yes)\b.*\bwithout asking\b/i,
  /\bbypass (approval|authorization|the safety)\b/i,
]

export interface SkillValidation {
  ok: boolean
  name?: string
  description?: string
  reason?: string
}

/** The same discipline `synthesize.ts` applies with a test run: nothing reaches the live file unless it passes structurally first. */
export function validateSkillDraft(content: string): SkillValidation {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)
  if (!frontmatter) return { ok: false, reason: 'no frontmatter block' }
  const nameMatch = frontmatter[1]!.match(/^name:\s*(.+)$/m)
  const name = nameMatch?.[1]?.trim()
  if (!name) return { ok: false, reason: 'frontmatter has no name' }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return { ok: false, reason: `name "${name}" is not lowercase-kebab-case` }
  const descriptionMatch = frontmatter[1]!.match(/^description:\s*(?:>-?\s*\n((?:[ \t]+.*\n?)+)|(.+))/m)
  const description = (descriptionMatch?.[1] ?? descriptionMatch?.[2] ?? '').replace(/\s+/g, ' ').trim()
  if (description.length < 30) return { ok: false, reason: 'description is missing or too short to be useful' }
  if (description.length > 800) return { ok: false, reason: 'description is too long' }
  const body = content.slice(frontmatter[0].length).trim()
  if (body.length < 80) return { ok: false, reason: 'body is too thin to be real guidance' }
  const flagged = RISKY_PATTERNS.find((pattern) => pattern.test(content))
  if (flagged) return { ok: false, reason: 'contains language that tries to grant itself authority an instruction skill should not have' }
  return { ok: true, name, description }
}

function quarantineDraft(stagingFile: string, reason: string, quarantineDir: string): void {
  try {
    mkdirSync(quarantineDir, { recursive: true })
    const target = join(quarantineDir, `${Date.now()}-${stagingFile.split(/[/\\]/).pop()}`)
    renameSync(stagingFile, target)
    writeFileSync(`${target}.reason.txt`, reason)
  } catch {
    try {
      rmSync(stagingFile, { force: true })
    } catch {
      // Nothing further to do — worst case a stale staging file sits unread.
    }
  }
}

// --- Drafting ---------------------------------------------------------------

const SKILL_CONTRACT = `Format (the same contract every SKILL.md elia loads):
---
name: lower-kebab-case-name
description: >
  One real paragraph, written for a model deciding whether this skill applies
  to the task in front of it right now — what it's for and when to reach for
  it, in plain language.
---
# <Title>

<Guidance organized the way the situation calls for, synthesized into
actionable instructions — not the lessons restated one-per-bullet.>`

function createPrompt(cluster: LessonEvidence[], stagingFile: string): string {
  return `Elia has several proven lessons about this project that keep recurring around one topic. Turn them into a persistent instruction skill — a SKILL.md that future turns read instead of re-deriving the same guidance from scratch every time.

## The lessons (each already certified — proved useful before it was kept)
${cluster.map((item) => `- ${item.text}`).join('\n')}

## What to write
Write exactly one file: ${stagingFile}

${SKILL_CONTRACT}

Hard requirements:
- Write only what the lessons actually support. Do not invent guidance beyond the evidence, and do not pad it with generic best-practice advice the lessons don't back.
- Never write anything telling a future run to ignore instructions, escalate its own authority, or skip approval/safety checks — this file is read as ordinary guidance every turn and must never try to be more than that.

Write the file with your file tools, then stop. Do not write anything else.`
}

function revisePrompt(currentContent: string, newEvidence: LessonEvidence[], reason: string, stagingFile: string): string {
  const evidenceBlock =
    newEvidence.length > 0
      ? `## New certified lessons to fold in\n${newEvidence.map((item) => `- ${item.text}`).join('\n')}`
      : `## Why this needs a rewrite\n${reason}\n\nSome of the lessons this skill was built from no longer hold up (they were retired). Re-derive the skill from what still stands — drop or correct guidance those lessons supported, keep everything else.`
  return `Elia wrote itself the instruction skill below. New evidence means it needs a revision.

## Current skill
${currentContent}

${evidenceBlock}

## What to write
Rewrite the whole skill and write it to exactly one file: ${stagingFile}

${SKILL_CONTRACT}

Hard requirements:
- Keep whatever guidance still holds from the current version — do not drop it just because it wasn't repeated in the new evidence.
- Incorporate the new evidence only where it actually changes or adds to the guidance.
- Never write anything telling a future run to ignore instructions, escalate its own authority, or skip approval/safety checks.

Write the file with your file tools, then stop. Do not write anything else.`
}

/**
 * The draft is one file whose whole content is in the prompt's evidence, so
 * the builder gets only write_file and stops once it lands. With the full
 * builder tool set every step re-sent ~9k tokens of tool definitions, and it
 * took about five steps per draft: on 2026-10-01 these drafts were 49 of the
 * day's 127 model calls.
 */
async function draftToStagingFile(prompt: string, _stagingFile: string): Promise<void> {
  const [{ runSubAgent }, { writeFileTool }] = await Promise.all([import('../subagent.ts'), import('../tools/writeFile.ts')])
  await runSubAgent({ role: 'builder', name: 'builder#instruction-skill', prompt, tools: [writeFileTool], finishAfterTool: writeFileTool.name })
}

// --- Create / revise ---------------------------------------------------------

export interface SkillEvolutionResult {
  ok: boolean
  detail: string
  slug?: string
}

export interface SkillStorageOptions {
  root?: string
  stagingDir?: string
  quarantineDir?: string
  /** Replaces the builder subagent that writes the draft — tests only, so no test spends a model call. */
  draft?: (prompt: string, stagingFile: string) => Promise<void>
  /** How soon after its last revision a skill may be rewritten again (default `MIN_REVISION_INTERVAL_MS`). */
  minRevisionIntervalMs?: number
}

/**
 * A skill is rewritten at most this often. Lessons cross the trust bar and
 * back as their evidence moves, and each crossing was a full rewrite: the
 * elia-development-workflow skill went v15, v16, v17 inside 50 seconds, "8
 * source lessons retired" each time, with "2 new" in between. Waiting batches
 * those swings into one rewrite of what has settled.
 */
export const MIN_REVISION_INTERVAL_MS = 30 * 60_000

/**
 * The pass in flight, if any. Every finished turn starts one in the background;
 * two turns seconds apart both read v19 and both wrote "v20" (session
 * muo052t5, 2026-09-30), two model calls for one revision.
 */
let evolutionInFlight: Promise<string[]> | undefined

export async function createInstructionSkill(cluster: LessonEvidence[], options: SkillStorageOptions = {}): Promise<SkillEvolutionResult> {
  const root = options.root ?? INSTRUCTION_SKILLS_ROOT
  const stagingDir = options.stagingDir ?? INSTRUCTION_SKILL_STAGING_DIR
  const quarantineDir = options.quarantineDir ?? INSTRUCTION_SKILL_QUARANTINE_DIR
  mkdirSync(stagingDir, { recursive: true })
  const stagingFile = join(stagingDir, `${Date.now()}-new.md`)
  try {
    await (options.draft ?? draftToStagingFile)(createPrompt(cluster, stagingFile), stagingFile)
  } catch (err) {
    return { ok: false, detail: `drafting a new skill failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!existsSync(stagingFile)) return { ok: false, detail: 'the builder did not write a draft' }
  const content = readFileSync(stagingFile, 'utf8')
  const validation = validateSkillDraft(content)
  if (!validation.ok) {
    quarantineDraft(stagingFile, validation.reason!, quarantineDir)
    return { ok: false, detail: `new-skill draft rejected: ${validation.reason}` }
  }
  const slug = slugify(validation.name!)
  if (readSkillMeta(slug, root) || existsSync(skillPath(root, slug))) {
    quarantineDraft(stagingFile, `a skill directory named "${slug}" already exists`, quarantineDir)
    return { ok: false, detail: `"${slug}" already exists — should have gone through revision instead` }
  }
  mkdirSync(skillDir(root, slug), { recursive: true })
  writeFileSync(skillPath(root, slug), content)
  rmSync(stagingFile, { force: true })
  const now = Date.now()
  writeSkillMeta(
    {
      slug,
      name: validation.name!,
      version: 1,
      createdAt: now,
      updatedAt: now,
      sourceLessonKeys: cluster.map((item) => item.key),
      authoredBy: 'elia',
      history: [{ version: 1, at: now, reason: `created from ${cluster.length} certified lessons` }],
    },
    root,
  )
  return { ok: true, detail: `created skill "${slug}" from ${cluster.length} certified lessons`, slug }
}

/**
 * `retiredKeys` are source lessons the revision has just re-derived the skill
 * without. They must leave `sourceLessonKeys` once the rewrite lands, or the
 * next pass still finds them "lost" and rewrites the same skill again — a paid
 * subagent call on every turn (`elia-development-workflow` went v14→v17 in
 * four turns, each time retiring the same 8 lessons).
 */
export async function reviseInstructionSkill(
  slug: string,
  newEvidence: LessonEvidence[],
  reason: string,
  options: SkillStorageOptions = {},
  retiredKeys: readonly string[] = [],
): Promise<SkillEvolutionResult> {
  const root = options.root ?? INSTRUCTION_SKILLS_ROOT
  const stagingDir = options.stagingDir ?? INSTRUCTION_SKILL_STAGING_DIR
  const quarantineDir = options.quarantineDir ?? INSTRUCTION_SKILL_QUARANTINE_DIR
  const meta = readSkillMeta(slug, root)
  if (!meta) return { ok: false, detail: `no elia-authored skill named "${slug}"` }
  const currentContent = existsSync(skillPath(root, slug)) ? readFileSync(skillPath(root, slug), 'utf8') : ''
  mkdirSync(stagingDir, { recursive: true })
  const stagingFile = join(stagingDir, `${Date.now()}-${slug}-revision.md`)
  try {
    await (options.draft ?? draftToStagingFile)(revisePrompt(currentContent, newEvidence, reason, stagingFile), stagingFile)
  } catch (err) {
    return { ok: false, detail: `revising "${slug}" failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!existsSync(stagingFile)) return { ok: false, detail: `the builder did not write a revised draft for "${slug}"` }
  const content = readFileSync(stagingFile, 'utf8')
  const validation = validateSkillDraft(content)
  if (!validation.ok) {
    quarantineDraft(stagingFile, validation.reason!, quarantineDir)
    return { ok: false, detail: `revision of "${slug}" rejected, current skill untouched: ${validation.reason}` }
  }
  if (currentContent) {
    mkdirSync(join(skillDir(root, slug), HISTORY_DIRNAME), { recursive: true })
    writeFileSync(historyPath(root, slug, meta.version), currentContent)
  }
  writeFileSync(skillPath(root, slug), content)
  rmSync(stagingFile, { force: true })
  const nextVersion = meta.version + 1
  writeSkillMeta(
    {
      ...meta,
      name: validation.name ?? meta.name,
      version: nextVersion,
      updatedAt: Date.now(),
      sourceLessonKeys: [...new Set([...meta.sourceLessonKeys.filter((key) => !retiredKeys.includes(key)), ...newEvidence.map((item) => item.key)])],
      history: [...meta.history, { version: nextVersion, at: Date.now(), reason }],
    },
    root,
  )
  return { ok: true, detail: `revised "${slug}" to v${nextVersion}: ${reason}`, slug }
}

/** The manual escape hatch for the auto-rollback this module doesn't yet do on its own: restore an archived version as current. Still moves forward in version history rather than rewriting it, so the trail stays honest. */
export function rollbackInstructionSkill(slug: string, toVersion: number, root = INSTRUCTION_SKILLS_ROOT): SkillEvolutionResult {
  const meta = readSkillMeta(slug, root)
  if (!meta) return { ok: false, detail: `no elia-authored skill named "${slug}"` }
  const archived = historyPath(root, slug, toVersion)
  if (!existsSync(archived)) return { ok: false, detail: `no archived v${toVersion} for "${slug}"` }
  const content = readFileSync(archived, 'utf8')
  const currentContent = existsSync(skillPath(root, slug)) ? readFileSync(skillPath(root, slug), 'utf8') : ''
  if (currentContent) {
    mkdirSync(join(skillDir(root, slug), HISTORY_DIRNAME), { recursive: true })
    writeFileSync(historyPath(root, slug, meta.version), currentContent)
  }
  writeFileSync(skillPath(root, slug), content)
  const nextVersion = meta.version + 1
  writeSkillMeta(
    {
      ...meta,
      version: nextVersion,
      updatedAt: Date.now(),
      history: [...meta.history, { version: nextVersion, at: Date.now(), reason: `rolled back to the content of v${toVersion}` }],
    },
    root,
  )
  return { ok: true, detail: `"${slug}" is now v${nextVersion}, the content of v${toVersion}`, slug }
}

// --- Orchestration ------------------------------------------------------------

export function relatesToSkill(candidate: LessonEvidence, meta: InstructionSkillMeta, evidenceByKey: Map<string, LessonEvidence>): boolean {
  const memberTexts = meta.sourceLessonKeys.map((key) => evidenceByKey.get(key)?.text).filter((text): text is string => Boolean(text))
  if (memberTexts.length === 0) return false
  const docs: Bm25Doc[] = memberTexts.map((text, index) => ({ id: String(index), text: clusteringText(text) }))
  return rankBm25(docs, clusteringText(candidate.text)).some((hit) => hit.score >= SIMILARITY_THRESHOLD)
}

/**
 * One bounded pass: cluster free evidence (cheap), create at most one new
 * skill and revise at most one existing one (each a subagent call) if the
 * evidence supports it. Called after lessons are (re)certified — see
 * `src/cli/interactive.ts` and `src/autonomy/loop.ts`. Never throws; skill
 * evolution is a bonus on a turn that already succeeded, never a reason to
 * fail one.
 */
export async function evolveInstructionSkills(lessonsPath = paths.lessons, options: SkillStorageOptions = {}): Promise<string[]> {
  // A pass already running will see the same lessons; a second one only races it.
  if (evolutionInFlight) return []
  evolutionInFlight = evolveInstructionSkillsOnce(lessonsPath, options)
  try {
    return await evolutionInFlight
  } finally {
    evolutionInFlight = undefined
  }
}

async function evolveInstructionSkillsOnce(lessonsPath: string, options: SkillStorageOptions): Promise<string[]> {
  const root = options.root ?? INSTRUCTION_SKILLS_ROOT
  const log: string[] = []
  try {
    const evidence = trustworthyLessons(lessonsPath)
    if (evidence.length === 0) return log
    const evidenceByKey = new Map(evidence.map((item) => [item.key, item]))

    const clusters = findLessonClusters(evidence).filter((cluster) => !clusterAlreadyCovered(cluster, root))
    for (const cluster of clusters.slice(0, MAX_CREATIONS_PER_PASS)) {
      log.push((await createInstructionSkill(cluster, options)).detail)
    }

    let revisions = 0
    for (const slug of elianAuthoredSlugs(root)) {
      if (revisions >= MAX_REVISIONS_PER_PASS) break
      const meta = readSkillMeta(slug, root)
      if (!meta) continue
      if (Date.now() - meta.updatedAt < (options.minRevisionIntervalMs ?? MIN_REVISION_INTERVAL_MS)) continue
      const known = new Set(meta.sourceLessonKeys)
      const currentKeys = new Set(evidence.map((item) => item.key))
      const added = evidence.filter((item) => !known.has(item.key) && relatesToSkill(item, meta, evidenceByKey))
      const lost = meta.sourceLessonKeys.filter((key) => !currentKeys.has(key))
      if (added.length > 0) {
        log.push((await reviseInstructionSkill(slug, added, `${added.length} new certified lesson(s) about this topic`, options)).detail)
        revisions++
      } else if (lost.length > 0) {
        log.push(
          (
            await reviseInstructionSkill(slug, [], `${lost.length} source lesson(s) were retired for not holding up — re-derived from what remains`, options, lost)
          ).detail,
        )
        revisions++
      }
    }
  } catch (err) {
    log.push(`skill evolution skipped: ${err instanceof Error ? err.message : String(err)}`)
  }
  return log
}

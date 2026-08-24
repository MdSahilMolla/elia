import { existsSync, readFileSync } from 'node:fs'
import { SKILL_BUNDLES_FILE } from './paths.ts'

const MAX_BUNDLES = 32
const MAX_SKILLS_PER_BUNDLE = 32
const MAX_BUNDLE_NAME_LENGTH = 48
const MAX_DESCRIPTION_LENGTH = 500
const SKILL_NAME_PATTERN = /^[a-z][a-z0-9_]{2,47}$/
const BUNDLE_NAME_PATTERN = /^[a-z][a-z0-9_-]{1,47}$/

export interface SkillBundle {
  name: string
  description?: string
  skills: string[]
}

/**
 * Reads only a declarative object mapping bundle names to loaded skill names.
 * Bundles cannot contain paths, modules, prompts, scripts, or nested bundles.
 */
export function listSkillBundles(path = SKILL_BUNDLES_FILE): SkillBundle[] {
  if (!existsSync(path)) return []
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`Unable to read skill bundles ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Invalid skill bundles ${path}: expected JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  if (!isRecord(parsed)) throw new Error(`Invalid skill bundles ${path}: expected an object mapping bundle names to bundle definitions`)

  const entries = Object.entries(parsed)
  if (entries.length > MAX_BUNDLES) throw new Error(`Invalid skill bundles ${path}: at most ${MAX_BUNDLES} bundles are allowed`)

  return entries.map(([name, value]) => {
    if (!BUNDLE_NAME_PATTERN.test(name) || name.length > MAX_BUNDLE_NAME_LENGTH) {
      throw new Error(`Invalid skill bundles ${path}: bundle name ${JSON.stringify(name)} is invalid`)
    }
    if (!isRecord(value)) throw new Error(`Invalid skill bundles ${path}: bundle ${JSON.stringify(name)} must be an object`)

    const skills = value.skills
    if (!Array.isArray(skills) || skills.length === 0) throw new Error(`Invalid skill bundles ${path}: bundle ${JSON.stringify(name)} needs a non-empty skills array`)
    if (skills.length > MAX_SKILLS_PER_BUNDLE) throw new Error(`Invalid skill bundles ${path}: bundle ${JSON.stringify(name)} contains too many skills`)
    const normalizedSkills: string[] = []
    for (const skill of skills) {
      if (typeof skill !== 'string' || !SKILL_NAME_PATTERN.test(skill)) throw new Error(`Invalid skill bundles ${path}: bundle ${JSON.stringify(name)} contains an invalid skill name`)
      if (!normalizedSkills.includes(skill)) normalizedSkills.push(skill)
    }

    const description = value.description
    if (description !== undefined && (typeof description !== 'string' || description.trim().length > MAX_DESCRIPTION_LENGTH)) {
      throw new Error(`Invalid skill bundles ${path}: bundle ${JSON.stringify(name)} has an invalid description`)
    }

    return {
      name,
      ...(typeof description === 'string' && description.trim() ? { description: description.trim() } : {}),
      skills: normalizedSkills,
    }
  })
}

/**
 * Expands selected bundle names into ordinary skill tool names. An omitted
 * selection remains omitted, preserving the existing "all loaded skills"
 * behavior. Unknown names remain untouched so the existing tool filter can
 * safely ignore a stale selection after a skill is removed.
 */
export function expandSkillSelection(selected: readonly string[] | undefined, path = SKILL_BUNDLES_FILE): string[] | undefined {
  if (selected === undefined) return undefined
  const bundles = new Map(listSkillBundles(path).map((bundle) => [bundle.name, bundle]))
  const expanded: string[] = []
  for (const name of selected) {
    const bundle = bundles.get(name)
    const names = bundle?.skills ?? [name]
    for (const skill of names) {
      if (!expanded.includes(skill)) expanded.push(skill)
    }
  }
  return expanded
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

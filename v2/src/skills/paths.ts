import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

/** Skills elia wrote for itself, available in every project. */
export const USER_SKILLS_DIR = join(homedir(), '.elia', 'skills')

/** Skills specific to the current project, checked in alongside it if the user wants. */
export const PROJECT_SKILLS_DIR = join(process.cwd(), '.elia', 'skills')

/** Skills that failed validation, kept for inspection rather than deleted. */
export const QUARANTINE_DIR = join(USER_SKILLS_DIR, 'quarantine')

export const USAGE_STATS_PATH = join(USER_SKILLS_DIR, 'usage.json')

/** The suffix that marks a file as a loadable skill, so notes and tests can sit alongside them. */
export const SKILL_SUFFIX = '.skill.ts'

export const SKILL_BUNDLES_FILE = join(process.cwd(), '.elia', 'skill-bundles.json')

export type SkillSource = 'user' | 'project' | 'external'

/**
 * Explicit shared skill directories. This is operator configuration only: the
 * loader never discovers arbitrary parent directories or remote locations.
 */
export function externalSkillDirs(environment: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string[] {
  const raw = environment.ELIA_SKILL_DIRS
  if (!raw) return []
  const seen = new Set<string>()
  return raw
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolve(cwd, entry))
    .filter((entry) => {
      if (seen.has(entry)) return false
      seen.add(entry)
      return true
    })
}

/** Skills are only loaded when this is on — set `ELIA_SKILLS=off` to run with built-in tools only. */
export function skillsEnabled(): boolean {
  return (process.env.ELIA_SKILLS ?? 'on').toLowerCase() !== 'off'
}

import { homedir } from 'node:os'
import { join } from 'node:path'

/** Skills elia wrote for itself, available in every project. */
export const USER_SKILLS_DIR = join(homedir(), '.elia', 'skills')

/** Skills specific to the current project, checked in alongside it if the user wants. */
export const PROJECT_SKILLS_DIR = join(process.cwd(), '.elia', 'skills')

/** Skills that failed validation, kept for inspection rather than deleted. */
export const QUARANTINE_DIR = join(USER_SKILLS_DIR, 'quarantine')

export const USAGE_STATS_PATH = join(USER_SKILLS_DIR, 'usage.json')

/** The suffix that marks a file as a loadable skill, so notes and tests can sit alongside them. */
export const SKILL_SUFFIX = '.skill.ts'

/** Skills are only loaded when this is on — set `ELIA_SKILLS=off` to run with built-in tools only. */
export function skillsEnabled(): boolean {
  return (process.env.ELIA_SKILLS ?? 'on').toLowerCase() !== 'off'
}

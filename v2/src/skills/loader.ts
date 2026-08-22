import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Tool } from '../tools/types.ts'
import { PROJECT_SKILLS_DIR, QUARANTINE_DIR, SKILL_SUFFIX, USER_SKILLS_DIR, skillsEnabled } from './paths.ts'

/**
 * Loads the tools elia has written for itself.
 *
 * Skills are ordinary TypeScript modules exporting a Tool, so a synthesized skill
 * is indistinguishable from a built-in one at the call site — same schema, same
 * `execute`. They're imported at startup, which means a bad skill could otherwise
 * break every subsequent session; so a module that throws or exports the wrong
 * shape is moved to a quarantine directory instead of loaded, and elia carries on
 * with one fewer tool rather than not starting.
 */

export interface LoadedSkill {
  name: string
  file: string
  source: 'user' | 'project'
}

export interface SkillLoadReport {
  loaded: LoadedSkill[]
  quarantined: { file: string; reason: string }[]
}

let loadedSkillCatalog: LoadedSkill[] = []

export async function loadSkills(): Promise<SkillLoadReport> {
  const report: SkillLoadReport = { loaded: [], quarantined: [] }
  loadedSkillCatalog = []
  if (!skillsEnabled()) return report

  const filesBySource = [
    [USER_SKILLS_DIR, 'user'],
    [PROJECT_SKILLS_DIR, 'project'],
  ] as const
  const availableFiles = filesBySource.flatMap(([dir]) => skillFilesIn(dir))
  if (availableFiles.length === 0) return report
  const { registerSynthesizedTool } = await import('../tools/registry.ts')

  for (const [dir, source] of filesBySource) {
    for (const file of skillFilesIn(dir)) {
      const result = await loadSkillFile(file)
      if ('tool' in result) {
        registerSynthesizedTool(result.tool)
        report.loaded.push({ name: result.tool.name, file, source })
      } else {
        quarantine(file, result.reason)
        report.quarantined.push({ file, reason: result.reason })
      }
    }
  }

  loadedSkillCatalog = [...report.loaded]
  return report
}

function skillFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(SKILL_SUFFIX))
      .map((name) => join(dir, name))
      .sort()
  } catch {
    return []
  }
}

/** Imports one skill file and checks it really is a usable Tool before it reaches the model. */
export async function loadSkillFile(file: string): Promise<{ tool: Tool } | { reason: string }> {
  let module: Record<string, unknown>
  try {
    // A cache-busting query means a freshly synthesized skill can be loaded in the
    // same process that just wrote it, without a restart.
    module = (await import(`${pathToFileURL(file).href}?t=${Date.now()}`)) as Record<string, unknown>
  } catch (err) {
    return { reason: `failed to import: ${err instanceof Error ? err.message : String(err)}` }
  }

  const candidate = module.default ?? module.tool ?? Object.values(module).find(looksLikeTool)
  if (!looksLikeTool(candidate)) {
    return { reason: 'does not export a Tool (need a default export with name, description, input_schema, execute)' }
  }
  if (!/^[a-z][a-z0-9_]{2,47}$/.test(candidate.name)) {
    return { reason: `invalid tool name "${candidate.name}" — use lower_snake_case, 3-48 characters` }
  }

  return { tool: candidate }
}

function looksLikeTool(value: unknown): value is Tool {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<Tool>
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.description === 'string' &&
    typeof candidate.execute === 'function' &&
    typeof candidate.input_schema === 'object' &&
    candidate.input_schema !== null &&
    candidate.input_schema.type === 'object'
  )
}

function quarantine(file: string, reason: string): void {
  try {
    mkdirSync(QUARANTINE_DIR, { recursive: true })
    const target = join(QUARANTINE_DIR, `${Date.now()}-${file.split(/[/\\]/).pop()}`)
    renameSync(file, target)
    process.stderr.write(`elia: quarantined skill ${file} (${reason})\n`)
  } catch {
    // If it can't be moved it simply stays and fails to load again next time.
  }
}

/** Returns successfully loaded skills with their actual tool names — used by `@skills`. */
export function listLoadedSkills(): LoadedSkill[] {
  return loadedSkillCatalog.map((skill) => ({ ...skill }))
}

export function registerLoadedSkill(skill: LoadedSkill): void {
  if (!loadedSkillCatalog.some((existing) => existing.name === skill.name && existing.file === skill.file)) {
    loadedSkillCatalog.push({ ...skill })
  }
}

/** Lists installed skills without importing them — used by `elia skills`. */
export function listSkillFiles(): { file: string; source: 'user' | 'project' }[] {
  return [
    ...skillFilesIn(USER_SKILLS_DIR).map((file) => ({ file, source: 'user' as const })),
    ...skillFilesIn(PROJECT_SKILLS_DIR).map((file) => ({ file, source: 'project' as const })),
  ]
}

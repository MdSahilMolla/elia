import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MEMORY_FILENAME = 'ELIA.md'
const PROJECT_INSTRUCTIONS_FILENAMES = ['AGENTS.override.md', 'AGENTS.md'] as const
const MAX_PROJECT_INSTRUCTIONS = 20_000

/** Reads the project-level memory file (`ELIA.md` in `dir`), if present. */
export function loadProjectMemory(dir: string): string | undefined {
  return readMemoryFile(join(dir, MEMORY_FILENAME))
}

/** Reads bounded repository instructions, preferring an explicit local override. */
export function loadProjectInstructions(dir: string): string | undefined {
  for (const filename of PROJECT_INSTRUCTIONS_FILENAMES) {
    const content = readMemoryFile(join(dir, filename))
    if (content) return content.slice(0, MAX_PROJECT_INSTRUCTIONS)
  }
  return undefined
}

/** Reads the user-level memory file (`~/.elia/ELIA.md`), if present. */
export function loadUserMemory(): string | undefined {
  return readMemoryFile(join(homedir(), '.elia', MEMORY_FILENAME))
}

function readMemoryFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  const content = readFileSync(path, 'utf8').trim()
  return content.length > 0 ? content : undefined
}

export interface InstalledSkill { name: string; description: string; path: string }

/** Where `npx skills` and other agents drop SKILL.md skills (project first, then home). */
const SKILL_ROOTS = (dir: string): string[] => [
  join(dir, 'agent', 'skills'), join(dir, '.agents', 'skills'), join(dir, '.claude', 'skills'),
  join(homedir(), '.agents', 'skills'), join(homedir(), '.claude', 'skills'),
]

/** Lists instruction skills (`<root>/<name>/SKILL.md`) by frontmatter name + description. */
export function loadInstalledSkills(dir: string): InstalledSkill[] {
  const seen = new Map<string, InstalledSkill>()
  for (const root of SKILL_ROOTS(dir)) {
    let entries: string[] = []
    try { entries = readdirSync(root) } catch { continue }
    for (const entry of entries) {
      const path = join(root, entry, 'SKILL.md')
      const text = readMemoryFile(path)
      const fm = text?.match(/^---\n([\s\S]*?)\n---/)?.[1]
      if (!fm) continue
      const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? entry
      const description = fm.match(/^description:\s*(?:>-?\s*\n((?:[ \t]+.*\n?)+)|(.+))/m)
      const desc = (description?.[1] ?? description?.[2] ?? '').replace(/\s+/g, ' ').trim()
      if (!seen.has(name)) seen.set(name, { name, description: desc.slice(0, 400), path })
    }
  }
  return [...seen.values()]
}

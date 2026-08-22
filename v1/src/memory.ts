import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MEMORY_FILENAME = 'ELIA.md'

/** Reads the project-level memory file (`ELIA.md` in `dir`), if present. */
export function loadProjectMemory(dir: string): string | undefined {
  return readMemoryFile(join(dir, MEMORY_FILENAME))
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

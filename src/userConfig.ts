import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { renameSyncWithRetry } from './securePersistence.ts'

/**
 * User-level configuration is intentionally separate from the project `.env`.
 * Explicit process/project values win; this file only fills missing variables.
 */
export const USER_CONFIG_ENV_PATH = 'ELIA_CONFIG_PATH'

export interface UserConfigLoadResult {
  path: string
  loaded: string[]
}

export function userConfigPath(): string {
  return process.env[USER_CONFIG_ENV_PATH] ?? join(homedir(), '.elia', 'config.env')
}

export function readUserConfigValues(filePath = userConfigPath()): Record<string, string> {
  if (!existsSync(filePath)) return {}
  let content: string
  try {
    content = readFileSync(filePath, 'utf8')
  } catch {
    return {}
  }
  const values: Record<string, string> = {}
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line)
    if (parsed) values[parsed.key] = parsed.value
  }
  return values
}

export function removeUserConfig(keys: string[], filePath = userConfigPath()): void {
  if (keys.length === 0 || !existsSync(filePath)) return
  const values = Object.fromEntries(keys.map((key) => [key, undefined])) as Record<string, string | undefined>
  writeUserConfig(values, filePath)
}

export function loadUserConfig(filePath = userConfigPath()): UserConfigLoadResult {
  if (!existsSync(filePath)) return { path: filePath, loaded: [] }
  let content: string
  try {
    content = readFileSync(filePath, 'utf8')
  } catch {
    return { path: filePath, loaded: [] }
  }

  // Duplicate keys are resolved last-wins across the file (the mode
  // `readUserConfigValues` already uses), while an externally-provided
  // variable still beats every file value. Processing the lines into a single
  // map keeps the two consistent without mutating `process.env` mid-parse.
  const fileValues: Record<string, string> = {}
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line)
    if (parsed) fileValues[parsed.key] = parsed.value
  }

  const loaded: string[] = []
  for (const [key, value] of Object.entries(fileValues)) {
    if (process.env[key] !== undefined) continue
    process.env[key] = value
    loaded.push(key)
  }
  return { path: filePath, loaded }
}

/** Writes only the supplied keys while preserving comments and unrelated settings. */
export function writeUserConfig(values: Record<string, string | undefined>, filePath = userConfigPath()): void {
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''
  const lines = existing.split(/\r?\n/)
  const remaining = new Set(Object.keys(values))
  const updated: string[] = []
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    if (!match || !remaining.has(match[1]!)) {
      updated.push(line)
      continue
    }
    remaining.delete(match[1]!)
    const value = values[match[1]!]
    if (value !== undefined) updated.push(`${match[1]}=${encodeEnvValue(value)}`)
  }

  for (const key of remaining) {
    const value = values[key]
    if (value !== undefined) updated.push(`${key}=${encodeEnvValue(value)}`)
  }

  const content = `${updated.join('\n').replace(/\n+$/, '')}\n`
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.tmp-${process.pid}`
  writeFileSync(temporary, content, { mode: 0o600 })
  try {
    // `renameSync` transiently fails on Windows (EPERM/EACCES/EBUSY) when AV/an
    // indexer/another process briefly holds the destination open — retry it the
    // same way securePersistence.ts's writers do.
    renameSyncWithRetry(temporary, filePath)
  } catch (error) {
    // Never leave a temp file holding a just-entered API key sitting on disk.
    try {
      rmSync(temporary, { force: true })
    } catch {
      // Already gone, or held open — nothing more we can do here.
    }
    throw error
  }
  try {
    // Tighten an existing file too; chmod is best-effort on filesystems without Unix modes.
    chmodSync(filePath, 0o600)
  } catch {
    // The atomic write above remains the source of truth.
  }
}

function parseEnvLine(line: string): { key: string; value: string } | undefined {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return undefined
  const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
  if (!match) return undefined
  return { key: match[1]!, value: decodeEnvValue(match[2]!) }
}

function decodeEnvValue(value: string): string {
  const withoutComment = stripInlineComment(value.trim())
  if (withoutComment.startsWith('"') && withoutComment.endsWith('"')) {
    try {
      const decoded = JSON.parse(withoutComment)
      return typeof decoded === 'string' ? decoded : withoutComment
    } catch {
      return withoutComment.slice(1, -1)
    }
  }
  if (withoutComment.startsWith("'") && withoutComment.endsWith("'")) return withoutComment.slice(1, -1)
  // An opener with no matching closer is malformed, not a literal that should
  // silently swallow the quote character into the value.
  if (withoutComment.startsWith('"') || withoutComment.startsWith("'")) return withoutComment.slice(1)
  return withoutComment
}

/** Removes an unquoted ` # ...` trailing comment, leaving `#` inside quotes alone. */
function stripInlineComment(value: string): string {
  let inSingle = false
  let inDouble = false
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!
    if (char === "'" && !inDouble) inSingle = !inSingle
    else if (char === '"' && !inSingle) inDouble = !inDouble
    else if (char === '#' && !inSingle && !inDouble && index > 0 && /[ \t]/.test(value[index - 1]!)) {
      return value.slice(0, index).trimEnd()
    }
  }
  return value
}

function encodeEnvValue(value: string): string {
  return /^[A-Za-z0-9_./:@+=,-]+$/.test(value) ? value : JSON.stringify(value)
}

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

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

export function loadUserConfig(filePath = userConfigPath()): UserConfigLoadResult {
  if (!existsSync(filePath)) return { path: filePath, loaded: [] }
  let content: string
  try {
    content = readFileSync(filePath, 'utf8')
  } catch {
    return { path: filePath, loaded: [] }
  }

  const loaded: string[] = []
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line)
    if (!parsed || process.env[parsed.key] !== undefined) continue
    process.env[parsed.key] = parsed.value
    loaded.push(parsed.key)
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
  renameSync(temporary, filePath)
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
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const decoded = JSON.parse(trimmed)
      return typeof decoded === 'string' ? decoded : trimmed
    } catch {
      return trimmed.slice(1, -1)
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1)
  return trimmed
}

function encodeEnvValue(value: string): string {
  return /^[A-Za-z0-9_./:@+=,-]+$/.test(value) ? value : JSON.stringify(value)
}

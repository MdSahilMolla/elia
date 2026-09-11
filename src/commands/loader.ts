import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { SlashCommand } from '../ui/slashPrompt.ts'

/**
 * User-authored slash commands: markdown files under `.elia/commands/` (project)
 * and `~/.elia/commands/` (user). Project wins on name collision.
 *
 * Expansion is prompt-only — the body becomes the next model turn. No shell
 * execution, no tool grants, no governor bypass.
 */

export interface CustomCommand {
  name: string
  description: string
  body: string
  source: 'project' | 'user'
  file: string
}

const MAX_COMMANDS = 64
const MAX_BODY_CHARS = 20_000
const MAX_NAME_LENGTH = 40

function commandsDir(kind: 'project' | 'user', cwd = process.cwd()): string {
  return kind === 'project' ? join(cwd, '.elia', 'commands') : join(homedir(), '.elia', 'commands')
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw)
  if (!match) return { meta: {}, body: raw.trim() }
  const meta: Record<string, string> = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '')
    if (key && value) meta[key] = value
  }
  return { meta, body: match[2]!.trim() }
}

function sanitizeName(fileBase: string): string | undefined {
  const bare = fileBase.replace(/\.md$/i, '').trim().toLowerCase()
  if (!/^[a-z][a-z0-9_-]{0,38}$/.test(bare)) return undefined
  if (bare.length > MAX_NAME_LENGTH) return undefined
  return bare
}

function loadDir(dir: string, source: 'project' | 'user'): CustomCommand[] {
  if (!existsSync(dir)) return []
  let entries: string[]
  try {
    entries = readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.md'))
  } catch {
    return []
  }
  const out: CustomCommand[] = []
  for (const entry of entries) {
    const name = sanitizeName(basename(entry))
    if (!name) continue
    const file = join(dir, entry)
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (raw.length > MAX_BODY_CHARS) continue
    const { meta, body } = parseFrontmatter(raw)
    if (!body) continue
    out.push({
      name: `/${name}`,
      description: meta.description || meta.desc || `Custom command from ${source}`,
      body,
      source,
      file,
    })
  }
  return out
}

/** Project commands override user commands with the same name. */
export function loadCustomCommands(cwd = process.cwd()): CustomCommand[] {
  const byName = new Map<string, CustomCommand>()
  for (const cmd of loadDir(commandsDir('user', cwd), 'user')) byName.set(cmd.name, cmd)
  for (const cmd of loadDir(commandsDir('project', cwd), 'project')) byName.set(cmd.name, cmd)
  return [...byName.values()].slice(0, MAX_COMMANDS).sort((a, b) => a.name.localeCompare(b.name))
}

export function customCommandsAsSlashEntries(commands: CustomCommand[] = loadCustomCommands()): SlashCommand[] {
  return commands.map((c) => ({ name: c.name, description: `${c.description} · custom` }))
}

/**
 * Expand `$ARGUMENTS`, `$0`..`$9`, and `$@` in a command body.
 * `$ARGUMENTS` / `$@` = full trailing args; `$1`..`$9` = whitespace-split tokens; `$0` = command name without slash.
 */
export function expandCustomCommand(body: string, commandName: string, argsText: string): string {
  const tokens = argsText.trim() ? argsText.trim().split(/\s+/) : []
  const bare = commandName.replace(/^\//, '')
  let out = body
  out = out.replaceAll('$ARGUMENTS', argsText.trim())
  out = out.replaceAll('$@', argsText.trim())
  out = out.replaceAll('$0', bare)
  for (let i = 1; i <= 9; i += 1) {
    out = out.replaceAll(`$${i}`, tokens[i - 1] ?? '')
  }
  return out.trim()
}

export function resolveCustomCommand(
  input: string,
  commands: CustomCommand[] = loadCustomCommands(),
): { command: CustomCommand; expanded: string } | undefined {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return undefined
  const space = trimmed.search(/\s/)
  const name = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase()
  const args = space === -1 ? '' : trimmed.slice(space + 1)
  const command = commands.find((c) => c.name === name)
  if (!command) return undefined
  return { command, expanded: expandCustomCommand(command.body, command.name, args) }
}

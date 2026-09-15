// Turns a tool call into the one-line "Edited App.tsx +16 −2" style header the
// Claude Code transcript uses — a human verb, the thing it acted on, and a
// change stat when there is one. Pure, so it is easy to unit test.
import type { ToolItem } from './store.ts'

function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** Workspace-relative path for edit/write headers, matching the transcript's "Edited src/x.ts" style. */
function relPath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const cwd = process.cwd().replace(/\\/g, '/')
  return normalized.startsWith(`${cwd}/`) ? normalized.slice(cwd.length + 1) : normalized
}

function firstString(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** "+12 −3" pulled from a fenced-diff result, or from a "(+12 −3)" the tool already printed. */
function diffStatOf(result: string | undefined): string {
  if (!result) return ''
  const parens = /\(\+(\d+)\s*[−-]\s*(\d+)\)/.exec(result)
  if (parens) return `+${parens[1]} −${parens[2]}`
  const lines = result.split('\n')
  let added = 0
  let removed = 0
  let inDiff = false
  for (const line of lines) {
    if (line.trim() === '```diff') inDiff = true
    else if (inDiff && line.trim() === '```') inDiff = false
    else if (inDiff && line.startsWith('+') && !line.startsWith('+++')) added += 1
    else if (inDiff && line.startsWith('-') && !line.startsWith('---')) removed += 1
  }
  return added || removed ? `+${added} −${removed}` : ''
}

/** "exit 0" / "exit 1" / "timed out" pulled from a run_command result's first line. */
export function shellExitStat(result: string | undefined): string {
  if (!result) return ''
  const first = result.split('\n', 1)[0] ?? ''
  if (/timed out/i.test(first)) return 'timed out'
  const code = /exit code:\s*(-?\d+)/i.exec(first)
  return code ? `exit ${code[1]}` : ''
}

export interface ToolSummary {
  verb: string
  target: string
  stat: string
  /** True when there is a body worth expanding (diff, long output, error). */
  expandable: boolean
}

export function summarizeTool(tool: ToolItem): ToolSummary {
  const input = tool.input
  const done = tool.status !== 'running'
  const stat = tool.name === 'edit_file' || tool.name === 'write_file' ? diffStatOf(tool.result) : ''

  switch (tool.name) {
    case 'read_file': {
      const name = basename(firstString(input, 'path') ?? '')
      const offset = typeof input.offset === 'number' ? input.offset : undefined
      const limit = typeof input.limit === 'number' ? input.limit : undefined
      const range =
        offset !== undefined
          ? `:${offset}-${offset + (limit ?? 2000) - 1}`
          : limit !== undefined
            ? `:1-${limit}`
            : ''
      return { verb: 'Read', target: `${name}${range}`, stat, expandable: done }
    }
    case 'edit_file':
      return { verb: 'Edited', target: relPath(firstString(input, 'path') ?? ''), stat, expandable: done }
    case 'write_file': {
      const created = tool.result?.startsWith('Created') ?? true
      return { verb: created ? 'Created' : 'Overwrote', target: relPath(firstString(input, 'path') ?? ''), stat, expandable: done }
    }
    case 'list_files':
      return { verb: 'Listed', target: firstString(input, 'pattern', 'path') ?? 'files', stat, expandable: done }
    case 'grep':
      return { verb: 'Searched', target: firstString(input, 'pattern') ?? '', stat, expandable: done }
    case 'run_command': {
      // First line only — a heredoc or a chained script would otherwise push the
      // header onto several rows. The row itself truncates to the terminal width.
      const cmd = (firstString(input, 'command') ?? '').split('\n', 1)[0]!
      return {
        verb: 'Ran',
        target: cmd.length > 120 ? `${cmd.slice(0, 119)}…` : cmd,
        stat: done ? shellExitStat(tool.result) : '',
        expandable: done,
      }
    }
    case 'web_search':
      return { verb: 'Searched the web', target: firstString(input, 'query') ?? '', stat, expandable: done }
    case 'web_fetch':
      return { verb: 'Fetched', target: firstString(input, 'url') ?? '', stat, expandable: done }
    case 'task':
      return { verb: 'Delegated to', target: firstString(input, 'role', 'description') ?? 'a subagent', stat, expandable: done }
    case 'todo_write':
      return { verb: 'Updated the plan', target: '', stat, expandable: done }
    case 'visualize':
      return { verb: 'Visualized', target: firstString(input, 'title', 'type') ?? 'data', stat, expandable: done }
    default: {
      const arg = Object.values(input).find((v) => typeof v === 'string') as string | undefined
      return { verb: tool.name, target: arg ? (arg.length > 50 ? `${arg.slice(0, 49)}…` : arg) : '', stat, expandable: done }
    }
  }
}

/**
 * Read-only lookups. A run of them renders as one grouped line ("Read 3 files,
 * searched 1 pattern") instead of a card each — the exploration phase of a
 * turn is where the transcript used to turn into a wall of near-identical rows.
 */
export const EXPLORE_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'grep',
  'list_files',
  'find_symbol',
  'recall',
  'web_search',
  'web_fetch',
  'read_spreadsheet',
  'board_read',
])

export function isExploreTool(name: string): boolean {
  return EXPLORE_TOOLS.has(name)
}

const ACTIVE_VERB: Record<string, string> = {
  Read: 'Reading',
  Edited: 'Editing',
  Created: 'Writing',
  Overwrote: 'Writing',
  Listed: 'Listing',
  Searched: 'Searching',
  Ran: 'Running',
  'Searched the web': 'Searching the web',
  Fetched: 'Fetching',
  'Delegated to': 'Delegating to',
  'Updated the plan': 'Updating the plan',
  Visualized: 'Visualizing',
}

/** "Ran" → "Running": the verb for a call that has not finished yet. */
export function activeVerb(verb: string): string {
  return ACTIVE_VERB[verb] ?? verb
}

/** "Reading app.ts" — what the working indicator says while a tool runs. */
export function toolActivity(call: { name: string; input: Record<string, unknown> }): string {
  const s = summarizeTool({ id: '', kind: 'tool', name: call.name, input: call.input, status: 'running' })
  const verb = activeVerb(s.verb)
  return s.target ? `${verb} ${s.target}` : verb
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** One line for a run of explore calls: "Read 3 files, searched 2 patterns". */
export function exploreSummary(tools: readonly ToolItem[]): string {
  const count = (name: string) => tools.filter((tool) => tool.name === name).length
  const parts: string[] = []
  const read = count('read_file') + count('read_spreadsheet')
  const searched = count('grep') + count('find_symbol')
  const listed = count('list_files')
  const web = count('web_search')
  const fetched = count('web_fetch')
  const recalled = count('recall') + count('board_read')
  if (read) parts.push(`read ${plural(read, 'file')}`)
  if (searched) parts.push(`searched ${plural(searched, 'pattern')}`)
  if (listed) parts.push(`listed ${plural(listed, 'path')}`)
  if (web) parts.push(`searched the web${web > 1 ? ` ${web} times` : ''}`)
  if (fetched) parts.push(`fetched ${plural(fetched, 'page')}`)
  if (recalled) parts.push(`checked memory${recalled > 1 ? ` ${recalled} times` : ''}`)
  const line = parts.join(', ')
  return line.charAt(0).toUpperCase() + line.slice(1)
}

export interface TurnRollup {
  commands: number
  edited: number
  created: number
  read: number
  searched: number
  other: number
  added: number
  removed: number
}

export function rollupTools(tools: ToolItem[]): TurnRollup {
  const r: TurnRollup = { commands: 0, edited: 0, created: 0, read: 0, searched: 0, other: 0, added: 0, removed: 0 }
  for (const tool of tools) {
    const s = summarizeTool(tool)
    const stat = /\+(\d+) −(\d+)/.exec(s.stat)
    if (stat) {
      r.added += Number(stat[1])
      r.removed += Number(stat[2])
    }
    if (tool.name === 'run_command') r.commands += 1
    else if (tool.name === 'edit_file') r.edited += 1
    else if (tool.name === 'write_file') r.created += 1
    else if (tool.name === 'read_file') r.read += 1
    else if (tool.name === 'grep' || tool.name === 'list_files' || tool.name === 'web_search') r.searched += 1
    else r.other += 1
  }
  return r
}

export function rollupLine(r: TurnRollup): string {
  const parts: string[] = []
  if (r.edited) parts.push(`edited ${r.edited} file${r.edited === 1 ? '' : 's'}`)
  if (r.created) parts.push(`created ${r.created} file${r.created === 1 ? '' : 's'}`)
  if (r.commands) parts.push(`ran ${r.commands} command${r.commands === 1 ? '' : 's'}`)
  if (r.read) parts.push(`read ${r.read} file${r.read === 1 ? '' : 's'}`)
  if (r.searched) parts.push(`${r.searched} search${r.searched === 1 ? '' : 'es'}`)
  // A turn that only read/searched isn't worth a rollup line.
  if (parts.length < 2 && !r.edited && !r.created && !r.commands) return ''
  if (parts.length === 0) return ''
  const head = parts.join(', ').replace(/^./, (c) => c.toUpperCase())
  const stat = r.added || r.removed ? ` · +${r.added} −${r.removed}` : ''
  return `${head}${stat}`
}

// Turns a tool call into the one-line "Edited App.tsx +16 −2" style header the
// Claude Code transcript uses — a human verb, the thing it acted on, and a
// change stat when there is one. Pure, so it is easy to unit test.
import type { ToolItem } from './store.ts'

function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
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
    case 'read_file':
      return { verb: 'Read', target: basename(firstString(input, 'path') ?? ''), stat, expandable: false }
    case 'edit_file':
      return { verb: 'Edited', target: basename(firstString(input, 'path') ?? ''), stat, expandable: done }
    case 'write_file': {
      const created = tool.result?.startsWith('Created') ?? true
      return { verb: created ? 'Created' : 'Overwrote', target: basename(firstString(input, 'path') ?? ''), stat, expandable: done }
    }
    case 'list_files':
      return { verb: 'Listed', target: firstString(input, 'pattern', 'path') ?? 'files', stat, expandable: done }
    case 'grep':
      return { verb: 'Searched', target: firstString(input, 'pattern') ?? '', stat, expandable: done }
    case 'run_command': {
      const cmd = firstString(input, 'command') ?? ''
      return { verb: 'Ran', target: cmd.length > 60 ? `${cmd.slice(0, 59)}…` : cmd, stat, expandable: done }
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
  const stat = r.added || r.removed ? `  +${r.added} −${r.removed}` : ''
  return `${head}${stat}`
}

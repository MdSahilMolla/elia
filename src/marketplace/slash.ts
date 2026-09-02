// The interactive flow behind `/marketplace`. Each source (npm, pip, skills, mcp,
// connector) opens the same shape of sub-menu:
//   Installed (N)  — what this project already has, select one to remove
//   Suggested      — a shortlist / catalog to install or add
//   Search / Add   — free-text search (npm, pip) or a custom entry (mcp, connector)
import type { SlashOutcome } from '../ui/app/index.tsx'
import {
  installCommand,
  listInstalled,
  parsePipList,
  removeCommand,
  searchMarket,
  suggestedInstalls,
  type InstalledItem,
} from './registry.ts'
import { runShell } from '../shell.ts'

const done = (text: string): SlashOutcome => ({ handled: true, text })
const platformDelete = (file: string): string => (process.platform === 'win32' ? `del "${file}"` : `rm "${file}"`)

type Source = 'npm' | 'pip' | 'skill' | 'mcp' | 'connector'
type PkgSource = 'npm' | 'pip' | 'skill'

function normalizeSource(raw?: string): Source | undefined {
  if (!raw) return undefined
  if (raw === 'bun' || raw === 'npm') return 'npm'
  if (raw === 'pip') return 'pip'
  if (raw === 'skill' || raw === 'skills') return 'skill'
  if (raw === 'mcp') return 'mcp'
  if (raw === 'connector' || raw === 'connectors') return 'connector'
  return undefined
}

/** Entry point: `/marketplace [source] [query]`. */
export async function marketplaceOutcome(rawSource?: string, query?: string): Promise<SlashOutcome> {
  const source = normalizeSource(rawSource)

  if (source && query) {
    if (source === 'npm' || source === 'pip') return searchResults(source, query)
    if (source === 'mcp' || source === 'connector') {
      const { mcpAddOutcome } = await import('../mcp/slash.ts')
      return mcpAddOutcome(source === 'mcp' ? 'server' : 'connector', query)
    }
  }
  if (source) return sourceMenu(source)

  return {
    handled: true,
    picker: {
      title: 'Marketplace — pick a source',
      options: [
        { label: 'npm', detail: 'JavaScript/TypeScript packages (bun/npm)', value: 'npm' },
        { label: 'pip', detail: 'Python packages', value: 'pip' },
        { label: 'skills', detail: "elia's learned tools (*.skill.ts)", value: 'skill' },
        { label: 'mcp', detail: 'MCP servers — a local tool process', value: 'mcp' },
        { label: 'connector', detail: 'hosted MCP endpoints (Notion, Linear, Sentry, …)', value: 'connector' },
      ],
      onSelect: (value) => {
        const picked = normalizeSource(value ?? undefined)
        if (picked) return sourceMenu(picked)
      },
    },
  }
}

// ---------- per-source sub-menu ----------

async function sourceMenu(source: Source): Promise<SlashOutcome> {
  if (source === 'mcp' || source === 'connector') {
    const { mcpManageOutcome } = await import('../mcp/slash.ts')
    const kindLabel = source === 'mcp' ? 'MCP servers' : 'connectors'
    return {
      handled: true,
      picker: {
        title: `Marketplace — ${kindLabel}`,
        options: [
          { label: 'Installed / configured', detail: `what's in .elia/mcp.json — status, test, enable, disable, remove`, value: 'installed' },
          { label: 'Suggested', detail: 'add one from the curated catalog', value: 'suggested' },
          { label: 'Add custom', detail: source === 'mcp' ? 'name + launch command' : 'name + endpoint URL', value: 'custom' },
        ],
        onSelect: async (value) => {
          const { mcpAddOutcome, mcpCustomAddOutcome } = await import('../mcp/slash.ts')
          if (value === 'installed') return mcpManageOutcome('', source === 'connector')
          if (value === 'suggested') return mcpAddOutcome(source === 'mcp' ? 'server' : 'connector')
          if (value === 'custom') return mcpCustomAddOutcome(source === 'mcp' ? 'server' : 'connector')
        },
      },
    }
  }

  const installed = await installedItems(source)
  const label = source === 'skill' ? 'skills' : source

  const options: { label: string; detail?: string; value: string }[] = [
    { label: `Installed (${installed.length})`, detail: installed.length ? 'select one to remove it' : 'nothing yet', value: 'installed' },
    { label: 'Suggested', detail: source === 'skill' ? 'routines elia could turn into a skill' : 'common, widely-useful packages', value: 'suggested' },
  ]
  if (source === 'npm' || source === 'pip') options.push({ label: `Search ${label}…`, detail: 'free-text search of the registry', value: 'search' })

  return {
    handled: true,
    picker: {
      title: `Marketplace — ${label}`,
      options,
      onSelect: (value) => {
        if (value === 'installed') return installedOutcome(source, installed)
        if (value === 'suggested') return suggestedOutcome(source)
        if (value === 'search' && (source === 'npm' || source === 'pip')) {
          return { handled: true, prompt: { label: `Search ${label} for:`, placeholder: 'name or keywords', onSubmit: (q) => searchResults(source, q) } }
        }
      },
    },
  }
}

// ---------- installed ----------

async function installedItems(source: PkgSource): Promise<InstalledItem[]> {
  const cwd = process.cwd()
  if (source === 'npm') return listInstalled(cwd).filter((i) => i.kind === 'npm' || i.kind === 'bun')
  if (source === 'skill') return listInstalled(cwd).filter((i) => i.kind === 'skill')
  if (source === 'pip') {
    const result = await runShell('pip list --format=json', undefined, cwd).catch(() => undefined)
    return result?.stdout ? parsePipList(result.stdout) : []
  }
  return []
}

function installedOutcome(source: PkgSource, items: InstalledItem[]): SlashOutcome {
  if (items.length === 0) return done(`Nothing installed for ${source === 'skill' ? 'skills' : source}.`)
  return {
    handled: true,
    picker: {
      title: `Installed ${source === 'skill' ? 'skills' : source} (${items.length}) — select to remove`,
      searchable: items.length > 8,
      options: items.map((i) => ({ label: i.name, detail: i.detail, value: `${i.kind}:${i.name}` })),
      onSelect: (value) => {
        const item = items.find((i) => `${i.kind}:${i.name}` === value)
        if (!item) return
        if (item.kind === 'skill' && item.file) {
          return { handled: true, runCommand: { command: platformDelete(item.file), description: `Delete skill "${item.name}" (${item.file})` } }
        }
        const cmd = removeCommand(item, process.cwd())
        return cmd
          ? { handled: true, runCommand: { command: cmd, description: `Uninstall ${item.name} (${item.kind}) — removes it from disk` } }
          : `Cannot remove ${item.name}.`
      },
    },
  }
}

// ---------- suggested ----------

async function suggestedOutcome(source: PkgSource): Promise<SlashOutcome> {
  if (source === 'skill') {
    const { skillCandidates } = await import('../skills/detector.ts')
    const candidates = skillCandidates()
    if (candidates.length === 0) {
      return done('No skill candidates yet. elia proposes one once it has repeated the same command shape or tool sequence enough times this project — then run "elia skills synth".')
    }
    return done(
      ['Routines elia could turn into a tested skill (run "elia skills synth" to build one):', ...candidates.map((c) => `  ${c.kind === 'command' ? '$' : '→'} ${c.pattern}   ×${c.count}`)].join('\n'),
    )
  }

  const kind: 'npm' | 'pip' = source
  const suggestions = suggestedInstalls(kind, process.cwd())
  if (suggestions.length === 0) return done(`This project already has every ${kind} package on the suggested shortlist. Use Search for anything else.`)
  return {
    handled: true,
    picker: {
      title: `Suggested ${kind} packages — select to install`,
      searchable: suggestions.length > 8,
      options: suggestions.map((s) => ({ label: s.name, detail: s.description, value: s.name })),
      onSelect: (name) => {
        if (!name) return
        try {
          return { handled: true, runCommand: { command: installCommand(kind, name, process.cwd()), description: `Install ${name} (${kind})` } }
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      },
    },
  }
}

// ---------- search ----------

async function searchResults(kind: 'npm' | 'pip', query: string): Promise<SlashOutcome> {
  let results
  try {
    results = await searchMarket(kind, query)
  } catch (error) {
    return done(`Search failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (results.length === 0) return done(`Nothing found for "${query}" on ${kind}.`)
  return {
    handled: true,
    picker: {
      title: `${kind} — results for "${query}"`,
      searchable: results.length > 8,
      options: results.map((r) => ({ label: `${r.name}${r.version ? ` @${r.version}` : ''}`, detail: (r.description ?? '').slice(0, 80), value: r.name })),
      onSelect: (name) => {
        if (!name) return
        try {
          return { handled: true, runCommand: { command: installCommand(kind, name, process.cwd()), description: `Install ${name} (${kind})` } }
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      },
    },
  }
}

// The interactive flows behind `/mcp`, `/connector`, and `/marketplace mcp`.
// Every "add" path ends in a write to `.elia/mcp.json` or `~/.elia/mcp.json`
// followed by a live reconnect, so what the user just added is verified and
// usable in the same session — no restart, no "did it work?".
//
// Note on the slash-chain framework (src/ui/app/App.tsx): a text prompt that is
// submitted blank aborts the chain, so optional inputs are modelled as a picker
// ("enter it" / "skip") rather than a prompt the user can leave empty.
import type { SlashOutcome } from '../ui/app/index.tsx'
import {
  findMcpServerScope,
  isValidMcpServerName,
  loadMcpServerConfigs,
  mcpTransportKind,
  removeMcpServer,
  setMcpServerDisabled,
  upsertMcpServer,
  type McpServerConfig,
} from './config.ts'
import { catalogEntryToConfig, searchCatalog, searchOfficialRegistry, type CatalogEntry } from './catalog.ts'
import { McpClient } from './client.ts'
import { McpHttpClient } from './httpClient.ts'
import { mcpStatusReport, reloadMcpTools } from './registry.ts'

type Kind = 'server' | 'connector'

const line = (text: string): SlashOutcome => ({ handled: true, text })

function existingNames(cwd: string): Set<string> {
  return new Set(loadMcpServerConfigs(cwd).servers.map((s) => s.name))
}

function uniqueName(base: string, cwd: string): string {
  const clean = base.replace(/[^a-z0-9_-]/gi, '-').replace(/^-+/, '').slice(0, 40) || 'server'
  const taken = existingNames(cwd)
  if (!taken.has(clean)) return clean
  for (let i = 2; i < 100; i++) if (!taken.has(`${clean}-${i}`)) return `${clean}-${i}`
  return `${clean}-${Date.now()}`
}

function describeEntry(entry: CatalogEntry): string {
  const auth =
    entry.kind === 'connector'
      ? entry.noAuth
        ? 'no auth'
        : entry.headers?.length
          ? `auth: ${entry.headers.map((h) => h.key).join(', ')}`
          : 'auth varies'
      : entry.env?.length
        ? `needs ${entry.env.map((e) => e.key).join(', ')}`
        : 'no secrets'
  return `${entry.description} · ${auth}`
}

// ---------- add: browse the catalog ----------

/** The `/marketplace mcp` / `/mcp` → add / `/connector` → add browse-and-add flow. */
export async function mcpAddOutcome(kind: Kind, query = ''): Promise<SlashOutcome> {
  const curated = searchCatalog(kind, query)
  let live: CatalogEntry[] = []
  try {
    live = (await searchOfficialRegistry(query)).filter(
      (e) => e.kind === kind && !curated.some((c) => c.url === e.url || (c.args && e.args && c.args.join() === e.args.join())),
    )
  } catch {
    // registry is best-effort; the curated list stands alone
  }
  const entries = [...curated, ...live]

  const customLabel = kind === 'connector' ? '＋  Add a custom connector (name + URL)' : '＋  Add a custom server (name + command)'
  const options = [
    { label: customLabel, detail: 'enter the details by hand', value: '__custom__' },
    ...entries.map((e) => ({ label: e.name, detail: describeEntry(e), value: e.id })),
  ]

  return {
    handled: true,
    picker: {
      title: kind === 'connector' ? 'Add an MCP connector' : 'Add an MCP server',
      searchable: options.length > 8,
      options,
      onSelect: (value) => {
        if (!value) return
        if (value === '__custom__') return customAddOutcome(kind)
        const entry = entries.find((e) => e.id === value)
        if (!entry) return `No catalog entry "${value}".`
        return catalogAddOutcome(entry)
      },
    },
  }
}

function catalogAddOutcome(entry: CatalogEntry): SlashOutcome {
  const name = uniqueName(entry.id, process.cwd())
  if (entry.kind === 'connector') {
    const headers = entry.headers ?? []
    if (headers.length === 0) return chooseScopeOutcome(name, () => catalogEntryToConfig(entry, name, {}), entry.homepage)
    return connectorAuthOutcome(entry, name, headers, {})
  }
  return collectEnvOutcome(entry, name, entry.env ?? [], {})
}

function collectEnvOutcome(
  entry: CatalogEntry,
  name: string,
  pending: { key: string; description: string }[],
  collected: Record<string, string>,
): SlashOutcome {
  if (pending.length === 0) return chooseScopeOutcome(name, () => catalogEntryToConfig(entry, name, collected), entry.homepage)
  const [next, ...rest] = pending
  return {
    handled: true,
    prompt: {
      label: `${next!.key} — ${next!.description}:`,
      onSubmit: (value) => {
        const trimmed = value.trim()
        if (!trimmed) return line(`${next!.key} is required for ${entry.name}. Run the command again to retry.`)
        collected[next!.key] = trimmed
        return collectEnvOutcome(entry, name, rest, collected)
      },
    },
  }
}

function connectorAuthOutcome(
  entry: CatalogEntry,
  name: string,
  pending: { key: string; description: string; example?: string }[],
  collected: Record<string, string>,
): SlashOutcome {
  if (pending.length === 0) return chooseScopeOutcome(name, () => catalogEntryToConfig(entry, name, collected), entry.homepage)
  const [next, ...rest] = pending
  return {
    handled: true,
    picker: {
      title: `${entry.name} — ${next!.key}`,
      options: [
        { label: `Enter the ${next!.key} value`, detail: next!.description, value: 'enter' },
        { label: 'Skip — connect without it', detail: entry.noAuth ? 'works unauthenticated' : 'may fail until you add it via /connector', value: 'skip' },
      ],
      onSelect: (choice) => {
        if (choice === 'skip') return connectorAuthOutcome(entry, name, rest, collected)
        if (choice !== 'enter') return
        return {
          handled: true,
          prompt: {
            label: `${next!.key} value${next!.example ? ` (e.g. "${next!.example}")` : ''}:`,
            placeholder: next!.example,
            onSubmit: (value) => {
              if (value.trim()) collected[next!.key] = value.trim()
              return connectorAuthOutcome(entry, name, rest, collected)
            },
          },
        }
      },
    },
  }
}

// ---------- add: custom ----------

/** The "add by hand" path on its own — `/marketplace → mcp → Add custom`. */
export function mcpCustomAddOutcome(kind: Kind): SlashOutcome {
  return customAddOutcome(kind)
}

function customAddOutcome(kind: Kind): SlashOutcome {
  return {
    handled: true,
    prompt: {
      label: kind === 'connector' ? 'Name for this connector (letters, digits, -, _):' : 'Name for this server (letters, digits, -, _):',
      placeholder: kind === 'connector' ? 'notion' : 'my-tool',
      onSubmit: (raw) => {
        const name = raw.trim()
        if (!isValidMcpServerName(name)) return line('Invalid name — 1–48 chars: a letter first, then letters/digits/-/_.')
        if (existingNames(process.cwd()).has(name)) return line(`A server named "${name}" already exists. Pick another name or manage it with /mcp.`)
        return kind === 'connector' ? customConnectorUrlOutcome(name) : customServerCommandOutcome(name)
      },
    },
  }
}

function customServerCommandOutcome(name: string): SlashOutcome {
  return {
    handled: true,
    prompt: {
      label: 'Launch command (e.g. "npx -y @modelcontextprotocol/server-github"):',
      placeholder: 'npx -y @scope/package',
      onSubmit: (raw) => {
        const parts = raw.trim().split(/\s+/).filter(Boolean)
        if (parts.length === 0) return line('No command given.')
        const config: McpServerConfig = { name, command: parts[0]!, args: parts.slice(1) }
        return chooseScopeOutcome(name, () => config)
      },
    },
  }
}

function customConnectorUrlOutcome(name: string): SlashOutcome {
  return {
    handled: true,
    prompt: {
      label: 'Connector URL (the MCP endpoint, usually ends in /mcp or /sse):',
      placeholder: 'https://mcp.example.com/mcp',
      onSubmit: (raw) => {
        const url = raw.trim()
        if (!/^https?:\/\//i.test(url)) return line('That is not an http(s) URL.')
        const transport: McpServerConfig['transport'] = /\/sse\b/i.test(url) ? 'sse' : undefined
        const build = (headers?: Record<string, string>): McpServerConfig => ({ name, url, transport, headers })
        return {
          handled: true,
          picker: {
            title: `Authentication for "${name}"`,
            options: [
              { label: 'No authentication', value: 'none' },
              { label: 'Authorization header', detail: 'e.g. "Bearer sk-…"', value: 'auth' },
              { label: 'A custom header', detail: 'any "Name: value"', value: 'custom' },
            ],
            onSelect: (choice) => {
              if (choice === 'none') return chooseScopeOutcome(name, () => build())
              if (choice === 'auth') {
                return {
                  handled: true,
                  prompt: {
                    label: 'Authorization header value (e.g. "Bearer sk-…"):',
                    onSubmit: (v) => (v.trim() ? chooseScopeOutcome(name, () => build({ Authorization: v.trim() })) : line('No value entered.')),
                  },
                }
              }
              if (choice === 'custom') {
                return {
                  handled: true,
                  prompt: {
                    label: 'Header line ("Name: value"):',
                    onSubmit: (raw2) => {
                      const h = raw2.trim()
                      const idx = h.indexOf(':')
                      if (idx <= 0) return line('Header must look like "Name: value".')
                      return chooseScopeOutcome(name, () => build({ [h.slice(0, idx).trim()]: h.slice(idx + 1).trim() }))
                    },
                  },
                }
              }
            },
          },
        }
      },
    },
  }
}

// ---------- write + reconnect ----------

function chooseScopeOutcome(name: string, buildConfig: () => McpServerConfig, homepage?: string): SlashOutcome {
  return {
    handled: true,
    picker: {
      title: `Save "${name}" where?`,
      options: [
        { label: 'This project', detail: '.elia/mcp.json — checked in, shared with the team', value: 'project' },
        { label: 'Your user config', detail: '~/.elia/mcp.json — personal, every project', value: 'user' },
      ],
      onSelect: async (scope) => {
        if (scope !== 'project' && scope !== 'user') return
        let path: string
        try {
          path = upsertMcpServer(scope, buildConfig(), process.cwd())
        } catch (err) {
          return err instanceof Error ? err.message : String(err)
        }
        const result = await connectAfterWrite(name, path)
        return homepage ? `${result}\nDocs: ${homepage}` : result
      },
    },
  }
}

async function connectAfterWrite(name: string, path: string): Promise<string> {
  if (process.env.ELIA_MCP_NO_AUTOCONNECT === '1') {
    return `Added "${name}" to ${path}. Run /mcp reload to connect it.`
  }
  let report
  try {
    report = await reloadMcpTools(process.cwd())
  } catch (err) {
    return `Saved "${name}" to ${path}, but the reconnect threw: ${err instanceof Error ? err.message : String(err)}. Try /mcp reload.`
  }
  const status = report.status.find((s) => s.name === name)
  if (status?.connected) {
    return `✓  Added "${name}" to ${path} and connected — ${status.toolCount} tool(s): ${status.tools.join(', ') || '(none exposed)'}`
  }
  const why = status?.error ?? report.failed.find((f) => f.server === name)?.reason ?? 'did not connect'
  return `Added "${name}" to ${path}, but it is not usable yet: ${why}\nFix the entry and run /mcp reload, or /connector → ${name} → Test connection.`
}

// ---------- manage: /mcp and /connector ----------

export async function mcpManageOutcome(arg = '', connectorsOnly = false): Promise<SlashOutcome> {
  const sub = arg.trim().toLowerCase()
  if (sub === 'reload') {
    const report = await reloadMcpTools(process.cwd())
    return line(renderReport(report.status, connectorsOnly))
  }
  if (sub === 'add') return mcpAddOutcome(connectorsOnly ? 'connector' : 'server')
  if (sub === 'list') return line(renderReport(mcpStatusReport().status, connectorsOnly))

  const all = mcpStatusReport().status
  const rows = connectorsOnly ? all.filter((s) => s.connector) : all

  const actions = connectorsOnly
    ? [{ label: '＋  Add a connector', detail: 'from the catalog or by URL', value: '__add_connector__' }]
    : [
        { label: '＋  Add an MCP server', detail: 'a local process (stdio)', value: '__add_server__' },
        { label: '＋  Add a connector', detail: 'a hosted endpoint (URL)', value: '__add_connector__' },
      ]
  const options = [
    ...actions,
    { label: '↻  Reload all', detail: 'reconnect every server from the config on disk', value: '__reload__' },
    ...rows.map((s) => ({
      label: `${s.connected ? '●' : s.disabled ? '○' : '✗'} ${s.name}`,
      detail: `${s.transport}${s.connector ? ' · connector' : ''} · ${s.disabled ? 'disabled' : s.connected ? `${s.toolCount} tool(s)` : s.error ?? 'not connected'}`,
      value: `srv:${s.name}`,
    })),
  ]

  return {
    handled: true,
    picker: {
      title: connectorsOnly ? `MCP connectors (${rows.length})` : `MCP servers (${rows.length})`,
      searchable: options.length > 10,
      options,
      onSelect: (value) => {
        if (!value) return
        if (value === '__add_server__') return mcpAddOutcome('server')
        if (value === '__add_connector__') return mcpAddOutcome('connector')
        if (value === '__reload__') return reloadMcpTools(process.cwd()).then((r) => renderReport(r.status, connectorsOnly))
        if (value.startsWith('srv:')) return serverActionsOutcome(value.slice(4))
      },
    },
  }
}

function serverActionsOutcome(name: string): SlashOutcome {
  const cwd = process.cwd()
  const scope = findMcpServerScope(name, cwd)
  const status = mcpStatusReport().status.find((s) => s.name === name)
  const config = loadMcpServerConfigs(cwd).servers.find((s) => s.name === name)
  if (!scope || !config) return line(`"${name}" is not in any config file.`)

  const options: { label: string; detail?: string; value: string }[] = [
    { label: status?.disabled ? 'Enable' : 'Disable', detail: `toggle in ${scope} config`, value: 'toggle' },
    { label: 'Test connection', detail: 'connect now and list tools', value: 'test' },
    { label: 'Remove', detail: `delete from ${scope} config`, value: 'remove' },
  ]
  if (status?.tools.length) options.push({ label: `Show ${status.tools.length} tool(s)`, value: 'tools' })

  return {
    handled: true,
    picker: {
      title: `${name} — ${mcpTransportKind(config)}${config.url ? ` · ${config.url}` : ''}`,
      options,
      onSelect: async (action) => {
        if (action === 'tools') return (status?.tools ?? []).join('\n') || 'No tools exposed.'
        if (action === 'test') return testConnection(config)
        if (action === 'toggle') {
          const next = !(status?.disabled ?? false)
          setMcpServerDisabled(scope, name, next, cwd)
          const report = await reloadMcpTools(cwd)
          const now = report.status.find((s) => s.name === name)
          return next
            ? `Disabled "${name}".`
            : now?.connected
              ? `Enabled "${name}" — ${now.toolCount} tool(s): ${now.tools.join(', ')}`
              : `Enabled "${name}", but it did not connect: ${now?.error ?? 'unknown'}`
        }
        if (action === 'remove') {
          return {
            handled: true,
            picker: {
              title: `Remove "${name}" from the ${scope} config?`,
              options: [
                { label: 'Yes, remove it', value: 'yes' },
                { label: 'Cancel', value: 'no' },
              ],
              onSelect: async (confirm) => {
                if (confirm !== 'yes') return 'Cancelled.'
                const { removed, path } = removeMcpServer(scope, name, cwd)
                await reloadMcpTools(cwd)
                return removed ? `Removed "${name}" from ${path}.` : `"${name}" was not in ${path}.`
              },
            },
          }
        }
      },
    },
  }
}

async function testConnection(config: McpServerConfig): Promise<string> {
  const client = mcpTransportKind(config) === 'stdio' ? new McpClient(config) : new McpHttpClient(config)
  try {
    await client.connect()
    const { tools } = await client.listTools()
    return `✓  ${config.name} is reachable — ${tools.length} tool(s): ${tools.map((t) => t.name).join(', ') || '(none)'}`
  } catch (err) {
    return `✗  ${config.name}: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    await client.closeAndWait().catch(() => {})
  }
}

function renderReport(
  status: { name: string; transport: string; connector: boolean; disabled: boolean; connected: boolean; toolCount: number; error?: string }[],
  connectorsOnly: boolean,
): string {
  const rows = connectorsOnly ? status.filter((s) => s.connector) : status
  if (rows.length === 0) {
    return connectorsOnly
      ? 'No connectors configured. Add one with /connector, or /marketplace → mcp.'
      : 'No MCP servers configured. Add one with /mcp, or /marketplace → mcp.'
  }
  return rows
    .map((s) => {
      const state = s.disabled ? 'disabled' : s.connected ? `connected · ${s.toolCount} tool(s)` : `offline · ${s.error ?? 'not connected'}`
      return `${s.connected ? '●' : '○'} ${s.name}  (${s.transport}${s.connector ? ' connector' : ''})  ${state}`
    })
    .join('\n')
}

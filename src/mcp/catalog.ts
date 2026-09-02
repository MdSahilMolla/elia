import type { McpServerConfig } from './config.ts'

/**
 * A curated, offline list of well-known MCP servers and connectors, shown by
 * `/marketplace mcp` and `/connector`. Curated rather than purely registry-fed so
 * the browse experience works with no network and every entry is one elia has a
 * sane default command/URL for. `searchOfficialRegistry` layers live results from
 * the official MCP registry on top, degrading to just this list when offline.
 */

export interface CatalogEntry {
  id: string
  name: string
  description: string
  kind: 'server' | 'connector'
  homepage?: string
  /** stdio servers: the launch command + args. */
  command?: string
  args?: string[]
  /** connectors: the hosted endpoint. */
  url?: string
  transport?: 'http' | 'sse'
  /** Env vars (stdio) the user must supply — usually secrets. */
  env?: { key: string; description: string }[]
  /** HTTP headers (connectors) the user must supply, e.g. an auth token. */
  headers?: { key: string; description: string; example?: string }[]
  /** True when the connector works with no credentials — good for a first try. */
  noAuth?: boolean
}

const SERVERS: CatalogEntry[] = [
  {
    id: 'github',
    name: 'GitHub',
    description: 'Repos, issues, PRs, code search via the GitHub API',
    kind: 'server',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: [{ key: 'GITHUB_PERSONAL_ACCESS_TOKEN', description: 'a GitHub PAT with the scopes you need' }],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read/write files under an explicit set of allowed directories',
    kind: 'server',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
  },
  {
    id: 'git',
    name: 'Git',
    description: 'Inspect and operate on a local git repository',
    kind: 'server',
    command: 'uvx',
    args: ['mcp-server-git'],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
  },
  {
    id: 'fetch',
    name: 'Fetch',
    description: 'Fetch a URL and return it as clean markdown',
    kind: 'server',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
  },
  {
    id: 'memory',
    name: 'Memory',
    description: 'A local knowledge-graph the model can read and write across turns',
    kind: 'server',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    description: 'A structured step-by-step reasoning scratchpad tool',
    kind: 'server',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
  },
  {
    id: 'postgres',
    name: 'Postgres',
    description: 'Read-only SQL queries and schema inspection against a Postgres database',
    kind: 'server',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    env: [{ key: 'DATABASE_URL', description: 'postgres://user:pass@host:5432/db' }],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Query and modify a local SQLite database file',
    kind: 'server',
    command: 'uvx',
    args: ['mcp-server-sqlite', '--db-path', './data.db'],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
  },
  {
    id: 'playwright',
    name: 'Playwright',
    description: 'Drive a real browser — navigate, click, type, snapshot (auto-routed through elia’s browser tool)',
    kind: 'server',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    homepage: 'https://github.com/microsoft/playwright-mcp',
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer',
    description: 'Headless Chrome automation and screenshots',
    kind: 'server',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer',
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Web and local search via the Brave Search API',
    kind: 'server',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: [{ key: 'BRAVE_API_KEY', description: 'a Brave Search API key' }],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Read and post messages in a Slack workspace',
    kind: 'server',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    env: [
      { key: 'SLACK_BOT_TOKEN', description: 'xoxb- bot token' },
      { key: 'SLACK_TEAM_ID', description: 'the workspace/team id' },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack',
  },
]

const CONNECTORS: CatalogEntry[] = [
  {
    id: 'deepwiki',
    name: 'DeepWiki',
    description: 'Ask questions about any public GitHub repo (Devin/Cognition). No auth.',
    kind: 'connector',
    url: 'https://mcp.deepwiki.com/mcp',
    noAuth: true,
    homepage: 'https://docs.devin.ai/work-with-devin/deepwiki-mcp',
  },
  {
    id: 'context7',
    name: 'Context7',
    description: 'Up-to-date, version-specific docs and code examples for libraries.',
    kind: 'connector',
    url: 'https://mcp.context7.com/mcp',
    noAuth: true,
    homepage: 'https://context7.com',
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    description: 'Search models, datasets, Spaces, and papers on the Hub.',
    kind: 'connector',
    url: 'https://huggingface.co/mcp',
    noAuth: true,
    headers: [{ key: 'Authorization', description: 'optional: "Bearer hf_…" for gated/private content', example: 'Bearer hf_xxx' }],
    homepage: 'https://huggingface.co/settings/mcp',
  },
  {
    id: 'github-remote',
    name: 'GitHub (hosted)',
    description: 'GitHub’s own hosted MCP server — no local process to run.',
    kind: 'connector',
    url: 'https://api.githubcopilot.com/mcp/',
    headers: [{ key: 'Authorization', description: 'a GitHub PAT', example: 'Bearer github_pat_xxx' }],
    homepage: 'https://github.com/github/github-mcp-server',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    description: 'Query issues, events, and releases in your Sentry org.',
    kind: 'connector',
    url: 'https://mcp.sentry.dev/mcp',
    headers: [{ key: 'Authorization', description: 'a Sentry auth token', example: 'Bearer sntrys_xxx' }],
    homepage: 'https://docs.sentry.io/product/sentry-mcp/',
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Issues, projects, and cycles in Linear.',
    kind: 'connector',
    url: 'https://mcp.linear.app/sse',
    transport: 'sse',
    headers: [{ key: 'Authorization', description: 'a Linear API key', example: 'Bearer lin_api_xxx' }],
    homepage: 'https://linear.app/docs/mcp',
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Search and edit pages and databases in a Notion workspace.',
    kind: 'connector',
    url: 'https://mcp.notion.com/mcp',
    headers: [{ key: 'Authorization', description: 'a Notion integration token', example: 'Bearer ntn_xxx' }],
    homepage: 'https://developers.notion.com/docs/mcp',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    description: 'Query and manage Stripe resources (customers, invoices, products).',
    kind: 'connector',
    url: 'https://mcp.stripe.com',
    headers: [{ key: 'Authorization', description: 'a Stripe restricted API key', example: 'Bearer rk_live_xxx' }],
    homepage: 'https://docs.stripe.com/mcp',
  },
]

export const MCP_CATALOG: CatalogEntry[] = [...SERVERS, ...CONNECTORS]

export function catalogEntries(kind: 'server' | 'connector'): CatalogEntry[] {
  return MCP_CATALOG.filter((entry) => entry.kind === kind)
}

export function findCatalogEntry(id: string): CatalogEntry | undefined {
  return MCP_CATALOG.find((entry) => entry.id === id)
}

/** Case-insensitive substring match over id / name / description, filtered by kind. */
export function searchCatalog(kind: 'server' | 'connector', query: string): CatalogEntry[] {
  const q = query.trim().toLowerCase()
  const pool = catalogEntries(kind)
  if (!q) return pool
  return pool.filter((e) => `${e.id} ${e.name} ${e.description}`.toLowerCase().includes(q))
}

/** The McpServerConfig a catalog entry maps to once the user has supplied its env/headers. */
export function catalogEntryToConfig(entry: CatalogEntry, name: string, secrets: Record<string, string>): McpServerConfig {
  if (entry.kind === 'connector') {
    const headers: Record<string, string> = {}
    for (const header of entry.headers ?? []) {
      const value = secrets[header.key]?.trim()
      if (value) headers[header.key] = value
    }
    return {
      name,
      url: entry.url!,
      transport: entry.transport === 'sse' ? 'sse' : undefined,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    }
  }
  const env: Record<string, string> = {}
  for (const variable of entry.env ?? []) {
    const value = secrets[variable.key]?.trim()
    if (value) env[variable.key] = value
  }
  return {
    name,
    command: entry.command!,
    args: entry.args,
    env: Object.keys(env).length > 0 ? env : undefined,
  }
}

interface RegistryServer {
  name: string
  description?: string
  repository?: { url?: string }
  packages?: { registry_name?: string; name?: string; runtime_hint?: string }[]
  remotes?: { transport_type?: string; url?: string }[]
}

/**
 * Best-effort live search of the official MCP registry
 * (registry.modelcontextprotocol.io). Any failure — offline, timeout, schema
 * drift — resolves to `[]` so the curated list still stands on its own.
 */
export async function searchOfficialRegistry(query: string, limit = 20): Promise<CatalogEntry[]> {
  if (process.env.ELIA_NO_MCP_REGISTRY === '1') return []
  try {
    const url = `https://registry.modelcontextprotocol.io/v0/servers?limit=${limit}${query.trim() ? `&search=${encodeURIComponent(query.trim())}` : ''}`
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000), headers: { accept: 'application/json' } })
    if (!response.ok) return []
    const data = (await response.json()) as { servers?: RegistryServer[] }
    const out: CatalogEntry[] = []
    for (const server of data.servers ?? []) {
      const remote = server.remotes?.find((r) => r.url)
      const pkg = server.packages?.find((p) => p.name)
      const shortName = server.name.split('/').pop() ?? server.name
      const id = `reg-${shortName.replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}`.slice(0, 48)
      if (remote?.url) {
        out.push({
          id,
          name: server.name,
          description: server.description ?? 'from the official MCP registry',
          kind: 'connector',
          url: remote.url,
          transport: remote.transport_type === 'sse' ? 'sse' : 'http',
          homepage: server.repository?.url,
        })
      } else if (pkg?.name && (pkg.registry_name === 'npm' || pkg.runtime_hint === 'npx' || !pkg.registry_name)) {
        out.push({
          id,
          name: server.name,
          description: server.description ?? 'from the official MCP registry',
          kind: 'server',
          command: 'npx',
          args: ['-y', pkg.name],
          homepage: server.repository?.url,
        })
      }
    }
    return out
  } catch {
    return []
  }
}

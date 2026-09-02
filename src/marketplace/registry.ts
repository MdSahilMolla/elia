// The data + commands behind /marketplace and /packages. This module never runs
// anything itself — it returns command strings that the caller executes through
// the normal risk-check + confirm + shell path, so an install or uninstall is
// always something the user explicitly approved and can see.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'

export type PackageKind = 'npm' | 'bun' | 'pip' | 'skill'

export interface MarketItem {
  name: string
  version?: string
  description?: string
  /** npmjs.com / pypi.org link, when there is one. */
  homepage?: string
}

export interface InstalledItem {
  name: string
  kind: PackageKind
  detail: string
  /** The file to delete for a skill; undefined for registry packages. */
  file?: string
}

const NPM_SEARCH = 'https://registry.npmjs.org/-/v1/search'
const PYPI_JSON = 'https://pypi.org/pypi'

function detectJsRunner(cwd: string): 'bun' | 'npm' {
  return existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb')) ? 'bun' : 'npm'
}

// ---------- search ----------

/** Searches the npm registry (also the source for `bun add`). */
export async function searchNpm(query: string, limit = 15): Promise<MarketItem[]> {
  const url = `${NPM_SEARCH}?text=${encodeURIComponent(query)}&size=${limit}`
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`npm registry returned ${response.status}`)
  const data = (await response.json()) as { objects?: { package: { name: string; version: string; description?: string; links?: { npm?: string } } }[] }
  return (data.objects ?? []).map((entry) => ({
    name: entry.package.name,
    version: entry.package.version,
    description: entry.package.description,
    homepage: entry.package.links?.npm,
  }))
}

/**
 * PyPI has no public keyword-search API any more, so this resolves the query as
 * an exact package name. Good enough for "install requests"; a fuzzy search
 * would need scraping, which this deliberately does not do.
 */
export async function searchPypi(query: string): Promise<MarketItem[]> {
  const name = query.trim().split(/\s+/)[0] ?? ''
  if (!name) return []
  const response = await fetch(`${PYPI_JSON}/${encodeURIComponent(name)}/json`, { signal: AbortSignal.timeout(10_000) })
  if (response.status === 404) return []
  if (!response.ok) throw new Error(`PyPI returned ${response.status}`)
  const data = (await response.json()) as { info?: { name: string; version: string; summary?: string; home_page?: string; project_url?: string } }
  if (!data.info) return []
  return [{
    name: data.info.name,
    version: data.info.version,
    description: data.info.summary,
    homepage: data.info.project_url || data.info.home_page,
  }]
}

export async function searchMarket(kind: PackageKind, query: string): Promise<MarketItem[]> {
  if (kind === 'npm' || kind === 'bun') return searchNpm(query)
  if (kind === 'pip') return searchPypi(query)
  return [] // skills: no remote registry yet
}

// ---------- install / remove command strings ----------

export function installCommand(kind: PackageKind, name: string, cwd = process.cwd()): string {
  const safe = shellSafeName(name)
  if (kind === 'bun') return `bun add ${safe}`
  if (kind === 'npm') return detectJsRunner(cwd) === 'bun' ? `bun add ${safe}` : `npm install ${safe}`
  if (kind === 'pip') return `pip install ${safe}`
  throw new Error(`skills are added by dropping a *.skill.ts file into .elia/skills — not "installed"`)
}

export function removeCommand(item: InstalledItem, cwd = process.cwd()): string {
  const safe = shellSafeName(item.name)
  if (item.kind === 'bun') return `bun remove ${safe}`
  if (item.kind === 'npm') return detectJsRunner(cwd) === 'bun' ? `bun remove ${safe}` : `npm uninstall ${safe}`
  if (item.kind === 'pip') return `pip uninstall -y ${safe}`
  return `` // skill: handled by deleting item.file
}

function shellSafeName(name: string): string {
  // npm/pip names are [a-z0-9._@/-] with an optional @scope and @version. Reject anything else outright.
  if (!/^[@a-z0-9][a-z0-9._@/-]*$/i.test(name)) throw new Error(`refusing an unsafe package name: ${name}`)
  return name
}

// ---------- installed inventory ----------

function jsDeps(cwd: string): InstalledItem[] {
  const pkgPath = join(cwd, 'package.json')
  if (!existsSync(pkgPath)) return []
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch {
    return []
  }
  const kind: PackageKind = detectJsRunner(cwd)
  const rows: InstalledItem[] = []
  for (const [name, range] of Object.entries(pkg.dependencies ?? {})) rows.push({ name, kind, detail: `dependency · ${range}` })
  for (const [name, range] of Object.entries(pkg.devDependencies ?? {})) rows.push({ name, kind, detail: `devDependency · ${range}` })
  return rows
}

function skillItems(): InstalledItem[] {
  const dirs = [join(process.cwd(), '.elia', 'skills'), join(homedir(), '.elia', 'skills')]
  const rows: InstalledItem[] = []
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.skill.ts')) continue
      rows.push({ name: basename(entry, '.skill.ts'), kind: 'skill', detail: dir.includes(homedir()) ? 'user skill' : 'project skill', file: join(dir, entry) })
    }
  }
  return rows
}

/** Everything installed that /packages can show and remove: JS deps + elia skills. (pip requires a shell call — see pipList.) */
export function listInstalled(cwd = process.cwd()): InstalledItem[] {
  return [...jsDeps(cwd), ...skillItems()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
}

// ---------- suggestions ----------

/**
 * A small, deliberately un-exotic shortlist of packages that pull their weight in
 * most projects. `/marketplace <src> → Suggested` shows these minus whatever the
 * project already has, so it's "things you might still want," not a top-10 chart.
 */
const SUGGESTED: Record<'npm' | 'pip', MarketItem[]> = {
  npm: [
    { name: 'typescript', description: 'the TypeScript compiler' },
    { name: 'tsx', description: 'run .ts files directly, no build step' },
    { name: 'vitest', description: 'fast unit-test runner' },
    { name: 'prettier', description: 'opinionated code formatter' },
    { name: 'eslint', description: 'pluggable linter' },
    { name: 'zod', description: 'schema validation with inferred types' },
    { name: 'dotenv', description: 'load .env into process.env' },
    { name: 'execa', description: 'nicer child_process' },
    { name: 'chalk', description: 'terminal string styling' },
    { name: 'pino', description: 'low-overhead JSON logger' },
  ],
  pip: [
    { name: 'requests', description: 'HTTP for humans' },
    { name: 'httpx', description: 'async-capable HTTP client' },
    { name: 'pytest', description: 'the standard test framework' },
    { name: 'ruff', description: 'very fast linter + formatter' },
    { name: 'pydantic', description: 'data validation via type hints' },
    { name: 'rich', description: 'rich text and tables in the terminal' },
    { name: 'typer', description: 'build CLIs from type hints' },
    { name: 'python-dotenv', description: 'load .env into os.environ' },
  ],
}

/** Suggested installs for a package source, with anything already present filtered out. */
export function suggestedInstalls(kind: 'npm' | 'bun' | 'pip', cwd = process.cwd(), installedNames: string[] = []): MarketItem[] {
  const key: 'npm' | 'pip' = kind === 'pip' ? 'pip' : 'npm'
  const have = new Set([...installedNames, ...listInstalled(cwd).map((i) => i.name)])
  return SUGGESTED[key].filter((item) => !have.has(item.name))
}

/** `pip list --format=json` parsed into inventory rows. Separate because it needs a subprocess. */
export function parsePipList(json: string): InstalledItem[] {
  try {
    const rows = JSON.parse(json) as { name: string; version: string }[]
    return rows.map((row) => ({ name: row.name, kind: 'pip' as const, detail: `pip · ${row.version}` }))
  } catch {
    return []
  }
}

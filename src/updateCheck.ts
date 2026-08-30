import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeSecureFile } from './securePersistence.ts'

const REGISTRY_URL = 'https://registry.npmjs.org/elia/latest'
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_CACHE_PATH = join(homedir(), '.elia', 'update-check.json')

interface UpdateCache {
  checkedAt: number
  latestVersion: string
}

export interface AvailableUpdate {
  currentVersion: string
  latestVersion: string
}

interface UpdateCheckOptions {
  cachePath?: string
  cacheTtlMs?: number
  fetcher?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  now?: number
}

function isNewerVersion(candidate: string, current: string): boolean {
  try {
    return Bun.semver.order(candidate, current) > 0
  } catch {
    return false
  }
}

function isValidVersion(version: string): boolean {
  try {
    return Bun.semver.order(version, version) === 0
  } catch {
    return false
  }
}

function readCache(path: string): UpdateCache | undefined {
  try {
    if (!existsSync(path)) return undefined
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<UpdateCache>
    if (!Number.isFinite(value.checkedAt) || typeof value.latestVersion !== 'string') return undefined
    return { checkedAt: value.checkedAt!, latestVersion: value.latestVersion }
  } catch {
    return undefined
  }
}

/** Check npm without making startup depend on registry or cache availability. */
export async function findAvailableUpdate(currentVersion: string, options: UpdateCheckOptions = {}): Promise<AvailableUpdate | undefined> {
  const cachePath = options.cachePath ?? DEFAULT_CACHE_PATH
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  const now = options.now ?? Date.now()
  const cached = readCache(cachePath)
  const cacheAge = cached ? now - cached.checkedAt : Number.POSITIVE_INFINITY

  if (cached && cacheAge >= 0 && cacheAge < cacheTtlMs) {
    return isNewerVersion(cached.latestVersion, currentVersion)
      ? { currentVersion, latestVersion: cached.latestVersion }
      : undefined
  }

  try {
    const response = await (options.fetcher ?? globalThis.fetch)(REGISTRY_URL, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(2_000),
    })
    if (!response.ok) throw new Error(`npm registry returned ${response.status}`)
    const body = (await response.json()) as { version?: unknown }
    if (typeof body.version !== 'string' || !isValidVersion(body.version)) throw new Error('npm registry returned an invalid version')
    try {
      writeSecureFile(cachePath, JSON.stringify({ checkedAt: now, latestVersion: body.version }))
    } catch {
      // A read-only home directory should not prevent the CLI from starting.
    }
    return isNewerVersion(body.version, currentVersion) ? { currentVersion, latestVersion: body.version } : undefined
  } catch {
    return cached && isNewerVersion(cached.latestVersion, currentVersion)
      ? { currentVersion, latestVersion: cached.latestVersion }
      : undefined
  }
}

export function renderUpdateNotice(update: AvailableUpdate): string {
  return `Update available: ${update.currentVersion} → ${update.latestVersion}. Run: npm install --global elia@latest`
}

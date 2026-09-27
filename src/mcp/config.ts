import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { projectMcpConfigPath, userMcpConfigPath } from './paths.ts'
import { withFileLock } from '../fileLock.ts'
import { hardenSecureFile, writeSecureFile } from '../securePersistence.ts'

/**
 * One configured MCP server. Two shapes:
 *  - **stdio** (`command` [+ `args`, `env`]) — a local process spawned over stdio,
 *    the same shape Claude Desktop and most other MCP hosts use for `mcpServers`,
 *    so an existing config can be copied in with no translation.
 *  - **remote / connector** (`url` [+ `headers`, `transport`]) — a hosted MCP
 *    endpoint reached over HTTP (Streamable HTTP by default, `"transport": "sse"`
 *    for a legacy SSE endpoint). `headers` carries auth (e.g. `Authorization`).
 */
export interface McpServerConfig {
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  transport?: 'stdio' | 'http' | 'sse'
  disabled?: boolean
}

export type McpConfigScope = 'project' | 'user'

const SERVER_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,47}$/i

/** True for a name safe to use as a config key and in a `mcp_<server>_<tool>` id. */
export function isValidMcpServerName(name: string): boolean {
  return SERVER_NAME_PATTERN.test(name)
}

/** stdio vs. remote, derived from which fields are set. */
export function mcpTransportKind(server: McpServerConfig): 'stdio' | 'http' | 'sse' {
  if (server.transport === 'sse') return 'sse'
  if (typeof server.url === 'string') return 'http'
  return 'stdio'
}

/** A connector is any server reached over the network rather than spawned locally. */
export function isConnector(server: McpServerConfig): boolean {
  return typeof server.url === 'string'
}

function scopePath(scope: McpConfigScope, cwd: string): string {
  return scope === 'project' ? projectMcpConfigPath(cwd) : userMcpConfigPath()
}

/**
 * Reads `.elia/mcp.json` (project) and `~/.elia/mcp.json` (user), each shaped
 * `{ "mcpServers": { "<name>": { ... } } }`. Project entries override user
 * entries with the same name, so a repo can pin or disable a server a user has
 * configured globally.
 */
export function loadMcpServerConfigs(cwd = process.cwd(), userPath = userMcpConfigPath()): { servers: McpServerConfig[]; errors: string[] } {
  const errors: string[] = []
  const byName = new Map<string, McpServerConfig>()

  for (const [path, layer] of [[userPath, 'user'], [projectMcpConfigPath(cwd), 'project']] as const) {
    if (!existsSync(path)) continue
    const parsed = parseConfigFile(path, layer, errors)
    for (const server of parsed) byName.set(server.name, server)
  }

  return { servers: [...byName.values()], errors }
}

/** Which layer a server named `name` is defined in, if any — needed before toggling or removing it. */
export function findMcpServerScope(name: string, cwd = process.cwd(), userPath = userMcpConfigPath()): McpConfigScope | null {
  for (const [path, scope] of [[projectMcpConfigPath(cwd), 'project'], [userPath, 'user']] as const) {
    if (!existsSync(path)) continue
    const parsed = parseConfigFile(path, scope, [])
    if (parsed.some((server) => server.name === name)) return scope
  }
  return null
}

function parseConfigFile(path: string, layer: string, errors: string[]): McpServerConfig[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    errors.push(`${layer} MCP config ${path}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    errors.push(`${layer} MCP config ${path}: invalid JSON (${err instanceof Error ? err.message : String(err)})`)
    return []
  }

  if (typeof json !== 'object' || json === null || !('mcpServers' in json)) {
    errors.push(`${layer} MCP config ${path}: expected a top-level "mcpServers" object`)
    return []
  }

  const serversRaw = (json as { mcpServers: unknown }).mcpServers
  if (typeof serversRaw !== 'object' || serversRaw === null) {
    errors.push(`${layer} MCP config ${path}: "mcpServers" must be an object`)
    return []
  }

  const servers: McpServerConfig[] = []
  for (const [name, value] of Object.entries(serversRaw as Record<string, unknown>)) {
    if (!SERVER_NAME_PATTERN.test(name)) {
      errors.push(`${layer} MCP config ${path}: skipping server "${name}" — name must be alphanumeric/underscore/dash`)
      continue
    }
    if (typeof value !== 'object' || value === null) {
      errors.push(`${layer} MCP config ${path}: skipping server "${name}" — entry must be an object`)
      continue
    }
    const entry = value as { command?: unknown; args?: unknown; env?: unknown; url?: unknown; headers?: unknown; transport?: unknown; disabled?: unknown }
    const hasUrl = typeof entry.url === 'string'
    const hasCommand = typeof entry.command === 'string'
    if (!hasUrl && !hasCommand) {
      errors.push(`${layer} MCP config ${path}: skipping server "${name}" — needs a string "command" (stdio) or "url" (connector)`)
      continue
    }

    const disabled = entry.disabled === true
    if (hasUrl) {
      const server: McpServerConfig = { name, url: entry.url as string, disabled }
      if (entry.transport === 'sse' || entry.transport === 'http') server.transport = entry.transport
      const headers = parseStringMap(entry.headers)
      if (headers) server.headers = headers
      servers.push(server)
      continue
    }

    const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : undefined
    const env = parseStringMap(entry.env)
    servers.push({ name, command: entry.command as string, args, env, disabled })
  }
  return servers
}

function parseStringMap(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter((pair): pair is [string, string] => typeof pair[1] === 'string'),
  )
}

// ---------- writes ----------

function readConfigObject(path: string): { mcpServers: Record<string, Record<string, unknown>> } {
  if (!existsSync(path)) return { mcpServers: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed && typeof parsed === 'object') {
      const servers = (parsed as { mcpServers?: unknown }).mcpServers
      return { ...(parsed as object), mcpServers: servers && typeof servers === 'object' ? (servers as Record<string, Record<string, unknown>>) : {} }
    }
  } catch {
    // A corrupt file is replaced rather than merged — the caller is explicitly asking to write.
  }
  return { mcpServers: {} }
}

// Sibling temp file + rename, same integrity guarantee as tools/atomicWrite.ts:
// a reader (or a crash) only ever sees the complete old file or the complete
// new one, never a truncated one. Kept synchronous (a plain rename) since
// this module's public API is sync and its config files are tiny.
function writeConfigObject(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.mcp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json.tmp`)
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  try {
    renameSync(tmp, path)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/** Cross-process lock guarding a single config file's read-modify-write cycle. */
function withConfigLock<T>(path: string, fn: () => T): T {
  return withFileLock(`${path}.lock`, fn, { ttlMs: 10_000, timeoutMs: 3_000 })
}

/** Turns a McpServerConfig into the minimal on-disk entry (no `name`, no empty maps). */
export function serverConfigToEntry(server: Omit<McpServerConfig, 'name'>): Record<string, unknown> {
  const entry: Record<string, unknown> = {}
  if (server.url) {
    entry.url = server.url
    if (server.transport && server.transport !== 'http') entry.transport = server.transport
    if (server.headers && Object.keys(server.headers).length > 0) entry.headers = server.headers
  } else {
    entry.command = server.command
    if (server.args && server.args.length > 0) entry.args = server.args
    if (server.env && Object.keys(server.env).length > 0) entry.env = server.env
  }
  if (server.disabled) entry.disabled = true
  return entry
}

/** Adds or replaces one server in the given layer. Returns the file it wrote. */
export function upsertMcpServer(scope: McpConfigScope, server: McpServerConfig, cwd = process.cwd()): string {
  if (!isValidMcpServerName(server.name)) throw new Error(`invalid server name "${server.name}" — use letters, digits, "_" or "-"`)
  const path = scopePath(scope, cwd)
  return withConfigLock(path, () => {
    const data = readConfigObject(path)
    const { name, ...rest } = server
    data.mcpServers[name] = serverConfigToEntry(rest)
    writeConfigObject(path, data)
    return path
  })
}

/** Removes one server from the given layer. Returns whether it was there. */
export function removeMcpServer(scope: McpConfigScope, name: string, cwd = process.cwd()): { path: string; removed: boolean } {
  const path = scopePath(scope, cwd)
  return withConfigLock(path, () => {
    const data = readConfigObject(path)
    const removed = name in data.mcpServers
    delete data.mcpServers[name]
    if (removed) writeConfigObject(path, data)
    return { path, removed }
  })
}

/** Flips `disabled` on one server in the given layer. Returns the new state, or null if the server isn't in that layer. */
export function setMcpServerDisabled(scope: McpConfigScope, name: string, disabled: boolean, cwd = process.cwd()): { path: string; disabled: boolean } | null {
  const path = scopePath(scope, cwd)
  return withConfigLock(path, () => {
    const data = readConfigObject(path)
    const entry = data.mcpServers[name]
    if (!entry) return null
    if (disabled) entry.disabled = true
    else delete entry.disabled
    writeConfigObject(path, data)
    return { path, disabled }
  })
}

export interface EliaMcpServerConfig {
  transport: 'stdio' | 'http'
  port: number
  host: string
  tokenPath: string
  allowedOperations: string[]
  approvalMode: 'auto' | 'always' | 'never'
  streamProgress: boolean
  domainAutoDetect: boolean
  allowRemoteHost: boolean
  maxConcurrentSessions: number
  costLimitPerSessionUsd: number | null
}

export type EliaMcpServerConfigOverrides = Partial<EliaMcpServerConfig>

export const DEFAULT_ELIA_MCP_PORT = 3284
export const DEFAULT_ELIA_MCP_HOST = '127.0.0.1'

export function defaultEliaMcpTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ELIA_MCP_TOKEN_PATH?.trim() || join(homedir(), '.elia', 'mcp-token')
}

function configError(field: string, requirement: string): never {
  throw new Error(`Invalid Elia MCP server config: ${field} ${requirement}`)
}

function configString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) configError(field, 'must be a non-empty string')
  return value.trim()
}

function configBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') configError(field, 'must be a boolean')
  return value
}

function configOperationList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 256 || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    configError('allowedOperations', 'must be an array of at most 256 non-empty strings')
  }
  return [...new Set((value as string[]).map((entry) => entry.trim()))]
}

export function validateEliaMcpServerConfig(value: unknown): EliaMcpServerConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) configError('root', 'must be an object')
  const raw = value as Record<string, unknown>
  const transport = raw.transport
  if (transport !== 'stdio' && transport !== 'http') configError('transport', 'must be "stdio" or "http"')
  const port = raw.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) configError('port', 'must be an integer from 1 to 65535')
  const host = configString(raw.host, 'host')
  if (host.length > 255 || /[\s/]/.test(host)) configError('host', 'must be a valid host without whitespace or paths')
  const tokenPath = expandEliaMcpPath(configString(raw.tokenPath, 'tokenPath'))
  const allowedOperations = configOperationList(raw.allowedOperations)
  const approvalMode = raw.approvalMode
  if (approvalMode !== 'auto' && approvalMode !== 'always' && approvalMode !== 'never') configError('approvalMode', 'must be "auto", "always", or "never"')
  const streamProgress = configBoolean(raw.streamProgress, 'streamProgress')
  const domainAutoDetect = configBoolean(raw.domainAutoDetect, 'domainAutoDetect')
  const allowRemoteHost = configBoolean(raw.allowRemoteHost, 'allowRemoteHost')
  const maxConcurrentSessions = raw.maxConcurrentSessions
  if (typeof maxConcurrentSessions !== 'number' || !Number.isInteger(maxConcurrentSessions) || maxConcurrentSessions < 1 || maxConcurrentSessions > 1_000) {
    configError('maxConcurrentSessions', 'must be an integer from 1 to 1000')
  }
  const costLimitPerSessionUsd = raw.costLimitPerSessionUsd
  if (costLimitPerSessionUsd !== null && (typeof costLimitPerSessionUsd !== 'number' || !Number.isFinite(costLimitPerSessionUsd) || costLimitPerSessionUsd <= 0)) {
    configError('costLimitPerSessionUsd', 'must be null or a positive finite number')
  }
  return {
    transport,
    port,
    host,
    tokenPath,
    allowedOperations,
    approvalMode,
    streamProgress,
    domainAutoDetect,
    allowRemoteHost,
    maxConcurrentSessions,
    costLimitPerSessionUsd,
  }
}

export function expandEliaMcpPath(path: string): string {
  const expanded = path === '~' ? homedir() : path.startsWith('~/') || path.startsWith('~\\') ? join(homedir(), path.slice(2)) : path
  return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded)
}

function envBoolean(env: NodeJS.ProcessEnv, key: string): boolean | undefined {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return undefined
  if (raw === '1' || raw.toLowerCase() === 'true') return true
  if (raw === '0' || raw.toLowerCase() === 'false') return false
  throw new Error(`Invalid ${key}: expected true/false or 1/0`)
}

function envNumber(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`Invalid ${key}: expected a number`)
  return value
}

function envChoice<T extends string>(env: NodeJS.ProcessEnv, key: string, choices: readonly T[]): T | undefined {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return undefined
  const normalized = raw.trim().toLowerCase()
  const choice = choices.find((candidate) => candidate === normalized)
  if (!choice) throw new Error(`Invalid ${key}: expected ${choices.join(' or ')}`)
  return choice
}

export function loadEliaMcpServerConfig(
  overrides: EliaMcpServerConfigOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): EliaMcpServerConfig {
  const allowedRaw = env.ELIA_MCP_ALLOWED_OPERATIONS
  const costRaw = env.ELIA_MCP_COST_LIMIT_PER_SESSION_USD
  const overrideCost = Object.hasOwn(overrides, 'costLimitPerSessionUsd') ? overrides.costLimitPerSessionUsd : undefined
  const config: EliaMcpServerConfig = {
    transport: overrides.transport ?? envChoice(env, 'ELIA_MCP_TRANSPORT', ['stdio', 'http'] as const) ?? 'stdio',
    port: overrides.port ?? envNumber(env, 'ELIA_MCP_PORT') ?? DEFAULT_ELIA_MCP_PORT,
    host: overrides.host ?? (env.ELIA_MCP_HOST?.trim() || DEFAULT_ELIA_MCP_HOST),
    tokenPath: overrides.tokenPath ?? defaultEliaMcpTokenPath(env),
    allowedOperations: overrides.allowedOperations ?? (allowedRaw === undefined ? ['*'] : allowedRaw.split(',').map((entry) => entry.trim()).filter(Boolean)),
    approvalMode: overrides.approvalMode ?? envChoice(env, 'ELIA_MCP_APPROVAL_MODE', ['auto', 'always', 'never'] as const) ?? 'auto',
    streamProgress: overrides.streamProgress ?? envBoolean(env, 'ELIA_MCP_STREAM_PROGRESS') ?? true,
    domainAutoDetect: overrides.domainAutoDetect ?? envBoolean(env, 'ELIA_MCP_DOMAIN_AUTO_DETECT') ?? true,
    allowRemoteHost: overrides.allowRemoteHost ?? envBoolean(env, 'ELIA_MCP_ALLOW_REMOTE_HOST') ?? false,
    maxConcurrentSessions: overrides.maxConcurrentSessions ?? envNumber(env, 'ELIA_MCP_MAX_CONCURRENT_SESSIONS') ?? 4,
    costLimitPerSessionUsd: overrideCost !== undefined ? overrideCost : (costRaw === undefined || costRaw.trim() === '' || costRaw.trim().toLowerCase() === 'none' || costRaw.trim().toLowerCase() === 'null' ? null : envNumber(env, 'ELIA_MCP_COST_LIMIT_PER_SESSION_USD')!),
  }
  return validateEliaMcpServerConfig(config)
}

function optionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a value`)
  return value
}

export function parseEliaMcpCliOverrides(args: readonly string[] = process.argv.slice(2)): EliaMcpServerConfigOverrides {
  const overrides: EliaMcpServerConfigOverrides = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    const [flag, inlineValue] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
    const take = (): string => inlineValue ?? optionValue(args, index++, flag)
    if (flag === '--transport') {
      const transport = take()
      if (transport !== 'stdio' && transport !== 'http') throw new Error('--transport must be stdio or http')
      overrides.transport = transport
    } else if (flag === '--port') {
      const port = Number(take())
      if (!Number.isInteger(port)) throw new Error('--port must be an integer')
      overrides.port = port
    } else if (flag === '--host') {
      overrides.host = take()
    } else if (flag === '--token-path') {
      overrides.tokenPath = take()
    } else if (flag === '--allowed-operations') {
      overrides.allowedOperations = take().split(',').map((entry) => entry.trim()).filter(Boolean)
    } else if (flag === '--approval-mode') {
      const approvalMode = take()
      if (approvalMode !== 'auto' && approvalMode !== 'always' && approvalMode !== 'never') throw new Error('--approval-mode must be auto, always, or never')
      overrides.approvalMode = approvalMode
    } else if (flag === '--stream-progress' || flag === '--no-stream-progress') {
      overrides.streamProgress = flag === '--stream-progress'
    } else if (flag === '--domain-auto-detect' || flag === '--no-domain-auto-detect') {
      overrides.domainAutoDetect = flag === '--domain-auto-detect'
    } else if (flag === '--allow-remote-host' || flag === '--no-allow-remote-host') {
      overrides.allowRemoteHost = flag === '--allow-remote-host'
    } else if (flag === '--max-concurrent-sessions') {
      const maxConcurrentSessions = Number(take())
      if (!Number.isInteger(maxConcurrentSessions)) throw new Error('--max-concurrent-sessions must be an integer')
      overrides.maxConcurrentSessions = maxConcurrentSessions
    } else if (flag === '--cost-limit-per-session-usd') {
      const raw = take()
      overrides.costLimitPerSessionUsd = raw.toLowerCase() === 'none' || raw.toLowerCase() === 'null' ? null : Number(raw)
    } else {
      throw new Error(`Unknown Elia MCP option: ${flag}`)
    }
  }
  return overrides
}

export function loadEliaMcpServerConfigFromCli(
  args: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): EliaMcpServerConfig {
  return loadEliaMcpServerConfig(parseEliaMcpCliOverrides(args), env)
}

export const eliaMcpServerConfigFromCli = loadEliaMcpServerConfigFromCli

const MCP_TOKEN_BYTES = 32
const MCP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export interface McpAuthTokenResult {
  token: string
  generated: boolean
  path: string
}

export function generateMcpAuthToken(): string {
  return randomBytes(MCP_TOKEN_BYTES).toString('base64url')
}

function loadMcpAuthTokenFile(path: string): string {
  let status: ReturnType<typeof lstatSync>
  try {
    status = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
  if (status.isSymbolicLink() || !status.isFile()) throw new Error(`Invalid MCP auth token file: ${path}`)
  hardenSecureFile(path)
  const token = readFileSync(path, 'utf8').trim()
  if (!MCP_TOKEN_PATTERN.test(token) || Buffer.from(token, 'base64url').length !== MCP_TOKEN_BYTES) {
    throw new Error(`Invalid MCP auth token file: ${path}`)
  }
  return token
}

export function loadOrCreateMcpAuthToken(path = defaultEliaMcpTokenPath()): McpAuthTokenResult {
  const tokenPath = expandEliaMcpPath(path)
  return withFileLock(`${tokenPath}.lock`, () => {
    const existing = loadMcpAuthTokenFile(tokenPath)
    if (existing) return { token: existing, generated: false, path: tokenPath }
    const token = generateMcpAuthToken()
    writeSecureFile(tokenPath, `${token}\n`)
    return { token, generated: true, path: tokenPath }
  }, { ttlMs: 10_000, timeoutMs: 3_000 })
}

export const loadOrCreateMcpToken = loadOrCreateMcpAuthToken

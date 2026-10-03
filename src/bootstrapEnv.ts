import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadUserConfig } from './userConfig.ts'

/**
 * Environment keys that choose which program elia runs, which files it treats
 * as its own trust state, or whether a safety layer is on. Bun loads the
 * working directory's `.env` before any of elia's code runs, so a repository
 * could set one of these just by shipping a `.env` — `git clone` + `elia`
 * would then run its command as the user, or switch a sandbox off. Provider
 * configuration (keys, base URLs, models) is deliberately not in this list:
 * a project `.env` is a normal place for it and it stays honoured.
 */
const SECURITY_SENSITIVE_KEY = /^ELIA_[A-Z0-9_]+_COMMAND$/
const SECURITY_SENSITIVE_KEYS = new Set([
  'ELIA_BROWSER_BRIDGE_COMMAND',
  'ELIA_COMMUNICATION_BRIDGE_COMMAND',
  'ELIA_NATIVE_PATH',
  'ELIA_GO_INDEX_PATH',
  'ELIA_ELIAD_PATH',
  'ELIA_ELIAD_SOCKET',
  'ELIA_JVM_BRIDGE_JAR',
  'ELIA_PREAUTH_DIR',
  'ELIA_PREAUTH_LEGACY_PATH',
  'ELIA_ALLOW_GLOBAL_PATH',
  'ELIA_ALLOW_LEGACY_PATH',
  'ELIA_CONFIG_PATH',
  'ELIA_SKILLS_TRUST_PROJECT',
  'ELIA_SKILL_DIRS',
  'ELIA_UNSAFE_HOOKS',
  'ELIA_SANDBOX',
  'ELIA_BOX_BIN',
  'ELIA_BOX_FALLBACK',
  'ELIA_BOX_IMAGE',
  'ELIA_MCP_USER_CONFIG',
  'ELIA_LIFECYCLE_HOOKS',
  'ELIA_OTEL_ENDPOINT',
])

export function isSecuritySensitiveEnvKey(key: string): boolean {
  return SECURITY_SENSITIVE_KEYS.has(key) || SECURITY_SENSITIVE_KEY.test(key)
}

/** Every file Bun may autoload from the working directory. */
const DOTENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local', '.env.production', '.env.production.local', '.env.test', '.env.test.local']

/** The values a dotenv line may have produced in `process.env`: as written, unquoted, unescaped, and with `$VAR` expanded. */
function candidateValues(raw: string, env: NodeJS.ProcessEnv): string[] {
  let value = raw.trim()
  const quote = value[0] === '"' || value[0] === "'" || value[0] === '`' ? value[0] : undefined
  if (quote) {
    const end = value.indexOf(quote, 1)
    value = end === -1 ? value.slice(1) : value.slice(1, end)
  } else {
    // An unquoted ` # comment` is not part of the value.
    const hash = value.search(/\s#/)
    if (hash !== -1) value = value.slice(0, hash).trimEnd()
  }
  const candidates = new Set([value])
  if (quote === '"') candidates.add(value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\(["\\])/g, '$1'))
  if (quote !== "'" && value.includes('$')) {
    candidates.add(value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, braced: string | undefined, fallback: string | undefined, bare: string | undefined) => env[(braced ?? bare)!] ?? fallback ?? ''))
  }
  return [...candidates]
}

/** `KEY=value` lines of one dotenv file (an `export ` prefix, comments and blank lines tolerated), as `[key, candidate values]`. */
export function parseDotenvKeys(content: string, env: NodeJS.ProcessEnv = process.env): Map<string, string[]> {
  const parsed = new Map<string, string[]>()
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/)
    if (!match) continue
    parsed.set(match[1]!, candidateValues(match[2]!, env))
  }
  return parsed
}

/**
 * Removes security-sensitive keys from `env` when their current value is
 * exactly what the project's own `.env` files say — i.e. Bun put them there,
 * not the user's shell or `~/.elia/config.env`. A value the user set in the
 * real environment to something different is left alone. Returns the keys it
 * dropped.
 */
export function dropProjectDotenvSecurityKeys(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): string[] {
  const dropped = new Set<string>()
  for (const file of DOTENV_FILES) {
    const path = join(cwd, file)
    if (!existsSync(path)) continue
    let content: string
    try {
      content = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    for (const [key, candidates] of parseDotenvKeys(content, env)) {
      if (!isSecuritySensitiveEnvKey(key)) continue
      const current = env[key]
      if (current !== undefined && candidates.includes(current)) {
        delete env[key]
        dropped.add(key)
      }
    }
  }
  return [...dropped]
}

/**
 * Drops repo-supplied security settings, then loads ~/.elia/config.env into
 * the environment. Imported first by index.ts, as a side effect, because the
 * order is the whole point.
 *
 * `config.ts` resolves the provider when it loads, and it loads during
 * index.ts's static imports (the REPL → agentLoop → config). Calling
 * `loadUserConfig()` in index.ts's body ran after all of those, so a provider
 * saved only in config.env — which is what `elia config set` and first-run
 * setup write — was never the one used: elia started "unconfigured" and fell
 * back to Anthropic. ES modules evaluate imports in order, so this one, listed
 * first, runs before anything that reads the provider.
 *
 * Explicit process and project `.env` values still win for everything but the
 * security-sensitive keys above; `loadUserConfig` only fills gaps, so a key
 * dropped from the project `.env` can still be set from the user's own config.
 */
const ignoredProjectKeys = dropProjectDotenvSecurityKeys()
if (ignoredProjectKeys.length > 0) {
  process.stderr.write(
    `elia: ignored ${ignoredProjectKeys.join(', ')} from this project's .env — a repository cannot set security-sensitive settings. Set them in your shell or ~/.elia/config.env if you meant them.\n`,
  )
}
loadUserConfig()

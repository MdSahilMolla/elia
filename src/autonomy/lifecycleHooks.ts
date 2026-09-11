import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { currentAgent } from './context.ts'

/**
 * Safe lifecycle hooks — prompt injection and optional bounded shell side-effects.
 *
 * Default (no env flag): only `UserPromptSubmit` inject hooks that append static
 * or lightly templated text to the user turn. They cannot grant approvals or
 * bypass the governor.
 *
 * Opt-in (`ELIA_UNSAFE_HOOKS=1`): `SessionEnd` / `PostToolUse` may run a single
 * allowlisted shell command pattern (notify-style). Still cannot grant approvals.
 */

const MAX_HOOKS = 16
const MAX_ID = 80
const MAX_INJECT = 2_000
const MAX_COMMAND = 500
const CONFIG_FILE = join('.elia', 'lifecycle-hooks.json')
const ENV_KEY = 'ELIA_LIFECYCLE_HOOKS'
const UNSAFE_ENV = 'ELIA_UNSAFE_HOOKS'

export type LifecycleEvent = 'UserPromptSubmit' | 'PostToolUse' | 'SessionEnd'

export interface LifecycleHook {
  id: string
  event: LifecycleEvent
  /** Static text (or `$TOOL` / `$STATUS` / `$PATH` templates) injected or logged. */
  inject?: string
  /** Shell command — only honored when ELIA_UNSAFE_HOOKS=1. */
  command?: string
}

interface RawHook {
  id?: unknown
  event?: unknown
  inject?: unknown
  command?: unknown
}

const storage = new AsyncLocalStorage<readonly LifecycleHook[]>()

export function withLifecycleHooks<T>(hooks: readonly LifecycleHook[], fn: () => Promise<T>): Promise<T> {
  return storage.run(hooks, fn)
}

export function activeLifecycleHooks(): readonly LifecycleHook[] {
  return storage.getStore() ?? []
}

function unsafeEnabled(env: NodeJS.ProcessEnv): boolean {
  return (env[UNSAFE_ENV] ?? '').trim() === '1'
}

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) return undefined
  return trimmed
}

export function parseLifecycleHooks(raw: string, source = 'lifecycle hook configuration'): LifecycleHook[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Invalid ${source}: expected JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  if (!Array.isArray(parsed)) throw new Error(`Invalid ${source}: expected an array`)
  if (parsed.length > MAX_HOOKS) throw new Error(`Invalid ${source}: at most ${MAX_HOOKS} hooks`)

  const ids = new Set<string>()
  const out: LifecycleHook[] = []
  for (let i = 0; i < parsed.length; i += 1) {
    const entry = parsed[i]
    if (!entry || typeof entry !== 'object') throw new Error(`Invalid ${source}: hook ${i + 1} must be an object`)
    const rawHook = entry as RawHook
    const id = bounded(rawHook.id, MAX_ID)
    if (!id) throw new Error(`Invalid ${source}: hook ${i + 1} needs id`)
    if (ids.has(id)) throw new Error(`Invalid ${source}: duplicate id ${JSON.stringify(id)}`)
    ids.add(id)
    const event = rawHook.event
    if (event !== 'UserPromptSubmit' && event !== 'PostToolUse' && event !== 'SessionEnd') {
      throw new Error(`Invalid ${source}: hook ${id} has unknown event`)
    }
    const inject = bounded(rawHook.inject, MAX_INJECT)
    const command = bounded(rawHook.command, MAX_COMMAND)
    if (!inject && !command) throw new Error(`Invalid ${source}: hook ${id} needs inject and/or command`)
    out.push({ id, event, inject, command })
  }
  return out
}

export function loadLifecycleHooks(
  cwd = currentAgent().cwd ?? process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
): LifecycleHook[] {
  const configured = environment[ENV_KEY]
  if (configured !== undefined) return parseLifecycleHooks(configured, `environment variable ${ENV_KEY}`)
  const path = join(cwd, CONFIG_FILE)
  if (!existsSync(path)) return []
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`Unable to read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parseLifecycleHooks(raw, path)
}

/** Text appended ahead of the user message for matching UserPromptSubmit hooks. */
export function collectPromptInjects(
  hooks: readonly LifecycleHook[] = activeLifecycleHooks().length ? activeLifecycleHooks() : loadLifecycleHooks(),
): string {
  return hooks
    .filter((h) => h.event === 'UserPromptSubmit' && h.inject)
    .map((h) => h.inject!)
    .join('\n')
    .trim()
}

function applyTemplates(template: string, vars: Record<string, string>): string {
  let out = template
  for (const [key, value] of Object.entries(vars)) out = out.replaceAll(`$${key}`, value)
  return out
}

/** Fire PostToolUse / SessionEnd side effects. Shell only when ELIA_UNSAFE_HOOKS=1. */
export async function fireLifecycleEvent(
  event: 'PostToolUse' | 'SessionEnd',
  vars: Record<string, string> = {},
  hooks: readonly LifecycleHook[] = activeLifecycleHooks().length ? activeLifecycleHooks() : loadLifecycleHooks(),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const notes: string[] = []
  const allowShell = unsafeEnabled(environment)
  for (const hook of hooks.filter((h) => h.event === event)) {
    if (hook.inject) notes.push(applyTemplates(hook.inject, vars))
    if (hook.command) {
      if (!allowShell) {
        notes.push(`[lifecycle ${hook.id}] command skipped — set ELIA_UNSAFE_HOOKS=1 to allow shell hooks`)
        continue
      }
      // Refuse obvious shell chaining / redirection in the opt-in path.
      if (/[;&|`$<>]/.test(hook.command) || hook.command.includes('\n')) {
        notes.push(`[lifecycle ${hook.id}] command rejected: metacharacters not allowed`)
        continue
      }
      try {
        const proc = Bun.spawn(hook.command.split(/\s+/), {
          cwd: currentAgent().cwd ?? process.cwd(),
          stdout: 'pipe',
          stderr: 'pipe',
        })
        await proc.exited
        notes.push(`[lifecycle ${hook.id}] ran (exit ${proc.exitCode ?? '?'})`)
      } catch (error) {
        notes.push(`[lifecycle ${hook.id}] failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  return notes
}

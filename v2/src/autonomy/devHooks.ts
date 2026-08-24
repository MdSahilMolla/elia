import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentMode } from './mode.ts'
import type { ActionRequest } from './governor.ts'
import { currentAgent } from './context.ts'

const MAX_HOOKS = 32
const MAX_ID_LENGTH = 80
const MAX_MATCH_LENGTH = 2_000
const MAX_MESSAGE_LENGTH = 500
const CONFIG_FILE = join('.elia', 'dev-hooks.json')
const HOOKS_ENV = 'ELIA_DEV_HOOKS'

export interface ToolHookContext {
  request: ActionRequest
  cwd: string
  mode: AgentMode
}

export interface ToolHookResult {
  allowed: boolean
  hookId?: string
  message?: string
}

export interface ToolHook {
  id: string
  tool?: string
  inputContains?: string
  message: string
  evaluate(context: ToolHookContext): ToolHookResult | undefined
}

interface RawToolHook {
  id?: unknown
  tool?: unknown
  inputContains?: unknown
  message?: unknown
}

const hookStorage = new AsyncLocalStorage<readonly ToolHook[]>()

/**
 * Runs work with the supplied hooks available to every awaited tool and child
 * agent in this async context. Hooks are supplementary policy: they can block,
 * but can never grant permission or bypass Elia's governor.
 */
export function withToolHooks<T>(hooks: readonly ToolHook[], fn: () => Promise<T>): Promise<T> {
  return hookStorage.run(hooks, fn)
}

export function activeToolHooks(): readonly ToolHook[] {
  return hookStorage.getStore() ?? []
}

/**
 * Loads only declarative development hooks. Configuration cannot name a module,
 * command, URL, or executable; it can only match a tool and a literal substring
 * in its JSON input and return a static blocking explanation.
 */
export function loadDevelopmentToolHooks(
  cwd = currentAgent().cwd ?? process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
): ToolHook[] {
  const configured = environment[HOOKS_ENV]
  if (configured !== undefined) return parseToolHooks(configured, `environment variable ${HOOKS_ENV}`)

  const path = join(cwd, CONFIG_FILE)
  if (!existsSync(path)) return []
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`Unable to read development hook configuration ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parseToolHooks(raw, path)
}

export function parseToolHooks(raw: string, source = 'development hook configuration'): ToolHook[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Invalid ${source}: expected JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  if (!Array.isArray(parsed)) throw new Error(`Invalid ${source}: expected an array of hook objects`)
  if (parsed.length > MAX_HOOKS) throw new Error(`Invalid ${source}: at most ${MAX_HOOKS} hooks are allowed`)

  const ids = new Set<string>()
  return parsed.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Invalid ${source}: hook ${index + 1} must be an object`)
    const rawHook = entry as RawToolHook
    const id = boundedString(rawHook.id, MAX_ID_LENGTH)
    if (!id) throw new Error(`Invalid ${source}: hook ${index + 1} needs a non-empty id`)
    if (ids.has(id)) throw new Error(`Invalid ${source}: hook id ${JSON.stringify(id)} is duplicated`)
    ids.add(id)

    const tool = optionalBoundedString(rawHook.tool)
    const inputContains = optionalBoundedString(rawHook.inputContains)
    const message = boundedString(rawHook.message, MAX_MESSAGE_LENGTH)
    if (!message) throw new Error(`Invalid ${source}: hook ${JSON.stringify(id)} needs a non-empty message`)
    if (!tool && !inputContains) throw new Error(`Invalid ${source}: hook ${JSON.stringify(id)} needs tool or inputContains`)

    return createToolHook({ id, tool, inputContains, message })
  })
}

export async function evaluateToolHooks(
  hooks: readonly ToolHook[],
  request: ActionRequest,
  cwd: string,
  mode: AgentMode,
): Promise<ToolHookResult> {
  const context = { request, cwd, mode }
  for (const hook of hooks) {
    const result = hook.evaluate(context)
    if (result && !result.allowed) return result
  }
  return { allowed: true }
}

function createToolHook(input: { id: string; tool?: string; inputContains?: string; message: string }): ToolHook {
  return {
    ...input,
    evaluate(context) {
      if (input.tool && input.tool !== context.request.name) return undefined
      if (input.inputContains) {
        const serialized = stableJson(context.request.input)
        if (!serialized.includes(input.inputContains)) return undefined
      }
      return { allowed: false, hookId: input.id, message: input.message }
    },
  }
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxLength) return undefined
  return trimmed
}

function optionalBoundedString(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.length > MAX_MATCH_LENGTH) return undefined
  return trimmed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}

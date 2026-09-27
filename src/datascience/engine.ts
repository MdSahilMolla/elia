import { currentAgent } from '../autonomy/context.ts'
import { compileExpression } from './expr.ts'
import type { Frame } from './frame.ts'
import { RecordBuilder, type ExecutionRecord } from './record.ts'
import { refOf, Workspace, type DatasetEntry } from './workspace.ts'
import { datascienceEffect, EFFECTS, GOVERNED_PARAMS, type Effect } from './effects.ts'

/**
 * The data-science execution engine. The model decides WHAT to do by calling an action;
 * this engine decides WHAT HAPPENED (deterministic computation), the action's checks decide
 * WHETHER IT IS TRUSTWORTHY, and every call leaves an execution record. Capabilities are
 * registered as independent plugins — adding one never touches the others.
 */

export type DsTool = 'ds_data' | 'ds_stats' | 'ds_ml' | 'ds_timeseries' | 'ds_analytics' | 'ds_report' | 'ds_python'

export interface ParamDoc {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'string|array'
  description: string
  required?: boolean
  enum?: readonly string[]
}

export type { Effect }

export interface ActionContext {
  params: Record<string, unknown>
  workspace: Workspace
  record: RecordBuilder
  /** Loads a dataset by reference, records it as an input, and applies an optional `where` filter. */
  dataset(ref: string, options?: { where?: string; record?: boolean }): { entry: DatasetEntry; frame: Frame }
  /** Registers a derived dataset produced by this run. */
  saveDataset(name: string, frame: Frame, operation: string, inputs: string[], steps: unknown[], extra?: { description?: string; grain?: string }): DatasetEntry
  /** Writes an artifact file under .elia/datascience/artifacts/ and records its hash. */
  artifact(relativePath: string, content: string | Uint8Array, kind: string, description?: string): { path: string; sha256: string; bytes: number }
  signal?: AbortSignal
}

export interface Capability {
  tool: DsTool
  action: string
  summary: string
  params: Record<string, ParamDoc>
  effect: Effect | ((params: Record<string, unknown>) => Effect)
  example?: Record<string, unknown>
  run(ctx: ActionContext): Promise<unknown> | unknown
}

const REGISTRY = new Map<string, Capability>()

export function registerCapability(capability: Capability): void {
  const key = `${capability.tool}.${capability.action}`
  const rule = EFFECTS[key]
  if (rule === undefined) throw new Error(`capability ${key} has no entry in datascience/effects.ts; the governor could not assess it`)
  if (typeof capability.effect === 'string' && capability.effect !== rule) throw new Error(`capability ${key} declares effect "${capability.effect}" but effects.ts says "${typeof rule === 'string' ? rule : 'dynamic'}"`)
  REGISTRY.set(key, capability)
}

export function capabilitiesFor(tool: DsTool): Capability[] {
  return [...REGISTRY.values()].filter((capability) => capability.tool === tool)
}

export function findCapability(tool: string, action: string): Capability | undefined {
  return REGISTRY.get(`${tool}.${action}`)
}

export function effectOf(tool: string, action: string, params: Record<string, unknown>): Effect | undefined {
  return datascienceEffect(tool, action, params)
}

export function usage(capability: Capability): string {
  const params = Object.entries(capability.params).map(([name, doc]) => `  ${name}${doc.required ? ' (required)' : ''}: ${doc.type}${doc.enum ? ` — one of ${doc.enum.join(', ')}` : ''} — ${doc.description}`)
  return `${capability.tool} action "${capability.action}": ${capability.summary}\n${params.join('\n')}${capability.example ? `\n  example: ${JSON.stringify(capability.example)}` : ''}`
}

/**
 * Models often send an array or object as its JSON text ('["region","channel"]'), a number
 * as a string, or `dataset` where the action takes `datasets`. Each is unambiguous, so it is
 * normalised in place — and noted in the record — rather than failing the call.
 */
function normaliseParams(capability: Capability, params: Record<string, unknown>): string[] {
  const notes: string[] = []
  for (const key of Object.keys(params)) {
    if (GOVERNED_PARAMS.has(key) || capability.params[key]) continue
    const target = [`${key}s`, key.replace(/s$/, '')].find((candidate) => candidate !== key && !GOVERNED_PARAMS.has(candidate) && capability.params[candidate] && params[candidate] === undefined)
    if (!target) continue
    const value = params[key]
    const targetType = capability.params[target]!.type
    params[target] = targetType === 'array' && !Array.isArray(value) ? [value] : targetType === 'string' && Array.isArray(value) && value.length === 1 ? value[0] : value
    delete params[key]
    notes.push(`"${key}" read as "${target}"`)
  }
  for (const [name, doc] of Object.entries(capability.params)) {
    const value = params[name]
    if (typeof value !== 'string' || GOVERNED_PARAMS.has(name)) continue
    const text = value.trim()
    if ((doc.type === 'array' || doc.type === 'string|array') && text.startsWith('[') && text.endsWith(']')) {
      try {
        const parsed: unknown = JSON.parse(text)
        if (Array.isArray(parsed)) {
          params[name] = parsed
          notes.push(`"${name}" parsed from JSON text`)
        }
      } catch {
        // Not JSON: a string|array parameter keeps the string; an array parameter fails its type check.
      }
    } else if (doc.type === 'object' && text.startsWith('{') && text.endsWith('}')) {
      try {
        const parsed: unknown = JSON.parse(text)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          params[name] = parsed
          notes.push(`"${name}" parsed from JSON text`)
        }
      } catch {
        // Left as is; the type check reports it.
      }
    } else if ((doc.type === 'number' || doc.type === 'integer') && /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) {
      params[name] = Number(text)
      notes.push(`"${name}" read as a number`)
    } else if (doc.type === 'boolean' && (text === 'true' || text === 'false')) {
      params[name] = text === 'true'
      notes.push(`"${name}" read as a boolean`)
    }
  }
  return notes
}

function checkParams(capability: Capability, params: Record<string, unknown>): void {
  const known = new Set(['action', ...Object.keys(capability.params)])
  const unknown = Object.keys(params).filter((key) => !known.has(key))
  if (unknown.length) throw new Error(`unknown parameter(s) ${unknown.map((u) => `"${u}"`).join(', ')}`)
  for (const [name, doc] of Object.entries(capability.params)) {
    const value = params[name]
    if (value === undefined || value === null) {
      if (doc.required) throw new Error(`"${name}" is required`)
      continue
    }
    const ok = (() => {
      switch (doc.type) {
        case 'string': return typeof value === 'string'
        case 'number': return typeof value === 'number' && Number.isFinite(value)
        case 'integer': return typeof value === 'number' && Number.isInteger(value)
        case 'boolean': return typeof value === 'boolean'
        case 'array': return Array.isArray(value)
        case 'object': return typeof value === 'object' && !Array.isArray(value)
        case 'string|array': return typeof value === 'string' || Array.isArray(value)
      }
    })()
    if (!ok) throw new Error(`"${name}" must be ${doc.type}`)
    if (doc.enum && typeof value === 'string' && !doc.enum.includes(value)) throw new Error(`"${name}" must be one of ${doc.enum.join(', ')}`)
  }
}

const MAX_RESULT_CHARS = 48_000

/** Bounds a result for the model: long arrays are cut with an explicit note rather than silently. */
export function boundResult(value: unknown, maxChars = MAX_RESULT_CHARS): unknown {
  let text = JSON.stringify(value)
  if (text.length <= maxChars) return value
  for (const limit of [200, 60, 20, 8]) {
    const trim = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.length > limit ? [...node.slice(0, limit).map(trim), `… ${node.length - limit} more items omitted (full result in the execution record)`] : node.map(trim)
      if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([key, inner]) => [key, trim(inner)]))
      if (typeof node === 'string' && node.length > 2000) return `${node.slice(0, 2000)}… (${node.length} chars)`
      return node
    }
    const trimmed = trim(value)
    text = JSON.stringify(trimmed)
    if (text.length <= maxChars) return trimmed
  }
  return { truncated: true, preview: text.slice(0, maxChars), note: 'result too large to show; see the execution record' }
}

function roundDeep(value: unknown): unknown {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return value === Infinity ? 'Infinity' : value === -Infinity ? '-Infinity' : null
    if (Number.isInteger(value)) return value
    const magnitude = Math.abs(value)
    return magnitude >= 1e-4 && magnitude < 1e15 ? Number(value.toPrecision(8)) : Number(value.toPrecision(6))
  }
  if (Array.isArray(value)) return value.map(roundDeep)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, inner]) => inner !== undefined).map(([key, inner]) => [key, roundDeep(inner)]))
  return value
}

export interface RunOutcome {
  runId: string
  status: ExecutionRecord['status']
  record: string
  checks: { passed: number; warnings: number; failed: number; details: ExecutionRecord['checks'] }
  warnings: string[]
  outputs: ExecutionRecord['outputs']
  result: unknown
}

/** Runs one capability with a full execution record; the record is written even when the action fails. */
export async function runCapability(tool: DsTool, params: Record<string, unknown>): Promise<RunOutcome> {
  const action = typeof params.action === 'string' ? params.action : ''
  const capability = findCapability(tool, action)
  if (!capability) {
    const actions = capabilitiesFor(tool).map((c) => `${c.action} — ${c.summary}`)
    throw new Error(`${tool} has no action "${action}". Actions:\n${actions.join('\n')}`)
  }
  const normalised = normaliseParams(capability, params)
  try {
    checkParams(capability, params)
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${usage(capability)}`)
  }
  const workspace = new Workspace()
  const record = new RecordBuilder(tool, action, params)
  // Recorded, not warned: how the call was spelled is not a caveat on the data.
  if (normalised.length) record.metric('inputNormalised', normalised)
  const ctx: ActionContext = {
    params,
    workspace,
    record,
    signal: currentAgent().signal,
    dataset(ref, options = {}) {
      const loaded = workspace.frame(ref)
      if (options.record !== false) record.input(refOf(loaded.entry), loaded.entry.fingerprint, loaded.entry.rows)
      const where = options.where ?? (typeof params.where === 'string' ? params.where : undefined)
      if (!where) return loaded
      const expression = compileExpression(where, loaded.frame.columns)
      record.code('expression', `where ${where}`)
      const rows = loaded.frame.rows.filter((row) => expression.test(row))
      record.check('filter keeps rows', rows.length === 0 ? 'fail' : 'pass', `where ${where}: ${rows.length} of ${loaded.frame.rows.length} rows`)
      return { entry: loaded.entry, frame: { ...loaded.frame, rows } }
    },
    saveDataset(name, frame, operation, inputs, steps, extra = {}) {
      const { entry, reused } = workspace.registerDataset({ name, frame, kind: 'derived', derivation: { inputs, operation, steps, runId: record.id }, ...(extra.description ? { description: extra.description } : {}), ...(extra.grain ? { grain: extra.grain } : {}) })
      record.outputDataset(`${refOf(entry)}${reused ? ' (identical to existing version)' : ''}`)
      return entry
    },
    artifact(relativePath, content, kind, description) {
      const entry = workspace.writeArtifact(relativePath, content, kind, record.id, description)
      record.outputArtifact(entry.path, entry.sha256, entry.bytes)
      return { path: entry.path, sha256: entry.sha256, bytes: entry.bytes }
    },
  }
  let result: unknown
  try {
    result = await capability.run(ctx)
  } catch (error) {
    const failed = record.finish(error)
    try {
      workspace.writeRecord({ ...failed })
    } catch {
      // A record that cannot be written must not hide the original error.
    }
    const message = (error as Error).message
    throw new Error(`${message}${message.includes('usage:') || message.includes('Actions:') ? '' : `\n${usage(capability)}`}\n(run ${failed.id} recorded with status "error")`)
  }
  const finished = record.finish()
  const rounded = roundDeep(result)
  const stored = { ...finished, result: boundResult(rounded, 200_000) }
  const path = workspace.writeRecord(stored)
  const checks = finished.checks
  return {
    runId: finished.id,
    status: finished.status,
    record: path,
    checks: { passed: checks.filter((c) => c.status === 'pass').length, warnings: checks.filter((c) => c.status === 'warn').length, failed: checks.filter((c) => c.status === 'fail').length, details: checks.filter((c) => c.status !== 'pass').concat(checks.filter((c) => c.status === 'pass').slice(0, Math.max(0, 12 - checks.filter((c) => c.status !== 'pass').length))) },
    warnings: finished.warnings,
    outputs: finished.outputs,
    result: boundResult(rounded),
  }
}

/** Text returned to the model: status first, so a failed validation is impossible to miss. */
export function formatOutcome(outcome: RunOutcome): string {
  const banner = outcome.status === 'failed' ? 'VALIDATION FAILED — do not report these results as reliable; fix the failing checks first.' : outcome.status === 'unvalidated' ? 'UNVALIDATED — this action has no postcondition checks; treat the result as descriptive only.' : outcome.status === 'passed-with-warnings' ? 'passed with warnings — carry the warnings into your limitations.' : 'passed'
  return JSON.stringify({ runId: outcome.runId, status: outcome.status, note: banner, checks: outcome.checks, warnings: outcome.warnings, outputs: outcome.outputs, result: outcome.result, record: outcome.record }, null, 1)
}

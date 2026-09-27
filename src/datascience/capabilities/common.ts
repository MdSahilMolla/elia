import type { ActionContext } from '../engine.ts'
import { assertColumns, previewRows, type Frame } from '../frame.ts'
import type { ChartResult } from '../viz.ts'
import { assertDatasetName } from '../workspace.ts'

/** Helpers shared by capability plugins. */

export function list(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return []
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean)
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value as string[]
  throw new Error(`"${name}" must be a column name or an array of column names`)
}

export function str(ctx: ActionContext, name: string, fallback?: string): string {
  const value = ctx.params[name]
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (fallback !== undefined) return fallback
  throw new Error(`"${name}" is required`)
}

export function num(ctx: ActionContext, name: string, fallback?: number): number {
  const value = ctx.params[name]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (fallback !== undefined) return fallback
  throw new Error(`"${name}" is required (a number)`)
}

export function optionalNum(ctx: ActionContext, name: string): number | undefined {
  const value = ctx.params[name]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function columns(ctx: ActionContext, frame: Frame, name: string, required = false): string[] {
  const names = list(ctx.params[name], name)
  if (required && names.length === 0) throw new Error(`"${name}" is required`)
  assertColumns(frame, names, name)
  return names
}

export function outputName(ctx: ActionContext, fallback: string): string {
  const value = typeof ctx.params.output === 'string' && ctx.params.output.trim() ? ctx.params.output.trim() : fallback.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
  return assertDatasetName(/^[A-Za-z]/.test(value) ? value : `d_${value}`, 'output')
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'chart'
}

/** Saves a chart as an SVG artifact and returns a compact reference for the model. */
export function saveChart(ctx: ActionContext, chart: ChartResult): { chart: string; path: string; warnings: string[] } {
  const base = `charts/${ctx.record.id}-${slug(chart.title)}`
  const saved = ctx.artifact(`${base}.svg`, chart.svg, 'chart', chart.title)
  // The data behind the chart travels with it, so a report can always show the table view.
  ctx.artifact(`${base}.json`, JSON.stringify({ title: chart.title, type: chart.type, warnings: chart.warnings, table: { columns: chart.table.columns, rows: chart.table.rows.slice(0, 500) } }), 'chart-data', chart.title)
  return { chart: chart.title, path: saved.path, warnings: chart.warnings }
}

export function preview(frame: Frame, limit = 8): Record<string, unknown> {
  return { rows: frame.rows.length, columns: frame.columns.map((name) => `${name}:${frame.types[name]}`), preview: previewRows(frame, limit) }
}

export const WHERE = { type: 'string', description: 'optional row filter in the expression language, e.g. year(order_date) == 2025 and region != "EU"' } as const
export const DATASET = { type: 'string', required: true, description: 'dataset name in the workspace ("orders" = latest version, "orders@2" = a specific version)' } as const
export const OUTPUT = { type: 'string', description: 'name for the derived dataset this action writes' } as const
export const SEED = { type: 'integer', description: 'random seed (default 42); recorded for reproducibility' } as const

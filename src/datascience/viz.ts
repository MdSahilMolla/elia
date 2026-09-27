import { createRng } from './rng.ts'
import { mean, quantileSorted, sorted as sortAscending } from './stats/describe.ts'

/**
 * Deterministic SVG charts. The palette, mark specs, and rules follow the data-viz method:
 * categorical hues in a fixed validated order (never cycled — extra series fold into
 * "Other"), one y-axis only, thin marks (bars ≤ 24px with 4px rounded data ends, 2px lines,
 * ≥ 8px markers with a surface ring), hairline recessive grids, a legend whenever there are
 * two or more series, text in ink tokens rather than series colours, and a data table for
 * every chart. Light and dark themes are selected steps of the same palette. Bars always
 * start at zero; a chart that cannot be drawn honestly is refused with a reason.
 */

const LIGHT = { surface: '#fcfcfb', ink: '#0b0b0b', secondary: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7', series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'], neutral: '#f0efec' }
const DARK = { surface: '#1a1a19', ink: '#ffffff', secondary: '#c3c2b7', muted: '#898781', grid: '#2c2c2a', axis: '#383835', series: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'], neutral: '#383835' }
const SEQUENTIAL = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b']
const DIVERGING_NEG = ['#e34948', '#ea7b7a', '#f2adac']
const DIVERGING_POS = ['#b7d3f6', '#6da7ec', '#2a78d6']
const OTHER_COLOR = { light: '#b5b3ab', dark: '#6b6a64' }
export const MAX_SERIES = 8
export const MAX_SCATTER_GROUPS = 3

export interface ChartResult {
  svg: string
  table: { columns: string[]; rows: Array<Array<string | number | null>> }
  warnings: string[]
  type: string
  title: string
}

export type ChartType = 'bar' | 'line' | 'area' | 'scatter' | 'histogram' | 'box' | 'violin' | 'heatmap' | 'waterfall' | 'funnel' | 'treemap' | 'network' | 'map'
export const CHART_TYPES: ChartType[] = ['bar', 'line', 'area', 'scatter', 'histogram', 'box', 'violin', 'heatmap', 'waterfall', 'funnel', 'treemap', 'network', 'map']

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function formatNumber(value: number | null | undefined, style: 'compact' | 'percent' | 'plain' = 'compact'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (style === 'percent') return `${(value * 100).toFixed(Math.abs(value) < 0.1 ? 1 : 0)}%`
  const abs = Math.abs(value)
  if (style === 'compact') {
    if (abs >= 1e9) return `${(value / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`
    if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`
    if (abs >= 1e4) return `${(value / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}K`
  }
  if (abs >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (abs >= 10) return value.toLocaleString('en-US', { maximumFractionDigits: 1 })
  if (abs >= 1) return value.toLocaleString('en-US', { maximumFractionDigits: 2 })
  return abs === 0 ? '0' : value.toPrecision(2)
}

/** "Nice" axis ticks (1, 2, 2.5, 5 × 10^k). */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1]
  if (min === max) { const pad = Math.abs(min) || 1; min -= pad; max += pad }
  const span = max - min
  const raw = span / count
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((candidate) => span / candidate <= count) ?? 10 * magnitude
  // The axis always covers the data: first tick ≤ min, last tick ≥ max.
  const start = Math.floor(min / step + 1e-9) * step
  const end = Math.ceil(max / step - 1e-9) * step
  const ticks: number[] = []
  for (let k = 0; start + k * step <= end + step * 1e-9 && k < 50; k++) ticks.push(Number((start + k * step).toPrecision(12)))
  return ticks
}

function style(id: string): string {
  const vars = (p: typeof LIGHT, other: string) => `--surface:${p.surface};--ink:${p.ink};--ink2:${p.secondary};--muted:${p.muted};--grid:${p.grid};--axis:${p.axis};--other:${other};${p.series.map((c, i) => `--s${i + 1}:${c};`).join('')}`
  return `<style>
#${id}{${vars(LIGHT, OTHER_COLOR.light)}font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
@media (prefers-color-scheme: dark){:root:where(:not([data-theme="light"])) #${id}{${vars(DARK, OTHER_COLOR.dark)}}}
:root[data-theme="dark"] #${id}{${vars(DARK, OTHER_COLOR.dark)}}
#${id} .bg{fill:var(--surface)}#${id} .title{fill:var(--ink);font-size:15px;font-weight:600}#${id} .subtitle{fill:var(--ink2);font-size:12px}
#${id} .tick{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}#${id} .label{fill:var(--ink2);font-size:11px}#${id} .value{fill:var(--ink);font-size:11px}
#${id} .grid{stroke:var(--grid);stroke-width:1}#${id} .axis{stroke:var(--axis);stroke-width:1}#${id} .legend{fill:var(--ink2);font-size:11px}
#${id} .ring{stroke:var(--surface);stroke-width:2}#${id} .gap{stroke:var(--surface);stroke-width:2}
#${id} .mark:hover{opacity:.82}
</style>`
}

function color(index: number): string {
  return index >= MAX_SERIES ? 'var(--other)' : `var(--s${index + 1})`
}

interface Frame {
  id: string
  width: number
  height: number
  left: number
  right: number
  top: number
  bottom: number
}

function open(frame: Frame, title: string, subtitle?: string): string[] {
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" id="${frame.id}" viewBox="0 0 ${frame.width} ${frame.height}" width="100%" style="max-width:${frame.width}px" role="img" aria-label="${escapeXml(title)}">`, style(frame.id), `<rect class="bg" width="${frame.width}" height="${frame.height}" rx="8"/>`, `<text class="title" x="16" y="24">${escapeXml(title)}</text>`]
  if (subtitle) parts.push(`<text class="subtitle" x="16" y="42">${escapeXml(subtitle)}</text>`)
  return parts
}

function legend(names: string[], x: number, y: number, maxWidth: number): { svg: string; height: number } {
  if (names.length < 2) return { svg: '', height: 0 }
  const items: string[] = []
  let cx = x
  let cy = y
  for (const [index, name] of names.entries()) {
    const label = name.length > 28 ? `${name.slice(0, 27)}…` : name
    const width = 18 + label.length * 6.4 + 14
    if (cx + width > x + maxWidth && cx > x) { cx = x; cy += 18 }
    items.push(`<rect x="${cx}" y="${cy - 8}" width="10" height="10" rx="2" fill="${color(index)}"/><text class="legend" x="${cx + 15}" y="${cy + 1}">${escapeXml(label)}</text>`)
    cx += width
  }
  return { svg: items.join(''), height: cy - y + 18 }
}

let counter = 0
function frameFor(width = 760, height = 420, top = 56): Frame {
  counter = (counter + 1) % 1_000_000
  return { id: `c${Date.now().toString(36)}${counter}`, width, height, left: 64, right: 24, top, bottom: 48 }
}

/** Folds series beyond the palette into "Other" (summed), preserving the first series' order. */
function foldSeries(series: Array<{ name: string; values: Array<number | null> }>, max: number, warnings: string[]): Array<{ name: string; values: Array<number | null> }> {
  if (series.length <= max) return series
  const kept = series.slice(0, max - 1)
  const rest = series.slice(max - 1)
  warnings.push(`${rest.length} series folded into "Other" (colours are never cycled or generated beyond ${max})`)
  const length = Math.max(...rest.map((s) => s.values.length))
  return [...kept, { name: 'Other', values: Array.from({ length }, (_, i) => rest.reduce((total, s) => total + (s.values[i] ?? 0), 0)) }]
}

function yAxis(parts: string[], frame: Frame, ticks: number[], scale: (v: number) => number, format: 'compact' | 'percent' | 'plain', yLabel?: string): void {
  for (const tick of ticks) {
    const y = scale(tick)
    parts.push(`<line class="grid" x1="${frame.left}" x2="${frame.width - frame.right}" y1="${y}" y2="${y}"/><text class="tick" x="${frame.left - 8}" y="${y + 4}" text-anchor="end">${formatNumber(tick, format)}</text>`)
  }
  if (yLabel) parts.push(`<text class="label" transform="translate(14 ${(frame.top + frame.height - frame.bottom) / 2}) rotate(-90)" text-anchor="middle">${escapeXml(yLabel)}</text>`)
}

// ================================================================ bar

export interface BarSpec { title: string; subtitle?: string; categories: string[]; series: Array<{ name: string; values: Array<number | null> }>; horizontal?: boolean; stacked?: boolean; yLabel?: string; format?: 'compact' | 'percent' | 'plain'; valueLabels?: boolean }

export function barChart(spec: BarSpec): ChartResult {
  const warnings: string[] = []
  const series = foldSeries(spec.series, MAX_SERIES, warnings)
  const n = spec.categories.length
  if (n === 0) throw new Error('a bar chart needs at least one category')
  if (n > 40) warnings.push(`${n} categories is too many to read; consider the top 20 plus "Other"`)
  const horizontal = spec.horizontal ?? (n > 8 || spec.categories.some((c) => c.length > 12))
  const format = spec.format ?? 'compact'
  const stackedTotals = spec.categories.map((_, i) => series.reduce((total, s) => total + Math.max(0, s.values[i] ?? 0), 0))
  const stackedNeg = spec.categories.map((_, i) => series.reduce((total, s) => total + Math.min(0, s.values[i] ?? 0), 0))
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null))
  const maxValue = spec.stacked ? Math.max(0, ...stackedTotals) : Math.max(0, ...all)
  const minValue = spec.stacked ? Math.min(0, ...stackedNeg) : Math.min(0, ...all)
  const ticks = niceTicks(minValue, maxValue)
  const lo = Math.min(ticks[0]!, 0)
  const hi = Math.max(ticks.at(-1)!, 0)
  const legendNames = series.map((s) => s.name)
  const labelWidth = horizontal ? Math.min(180, Math.max(50, ...spec.categories.map((c) => Math.min(c.length, 26) * 6.2))) : 0
  const height = horizontal ? Math.max(260, 70 + n * (spec.stacked || series.length === 1 ? 26 : 12 * series.length + 12) + (legendNames.length > 1 ? 30 : 0)) : 420
  const frame = frameFor(760, height, spec.subtitle ? 64 : 48)
  if (horizontal) frame.left = labelWidth + 20
  const parts = open(frame, spec.title, spec.subtitle)
  const leg = legend(legendNames, frame.left, frame.top + 4, frame.width - frame.left - frame.right)
  frame.top += leg.height ? leg.height + 8 : 8
  parts.push(leg.svg)
  const plotW = frame.width - frame.left - frame.right
  const plotH = frame.height - frame.top - frame.bottom
  const band = (horizontal ? plotH : plotW) / n
  const perSeries = spec.stacked ? 1 : series.length
  const thickness = Math.min(24, (band * 0.7) / perSeries)
  const valueScale = (v: number) => (horizontal ? frame.left + ((v - lo) / (hi - lo)) * plotW : frame.top + plotH - ((v - lo) / (hi - lo)) * plotH)
  const zero = valueScale(0)
  if (horizontal) {
    for (const tick of ticks) { const x = valueScale(tick); parts.push(`<line class="grid" x1="${x}" x2="${x}" y1="${frame.top}" y2="${frame.top + plotH}"/><text class="tick" x="${x}" y="${frame.top + plotH + 16}" text-anchor="middle">${formatNumber(tick, format)}</text>`) }
    if (spec.yLabel) parts.push(`<text class="label" x="${frame.left + plotW / 2}" y="${frame.height - 10}" text-anchor="middle">${escapeXml(spec.yLabel)}</text>`)
  } else yAxis(parts, frame, ticks, valueScale, format, spec.yLabel)
  const rect = (x: number, y: number, w: number, h: number, radiusEnd: 'top' | 'bottom' | 'right' | 'left' | 'none', fill: string, tip: string) => {
    const r = Math.min(4, w / 2, h / 2)
    if (w <= 0 || h <= 0) return ''
    let d: string
    if (radiusEnd === 'top') d = `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
    else if (radiusEnd === 'bottom') d = `M${x},${y}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w - r}Q${x + w},${y + h} ${x + w},${y + h - r}V${y}Z`
    else if (radiusEnd === 'right') d = `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`
    else if (radiusEnd === 'left') d = `M${x + w},${y}H${x + r}Q${x},${y} ${x},${y + r}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w}Z`
    else d = `M${x},${y}h${w}v${h}h${-w}Z`
    return `<path class="mark" d="${d}" fill="${fill}"><title>${escapeXml(tip)}</title></path>`
  }
  spec.categories.forEach((category, i) => {
    const centre = (horizontal ? frame.top : frame.left) + band * (i + 0.5)
    const label = category.length > 26 ? `${category.slice(0, 25)}…` : category
    if (horizontal) parts.push(`<text class="label" x="${frame.left - 8}" y="${centre + 4}" text-anchor="end">${escapeXml(label)}</text>`)
    else if (i % Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 64)))) === 0) parts.push(`<text class="label" x="${centre}" y="${frame.top + plotH + 16}" text-anchor="middle">${escapeXml(label.slice(0, 10))}</text>`)
    let posOffset = 0
    let negOffset = 0
    series.forEach((s, j) => {
      const value = s.values[i]
      if (value === null || value === undefined) return
      const tip = `${category}${series.length > 1 ? ` · ${s.name}` : ''}: ${formatNumber(value, format === 'percent' ? 'percent' : 'plain')}`
      const start = spec.stacked ? (value >= 0 ? posOffset : negOffset) : 0
      const end = start + value
      if (spec.stacked) value >= 0 ? (posOffset = end) : (negOffset = end)
      const a = valueScale(start)
      const b = valueScale(end)
      const offset = spec.stacked ? -thickness / 2 : -((perSeries * thickness + (perSeries - 1) * 2) / 2) + j * (thickness + 2)
      const isTopSegment = !spec.stacked || j === series.length - 1 || series.slice(j + 1).every((other) => (other.values[i] ?? 0) === 0 || Math.sign(other.values[i] ?? 0) !== Math.sign(value))
      const gap = spec.stacked && j > 0 ? 1 : 0
      if (horizontal) parts.push(rect(Math.min(a, b) + (value >= 0 ? gap : 0), centre + offset, Math.abs(b - a) - gap, thickness, isTopSegment ? (value >= 0 ? 'right' : 'left') : 'none', color(j), tip))
      else parts.push(rect(centre + offset, Math.min(a, b), thickness, Math.abs(b - a) - gap, isTopSegment ? (value >= 0 ? 'top' : 'bottom') : 'none', color(j), tip))
      if ((spec.valueLabels ?? series.length === 1) && !spec.stacked && n <= 24) {
        const text = formatNumber(value, format)
        parts.push(horizontal ? `<text class="value" x="${b + (value >= 0 ? 6 : -6)}" y="${centre + offset + thickness / 2 + 4}" text-anchor="${value >= 0 ? 'start' : 'end'}">${text}</text>` : `<text class="value" x="${centre + offset + thickness / 2}" y="${b - (value >= 0 ? 6 : -14)}" text-anchor="middle">${text}</text>`)
      }
    })
  })
  parts.push(horizontal ? `<line class="axis" x1="${zero}" x2="${zero}" y1="${frame.top}" y2="${frame.top + plotH}"/>` : `<line class="axis" x1="${frame.left}" x2="${frame.width - frame.right}" y1="${zero}" y2="${zero}"/>`, '</svg>')
  return { svg: parts.join(''), table: { columns: ['category', ...series.map((s) => s.name)], rows: spec.categories.map((c, i) => [c, ...series.map((s) => s.values[i] ?? null)]) }, warnings, type: 'bar', title: spec.title }
}

// ================================================================ line / area

export interface LineSpec { title: string; subtitle?: string; x: Array<string | number>; series: Array<{ name: string; values: Array<number | null> }>; band?: { lower: Array<number | null>; upper: Array<number | null>; label: string }; area?: boolean; yLabel?: string; xLabel?: string; format?: 'compact' | 'percent' | 'plain'; zeroBaseline?: boolean; highlightFrom?: number; markers?: boolean; xIsTime?: boolean }

export function lineChart(spec: LineSpec): ChartResult {
  const warnings: string[] = []
  const series = foldSeries(spec.series, MAX_SERIES, warnings)
  const n = spec.x.length
  if (n < 2) throw new Error('a line chart needs at least two x values')
  const format = spec.format ?? 'compact'
  const values = [...series.flatMap((s) => s.values), ...(spec.band ? [...spec.band.lower, ...spec.band.upper] : [])].filter((v): v is number => v !== null && Number.isFinite(v))
  let lo = Math.min(...values)
  let hi = Math.max(...values)
  if (spec.area || spec.zeroBaseline) { lo = Math.min(0, lo); hi = Math.max(0, hi) }
  const ticks = niceTicks(lo, hi)
  lo = ticks[0]!
  hi = ticks.at(-1)!
  const frame = frameFor(760, 420, spec.subtitle ? 64 : 48)
  const parts = open(frame, spec.title, spec.subtitle)
  const leg = legend([...series.map((s) => s.name)], frame.left, frame.top + 4, frame.width - frame.left - frame.right - 80)
  frame.top += leg.height ? leg.height + 8 : 8
  parts.push(leg.svg)
  frame.right = series.length > 1 && series.length <= 4 ? 96 : 32
  const plotW = frame.width - frame.left - frame.right
  const plotH = frame.height - frame.top - frame.bottom
  const xScale = (i: number) => frame.left + (i / (n - 1)) * plotW
  const yScale = (v: number) => frame.top + plotH - ((v - lo) / (hi - lo)) * plotH
  yAxis(parts, frame, ticks, yScale, format, spec.yLabel)
  const tickEvery = Math.max(1, Math.ceil(n / 8))
  for (let i = 0; i < n; i += tickEvery) parts.push(`<text class="tick" x="${xScale(i)}" y="${frame.top + plotH + 16}" text-anchor="middle">${escapeXml(String(spec.x[i]).slice(0, 10))}</text>`)
  if (spec.xLabel) parts.push(`<text class="label" x="${frame.left + plotW / 2}" y="${frame.height - 8}" text-anchor="middle">${escapeXml(spec.xLabel)}</text>`)
  if (spec.highlightFrom !== undefined && spec.highlightFrom > 0 && spec.highlightFrom < n) {
    const x = xScale(spec.highlightFrom - 0.5)
    parts.push(`<line class="axis" x1="${x}" x2="${x}" y1="${frame.top}" y2="${frame.top + plotH}"/><text class="tick" x="${x + 4}" y="${frame.top + 12}">forecast →</text>`)
  }
  if (spec.band) {
    const upper: string[] = []
    const lower: string[] = []
    spec.band.upper.forEach((v, i) => { if (v !== null && spec.band!.lower[i] !== null) { upper.push(`${xScale(i)},${yScale(v)}`); lower.unshift(`${xScale(i)},${yScale(spec.band!.lower[i]!)}`) } })
    if (upper.length) parts.push(`<polygon points="${[...upper, ...lower].join(' ')}" fill="var(--s1)" fill-opacity="0.12"><title>${escapeXml(spec.band.label)}</title></polygon>`)
  }
  series.forEach((s, j) => {
    const segments: string[][] = [[]]
    s.values.forEach((v, i) => { if (v === null || !Number.isFinite(v)) { if (segments.at(-1)!.length) segments.push([]) } else segments.at(-1)!.push(`${xScale(i)},${yScale(v)}`) })
    for (const segment of segments.filter((seg) => seg.length)) {
      if (spec.area) parts.push(`<polygon points="${segment.join(' ')} ${segment.at(-1)!.split(',')[0]},${yScale(Math.max(lo, 0))} ${segment[0]!.split(',')[0]},${yScale(Math.max(lo, 0))}" fill="${color(j)}" fill-opacity="0.1"/>`)
      parts.push(`<polyline points="${segment.join(' ')}" fill="none" stroke="${color(j)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`)
    }
    const showMarkers = spec.markers ?? n <= 40
    s.values.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) return
      const tip = `${spec.x[i]}${series.length > 1 ? ` · ${s.name}` : ''}: ${formatNumber(v, format === 'percent' ? 'percent' : 'plain')}${spec.band && j === 0 && spec.band.lower[i] !== null ? ` (${spec.band.label}: ${formatNumber(spec.band.lower[i], 'plain')} – ${formatNumber(spec.band.upper[i], 'plain')})` : ''}`
      parts.push(`<circle class="mark${showMarkers ? ' ring' : ''}" cx="${xScale(i)}" cy="${yScale(v)}" r="${showMarkers ? 4 : 7}" fill="${showMarkers ? color(j) : 'transparent'}"><title>${escapeXml(tip)}</title></circle>`)
    })
    const lastIndex = s.values.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0).at(-1)
    if (lastIndex !== undefined && series.length <= 4) {
      const lastValue = s.values[lastIndex]!
      parts.push(`<text class="value" x="${xScale(lastIndex) + 8}" y="${yScale(lastValue) + 4}">${series.length > 1 ? `${escapeXml(s.name.slice(0, 10))} ` : ''}${formatNumber(lastValue, format)}</text>`)
    }
  })
  parts.push(`<line class="axis" x1="${frame.left}" x2="${frame.left + plotW}" y1="${frame.top + plotH}" y2="${frame.top + plotH}"/>`, '</svg>')
  return { svg: parts.join(''), table: { columns: ['x', ...series.map((s) => s.name), ...(spec.band ? ['lower', 'upper'] : [])], rows: spec.x.map((x, i) => [String(x), ...series.map((s) => s.values[i] ?? null), ...(spec.band ? [spec.band.lower[i] ?? null, spec.band.upper[i] ?? null] : [])]) }, warnings, type: spec.area ? 'area' : 'line', title: spec.title }
}

// ================================================================ scatter

export interface ScatterSpec { title: string; subtitle?: string; points: Array<{ x: number; y: number; group?: string; label?: string }>; xLabel?: string; yLabel?: string; trend?: boolean }

export function scatterChart(spec: ScatterSpec): ChartResult {
  const warnings: string[] = []
  const points = spec.points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
  if (points.length < 2) throw new Error('a scatter plot needs at least two finite points')
  const groupCounts = new Map<string, number>()
  for (const p of points) if (p.group !== undefined) groupCounts.set(p.group, (groupCounts.get(p.group) ?? 0) + 1)
  let groups = [...groupCounts.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g)
  if (groups.length > MAX_SCATTER_GROUPS) {
    warnings.push(`${groups.length} groups exceed the ${MAX_SCATTER_GROUPS} colours that stay distinguishable in a scatter; the rest are shown as "Other"`)
    groups = [...groups.slice(0, MAX_SCATTER_GROUPS), 'Other']
  }
  const groupIndex = (g?: string) => (g === undefined ? 0 : groups.indexOf(g) >= 0 && groups.indexOf(g) < MAX_SCATTER_GROUPS ? groups.indexOf(g) : MAX_SERIES)
  const sample = points.length > 5000 ? createRng(1).shuffle(points).slice(0, 5000) : points
  if (sample.length < points.length) warnings.push(`${points.length} points; a seeded random 5,000 are drawn to keep the chart legible`)
  const xt = niceTicks(Math.min(...points.map((p) => p.x)), Math.max(...points.map((p) => p.x)))
  const yt = niceTicks(Math.min(...points.map((p) => p.y)), Math.max(...points.map((p) => p.y)))
  const frame = frameFor(760, 440, spec.subtitle ? 64 : 48)
  const parts = open(frame, spec.title, spec.subtitle)
  const leg = legend(groups.length ? groups : [], frame.left, frame.top + 4, frame.width - frame.left - frame.right)
  frame.top += leg.height ? leg.height + 8 : 8
  parts.push(leg.svg.replace(/var\(--s4\)/g, 'var(--other)'))
  const plotW = frame.width - frame.left - frame.right
  const plotH = frame.height - frame.top - frame.bottom
  const xScale = (v: number) => frame.left + ((v - xt[0]!) / (xt.at(-1)! - xt[0]!)) * plotW
  const yScale = (v: number) => frame.top + plotH - ((v - yt[0]!) / (yt.at(-1)! - yt[0]!)) * plotH
  yAxis(parts, frame, yt, yScale, 'compact', spec.yLabel)
  for (const tick of xt) parts.push(`<line class="grid" x1="${xScale(tick)}" x2="${xScale(tick)}" y1="${frame.top}" y2="${frame.top + plotH}"/><text class="tick" x="${xScale(tick)}" y="${frame.top + plotH + 16}" text-anchor="middle">${formatNumber(tick)}</text>`)
  if (spec.xLabel) parts.push(`<text class="label" x="${frame.left + plotW / 2}" y="${frame.height - 8}" text-anchor="middle">${escapeXml(spec.xLabel)}</text>`)
  const opacity = sample.length > 500 ? 0.45 : 0.85
  for (const p of sample) parts.push(`<circle class="mark ring" cx="${xScale(p.x).toFixed(1)}" cy="${yScale(p.y).toFixed(1)}" r="4" fill="${color(groupIndex(p.group))}" fill-opacity="${opacity}"><title>${escapeXml(`${p.label ? `${p.label}: ` : ''}${formatNumber(p.x, 'plain')}, ${formatNumber(p.y, 'plain')}${p.group ? ` (${p.group})` : ''}`)}</title></circle>`)
  if (spec.trend) {
    const mx = mean(points.map((p) => p.x))
    const my = mean(points.map((p) => p.y))
    const sxx = points.reduce((t, p) => t + (p.x - mx) ** 2, 0)
    if (sxx > 0) {
      const slope = points.reduce((t, p) => t + (p.x - mx) * (p.y - my), 0) / sxx
      const x0 = xt[0]!
      const x1 = xt.at(-1)!
      parts.push(`<line x1="${xScale(x0)}" y1="${yScale(my + slope * (x0 - mx))}" x2="${xScale(x1)}" y2="${yScale(my + slope * (x1 - mx))}" stroke="var(--ink2)" stroke-width="1.5" stroke-dasharray="0"><title>least-squares line (association, not causation)</title></line>`)
    }
  }
  parts.push('</svg>')
  return { svg: parts.join(''), table: { columns: ['x', 'y', 'group', 'label'], rows: points.slice(0, 1000).map((p) => [p.x, p.y, p.group ?? null, p.label ?? null]) }, warnings, type: 'scatter', title: spec.title }
}

// ================================================================ distributions

export function histogramChart(spec: { title: string; subtitle?: string; values: number[]; bins?: number; xLabel?: string }): ChartResult {
  const values = sortAscending(spec.values.filter(Number.isFinite))
  if (values.length < 2) throw new Error('a histogram needs at least two values')
  const min = values[0]!
  const max = values.at(-1)!
  const iqr = quantileSorted(values, 0.75) - quantileSorted(values, 0.25)
  const k = spec.bins ?? Math.max(5, Math.min(50, iqr > 0 ? Math.ceil((max - min) / ((2 * iqr) / Math.cbrt(values.length))) : 10))
  const width = (max - min) / k || 1
  const counts = new Array<number>(k).fill(0)
  for (const v of values) counts[Math.min(k - 1, Math.floor((v - min) / width))]!++
  const labels = counts.map((_, i) => formatNumber(min + i * width))
  const chart = barChart({ title: spec.title, subtitle: spec.subtitle ?? `${values.length} values, ${k} bins of width ${formatNumber(width, 'plain')}`, categories: labels, series: [{ name: 'count', values: counts }], horizontal: false, yLabel: 'count', valueLabels: false })
  return { ...chart, type: 'histogram', table: { columns: ['bin_start', 'bin_end', 'count'], rows: counts.map((c, i) => [min + i * width, min + (i + 1) * width, c]) } }
}

export function boxChart(spec: { title: string; subtitle?: string; groups: Array<{ name: string; values: number[] }>; yLabel?: string; violin?: boolean }): ChartResult {
  const groups = spec.groups.filter((g) => g.values.length > 0).slice(0, 30)
  if (!groups.length) throw new Error('a box plot needs at least one non-empty group')
  const all = groups.flatMap((g) => g.values)
  const ticks = niceTicks(Math.min(...all), Math.max(...all))
  const frame = frameFor(760, 420, spec.subtitle ? 64 : 48)
  const parts = open(frame, spec.title, spec.subtitle)
  frame.top += 8
  const plotW = frame.width - frame.left - frame.right
  const plotH = frame.height - frame.top - frame.bottom
  const yScale = (v: number) => frame.top + plotH - ((v - ticks[0]!) / (ticks.at(-1)! - ticks[0]!)) * plotH
  yAxis(parts, frame, ticks, yScale, 'compact', spec.yLabel)
  const band = plotW / groups.length
  const rows: Array<Array<string | number | null>> = []
  groups.forEach((group, i) => {
    const s = sortAscending(group.values)
    const q1 = quantileSorted(s, 0.25)
    const med = quantileSorted(s, 0.5)
    const q3 = quantileSorted(s, 0.75)
    const iqr = q3 - q1
    const lowWhisker = s.find((v) => v >= q1 - 1.5 * iqr) ?? s[0]!
    const highWhisker = [...s].reverse().find((v) => v <= q3 + 1.5 * iqr) ?? s.at(-1)!
    const cx = frame.left + band * (i + 0.5)
    const w = Math.min(24, band * 0.5)
    rows.push([group.name, s.length, s[0]!, q1, med, q3, s.at(-1)!])
    const tip = `${group.name}: n=${s.length}, median ${formatNumber(med, 'plain')}, IQR ${formatNumber(q1, 'plain')}–${formatNumber(q3, 'plain')}`
    if (spec.violin && s.length >= 10) {
      const bandwidth = 1.06 * Math.min(Math.sqrt(s.reduce((t, v) => t + (v - mean(s)) ** 2, 0) / s.length), iqr / 1.34 || 1) * s.length ** -0.2 || 1
      const grid = Array.from({ length: 40 }, (_, k) => ticks[0]! + ((ticks.at(-1)! - ticks[0]!) * k) / 39)
      const density = grid.map((y) => s.reduce((t, v) => t + Math.exp(-0.5 * ((y - v) / bandwidth) ** 2), 0))
      const peak = Math.max(...density) || 1
      const half = Math.min(band * 0.4, 40)
      const right = grid.map((y, k) => `${cx + (density[k]! / peak) * half},${yScale(y)}`)
      const left = grid.map((y, k) => `${cx - (density[k]! / peak) * half},${yScale(y)}`).reverse()
      parts.push(`<polygon class="mark" points="${[...right, ...left].join(' ')}" fill="${color(0)}" fill-opacity="0.18"><title>${escapeXml(tip)}</title></polygon>`)
    }
    parts.push(`<line class="axis" x1="${cx}" x2="${cx}" y1="${yScale(lowWhisker)}" y2="${yScale(highWhisker)}"/>`)
    parts.push(`<rect class="mark" x="${cx - w / 2}" y="${yScale(q3)}" width="${w}" height="${Math.max(1, yScale(q1) - yScale(q3))}" rx="4" fill="${color(0)}" fill-opacity="${spec.violin ? 0.6 : 0.85}"><title>${escapeXml(tip)}</title></rect>`)
    parts.push(`<line x1="${cx - w / 2}" x2="${cx + w / 2}" y1="${yScale(med)}" y2="${yScale(med)}" stroke="var(--surface)" stroke-width="2"/>`)
    for (const outlier of s.filter((v) => v < lowWhisker || v > highWhisker).slice(0, 50)) parts.push(`<circle class="ring" cx="${cx}" cy="${yScale(outlier)}" r="3" fill="var(--muted)"><title>${escapeXml(`${group.name}: ${formatNumber(outlier, 'plain')}`)}</title></circle>`)
    parts.push(`<text class="label" x="${cx}" y="${frame.top + plotH + 16}" text-anchor="middle">${escapeXml(group.name.slice(0, 14))}</text>`)
  })
  parts.push('</svg>')
  return { svg: parts.join(''), table: { columns: ['group', 'n', 'min', 'q1', 'median', 'q3', 'max'], rows }, warnings: [], type: spec.violin ? 'violin' : 'box', title: spec.title }
}

// ================================================================ heatmap

export function heatmapChart(spec: { title: string; subtitle?: string; xLabels: string[]; yLabels: string[]; values: Array<Array<number | null>>; diverging?: boolean; format?: 'compact' | 'percent' | 'plain'; domain?: [number, number] }): ChartResult {
  const flat = spec.values.flat().filter((v): v is number => v !== null && Number.isFinite(v))
  if (!flat.length) throw new Error('a heatmap needs numeric values')
  const lo = spec.domain?.[0] ?? (spec.diverging ? -Math.max(...flat.map(Math.abs)) : Math.min(...flat))
  const hi = spec.domain?.[1] ?? (spec.diverging ? Math.max(...flat.map(Math.abs)) : Math.max(...flat))
  const labelWidth = Math.min(160, Math.max(40, ...spec.yLabels.map((l) => Math.min(l.length, 22) * 6.2)))
  const cell = Math.max(14, Math.min(56, Math.floor((760 - labelWidth - 40) / Math.max(1, spec.xLabels.length))))
  const width = labelWidth + 40 + cell * spec.xLabels.length
  const height = (spec.subtitle ? 110 : 94) + cell * spec.yLabels.length
  const frame = frameFor(Math.max(360, width), height, spec.subtitle ? 64 : 48)
  frame.left = labelWidth + 20
  const parts = open(frame, spec.title, spec.subtitle)
  const fill = (v: number) => {
    if (spec.diverging) {
      const t = (v - 0) / Math.max(Math.abs(lo), Math.abs(hi), 1e-12)
      if (Math.abs(t) < 0.12) return 'var(--grid)'
      // Stronger magnitude → darker step on either arm (NEG is ordered dark→light, POS light→dark).
      const idx = Math.min(2, Math.floor(Math.abs(t) * 3))
      return t < 0 ? DIVERGING_NEG[2 - idx]! : DIVERGING_POS[idx]!
    }
    const t = hi === lo ? 0.5 : (v - lo) / (hi - lo)
    return SEQUENTIAL[Math.min(SEQUENTIAL.length - 1, Math.floor(t * (SEQUENTIAL.length - 1)))]!
  }
  const top = frame.top + 20
  spec.xLabels.forEach((label, i) => parts.push(`<text class="tick" x="${frame.left + i * cell + cell / 2}" y="${top - 6}" text-anchor="middle">${escapeXml(label.slice(0, Math.max(3, Math.floor(cell / 6.5))))}</text>`))
  spec.yLabels.forEach((label, j) => {
    parts.push(`<text class="label" x="${frame.left - 8}" y="${top + j * cell + cell / 2 + 4}" text-anchor="end">${escapeXml(label.slice(0, 22))}</text>`)
    spec.xLabels.forEach((xLabel, i) => {
      const v = spec.values[j]?.[i]
      if (v === null || v === undefined || !Number.isFinite(v)) return
      const f = fill(v)
      const dark = SEQUENTIAL.indexOf(f) >= 7 || f === DIVERGING_NEG[0] || f === DIVERGING_POS[2]
      parts.push(`<rect class="mark gap" x="${frame.left + i * cell}" y="${top + j * cell}" width="${cell}" height="${cell}" rx="2" fill="${f}"><title>${escapeXml(`${label} × ${xLabel}: ${formatNumber(v, spec.format === 'percent' ? 'percent' : 'plain')}`)}</title></rect>`)
      if (cell >= 34 && spec.xLabels.length * spec.yLabels.length <= 225) parts.push(`<text x="${frame.left + i * cell + cell / 2}" y="${top + j * cell + cell / 2 + 4}" text-anchor="middle" font-size="10" fill="${f === 'var(--grid)' ? 'var(--ink)' : dark ? '#ffffff' : '#0b0b0b'}">${formatNumber(v, spec.format ?? 'plain')}</text>`)
    })
  })
  parts.push('</svg>')
  return { svg: parts.join(''), table: { columns: ['row', ...spec.xLabels], rows: spec.yLabels.map((label, j) => [label, ...spec.xLabels.map((_, i) => spec.values[j]?.[i] ?? null)]) }, warnings: [], type: 'heatmap', title: spec.title }
}

// ================================================================ waterfall, funnel, treemap

export function waterfallChart(spec: { title: string; subtitle?: string; start: { label: string; value: number }; steps: Array<{ label: string; value: number }>; endLabel?: string; format?: 'compact' | 'percent' | 'plain' }): ChartResult {
  const format = spec.format ?? 'compact'
  const bars: Array<{ label: string; from: number; to: number; kind: 'total' | 'up' | 'down' }> = [{ label: spec.start.label, from: 0, to: spec.start.value, kind: 'total' }]
  let running = spec.start.value
  for (const step of spec.steps) { bars.push({ label: step.label, from: running, to: running + step.value, kind: step.value >= 0 ? 'up' : 'down' }); running += step.value }
  bars.push({ label: spec.endLabel ?? 'End', from: 0, to: running, kind: 'total' })
  const values = bars.flatMap((b) => [b.from, b.to])
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values))
  const frame = frameFor(760, 420, spec.subtitle ? 64 : 48)
  const parts = open(frame, spec.title, spec.subtitle)
  parts.push(legend(['increase', 'decrease'], frame.left, frame.top + 4, 400).svg.replace('var(--s1)', 'var(--s1)').replace('var(--s2)', 'var(--s8)'))
  frame.top += 30
  const plotW = frame.width - frame.left - frame.right
  const plotH = frame.height - frame.top - frame.bottom
  const yScale = (v: number) => frame.top + plotH - ((v - ticks[0]!) / (ticks.at(-1)! - ticks[0]!)) * plotH
  yAxis(parts, frame, ticks, yScale, format)
  const band = plotW / bars.length
  const w = Math.min(24 * 1.5, band * 0.6)
  bars.forEach((bar, i) => {
    const cx = frame.left + band * (i + 0.5)
    const top = yScale(Math.max(bar.from, bar.to))
    const h = Math.max(1, Math.abs(yScale(bar.from) - yScale(bar.to)))
    const fill = bar.kind === 'total' ? 'var(--ink2)' : bar.kind === 'up' ? 'var(--s1)' : 'var(--s8)'
    parts.push(`<rect class="mark" x="${cx - w / 2}" y="${top}" width="${w}" height="${h}" rx="3" fill="${fill}"><title>${escapeXml(`${bar.label}: ${bar.kind === 'total' ? formatNumber(bar.to, 'plain') : `${bar.to - bar.from >= 0 ? '+' : ''}${formatNumber(bar.to - bar.from, 'plain')}`}`)}</title></rect>`)
    parts.push(`<text class="value" x="${cx}" y="${top - 6}" text-anchor="middle">${bar.kind === 'total' ? formatNumber(bar.to, format) : `${bar.to - bar.from >= 0 ? '+' : ''}${formatNumber(bar.to - bar.from, format)}`}</text>`)
    parts.push(`<text class="label" x="${cx}" y="${frame.top + plotH + 16}" text-anchor="middle">${escapeXml(bar.label.slice(0, Math.max(6, Math.floor(band / 6.5))))}</text>`)
    if (i < bars.length - 1) parts.push(`<line class="grid" x1="${cx + w / 2}" x2="${cx + band - w / 2}" y1="${yScale(bar.to)}" y2="${yScale(bar.to)}"/>`)
  })
  parts.push(`<line class="axis" x1="${frame.left}" x2="${frame.left + plotW}" y1="${yScale(0)}" y2="${yScale(0)}"/>`, '</svg>')
  return { svg: parts.join(''), table: { columns: ['step', 'change', 'running_total'], rows: bars.map((b) => [b.label, b.kind === 'total' ? null : b.to - b.from, b.to]) }, warnings: [], type: 'waterfall', title: spec.title }
}

export function funnelChart(spec: { title: string; subtitle?: string; steps: Array<{ label: string; value: number }> }): ChartResult {
  if (spec.steps.length < 2) throw new Error('a funnel needs at least two steps')
  const first = spec.steps[0]!.value || 1
  const frame = frameFor(760, 80 + spec.steps.length * 44, spec.subtitle ? 64 : 48)
  const parts = open(frame, spec.title, spec.subtitle)
  const labelWidth = 170
  const plotW = frame.width - labelWidth - 140
  const ramp = ['#0d366b', '#104281', '#184f95', '#1c5cab', '#256abf', '#2a78d6', '#3987e5', '#5598e7', '#6da7ec', '#86b6ef']
  spec.steps.forEach((step, i) => {
    const y = frame.top + 8 + i * 44
    const w = Math.max(2, (step.value / first) * plotW)
    parts.push(`<text class="label" x="${labelWidth - 10}" y="${y + 16}" text-anchor="end">${escapeXml(step.label.slice(0, 24))}</text>`)
    parts.push(`<rect class="mark" x="${labelWidth}" y="${y}" width="${w}" height="24" rx="4" fill="${ramp[Math.min(ramp.length - 1, Math.round((i * (ramp.length - 1)) / Math.max(1, spec.steps.length - 1)))]}"><title>${escapeXml(`${step.label}: ${formatNumber(step.value, 'plain')} (${formatNumber(step.value / first, 'percent')} of first step)`)}</title></rect>`)
    const conversion = i === 0 ? '' : ` · ${formatNumber(spec.steps[i - 1]!.value ? step.value / spec.steps[i - 1]!.value : 0, 'percent')} of previous`
    parts.push(`<text class="value" x="${labelWidth + w + 8}" y="${y + 16}">${formatNumber(step.value)}${conversion}</text>`)
  })
  parts.push('</svg>')
  return { svg: parts.join(''), table: { columns: ['step', 'value', 'share_of_first'], rows: spec.steps.map((s) => [s.label, s.value, s.value / first]) }, warnings: [], type: 'funnel', title: spec.title }
}

export function treemapChart(spec: { title: string; subtitle?: string; items: Array<{ label: string; value: number }> }): ChartResult {
  const warnings: string[] = []
  let items = spec.items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value)
  if (items.length !== spec.items.length) warnings.push('non-positive values cannot be area-encoded and were left out')
  if (items.length > 20) { const rest = items.slice(19).reduce((t, i) => t + i.value, 0); items = [...items.slice(0, 19), { label: 'Other', value: rest }]; warnings.push('items beyond the top 19 were combined into "Other"') }
  const frame = frameFor(760, 440, spec.subtitle ? 64 : 48)
  const parts = open(frame, spec.title, spec.subtitle)
  const total = items.reduce((t, i) => t + i.value, 0)
  const rects: Array<{ x: number; y: number; w: number; h: number; item: { label: string; value: number } }> = []
  const layout = (list: typeof items, x: number, y: number, w: number, h: number) => {
    if (!list.length) return
    if (list.length === 1) { rects.push({ x, y, w, h, item: list[0]! }); return }
    const sum = list.reduce((t, i) => t + i.value, 0)
    let acc = 0
    let split = 0
    while (split < list.length - 1 && acc + list[split]!.value < sum / 2) { acc += list[split]!.value; split++ }
    split = Math.max(1, split)
    acc = list.slice(0, split).reduce((t, i) => t + i.value, 0)
    const ratio = acc / sum
    if (w >= h) { layout(list.slice(0, split), x, y, w * ratio, h); layout(list.slice(split), x + w * ratio, y, w * (1 - ratio), h) }
    else { layout(list.slice(0, split), x, y, w, h * ratio); layout(list.slice(split), x, y + h * ratio, w, h * (1 - ratio)) }
  }
  layout(items, 16, frame.top + 8, frame.width - 32, frame.height - frame.top - 24)
  for (const r of rects) {
    const idx = items.indexOf(r.item)
    const fill = SEQUENTIAL[Math.max(3, SEQUENTIAL.length - 1 - Math.floor((idx / Math.max(1, items.length - 1)) * 9))]!
    const darkText = SEQUENTIAL.indexOf(fill) < 7
    parts.push(`<rect class="mark gap" x="${r.x}" y="${r.y}" width="${Math.max(0, r.w)}" height="${Math.max(0, r.h)}" rx="3" fill="${fill}"><title>${escapeXml(`${r.item.label}: ${formatNumber(r.item.value, 'plain')} (${formatNumber(r.item.value / total, 'percent')})`)}</title></rect>`)
    if (r.w > 70 && r.h > 30) parts.push(`<text x="${r.x + 8}" y="${r.y + 18}" font-size="11" fill="${darkText ? '#0b0b0b' : '#ffffff'}">${escapeXml(r.item.label.slice(0, Math.floor(r.w / 7)))}</text><text x="${r.x + 8}" y="${r.y + 32}" font-size="11" fill="${darkText ? '#0b0b0b' : '#ffffff'}">${formatNumber(r.item.value / total, 'percent')}</text>`)
  }
  parts.push('</svg>')
  return { svg: parts.join(''), table: { columns: ['item', 'value', 'share'], rows: items.map((i) => [i.label, i.value, i.value / total]) }, warnings, type: 'treemap', title: spec.title }
}

// ================================================================ network and map

export function networkChart(spec: { title: string; subtitle?: string; nodes: Array<{ id: string; group?: number; size?: number }>; edges: Array<{ source: string; target: string }>; seed?: number }): ChartResult {
  const warnings: string[] = []
  let nodes = spec.nodes
  if (nodes.length > 300) { nodes = [...nodes].sort((a, b) => (b.size ?? 0) - (a.size ?? 0)).slice(0, 300); warnings.push('only the 300 largest nodes are drawn') }
  const index = new Map(nodes.map((n, i) => [n.id, i]))
  const edges = spec.edges.filter((e) => index.has(e.source) && index.has(e.target))
  const rng = createRng(spec.seed ?? 42)
  const frame = frameFor(760, 520, spec.subtitle ? 64 : 48)
  const W = frame.width - 40
  const H = frame.height - frame.top - 20
  const pos = nodes.map((_, i) => ({ x: W / 2 + (W / 3) * Math.cos((2 * Math.PI * i) / nodes.length) + rng.normal(0, 5), y: H / 2 + (H / 3) * Math.sin((2 * Math.PI * i) / nodes.length) + rng.normal(0, 5) }))
  const k = Math.sqrt((W * H) / Math.max(1, nodes.length))
  for (let iteration = 0; iteration < 200; iteration++) {
    const disp = nodes.map(() => ({ x: 0, y: 0 }))
    const temperature = (W / 10) * (1 - iteration / 200)
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const dx = pos[i]!.x - pos[j]!.x; const dy = pos[i]!.y - pos[j]!.y
      const d = Math.max(0.01, Math.hypot(dx, dy))
      const f = (k * k) / d
      disp[i]!.x += (dx / d) * f; disp[i]!.y += (dy / d) * f; disp[j]!.x -= (dx / d) * f; disp[j]!.y -= (dy / d) * f
    }
    for (const e of edges) {
      const a = index.get(e.source)!; const b = index.get(e.target)!
      const dx = pos[a]!.x - pos[b]!.x; const dy = pos[a]!.y - pos[b]!.y
      const d = Math.max(0.01, Math.hypot(dx, dy))
      const f = (d * d) / k
      disp[a]!.x -= (dx / d) * f; disp[a]!.y -= (dy / d) * f; disp[b]!.x += (dx / d) * f; disp[b]!.y += (dy / d) * f
    }
    // Gravity toward the centre keeps loosely connected graphs from pinning to the frame.
    const gravity = (1.5 * nodes.length * k * k) / ((W / 2) * (W / 2))
    pos.forEach((p, i) => { disp[i]!.x -= gravity * (p.x - W / 2); disp[i]!.y -= gravity * (p.y - H / 2) * (W / H) })
    pos.forEach((p, i) => { const d = Math.max(0.01, Math.hypot(disp[i]!.x, disp[i]!.y)); p.x = Math.min(W - 12, Math.max(12, p.x + (disp[i]!.x / d) * Math.min(d, temperature))); p.y = Math.min(H - 12, Math.max(12, p.y + (disp[i]!.y / d) * Math.min(d, temperature))) })
  }
  const parts = open(frame, spec.title, spec.subtitle)
  const X = (x: number) => 20 + x
  const Y = (y: number) => frame.top + 10 + y
  for (const e of edges.slice(0, 3000)) { const a = pos[index.get(e.source)!]!; const b = pos[index.get(e.target)!]!; parts.push(`<line x1="${X(a.x).toFixed(1)}" y1="${Y(a.y).toFixed(1)}" x2="${X(b.x).toFixed(1)}" y2="${Y(b.y).toFixed(1)}" class="grid"/>`) }
  const maxSize = Math.max(1, ...nodes.map((n) => n.size ?? 1))
  nodes.forEach((n, i) => parts.push(`<circle class="mark ring" cx="${X(pos[i]!.x).toFixed(1)}" cy="${Y(pos[i]!.y).toFixed(1)}" r="${(4 + 6 * Math.sqrt((n.size ?? 1) / maxSize)).toFixed(1)}" fill="${color(Math.min(MAX_SERIES, n.group ?? 0))}"><title>${escapeXml(`${n.id}${n.group !== undefined ? ` (community ${n.group})` : ''}`)}</title></circle>`))
  parts.push('</svg>')
  return { svg: parts.join(''), table: { columns: ['node', 'group', 'size'], rows: nodes.map((n) => [n.id, n.group ?? null, n.size ?? null]) }, warnings: [...warnings, 'node positions come from a seeded force-directed layout; distance on the page is not a measured quantity'], type: 'network', title: spec.title }
}

export function mapChart(spec: { title: string; subtitle?: string; points: Array<{ lat: number; lon: number; value?: number; label?: string }> }): ChartResult {
  const points = spec.points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
  if (!points.length) throw new Error('a map needs points with latitude and longitude')
  const lats = points.map((p) => p.lat)
  const lons = points.map((p) => p.lon)
  const pad = 0.05
  const minLat = Math.min(...lats); const maxLat = Math.max(...lats); const minLon = Math.min(...lons); const maxLon = Math.max(...lons)
  const frame = frameFor(760, 480, spec.subtitle ? 64 : 48)
  const parts = open(frame, spec.title, spec.subtitle)
  const plotW = frame.width - 40
  const plotH = frame.height - frame.top - 30
  const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (Math.max(-85, Math.min(85, lat)) * Math.PI) / 360))
  const y0 = mercY(minLat); const y1 = mercY(maxLat)
  const spanX = (maxLon - minLon) || 1; const spanY = (y1 - y0) || 1
  const scale = Math.min(plotW / (spanX * (1 + 2 * pad)), plotH / (((spanY * 180) / Math.PI) * (1 + 2 * pad)))
  const X = (lon: number) => 20 + plotW / 2 + (lon - (minLon + maxLon) / 2) * scale
  const Y = (lat: number) => frame.top + 10 + plotH / 2 - ((mercY(lat) - (y0 + y1) / 2) * 180 / Math.PI) * scale
  for (let lon = Math.ceil(minLon); lon <= maxLon; lon += Math.max(1, Math.round(spanX / 6))) parts.push(`<line class="grid" x1="${X(lon)}" x2="${X(lon)}" y1="${frame.top}" y2="${frame.height - 20}"/><text class="tick" x="${X(lon)}" y="${frame.height - 8}" text-anchor="middle">${lon}°</text>`)
  const values = points.map((p) => p.value).filter((v): v is number => v !== undefined && Number.isFinite(v))
  const maxV = values.length ? Math.max(...values.map(Math.abs)) : 1
  for (const p of points.slice(0, 5000)) {
    const r = p.value !== undefined ? 3 + 9 * Math.sqrt(Math.abs(p.value) / maxV) : 4
    parts.push(`<circle class="mark ring" cx="${X(p.lon).toFixed(1)}" cy="${Y(p.lat).toFixed(1)}" r="${r.toFixed(1)}" fill="var(--s1)" fill-opacity="0.6"><title>${escapeXml(`${p.label ? `${p.label}: ` : ''}${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}${p.value !== undefined ? ` — ${formatNumber(p.value, 'plain')}` : ''}`)}</title></circle>`)
  }
  parts.push('</svg>')
  return { svg: parts.join(''), table: { columns: ['lat', 'lon', 'value', 'label'], rows: points.slice(0, 1000).map((p) => [p.lat, p.lon, p.value ?? null, p.label ?? null]) }, warnings: ['Web-Mercator projection of point locations; no basemap is drawn (no external tiles are fetched). Bubble area is proportional to value.'], type: 'map', title: spec.title }
}

/** Picks a chart form from the roles of the fields being plotted. */
export function recommendChart(input: { xType?: 'time' | 'category' | 'number'; yCount: number; seriesCount?: number; categories?: number; purpose?: string }): { type: ChartType; reason: string } {
  const purpose = (input.purpose ?? '').toLowerCase()
  if (/bridge|decompos|walk|contribution/.test(purpose)) return { type: 'waterfall', reason: 'a change broken into additive contributions reads best as a waterfall' }
  if (/funnel|conversion|stage/.test(purpose)) return { type: 'funnel', reason: 'ordered stages with drop-off are a funnel' }
  if (/share|composition|part/.test(purpose) && (input.categories ?? 0) > 6) return { type: 'treemap', reason: 'many parts of a whole; a treemap keeps them legible (pies are avoided)' }
  if (/distribution|spread/.test(purpose)) return { type: input.seriesCount && input.seriesCount > 1 ? 'box' : 'histogram', reason: 'distribution of a numeric variable' }
  if (/correlat|matrix/.test(purpose)) return { type: 'heatmap', reason: 'pairwise values across two dimensions' }
  if (input.xType === 'time') return { type: 'line', reason: 'change over time is a line' }
  if (input.xType === 'number') return { type: 'scatter', reason: 'two numeric variables are a scatter plot' }
  return { type: 'bar', reason: `magnitude across ${input.categories ?? 'several'} categories is a bar chart, sorted, starting at zero` }
}

import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { Tool } from './types.ts'
import { currentAgent, resolveWorkspacePath } from '../autonomy/context.ts'
import { ensureSecureDirectory, writeSecureFile } from '../securePersistence.ts'
import { captureBeforeWrite } from '../checkpoint.ts'

const MAX_TITLE = 120
const MAX_LABEL = 60
const MAX_BAR_ITEMS = 30
const MAX_FLOW_NODES = 24
const MAX_FLOW_EDGES = 40
const MAX_VALUE = 1_000_000_000_000
const SAFE_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,31})$/
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

interface BarItem { label: string; value: number }
interface FlowNode { id: string; label: string }
interface FlowEdge { from: string; to: string; label?: string }
type Visualization =
  | { type: 'bar'; title: string; slug: string; items: BarItem[] }
  | { type: 'flow'; title: string; slug: string; nodes: FlowNode[]; edges: FlowEdge[] }

export const visualizeTool: Tool = {
  name: 'visualize',
  description: 'Create a deterministic bar chart or flow diagram from structured data. Writes a safe SVG and Markdown companion under .elia/artifacts and returns a bounded terminal preview. Raw HTML, SVG, scripts, and remote content are not accepted.',
  input_schema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['bar', 'flow'], description: 'Visualization type.' },
      title: { type: 'string', description: 'Short visualization title.' },
      slug: { type: 'string', description: 'Optional lowercase filename slug using only letters, numbers, and hyphens.' },
      items: { type: 'array', description: 'For bar charts: 1-30 objects with label and finite numeric value.', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'number' } }, required: ['label', 'value'] } },
      nodes: { type: 'array', description: 'For flows: 1-24 unique nodes with id and label.', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } }, required: ['id', 'label'] } },
      edges: { type: 'array', description: 'For flows: up to 40 edges whose from/to values reference declared node ids.', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string' } }, required: ['from', 'to'] } },
    },
    required: ['type', 'title'],
  },
  async execute(input) {
    const visualization = parseInput(input)
    const cwd = currentAgent().cwd ?? process.cwd()
    const artifactDir = resolveWorkspacePath(join('.elia', 'artifacts'), cwd)
    const svgPath = resolveWorkspacePath(join('.elia', 'artifacts', `${visualization.slug}.svg`), cwd)
    const markdownPath = resolveWorkspacePath(join('.elia', 'artifacts', `${visualization.slug}.md`), cwd)
    ensureSecureDirectory(artifactDir)
    const svg = visualization.type === 'bar' ? renderBarSvg(visualization) : renderFlowSvg(visualization)
    const terminal = visualization.type === 'bar' ? renderBarTerminal(visualization) : renderFlowTerminal(visualization)
    const markdown = renderMarkdown(visualization, terminal)
    if (currentAgent().signal?.aborted) throw new Error('Visualization cancelled before writing — the run was aborted.')
    const outputs = [[svgPath, svg], [markdownPath, markdown]] as const
    for (const [path, content] of outputs) {
      if (existsSync(path) && readFileSync(path, 'utf8') !== content) {
        throw new Error(`Visualization artifact already exists with different content: ${relative(cwd, path).replace(/\\/g, '/')}. Choose a different slug.`)
      }
    }
    for (const [path, content] of outputs) {
      if (existsSync(path)) continue
      await captureBeforeWrite(path)
      writeSecureFile(path, content)
    }
    return [`Created ${visualization.type} visualization \"${terminalText(visualization.title)}\".`, `SVG: ${relative(cwd, svgPath).replace(/\\/g, '/')}`, `Markdown: ${relative(cwd, markdownPath).replace(/\\/g, '/')}`, '', terminal].join('\n')
  },
}

function parseInput(input: Record<string, unknown>): Visualization {
  for (const field of ['html', 'svg', 'script', 'url']) {
    if (field in input) throw new Error(`visualize does not accept raw ${field} content`)
  }
  if (input.type !== 'bar' && input.type !== 'flow') throw new Error('visualize "type" must be "bar" or "flow"')
  const title = boundedText(input.title, 'title', MAX_TITLE)
  const slug = input.slug === undefined ? slugify(terminalText(title)) : boundedText(input.slug, 'slug', 64)
  if (!SAFE_SLUG.test(slug)) throw new Error('visualize "slug" must be 1-64 lowercase letters, numbers, or hyphens and cannot start or end with a hyphen')
  if (input.type === 'bar') {
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > MAX_BAR_ITEMS) throw new Error(`visualize bar "items" must contain 1-${MAX_BAR_ITEMS} entries`)
    const items = input.items.map((item, index) => {
      const record = objectAt(item, `items[${index}]`)
      const label = boundedText(record.label, `items[${index}].label`, MAX_LABEL)
      if (typeof record.value !== 'number' || !Number.isFinite(record.value) || Math.abs(record.value) > MAX_VALUE) throw new Error(`visualize items[${index}].value must be a finite number between -${MAX_VALUE} and ${MAX_VALUE}`)
      return { label, value: record.value }
    })
    return { type: 'bar', title, slug, items }
  }
  if (!Array.isArray(input.nodes) || input.nodes.length < 1 || input.nodes.length > MAX_FLOW_NODES) throw new Error(`visualize flow "nodes" must contain 1-${MAX_FLOW_NODES} entries`)
  const rawEdges = input.edges ?? []
  if (!Array.isArray(rawEdges) || rawEdges.length > MAX_FLOW_EDGES) throw new Error(`visualize flow "edges" must contain 0-${MAX_FLOW_EDGES} entries`)
  const nodes = input.nodes.map((node, index) => {
    const record = objectAt(node, `nodes[${index}]`)
    const id = boundedText(record.id, `nodes[${index}].id`, 32)
    if (!SAFE_ID.test(id)) throw new Error(`visualize nodes[${index}].id contains unsupported characters`)
    return { id, label: boundedText(record.label, `nodes[${index}].label`, MAX_LABEL) }
  })
  const ids = new Set(nodes.map((node) => node.id))
  if (ids.size !== nodes.length) throw new Error('visualize flow node ids must be unique')
  const edges = rawEdges.map((edge, index) => {
    const record = objectAt(edge, `edges[${index}]`)
    const from = boundedText(record.from, `edges[${index}].from`, 32)
    const to = boundedText(record.to, `edges[${index}].to`, 32)
    if (!ids.has(from) || !ids.has(to)) throw new Error(`visualize edges[${index}] must reference declared node ids`)
    const label = record.label === undefined ? undefined : boundedText(record.label, `edges[${index}].label`, 40)
    return { from, to, label }
  })
  return { type: 'flow', title, slug, nodes, edges }
}

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`visualize "${field}" must be a non-empty string`)
  const text = value.trim()
  if (text.length > max) throw new Error(`visualize "${field}" must be at most ${max} characters`)
  return text
}

function objectAt(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`visualize ${field} must be an object`)
  return value as Record<string, unknown>
}

function slugify(title: string): string {
  const slug = terminalText(title).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64).replace(/-$/g, '')
  return slug || 'visualization'
}

function withoutTerminalControls(value: string): string {
  return value
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|.)/g, '')
    .replace(CONTROL, ' ')
}

function xml(value: string): string {
  return withoutTerminalControls(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function terminalText(value: string): string { return withoutTerminalControls(value).replace(/\s+/g, ' ').trim() }
function clipped(value: string, max: number): string { const safe = terminalText(value); return safe.length <= max ? safe : `${safe.slice(0, Math.max(1, max - 1))}…` }
function number(value: number): string { return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, useGrouping: false }).format(value) }

function renderBarSvg(chart: Extract<Visualization, { type: 'bar' }>): string {
  const width = 800, rowHeight = 42, height = 92 + chart.items.length * rowHeight, plotLeft = 210, plotWidth = 540
  const min = Math.min(0, ...chart.items.map((item) => item.value)), max = Math.max(0, ...chart.items.map((item) => item.value)), span = max - min || 1
  const zeroX = plotLeft + ((0 - min) / span) * plotWidth
  const rows = chart.items.map((item, index) => {
    const y = 70 + index * rowHeight, valueX = plotLeft + ((item.value - min) / span) * plotWidth, x = Math.min(zeroX, valueX), barWidth = Math.max(1, Math.abs(valueX - zeroX))
    return `<text x="190" y="${y + 19}" text-anchor="end" class="label">${xml(clipped(item.label, 28))}</text><rect x="${x.toFixed(2)}" y="${y}" width="${barWidth.toFixed(2)}" height="26" rx="4" fill="${item.value < 0 ? '#f97316' : '#38bdf8'}"/><text x="${item.value < 0 ? x - 8 : x + barWidth + 8}" y="${y + 19}" text-anchor="${item.value < 0 ? 'end' : 'start'}" class="value">${xml(number(item.value))}</text>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${xml(chart.title)}"><style>text{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.title{font-size:22px;font-weight:700;fill:#e2e8f0}.label,.value{font-size:14px;fill:#cbd5e1}</style><rect width="100%" height="100%" fill="#0f172a"/><text x="40" y="40" class="title">${xml(chart.title)}</text><line x1="${zeroX.toFixed(2)}" y1="62" x2="${zeroX.toFixed(2)}" y2="${height - 20}" stroke="#64748b"/>${rows}</svg>\n`
}

function renderFlowSvg(flow: Extract<Visualization, { type: 'flow' }>): string {
  const columns = Math.min(3, flow.nodes.length), rows = Math.ceil(flow.nodes.length / columns), width = 800, height = 100 + rows * 150, nodeWidth = 190, nodeHeight = 64
  const positions = new Map(flow.nodes.map((node, index) => [node.id, { x: 55 + (index % columns) * (690 / columns), y: 75 + Math.floor(index / columns) * 150 }]))
  const edges = flow.edges.map((edge) => {
    const from = positions.get(edge.from)!, to = positions.get(edge.to)!, x1 = from.x + nodeWidth / 2, y1 = from.y + nodeHeight / 2, x2 = to.x + nodeWidth / 2, y2 = to.y + nodeHeight / 2
    const label = edge.label ? `<text x="${((x1 + x2) / 2).toFixed(2)}" y="${((y1 + y2) / 2 - 6).toFixed(2)}" text-anchor="middle" class="edge-label">${xml(clipped(edge.label, 24))}</text>` : ''
    return `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="#64748b" stroke-width="2" marker-end="url(#arrow)"/>${label}`
  }).join('')
  const nodes = flow.nodes.map((node) => { const point = positions.get(node.id)!; return `<rect x="${point.x.toFixed(2)}" y="${point.y.toFixed(2)}" width="${nodeWidth}" height="${nodeHeight}" rx="10" fill="#1e293b" stroke="#38bdf8" stroke-width="2"/><text x="${(point.x + nodeWidth / 2).toFixed(2)}" y="${(point.y + 39).toFixed(2)}" text-anchor="middle" class="node">${xml(clipped(node.label, 24))}</text>` }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${xml(flow.title)}"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#64748b"/></marker></defs><style>text{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.title{font-size:22px;font-weight:700;fill:#e2e8f0}.node{font-size:14px;fill:#e2e8f0}.edge-label{font-size:12px;fill:#94a3b8}</style><rect width="100%" height="100%" fill="#0f172a"/><text x="40" y="40" class="title">${xml(flow.title)}</text>${edges}${nodes}</svg>\n`
}

function renderBarTerminal(chart: Extract<Visualization, { type: 'bar' }>): string {
  const maxMagnitude = Math.max(...chart.items.map((item) => Math.abs(item.value)), 1)
  const lines = chart.items.map((item) => { const length = item.value === 0 ? 0 : Math.max(1, Math.round(Math.abs(item.value) / maxMagnitude * 24)); return `${clipped(item.label, 18).padEnd(18)} ${item.value < 0 ? '−' : ' '} ${'█'.repeat(length).padEnd(24)} ${number(item.value)}` })
  return [clipped(chart.title, 72), ...lines].join('\n')
}

function renderFlowTerminal(flow: Extract<Visualization, { type: 'flow' }>): string {
  const labels = new Map(flow.nodes.map((node) => [node.id, clipped(node.label, 18)]))
  const nodes = flow.nodes.map((node) => `• ${clipped(node.label, 36)} [${node.id}]`)
  const edges = flow.edges.map((edge) => `  ${labels.get(edge.from)} → ${labels.get(edge.to)}${edge.label ? ` — ${clipped(edge.label, 20)}` : ''}`)
  return [clipped(flow.title, 72), ...nodes, ...(edges.length ? ['Connections:', ...edges] : [])].join('\n')
}

function markdownText(value: string): string { return terminalText(value).replace(/([\\`*_[\]<>|])/g, '\\$1') }
function renderMarkdown(visualization: Visualization, terminal: string): string {
  const details = visualization.type === 'bar'
    ? ['| Label | Value |', '|---|---:|', ...visualization.items.map((item) => `| ${markdownText(item.label)} | ${number(item.value)} |`)]
    : ['## Nodes', ...visualization.nodes.map((node) => `- **${markdownText(node.id)}:** ${markdownText(node.label)}`), '', '## Connections', ...(visualization.edges.length ? visualization.edges.map((edge) => `- ${markdownText(edge.from)} → ${markdownText(edge.to)}${edge.label ? `: ${markdownText(edge.label)}` : ''}`) : ['- None'])]
  return `# ${markdownText(visualization.title)}\n\n![${markdownText(visualization.title)}](./${visualization.slug}.svg)\n\nType: ${visualization.type}\n\nGenerated deterministically from user-supplied structured data. No remote content or executable markup is included.\n\n${details.join('\n')}\n\n## Terminal fallback\n\n\`\`\`text\n${terminal.replace(/```/g, '` ` `')}\n\`\`\`\n`
}

/** Extract the bounded terminal-native body from a successful visualize result. */
export function visualizationTerminalPreview(result: string): string {
  const separator = result.indexOf('\n\n')
  return separator === -1 ? result : result.slice(separator + 2)
}

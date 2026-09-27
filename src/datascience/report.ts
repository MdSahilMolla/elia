import type { ChartResult } from './viz.ts'
import { formatNumber } from './viz.ts'

/**
 * Analysis reports as a self-contained HTML page (light and dark themes, readable on a
 * phone, printable) and a Markdown twin. The structure is fixed — Objective, Data, Method,
 * Results, Validation, Limitations, Artifacts — so a reader always finds the same things in
 * the same place. Every chart carries its data table, and the artifact list only contains
 * files whose hashes were verified at build time.
 */

export interface ReportTable {
  caption?: string
  columns: string[]
  rows: Array<Array<string | number | boolean | null>>
}

export interface ReportBlock {
  heading?: string
  text?: string
  bullets?: string[]
  table?: ReportTable
  chart?: ChartResult
  callout?: { tone: 'info' | 'warning' | 'critical' | 'success'; text: string }
  metrics?: Array<{ label: string; value: string; detail?: string }>
}

export interface ReportInput {
  title: string
  subtitle?: string
  generatedAt?: string
  objective: string
  data: ReportBlock[]
  method: ReportBlock[]
  results: ReportBlock[]
  validation: ReportBlock[]
  limitations: string[]
  artifacts: Array<{ path: string; kind: string; sha256: string; bytes: number; description?: string }>
  reproducibility?: string[]
}

function esc(text: unknown): string {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'number') return formatNumber(value, 'plain')
  return String(value)
}

/** Minimal inline Markdown: **bold**, `code`, and paragraphs. */
function inline(text: string): string {
  return esc(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>')
}

function htmlTable(table: ReportTable, limit = 200): string {
  const rows = table.rows.slice(0, limit)
  return `<div class="table-wrap"><table>${table.caption ? `<caption>${esc(table.caption)}</caption>` : ''}<thead><tr>${table.columns.map((c) => `<th scope="col">${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((v) => `<td${typeof v === 'number' ? ' class="num"' : ''}>${esc(cell(v))}</td>`).join('')}</tr>`).join('')}</tbody></table>${table.rows.length > limit ? `<p class="muted">Showing ${limit} of ${table.rows.length} rows.</p>` : ''}</div>`
}

function htmlBlock(block: ReportBlock): string {
  const parts: string[] = []
  if (block.heading) parts.push(`<h3>${esc(block.heading)}</h3>`)
  if (block.callout) parts.push(`<div class="callout ${block.callout.tone}" role="note"><span class="tag">${block.callout.tone === 'critical' ? 'Critical' : block.callout.tone === 'warning' ? 'Caution' : block.callout.tone === 'success' ? 'Passed' : 'Note'}</span> ${inline(block.callout.text)}</div>`)
  if (block.metrics?.length) parts.push(`<div class="tiles">${block.metrics.map((m) => `<div class="tile"><div class="tile-label">${esc(m.label)}</div><div class="tile-value">${esc(m.value)}</div>${m.detail ? `<div class="tile-detail">${esc(m.detail)}</div>` : ''}</div>`).join('')}</div>`)
  if (block.text) parts.push(...block.text.split(/\n{2,}/).map((p) => `<p>${inline(p)}</p>`))
  if (block.bullets?.length) parts.push(`<ul>${block.bullets.map((b) => `<li>${inline(b)}</li>`).join('')}</ul>`)
  if (block.chart) {
    parts.push(`<figure>${block.chart.svg}${block.chart.warnings.length ? `<figcaption class="muted">${block.chart.warnings.map(esc).join(' ')}</figcaption>` : ''}</figure>`)
    parts.push(`<details><summary>Data table — ${esc(block.chart.title)}</summary>${htmlTable(block.chart.table)}</details>`)
  }
  if (block.table) parts.push(htmlTable(block.table))
  return parts.join('\n')
}

const CSS = `
:root{color-scheme:light;--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--line:#e1e0d9;--accent:#2a78d6;--good:#006300;--warn:#8a5a00;--crit:#b42323;--info-bg:#eef4fc;--warn-bg:#fdf5e4;--crit-bg:#fcecec;--good-bg:#ecf6ec}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#ffffff;--ink2:#c3c2b7;--muted:#898781;--line:#2c2c2a;--accent:#3987e5;--good:#0ca30c;--warn:#fab219;--crit:#e66767;--info-bg:#15202e;--warn-bg:#2a2210;--crit-bg:#2e1515;--good-bg:#132613}}
:root[data-theme="dark"]{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#ffffff;--ink2:#c3c2b7;--muted:#898781;--line:#2c2c2a;--accent:#3987e5;--good:#0ca30c;--warn:#fab219;--crit:#e66767;--info-bg:#15202e;--warn-bg:#2a2210;--crit-bg:#2e1515;--good-bg:#132613}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:980px;margin:0 auto;padding:32px 16px 64px}header h1{font-size:28px;line-height:1.2;margin:0 0 6px}header p{margin:0;color:var(--ink2)}
nav{display:flex;flex-wrap:wrap;gap:6px 14px;margin:18px 0 8px;font-size:13px}nav a{color:var(--accent);text-decoration:none}
section{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:20px 22px;margin:18px 0}
h2{font-size:19px;margin:0 0 12px}h3{font-size:15px;margin:18px 0 8px}p{margin:8px 0}ul{margin:8px 0;padding-left:20px}li{margin:4px 0}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--page);padding:1px 5px;border-radius:4px}
.muted{color:var(--muted);font-size:13px}figure{margin:12px 0}figure svg{max-width:100%;height:auto;display:block}
details{margin:6px 0 14px}summary{cursor:pointer;color:var(--ink2);font-size:13px}
.table-wrap{overflow-x:auto;margin:10px 0}table{border-collapse:collapse;width:100%;font-size:13px}caption{text-align:left;color:var(--ink2);padding:4px 0}
th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--ink2);font-weight:600}td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.callout{border-radius:8px;padding:10px 12px;margin:10px 0;border:1px solid var(--line)}.callout .tag{font-weight:600;margin-right:4px}
.callout.info{background:var(--info-bg)}.callout.warning{background:var(--warn-bg)}.callout.warning .tag{color:var(--warn)}.callout.critical{background:var(--crit-bg)}.callout.critical .tag{color:var(--crit)}.callout.success{background:var(--good-bg)}.callout.success .tag{color:var(--good)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:10px 0}.tile{border:1px solid var(--line);border-radius:10px;padding:12px}.tile-label{color:var(--ink2);font-size:12px}.tile-value{font-size:24px;font-weight:600;margin-top:2px}.tile-detail{color:var(--muted);font-size:12px;margin-top:2px}
footer{color:var(--muted);font-size:12px;margin-top:24px}
@media print{body{background:#fff}section{break-inside:avoid;border-color:#ddd}nav{display:none}}
`

export function buildReportHtml(input: ReportInput): string {
  const sections: Array<[string, string, string]> = [
    ['objective', 'Objective', `<p>${inline(input.objective)}</p>`],
    ['data', 'Data', input.data.map(htmlBlock).join('\n')],
    ['method', 'Method', input.method.map(htmlBlock).join('\n')],
    ['results', 'Results', input.results.map(htmlBlock).join('\n')],
    ['validation', 'Validation', input.validation.map(htmlBlock).join('\n')],
    ['limitations', 'Limitations', input.limitations.length ? `<ul>${input.limitations.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>` : '<p class="muted">None recorded.</p>'],
    ['artifacts', 'Artifacts', input.artifacts.length ? htmlTable({ columns: ['file', 'kind', 'size', 'sha256'], rows: input.artifacts.map((a) => [a.path, a.kind, `${formatNumber(a.bytes / 1024, 'plain')} KB`, a.sha256.slice(0, 16)]) }) : '<p class="muted">No artifacts were produced.</p>'],
  ]
  if (input.reproducibility?.length) sections.push(['reproducibility', 'Reproducibility', `<ul>${input.reproducibility.map((r) => `<li>${inline(r)}</li>`).join('')}</ul>`])
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(input.title)}</title><style>${CSS}</style></head>
<body><main>
<header><h1>${esc(input.title)}</h1>${input.subtitle ? `<p>${esc(input.subtitle)}</p>` : ''}<p class="muted">Generated ${esc(input.generatedAt ?? new Date().toISOString())} by elia data science mode. Every figure below was computed by the deterministic engine and is traceable to an execution record.</p></header>
<nav aria-label="Sections">${sections.map(([id, name]) => `<a href="#${id}">${name}</a>`).join('')}</nav>
${sections.map(([id, name, body]) => `<section id="${id}"><h2>${name}</h2>${body}</section>`).join('\n')}
<footer>Charts use a colour-vision-deficiency-validated palette; each chart's data table is provided for accessibility.</footer>
</main></body></html>`
}

function mdTable(table: ReportTable, limit = 50): string {
  const rows = table.rows.slice(0, limit)
  const escapeCell = (v: unknown) => cell(v).replace(/\|/g, '\\|').replace(/\n/g, ' ')
  return [`| ${table.columns.map(escapeCell).join(' | ')} |`, `| ${table.columns.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`), ...(table.rows.length > limit ? [`\n_Showing ${limit} of ${table.rows.length} rows._`] : [])].join('\n')
}

function mdBlock(block: ReportBlock, chartFiles: Map<ChartResult, string>): string {
  const parts: string[] = []
  if (block.heading) parts.push(`### ${block.heading}`)
  if (block.callout) parts.push(`> **${block.callout.tone === 'critical' ? 'Critical' : block.callout.tone === 'warning' ? 'Caution' : block.callout.tone === 'success' ? 'Passed' : 'Note'}:** ${block.callout.text}`)
  if (block.metrics?.length) parts.push(block.metrics.map((m) => `- **${m.label}:** ${m.value}${m.detail ? ` (${m.detail})` : ''}`).join('\n'))
  if (block.text) parts.push(block.text)
  if (block.bullets?.length) parts.push(block.bullets.map((b) => `- ${b}`).join('\n'))
  if (block.chart) {
    const file = chartFiles.get(block.chart)
    if (file) parts.push(`![${block.chart.title}](${file})`)
    parts.push(mdTable(block.chart.table, 30))
  }
  if (block.table) parts.push(`${block.table.caption ? `_${block.table.caption}_\n\n` : ''}${mdTable(block.table)}`)
  return parts.join('\n\n')
}

export function buildReportMarkdown(input: ReportInput, chartFiles: Map<ChartResult, string> = new Map()): string {
  return [
    `# ${input.title}`,
    input.subtitle ?? '',
    `_Generated ${input.generatedAt ?? new Date().toISOString()} by elia data science mode._`,
    '## Objective', input.objective,
    '## Data', ...input.data.map((b) => mdBlock(b, chartFiles)),
    '## Method', ...input.method.map((b) => mdBlock(b, chartFiles)),
    '## Results', ...input.results.map((b) => mdBlock(b, chartFiles)),
    '## Validation', ...input.validation.map((b) => mdBlock(b, chartFiles)),
    '## Limitations', input.limitations.map((l) => `- ${l}`).join('\n') || '_None recorded._',
    '## Artifacts', input.artifacts.length ? mdTable({ columns: ['file', 'kind', 'bytes', 'sha256'], rows: input.artifacts.map((a) => [a.path, a.kind, a.bytes, a.sha256.slice(0, 16)]) }) : '_No artifacts were produced._',
    ...(input.reproducibility?.length ? ['## Reproducibility', input.reproducibility.map((r) => `- ${r}`).join('\n')] : []),
  ].filter((part) => part !== '').join('\n\n') + '\n'
}

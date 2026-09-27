import { expect, test } from 'bun:test'
import { barChart, CHART_TYPES, formatNumber, heatmapChart, lineChart, niceTicks, recommendChart, scatterChart } from './viz.ts'
import { buildReportHtml, buildReportMarkdown } from './report.ts'

test('axis ticks always cover the data', () => {
  for (const [min, max] of [[0, 109], [-3.2, 7.9], [0.001, 0.009], [1000, 1000], [-50, -10]] as Array<[number, number]>) {
    const ticks = niceTicks(min, max)
    expect(ticks[0]!).toBeLessThanOrEqual(min)
    expect(ticks.at(-1)!).toBeGreaterThanOrEqual(max)
  }
})

test('bars start at zero, series beyond the palette fold into Other, and every chart has a table', () => {
  const chart = barChart({ title: 'x', categories: ['a', 'b'], series: Array.from({ length: 10 }, (_, i) => ({ name: `s${i}`, values: [i + 1, i + 2] })) })
  expect(chart.warnings[0]).toContain('folded into "Other"')
  expect(chart.table.columns.at(-1)).toBe('Other')
  expect(chart.svg).toContain('>0<')
  expect(chart.svg.startsWith('<svg')).toBe(true)
  expect(chart.svg).toContain('prefers-color-scheme: dark')
})

test('scatter caps colour groups at three and lines draw interval bands', () => {
  const scatter = scatterChart({ title: 's', points: Array.from({ length: 40 }, (_, i) => ({ x: i, y: i * 2, group: `g${i % 6}` })) })
  expect(scatter.warnings[0]).toContain('"Other"')
  const line = lineChart({ title: 'l', x: [1, 2, 3], series: [{ name: 'y', values: [1, 2, 3] }], band: { lower: [0.5, 1.5, 2.5], upper: [1.5, 2.5, 3.5], label: '90% interval' } })
  expect(line.svg).toContain('<polygon')
  expect(line.table.columns).toEqual(['x', 'y', 'lower', 'upper'])
})

test('heatmap cells carry hover titles and chart recommendation follows the data roles', () => {
  const heat = heatmapChart({ title: 'h', xLabels: ['a', 'b'], yLabels: ['c'], values: [[0.5, -0.5]], diverging: true })
  expect(heat.svg).toContain('<title>c × a: 0.50</title>')
  expect(heat.svg).toContain('fill="#e34948"><title>c × b: -0.50</title>')
  expect(recommendChart({ xType: 'time', yCount: 1 }).type).toBe('line')
  expect(recommendChart({ xType: 'category', yCount: 1, purpose: 'revenue bridge' }).type).toBe('waterfall')
  expect(CHART_TYPES).toContain('treemap')
  expect(formatNumber(1_234_567)).toBe('1.2M')
  expect(formatNumber(0.125, 'percent')).toBe('13%')
})

test('reports have the fixed section order in HTML and Markdown and escape content', () => {
  const chart = barChart({ title: 'Revenue', categories: ['a'], series: [{ name: 'v', values: [1] }] })
  const input = { title: 'Report <x>', objective: 'Why did **revenue** fall?', data: [{ text: 'orders@1' }], method: [{ bullets: ['OLS'] }], results: [{ chart }], validation: [{ callout: { tone: 'success' as const, text: 'checks passed' } }], limitations: ['small sample'], artifacts: [{ path: 'a.csv', kind: 'dataset', sha256: 'f'.repeat(64), bytes: 2048 }] }
  const html = buildReportHtml(input)
  const order = ['id="objective"', 'id="data"', 'id="method"', 'id="results"', 'id="validation"', 'id="limitations"', 'id="artifacts"'].map((marker) => html.indexOf(marker))
  expect(order).toEqual([...order].sort((a, b) => a - b))
  expect(html).toContain('Report &lt;x&gt;')
  expect(html).toContain('<strong>revenue</strong>')
  expect(html).toContain('Data table — Revenue')
  const md = buildReportMarkdown(input)
  expect(md.indexOf('## Objective')).toBeLessThan(md.indexOf('## Artifacts'))
})

import pptxgen from 'pptxgenjs'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { paths } from '../config.ts'
import { analyzeWorkbook, auditWorkbook, readWorkbook, safeOutputPath } from './spreadsheet.ts'
import type { Tool } from './types.ts'

type PresentationAction = 'from_workbook' | 'verify'

interface PresentationRequest {
  action: PresentationAction
  path: string
  outputPath?: string
  sheet?: string
  groupBy?: string
  measure?: string
  keyColumn?: string
  title?: string
  subtitle?: string
  render?: boolean
}

type AnalysisSheet = {
  sheet: string
  rows: number
  columns: string[]
  numericColumns: string[]
  selectedMeasure?: string
  selectedGroupBy?: string
  summary?: { column: string; count: number; sum: number; average: number; min: number; max: number }
  groups: Array<{ group: string; count: number; sum: number }>
  formulaCells: number
}

type AnalysisResult = { action: string; sheets: AnalysisSheet[] }
type AuditResult = { action: string; sheets: Array<{ sheet: string; rows: number; columns: number; formulaCells: number; duplicateKeys?: number; status: string }> }

const NAVY = '121F34'
const BLUE = '2E70BC'
const TEAL = '269B91'
const ORANGE = 'EB8F34'
const RED = 'BE4545'
const LIGHT = 'EFF4F8'
const MID = '667484'
const WHITE = 'FFFFFF'
const FONT = 'Aptos'
const SHAPE_LINE = 'line' as any
const SHAPE_ROUND_RECT = 'roundRect' as any
const MAX_GROUPS = 12

function money(value: number): string {
  const sign = value < 0 ? '-' : ''
  const absolute = Math.abs(value)
  if (absolute >= 1_000_000) return `${sign}$${(absolute / 1_000_000).toFixed(2)}M`
  if (absolute >= 1_000) return `${sign}$${(absolute / 1_000).toFixed(1)}K`
  return `${sign}$${absolute.toFixed(0)}`
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
}

function atomicText(path: string, text: string): void {
  ensureParent(path)
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, text)
  renameSync(temp, path)
}

function addTitle(slide: pptxgen.Slide, title: string, subtitle: string): void {
  slide.addText(title, { x: 0.55, y: 0.28, w: 12.2, h: 0.45, fontFace: FONT, fontSize: 25, bold: true, color: NAVY, margin: 0, fit: 'shrink' })
  slide.addText(subtitle, { x: 0.58, y: 0.82, w: 12, h: 0.25, fontFace: FONT, fontSize: 10, color: MID, margin: 0, fit: 'shrink' })
  slide.addShape(SHAPE_LINE, { x: 0.55, y: 1.22, w: 12.2, h: 0, line: { color: BLUE, width: 1.5 } })
}

function addFooter(slide: pptxgen.Slide, number: number): void {
  slide.addText(`Elia management presentation  •  ${number}`, { x: 0.58, y: 7.1, w: 12, h: 0.15, fontFace: FONT, fontSize: 7, color: MID, margin: 0, fit: 'shrink' })
}

function addKpi(slide: pptxgen.Slide, x: number, label: string, value: string, detail: string, color: string): void {
  slide.addShape(SHAPE_ROUND_RECT, { x, y: 1.55, w: 3.85, h: 1.25, rectRadius: 0.08, fill: { color: LIGHT }, line: { color, width: 1.2 } })
  slide.addText(label.toUpperCase(), { x: x + 0.18, y: 1.72, w: 3.4, h: 0.18, fontFace: FONT, fontSize: 8, bold: true, color: MID, margin: 0, fit: 'shrink' })
  slide.addText(value, { x: x + 0.18, y: 1.98, w: 3.4, h: 0.4, fontFace: FONT, fontSize: 23, bold: true, color, margin: 0, fit: 'shrink' })
  slide.addText(detail, { x: x + 0.18, y: 2.48, w: 3.4, h: 0.18, fontFace: FONT, fontSize: 8, color: MID, margin: 0, fit: 'shrink' })
}

function addTable(slide: pptxgen.Slide, headers: string[], rows: string[][], x: number, y: number, w: number, h: number): void {
  const data = [headers.map((text) => ({ text, options: { bold: true, color: WHITE, fill: NAVY } })), ...rows.map((row) => row.map((text) => ({ text, options: { color: NAVY } })))]
  slide.addTable(data as any, {
    x, y, w, h,
    fontFace: FONT,
    fontSize: 9,
    color: NAVY,
    border: { type: 'solid', color: 'D6DEE7', pt: 0.5 },
    fill: WHITE,
    margin: 0.06,
    rowH: h / Math.max(data.length, 1),
    autoFit: false,
  } as any)
}

async function makeDeck(analysis: AnalysisResult, audit: AuditResult, request: PresentationRequest, outputPath: string): Promise<void> {
  const pptx = new pptxgen()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = 'Elia'
  pptx.subject = 'Management presentation generated from verified workbook analysis'
  pptx.title = request.title ?? 'Management Review'
  pptx.company = 'Elia'
  const sheet = analysis.sheets[0]
  if (!sheet) throw new Error('workbook has no analyzable sheets')
  const title = request.title ?? `${sheet.selectedMeasure ?? 'Workbook'} Management Review`
  const subtitle = request.subtitle ?? `Generated from ${basename(request.path)} with verified workbook analysis`
  const groups = sheet.groups.slice(0, MAX_GROUPS)
  const total = sheet.summary?.sum ?? 0
  const average = sheet.summary?.average ?? 0
  const top = groups[0]
  const low = [...groups].sort((a, b) => a.sum - b.sum)[0]
  const auditSheet = audit.sheets.find((item) => item.sheet === sheet.sheet)

  let slide = pptx.addSlide(); slide.background = { color: WHITE }
  slide.addText(title, { x: 0.72, y: 1.1, w: 11.9, h: 0.75, fontFace: FONT, fontSize: 34, bold: true, color: NAVY, align: 'center', margin: 0, fit: 'shrink' })
  slide.addText(subtitle, { x: 0.8, y: 2.0, w: 11.7, h: 0.35, fontFace: FONT, fontSize: 15, color: MID, align: 'center', margin: 0, fit: 'shrink' })
  slide.addText(`Sheet: ${sheet.sheet}  •  ${sheet.rows.toLocaleString()} data rows  •  Generated by Elia`, { x: 0.8, y: 2.72, w: 11.7, h: 0.25, fontFace: FONT, fontSize: 10, color: BLUE, bold: true, align: 'center', margin: 0, fit: 'shrink' })
  addFooter(slide, 1)

  slide = pptx.addSlide(); slide.background = { color: WHITE }
  addTitle(slide, 'Executive summary', `The workbook’s ${sheet.selectedMeasure ?? 'measure'} is summarized into a decision-ready view.`)
  addKpi(slide, 0.6, sheet.selectedMeasure ?? 'Measure', money(total), `${sheet.summary?.count.toLocaleString() ?? 0} numeric records`, BLUE)
  addKpi(slide, 4.75, 'Average', money(average), 'average per numeric record', TEAL)
  addKpi(slide, 8.9, 'Top group', top?.group ?? 'n/a', top ? money(top.sum) : 'n/a', ORANGE)
  const takeaway = top && low
    ? `${top.group} is the largest contributor at ${money(top.sum)}, while ${low.group} is the smallest at ${money(low.sum)}. Use the grouped view to focus management attention where scale and outcome diverge.`
    : 'The workbook has been summarized, but no categorical grouping was available for a comparative management view.'
  slide.addText(`Management takeaway:\n${takeaway}`, { x: 0.8, y: 3.5, w: 11.5, h: 1.35, fontFace: FONT, fontSize: 17, bold: true, color: NAVY, margin: 0.04, breakLine: false, fit: 'shrink', valign: 'mid' } as any)
  slide.addText(`Audit status: ${auditSheet?.status ?? 'review'}  •  Formula cells: ${auditSheet?.formulaCells ?? 0}  •  Duplicate keys: ${auditSheet?.duplicateKeys ?? 'not checked'}`, { x: 0.8, y: 5.55, w: 11.5, h: 0.25, fontFace: FONT, fontSize: 10, color: MID, margin: 0, fit: 'shrink' })
  addFooter(slide, 2)

  slide = pptx.addSlide(); slide.background = { color: WHITE }
  addTitle(slide, 'Grouped performance', `${sheet.selectedGroupBy ?? 'Group'} comparison for ${sheet.selectedMeasure ?? 'measure'}.`)
  if (groups.length > 0) {
    slide.addChart(pptx.ChartType.bar, [{ name: sheet.selectedMeasure ?? 'Measure', labels: groups.map((item) => item.group), values: groups.map((item) => item.sum) }], {
      x: 0.7, y: 1.55, w: 7.3, h: 4.6, catAxisLabelFontFace: FONT, valAxisLabelFontFace: FONT, chartColors: [BLUE], showLegend: false, showTitle: false, showValue: false, valAxisMinVal: 0, showCatName: false,
    } as any)
    const rows = groups.slice(0, 8).map((item) => [item.group, item.count.toLocaleString(), money(item.sum)])
    addTable(slide, [sheet.selectedGroupBy ?? 'Group', 'Records', sheet.selectedMeasure ?? 'Measure'], rows, 8.25, 1.7, 4.35, 3.9)
  } else {
    slide.addText('No categorical grouping was available. Use the spreadsheet analyze action with an explicit groupBy column for a comparative view.', { x: 1, y: 2.8, w: 11, h: 0.8, fontFace: FONT, fontSize: 18, color: MID, align: 'center', margin: 0, fit: 'shrink' })
  }
  addFooter(slide, 3)

  slide = pptx.addSlide(); slide.background = { color: WHITE }
  addTitle(slide, 'Data quality and formula audit', 'The deck reports what was checked rather than implying that the source workbook is perfect.')
  const auditRows = audit.sheets.map((item) => [item.sheet, item.rows.toLocaleString(), item.formulaCells.toString(), item.duplicateKeys === undefined ? 'not checked' : item.duplicateKeys.toString(), item.status])
  addTable(slide, ['Sheet', 'Rows', 'Formula cells', 'Duplicate keys', 'Status'], auditRows, 0.75, 1.7, 11.8, Math.min(3.5, 0.45 + auditRows.length * 0.45))
  slide.addText('Recommended operator checks', { x: 0.85, y: 5.15, w: 4.0, h: 0.3, fontFace: FONT, fontSize: 16, bold: true, color: NAVY, margin: 0, fit: 'shrink' })
  slide.addText('• Reconcile key totals to the source system\n• Review duplicate-key and blank-value findings\n• Inspect formula cells before publishing decisions\n• Keep the source workbook unchanged and use a generated output copy', { x: 0.85, y: 5.55, w: 11.2, h: 0.95, fontFace: FONT, fontSize: 13, color: NAVY, margin: 0.02, fit: 'shrink' } as any)
  addFooter(slide, 4)

  slide = pptx.addSlide(); slide.background = { color: WHITE }
  addTitle(slide, 'Recommended management actions', 'Convert verified workbook findings into accountable next steps.')
  const actionRows = [
    ['1', `Investigate ${low?.group ?? 'lowest-performing group'}`, 'Business owner', 'Next review'],
    ['2', `Replicate practices from ${top?.group ?? 'top-performing group'}`, 'Operations', '30 days'],
    ['3', 'Review measure definitions and source reconciliation', 'Finance / data', '2 weeks'],
    ['4', 'Repeat this analysis on the next reporting period', 'Analyst', 'Next period'],
  ]
  addTable(slide, ['#', 'Action', 'Owner', 'Timing'], actionRows, 0.75, 1.75, 11.8, 2.4)
  slide.addText('Decision requested: approve the focused diagnostic and assign owners before the next operating review.', { x: 0.85, y: 5.05, w: 11.4, h: 0.75, fontFace: FONT, fontSize: 17, bold: true, color: BLUE, margin: 0.02, fit: 'shrink' } as any)
  addFooter(slide, 5)

  await pptx.writeFile({ fileName: outputPath })
}

function parseAnalysis(text: string): AnalysisResult {
  const result = JSON.parse(text) as AnalysisResult
  if (!result.sheets || result.sheets.length === 0) throw new Error('workbook has no analyzable sheets')
  return result
}

async function verifyPresentation(path: string, render: boolean): Promise<string> {
  if (!existsSync(path)) throw new Error(`Presentation not found: ${path}`)
  const process = Bun.spawn(['unzip', '-Z1', path], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout as ReadableStream<Uint8Array>).text(),
    new Response(process.stderr as ReadableStream<Uint8Array>).text(),
    process.exited,
  ])
  if (exitCode !== 0) throw new Error(`could not inspect PPTX package: ${stderr.trim() || `unzip exited with ${exitCode}`}`)
  const entries = stdout.split(/\r?\n/).filter(Boolean)
  const slideEntries = entries.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry))
  const validPackage = entries.includes('ppt/presentation.xml') && entries.includes('[Content_Types].xml') && slideEntries.length > 0
  let rendered = false
  let renderPath: string | undefined
  if (render && Bun.which('libreoffice')) {
    const tempDir = mkdtempSync(resolve(paths.workspace, '.presentation-verify-'))
    try {
      const conversion = Bun.spawn(['libreoffice', '--headless', '--convert-to', 'pdf', '--outdir', tempDir, path], { stdout: 'pipe', stderr: 'pipe' })
      const [, conversionStderr, conversionExit] = await Promise.all([
        new Response(conversion.stdout as ReadableStream<Uint8Array>).text(),
        new Response(conversion.stderr as ReadableStream<Uint8Array>).text(),
        conversion.exited,
      ])
      if (conversionExit === 0) {
        rendered = true
        renderPath = join(tempDir, `${basename(path, extname(path))}.pdf`)
      } else if (conversionStderr.trim()) {
        renderPath = `render unavailable: ${conversionStderr.trim().slice(0, 300)}`
      }
    } finally {
      if (!rendered) rmSync(tempDir, { recursive: true, force: true })
    }
  }
  return JSON.stringify({ action: 'verify', path, validPackage, slides: slideEntries.length, rendered, renderPath, status: validPackage ? 'pass' : 'review' }, null, 2)
}

export function validatePresentationRequest(input: Record<string, unknown>): PresentationRequest {
  if (input.action !== 'from_workbook' && input.action !== 'verify') throw new Error('action must be from_workbook or verify')
  if (typeof input.path !== 'string' || input.path.length === 0) throw new Error('path is required')
  if (input.outputPath !== undefined && typeof input.outputPath !== 'string') throw new Error('outputPath must be a string')
  if (input.render !== undefined && typeof input.render !== 'boolean') throw new Error('render must be a boolean')
  for (const key of ['sheet', 'groupBy', 'measure', 'keyColumn', 'title', 'subtitle']) if (input[key] !== undefined && typeof input[key] !== 'string') throw new Error(`${key} must be a string`)
  return { action: input.action as PresentationAction, path: input.path, outputPath: input.outputPath as string | undefined, sheet: input.sheet as string | undefined, groupBy: input.groupBy as string | undefined, measure: input.measure as string | undefined, keyColumn: input.keyColumn as string | undefined, title: input.title as string | undefined, subtitle: input.subtitle as string | undefined, render: input.render as boolean | undefined }
}

export const presentationTool: Tool = {
  name: 'presentation',
  description: 'Create an editable management presentation from a verified local Excel workbook. Elia analyzes the workbook, audits data quality and formulas, builds a concise KPI/chart/table/action deck, writes a PPTX plus a JSON sidecar, and reports the exact output paths. Rendering or final visual review should follow before consequential delivery.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['from_workbook', 'verify'] },
      path: { type: 'string', description: 'Input .xlsx/.xls workbook path' },
      outputPath: { type: 'string', description: 'Output .pptx path inside the current workspace' },
      sheet: { type: 'string', description: 'Optional source sheet' },
      groupBy: { type: 'string', description: 'Optional categorical grouping column' },
      measure: { type: 'string', description: 'Optional numeric measure column' },
      keyColumn: { type: 'string', description: 'Optional duplicate-detection key column for the audit slide' },
      title: { type: 'string', description: 'Optional presentation title' },
      subtitle: { type: 'string', description: 'Optional presentation subtitle' },
      render: { type: 'boolean', description: 'For verify: optionally render to PDF with LibreOffice when installed' },
    },
    required: ['action', 'path'],
  },
  async execute(input) {
    const request = validatePresentationRequest(input)
    if (request.action === 'verify') return verifyPresentation(request.path, request.render ?? false)
    const workbook = readWorkbook(request.path)
    const analysis = parseAnalysis(analyzeWorkbook(workbook, request.sheet, request.groupBy, request.measure))
    const audit = JSON.parse(auditWorkbook(workbook, request.sheet, request.keyColumn)) as AuditResult
    const defaultName = `${basename(request.path, extname(request.path))}-management-review.pptx`
    const outputPath = safeOutputPath(request.outputPath, join(paths.workspace, defaultName))
    ensureParent(outputPath)
    await makeDeck(analysis, audit, request, outputPath)
    const packageVerification = JSON.parse(await verifyPresentation(outputPath, false)) as { validPackage: boolean; slides: number }
    if (!packageVerification.validPackage) throw new Error(`generated presentation failed package verification: ${outputPath}`)
    const analysisPath = `${outputPath}.analysis.json`
    atomicText(analysisPath, JSON.stringify({ source: request.path, analysis, audit, packageVerification }, null, 2))
    return JSON.stringify({ action: request.action, outputPath, analysisPath, slides: packageVerification.slides, verified: true, sourceSheet: analysis.sheets[0]?.sheet, status: 'created' }, null, 2)
  },
}

export { makeDeck }

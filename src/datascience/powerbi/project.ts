import { createHash } from 'node:crypto'
import type { Frame } from '../frame.ts'
import { isMissing, scalarKey, toDateMs, toNumber, type ColumnType, type Scalar } from '../values.ts'
import { BASE_THEME, BASE_THEME_NAME } from './baseTheme.ts'

/**
 * Power BI project (PBIP) generation. Microsoft does not support producing a .pbix
 * programmatically — PBIX ↔ PBIP conversion is only possible through Power BI Desktop's
 * "Save as" — so the deliverable is a PBIP folder: a semantic model in TMDL and a report
 * in the PBIR format, both documented, text-based formats that Power BI Desktop opens
 * directly (File › Open › the .pbip) and that Fabric Git integration and REST APIs deploy.
 *
 * File shapes follow Microsoft's published JSON schemas (developer.microsoft.com/
 * json-schemas/fabric/…) and documentation. The generator validates every cross-reference
 * it creates — visual bindings to model fields, DAX references, relationships against the
 * data — but it cannot run Power BI Desktop here; that last check is left to the user and
 * said so in the project README.
 */

const SCHEMA = {
  pbip: 'https://developer.microsoft.com/json-schemas/fabric/pbip/pbipProperties/1.0.0/schema.json',
  pbism: 'https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json',
  pbir: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json',
  version: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/versionMetadata/1.0.0/schema.json',
  report: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/report/3.3.0/schema.json',
  pages: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/pagesMetadata/1.1.0/schema.json',
  page: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/page/2.1.0/schema.json',
  visual: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.9.0/schema.json',
  platform: 'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json',
}
const THEME_VERSIONS = { visual: '2.9.0', report: '3.3.0', page: '2.1.0' }

export interface ModelTable {
  name: string
  frame: Frame
  role: 'fact' | 'dimension'
  description?: string
  /** Semantic types from the understanding step, used for formats, summarisation and data categories. */
  semantic?: Record<string, string>
  hidden?: string[]
}

export interface ModelRelationship { fromTable: string; fromColumn: string; toTable: string; toColumn: string }
export interface ModelMeasure { table: string; name: string; expression: string; formatString?: string; description?: string; displayFolder?: string }
export type VisualKind = 'kpis' | 'line' | 'column' | 'bar' | 'table' | 'matrix' | 'slicer' | 'scatter' | 'funnel' | 'waterfall' | 'treemap' | 'area'

export interface VisualSpec {
  kind: VisualKind
  title?: string
  measures?: string[]
  category?: string
  series?: string
  rows?: string[]
  columns?: string[]
}

export interface PageSpec { name: string; visuals: VisualSpec[] }

export interface PowerBiRequest {
  name: string
  tables: ModelTable[]
  relationships: ModelRelationship[]
  measures?: ModelMeasure[]
  dateTable?: { columns: Array<{ table: string; column: string }> } | false
  pages?: PageSpec[]
  audience?: string
  /** Absolute folder the CSVs will live in; becomes the DataFolder parameter's default. */
  dataFolder: string
}

export interface ProjectFile { path: string; content: string }

export interface PowerBiResult {
  files: ProjectFile[]
  csv: Array<{ table: string; path: string; rows: number }>
  measures: ModelMeasure[]
  relationships: Array<ModelRelationship & { orphanRows: number; unique: boolean }>
  pages: PageSpec[]
  checks: Array<{ name: string; status: 'pass' | 'warn' | 'fail'; detail: string }>
  limitations: string[]
}

// ---------------------------------------------------------------- naming and ids

/** TMDL object names need single quotes unless they are plain identifiers; embedded quotes are doubled. */
export function tmdlName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`
}

/** DAX table reference: always quoted, which is valid for every name. */
export function daxTable(name: string): string {
  return `'${name.replace(/'/g, "''")}'`
}

export function daxColumn(table: string, column: string): string {
  return `${daxTable(table)}[${column.replace(/]/g, ']]')}]`
}

/** Deterministic GUID-shaped lineage tags so regenerating the same model yields the same files. */
function guid(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

function hexId(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 20)
}

const TAB = '\t'

// ---------------------------------------------------------------- columns

interface ColumnModel { name: string; dataType: string; formatString?: string; summarizeBy: string; dataCategory?: string; isKey?: boolean; hidden?: boolean; mType: string }

function columnModel(table: ModelTable, name: string, keys: Set<string>): ColumnModel {
  const type: ColumnType = table.frame.types[name] ?? 'string'
  const semantic = table.semantic?.[name] ?? ''
  const isKey = keys.has(`${table.name}.${name}`)
  const lower = name.toLowerCase()
  const categories: Record<string, string> = { country: 'Country', region: 'StateOrProvince', city: 'City', postal_code: 'PostalCode', latitude: 'Latitude', longitude: 'Longitude', address: 'Address', url: 'WebUrl' }
  const base: ColumnModel = { name, dataType: 'string', summarizeBy: 'none', mType: 'type text', ...(categories[semantic] ? { dataCategory: categories[semantic] } : {}), ...(table.hidden?.includes(name) ? { hidden: true } : {}) }
  switch (type) {
    case 'integer': return { ...base, dataType: 'int64', mType: 'Int64.Type', formatString: semantic === 'year' ? '0' : '#,0', summarizeBy: isKey || semantic === 'identifier' || semantic === 'year' || table.role === 'dimension' ? 'none' : 'sum' }
    case 'number': return { ...base, dataType: 'double', mType: 'type number', formatString: semantic === 'currency_amount' ? '#,0.00' : semantic === 'percentage' ? (lower.includes('pct') || lower.includes('percent') ? '0.0' : '0.0%') : '#,0.00', summarizeBy: table.role === 'fact' && !['latitude', 'longitude', 'percentage'].includes(semantic) ? 'sum' : 'none' }
    case 'boolean': return { ...base, dataType: 'boolean', mType: 'type logical', formatString: '"TRUE";"TRUE";"FALSE"' }
    case 'date': return { ...base, dataType: 'dateTime', mType: 'type date', formatString: 'yyyy-mm-dd' }
    case 'datetime': return { ...base, dataType: 'dateTime', mType: 'type datetime', formatString: 'yyyy-mm-dd hh:nn:ss' }
    default: return base
  }
}

function csvValue(value: Scalar | undefined): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function frameToCsv(frame: Frame): string {
  return [frame.columns.map(csvValue).join(','), ...frame.rows.map((row) => frame.columns.map((name) => csvValue(row[name])).join(','))].join('\r\n') + '\r\n'
}

function mString(text: string): string {
  return `"${text.replace(/"/g, '""')}"`
}

// ---------------------------------------------------------------- measures and DAX checks

const DAX_FUNCTIONS = new Set('ABS ADDCOLUMNS ALL ALLEXCEPT ALLSELECTED AND AVERAGE AVERAGEX BLANK CALCULATE CALCULATETABLE CALENDAR CALENDARAUTO COALESCE CONCATENATEX COUNT COUNTA COUNTBLANK COUNTROWS COUNTX DATE DATEADD DATESBETWEEN DATESMTD DATESQTD DATESYTD DAY DISTINCT DISTINCTCOUNT DIVIDE EDATE EOMONTH FILTER FIRSTDATE FORMAT HASONEVALUE IF IFERROR ISBLANK ISFILTERED KEEPFILTERS LASTDATE MAX MAXX MEDIAN MIN MINX MONTH NOT OR PARALLELPERIOD PERCENTILE.INC PREVIOUSMONTH PREVIOUSYEAR QUARTER RANKX RELATED RELATEDTABLE REMOVEFILTERS ROUND SAMEPERIODLASTYEAR SELECTEDVALUE SUM SUMMARIZE SUMX SWITCH TODAY TOPN TOTALMTD TOTALQTD TOTALYTD TRUE FALSE USERELATIONSHIP VALUES WEEKDAY WEEKNUM YEAR DATEDIFF STDEV.S VAR.S'.split(' '))

export function checkDax(expression: string, model: { tables: Map<string, Set<string>>; measures: Set<string> }): string[] {
  const problems: string[] = []
  let depth = 0
  let inString = false
  for (const character of expression) {
    if (character === '"') inString = !inString
    if (inString) continue
    if (character === '(') depth++
    if (character === ')') depth--
    if (depth < 0) { problems.push('unbalanced parentheses'); break }
  }
  if (depth > 0) problems.push('unbalanced parentheses')
  const withoutStrings = expression.replace(/"(?:[^"]|"")*"/g, '""')
  for (const match of withoutStrings.matchAll(/(?:'((?:[^']|'')+)'|\b([A-Za-z_][A-Za-z0-9_]*))\[((?:[^\]]|\]\])+)\]/g)) {
    const table = (match[1] ?? match[2]!).replace(/''/g, "'")
    const column = match[3]!.replace(/]]/g, ']')
    if (!model.tables.has(table)) problems.push(`unknown table ${table}`)
    else if (!model.tables.get(table)!.has(column) && !model.measures.has(column)) problems.push(`unknown column ${table}[${column}]`)
  }
  for (const match of withoutStrings.replace(/(?:'(?:[^']|'')+'|\b[A-Za-z_][A-Za-z0-9_]*)\[(?:[^\]]|\]\])+\]/g, '').matchAll(/\[((?:[^\]]|\]\])+)\]/g)) {
    const name = match[1]!.replace(/]]/g, ']')
    const isColumn = [...model.tables.values()].some((columns) => columns.has(name))
    if (!model.measures.has(name) && !isColumn) problems.push(`unknown measure or column [${name}]`)
  }
  for (const match of withoutStrings.matchAll(/\b([A-Z][A-Z0-9.]*)\s*\(/g)) if (!DAX_FUNCTIONS.has(match[1]!)) problems.push(`function ${match[1]} is not in the checked list (verify it exists)`)
  return problems
}

function prettyName(column: string): string {
  return column.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function autoMeasures(request: PowerBiRequest, dateColumns: Array<{ table: string; column: string }>, keys: Set<string>): ModelMeasure[] {
  const out: ModelMeasure[] = []
  for (const table of request.tables.filter((t) => t.role === 'fact')) {
    out.push({ table: table.name, name: `${prettyName(table.name)} Rows`, expression: `COUNTROWS(${daxTable(table.name)})`, formatString: '#,0', displayFolder: 'Counts' })
    for (const column of table.frame.columns) {
      const type = table.frame.types[column]
      const semantic = table.semantic?.[column] ?? ''
      if ((type === 'number' || type === 'integer') && !keys.has(`${table.name}.${column}`) && !['identifier', 'year', 'month', 'latitude', 'longitude', 'ordinal'].includes(semantic)) {
        if (semantic === 'percentage') out.push({ table: table.name, name: `Average ${prettyName(column)}`, expression: `AVERAGE(${daxColumn(table.name, column)})`, formatString: '0.0%', displayFolder: 'Base measures' })
        else out.push({ table: table.name, name: `Total ${prettyName(column)}`, expression: `SUM(${daxColumn(table.name, column)})`, formatString: semantic === 'currency_amount' ? '#,0.00' : '#,0.##', displayFolder: 'Base measures' })
      }
    }
  }
  for (const relationship of request.relationships) {
    const dim = request.tables.find((t) => t.name === relationship.toTable)
    if (dim?.role === 'dimension' && !out.some((m) => m.name === `Distinct ${prettyName(relationship.toTable)}`)) out.push({ table: relationship.fromTable, name: `Distinct ${prettyName(relationship.toTable)}`, expression: `DISTINCTCOUNT(${daxColumn(relationship.fromTable, relationship.fromColumn)})`, formatString: '#,0', displayFolder: 'Counts' })
  }
  if (dateColumns.length) {
    // Anchor time intelligence on money when there is a monetary measure, else on the first total.
    const primary = out.find((m) => m.name.startsWith('Total ') && m.formatString === '#,0.00') ?? out.find((m) => m.name.startsWith('Total '))
    if (primary) {
      const base = `[${primary.name}]`
      out.push(
        { table: primary.table, name: `${primary.name} YTD`, expression: `TOTALYTD(${base}, 'Date'[Date])`, formatString: primary.formatString, displayFolder: 'Time intelligence' },
        { table: primary.table, name: `${primary.name} PY`, expression: `CALCULATE(${base}, SAMEPERIODLASTYEAR('Date'[Date]))`, formatString: primary.formatString, displayFolder: 'Time intelligence' },
        { table: primary.table, name: `${primary.name} YoY %`, expression: `VAR Current = ${base}\nVAR Prior = [${primary.name} PY]\nRETURN DIVIDE(Current - Prior, Prior)`, formatString: '0.0%', displayFolder: 'Time intelligence' },
      )
    }
  }
  return out
}

// ---------------------------------------------------------------- TMDL writers

function tmdlTable(table: ModelTable, columns: ColumnModel[], measures: ModelMeasure[], project: string): string {
  const lines: string[] = [`table ${tmdlName(table.name)}`, `${TAB}lineageTag: ${guid(`${project}|table|${table.name}`)}`]
  if (table.description) lines.splice(0, 0, `/// ${table.description.replace(/\n/g, ' ')}`)
  lines.push('')
  for (const measure of measures) {
    if (measure.description) lines.push(`${TAB}/// ${measure.description.replace(/\n/g, ' ')}`)
    const expression = measure.expression.includes('\n') ? `\n${measure.expression.split('\n').map((line) => `${TAB}${TAB}${TAB}${line}`).join('\n')}` : ` ${measure.expression}`
    lines.push(`${TAB}measure ${tmdlName(measure.name)} =${expression}`)
    if (measure.formatString) lines.push(`${TAB}${TAB}formatString: ${measure.formatString}`)
    if (measure.displayFolder) lines.push(`${TAB}${TAB}displayFolder: ${measure.displayFolder}`)
    lines.push(`${TAB}${TAB}lineageTag: ${guid(`${project}|measure|${measure.table}|${measure.name}`)}`, '')
  }
  for (const column of columns) {
    lines.push(`${TAB}column ${tmdlName(column.name)}`, `${TAB}${TAB}dataType: ${column.dataType}`)
    if (column.isKey) lines.push(`${TAB}${TAB}isKey`)
    if (column.hidden) lines.push(`${TAB}${TAB}isHidden`)
    if (column.formatString) lines.push(`${TAB}${TAB}formatString: ${column.formatString}`)
    if (column.dataCategory) lines.push(`${TAB}${TAB}dataCategory: ${column.dataCategory}`)
    lines.push(`${TAB}${TAB}lineageTag: ${guid(`${project}|column|${table.name}|${column.name}`)}`, `${TAB}${TAB}summarizeBy: ${column.summarizeBy}`, `${TAB}${TAB}sourceColumn: ${column.name}`, '', `${TAB}${TAB}annotation SummarizationSetBy = Automatic`, '')
  }
  const typed = columns.map((column) => `{${mString(column.name)}, ${column.mType}}`).join(', ')
  lines.push(
    `${TAB}partition ${tmdlName(table.name)} = m`,
    `${TAB}${TAB}mode: import`,
    `${TAB}${TAB}source =`,
    `${TAB}${TAB}${TAB}${TAB}let`,
    `${TAB}${TAB}${TAB}${TAB}    Source = Csv.Document(File.Contents(DataFolder & ${mString(`/${table.name}.csv`)}), [Delimiter = ",", Encoding = 65001, QuoteStyle = QuoteStyle.Csv]),`,
    `${TAB}${TAB}${TAB}${TAB}    Headers = Table.PromoteHeaders(Source, [PromoteAllScalars = true]),`,
    `${TAB}${TAB}${TAB}${TAB}    Typed = Table.TransformColumnTypes(Headers, {${typed}}, "en-US")`,
    `${TAB}${TAB}${TAB}${TAB}in`,
    `${TAB}${TAB}${TAB}${TAB}    Typed`,
    '',
    `${TAB}annotation PBI_ResultType = Table`,
    '',
  )
  return lines.join('\n')
}

function dateTableTmdl(start: Date, end: Date, project: string): string {
  const d = (date: Date) => `DATE(${date.getUTCFullYear()}, ${date.getUTCMonth() + 1}, ${date.getUTCDate()})`
  const column = (name: string, dataType: string, formatString?: string, extra: string[] = []) => [`${TAB}column ${tmdlName(name)}`, `${TAB}${TAB}dataType: ${dataType}`, ...extra.map((line) => `${TAB}${TAB}${line}`), `${TAB}${TAB}isNameInferred`, ...(formatString ? [`${TAB}${TAB}formatString: ${formatString}`] : []), `${TAB}${TAB}lineageTag: ${guid(`${project}|date|${name}`)}`, `${TAB}${TAB}summarizeBy: none`, `${TAB}${TAB}sourceColumn: [${name}]`, '', `${TAB}${TAB}annotation SummarizationSetBy = Automatic`, '']
  return [
    '/// Calendar table generated by elia; marked as a date table (dataCategory Time, Date is the key).',
    `table Date`,
    `${TAB}lineageTag: ${guid(`${project}|table|Date`)}`,
    `${TAB}dataCategory: Time`,
    '',
    ...column('Date', 'dateTime', 'yyyy-mm-dd', ['isKey']),
    ...column('Year', 'int64', '0'),
    ...column('Quarter', 'string'),
    ...column('Month Number', 'int64', '0'),
    ...column('Month Name', 'string', undefined, ["sortByColumn: 'Month Number'"]),
    ...column('Year Month', 'string'),
    `${TAB}hierarchy 'Year Hierarchy'`,
    `${TAB}${TAB}lineageTag: ${guid(`${project}|date|hierarchy`)}`,
    '',
    `${TAB}${TAB}level Year`,
    `${TAB}${TAB}${TAB}lineageTag: ${guid(`${project}|date|level|Year`)}`,
    `${TAB}${TAB}${TAB}column: Year`,
    '',
    `${TAB}${TAB}level Quarter`,
    `${TAB}${TAB}${TAB}lineageTag: ${guid(`${project}|date|level|Quarter`)}`,
    `${TAB}${TAB}${TAB}column: Quarter`,
    '',
    `${TAB}${TAB}level 'Month Name'`,
    `${TAB}${TAB}${TAB}lineageTag: ${guid(`${project}|date|level|Month`)}`,
    `${TAB}${TAB}${TAB}column: 'Month Name'`,
    '',
    `${TAB}partition Date = calculated`,
    `${TAB}${TAB}mode: import`,
    `${TAB}${TAB}source =`,
    `${TAB}${TAB}${TAB}${TAB}ADDCOLUMNS(`,
    `${TAB}${TAB}${TAB}${TAB}    CALENDAR(${d(start)}, ${d(end)}),`,
    `${TAB}${TAB}${TAB}${TAB}    "Year", YEAR([Date]),`,
    `${TAB}${TAB}${TAB}${TAB}    "Quarter", "Q" & QUARTER([Date]),`,
    `${TAB}${TAB}${TAB}${TAB}    "Month Number", MONTH([Date]),`,
    `${TAB}${TAB}${TAB}${TAB}    "Month Name", FORMAT([Date], "MMM"),`,
    `${TAB}${TAB}${TAB}${TAB}    "Year Month", FORMAT([Date], "YYYY-MM")`,
    `${TAB}${TAB}${TAB}${TAB})`,
    '',
  ].join('\n')
}

// ---------------------------------------------------------------- report writers

type FieldRef = { kind: 'column' | 'measure'; table: string; name: string }

function fieldJson(field: FieldRef): Record<string, unknown> {
  return field.kind === 'measure' ? { Measure: { Expression: { SourceRef: { Entity: field.table } }, Property: field.name } } : { Column: { Expression: { SourceRef: { Entity: field.table } }, Property: field.name } }
}

function projection(field: FieldRef): Record<string, unknown> {
  return { field: fieldJson(field), queryRef: `${field.table}.${field.name}`, nativeQueryRef: field.name }
}

function literal(value: string): Record<string, unknown> {
  return { expr: { Literal: { Value: value } } }
}

function titleObjects(title: string | undefined): Record<string, unknown> | undefined {
  if (!title) return undefined
  return { title: [{ properties: { show: literal('true'), text: literal(`'${title.replace(/'/g, "''")}'`) } }] }
}

const VISUAL_TYPES: Record<VisualKind, string> = { kpis: 'cardVisual', line: 'lineChart', area: 'areaChart', column: 'clusteredColumnChart', bar: 'clusteredBarChart', table: 'tableEx', matrix: 'pivotTable', slicer: 'slicer', scatter: 'scatterChart', funnel: 'funnel', waterfall: 'waterfallChart', treemap: 'treemap' }

function visualJson(spec: VisualSpec, resolve: (ref: string) => FieldRef, position: { x: number; y: number; width: number; height: number }, name: string, z: number): Record<string, unknown> {
  const measures = (spec.measures ?? []).map(resolve)
  const category = spec.category ? resolve(spec.category) : undefined
  const series = spec.series ? resolve(spec.series) : undefined
  const queryState: Record<string, { projections: unknown[] }> = {}
  let sortDefinition: Record<string, unknown> | undefined
  switch (spec.kind) {
    case 'kpis': queryState.Data = { projections: measures.map(projection) }; break
    case 'slicer': queryState.Values = { projections: [projection(category!)] }; break
    case 'table': queryState.Values = { projections: [...(category ? [projection(category)] : []), ...(spec.rows ?? []).map(resolve).map(projection), ...measures.map(projection)] }; break
    case 'matrix':
      queryState.Rows = { projections: (spec.rows ?? (category ? [spec.category!] : [])).map(resolve).map(projection) }
      if (spec.columns?.length) queryState.Columns = { projections: spec.columns.map(resolve).map(projection) }
      queryState.Values = { projections: measures.map(projection) }
      break
    case 'scatter':
      queryState.Category = { projections: [projection(category!)] }
      queryState.X = { projections: [projection(measures[0]!)] }
      queryState.Y = { projections: [projection(measures[1]!)] }
      break
    case 'treemap':
      queryState.Group = { projections: [projection(category!)] }
      queryState.Values = { projections: [projection(measures[0]!)] }
      break
    default:
      queryState.Category = { projections: [projection(category!)] }
      queryState.Y = { projections: measures.map(projection) }
      if (series) queryState.Series = { projections: [projection(series)] }
      if ((spec.kind === 'bar' || spec.kind === 'column' || spec.kind === 'funnel') && measures[0]) sortDefinition = { sort: [{ field: fieldJson(measures[0]), direction: 'Descending' }], isDefaultSort: true }
  }
  const container = titleObjects(spec.title)
  return {
    $schema: SCHEMA.visual,
    name,
    position: { x: position.x, y: position.y, z, height: position.height, width: position.width, tabOrder: z },
    visual: {
      visualType: VISUAL_TYPES[spec.kind],
      query: { queryState, ...(sortDefinition ? { sortDefinition } : {}) },
      ...(container ? { visualContainerObjects: container } : {}),
      drillFilterOtherVisuals: true,
    },
  }
}

/** A consistent page grid: a KPI band, then a 2-column body; slicers share the top row. */
function layoutPage(visuals: VisualSpec[]): Array<{ x: number; y: number; width: number; height: number }> {
  const width = 1280
  const margin = 20
  const slicers = visuals.filter((v) => v.kind === 'slicer')
  const kpis = visuals.filter((v) => v.kind === 'kpis')
  const body = visuals.filter((v) => v.kind !== 'slicer' && v.kind !== 'kpis')
  const positions = new Map<VisualSpec, { x: number; y: number; width: number; height: number }>()
  let y = margin
  if (slicers.length) {
    const w = Math.min(300, (width - margin * (slicers.length + 1)) / slicers.length)
    slicers.forEach((v, i) => positions.set(v, { x: margin + i * (w + margin), y, width: w, height: 70 }))
    y += 70 + margin
  }
  for (const v of kpis) { positions.set(v, { x: margin, y, width: width - 2 * margin, height: 120 }); y += 120 + margin }
  const rows = Math.ceil(body.length / 2)
  const available = 720 - y - margin
  const rowHeight = rows ? Math.max(180, (available - margin * (rows - 1)) / rows) : 0
  const colWidth = (width - 3 * margin) / 2
  body.forEach((v, i) => {
    const alone = i === body.length - 1 && body.length % 2 === 1
    positions.set(v, { x: margin + (i % 2) * (colWidth + margin), y: y + Math.floor(i / 2) * (rowHeight + margin), width: alone ? width - 2 * margin : colWidth, height: rowHeight })
  })
  return visuals.map((v) => positions.get(v)!)
}

// ---------------------------------------------------------------- build

export function buildPowerBiProject(request: PowerBiRequest): PowerBiResult {
  const project = request.name.replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'Analysis'
  const checks: PowerBiResult['checks'] = []
  const tableNames = new Set(request.tables.map((t) => t.name))
  if (tableNames.size !== request.tables.length) throw new Error('table names must be unique')
  if (tableNames.has('Date') && request.dateTable !== false) throw new Error('a source table is already named "Date"; rename it or pass dateTable: false')
  for (const t of request.tables) if (!/^[A-Za-z][A-Za-z0-9 _-]{0,99}$/.test(t.name)) throw new Error(`table name "${t.name}" must start with a letter and use letters, digits, spaces, "_" or "-"`)
  // Relationships: validated against the data before they are written.
  const relationships = request.relationships.map((r) => {
    const from = request.tables.find((t) => t.name === r.fromTable)
    const to = request.tables.find((t) => t.name === r.toTable)
    if (!from || !to) throw new Error(`relationship ${r.fromTable}.${r.fromColumn} → ${r.toTable}.${r.toColumn} names an unknown table`)
    if (!from.frame.columns.includes(r.fromColumn) || !to.frame.columns.includes(r.toColumn)) throw new Error(`relationship ${r.fromTable}.${r.fromColumn} → ${r.toTable}.${r.toColumn} names an unknown column`)
    const toKeys = to.frame.rows.map((row) => row[r.toColumn]).filter((v) => !isMissing(v)).map((v) => scalarKey(v ?? null))
    const unique = new Set(toKeys).size === toKeys.length
    const keySet = new Set(toKeys)
    const orphanRows = from.frame.rows.filter((row) => !isMissing(row[r.fromColumn]) && !keySet.has(scalarKey(row[r.fromColumn] ?? null))).length
    checks.push({ name: `relationship ${r.fromTable}[${r.fromColumn}] → ${r.toTable}[${r.toColumn}]`, status: !unique ? 'fail' : orphanRows ? 'warn' : 'pass', detail: !unique ? `${r.toTable}[${r.toColumn}] is not unique, so this cannot be a many-to-one relationship — dedupe the dimension first` : orphanRows ? `${orphanRows} ${r.fromTable} rows have no matching ${r.toTable} row; Power BI shows them under a blank member` : 'many-to-one, every key matches' })
    if (from.frame.types[r.fromColumn] !== to.frame.types[r.toColumn]) checks.push({ name: `relationship key types ${r.fromTable}[${r.fromColumn}]`, status: 'warn', detail: `${from.frame.types[r.fromColumn]} vs ${to.frame.types[r.toColumn]}; Power BI requires matching data types` })
    return { ...r, orphanRows, unique }
  })
  const keys = new Set(relationships.flatMap((r) => [`${r.fromTable}.${r.fromColumn}`, `${r.toTable}.${r.toColumn}`]))
  const columnModels = new Map(request.tables.map((t) => [t.name, t.frame.columns.map((c) => ({ ...columnModel(t, c, keys), ...(t.role === 'dimension' && relationships.some((r) => r.toTable === t.name && r.toColumn === c) ? { isKey: true } : {}), ...(t.role === 'fact' && keys.has(`${t.name}.${c}`) ? { hidden: true } : {}) }))]))
  // Date table
  const dateColumns = request.dateTable === false ? [] : request.dateTable?.columns ?? request.tables.filter((t) => t.role === 'fact').flatMap((t) => t.frame.columns.filter((c) => t.frame.types[c] === 'date' || t.frame.types[c] === 'datetime').slice(0, 1).map((c) => ({ table: t.name, column: c })))
  let dateRange: [Date, Date] | undefined
  if (dateColumns.length) {
    const ms = dateColumns.flatMap(({ table, column }) => request.tables.find((t) => t.name === table)!.frame.rows.map((row) => toDateMs(row[column])).filter((v): v is number => v !== undefined))
    if (ms.length) {
      const min = new Date(Math.min(...ms))
      const max = new Date(Math.max(...ms))
      dateRange = [new Date(Date.UTC(min.getUTCFullYear(), 0, 1)), new Date(Date.UTC(max.getUTCFullYear(), 11, 31))]
      checks.push({ name: 'date table covers the data', status: 'pass', detail: `calendar ${dateRange[0].toISOString().slice(0, 10)} to ${dateRange[1].toISOString().slice(0, 10)} (whole years, as time intelligence requires)` })
    }
  }
  const allMeasures = [...autoMeasures(request, dateRange ? dateColumns : [], keys), ...(request.measures ?? [])]
  const measureNames = new Set<string>()
  for (const measure of allMeasures) {
    if (measureNames.has(measure.name)) throw new Error(`measure "${measure.name}" is defined twice`)
    measureNames.add(measure.name)
    if (!tableNames.has(measure.table)) throw new Error(`measure "${measure.name}" is placed on unknown table ${measure.table}`)
  }
  const modelColumns = new Map<string, Set<string>>(request.tables.map((t) => [t.name, new Set(t.frame.columns)]))
  if (dateRange) modelColumns.set('Date', new Set(['Date', 'Year', 'Quarter', 'Month Number', 'Month Name', 'Year Month']))
  for (const measure of allMeasures) {
    const problems = checkDax(measure.expression, { tables: modelColumns, measures: measureNames })
    const hard = problems.filter((p) => !p.startsWith('function'))
    checks.push({ name: `DAX [${measure.name}]`, status: hard.length ? 'fail' : problems.length ? 'warn' : 'pass', detail: problems.length ? problems.join('; ') : 'references resolve, parentheses balance' })
  }
  // Files: semantic model
  const files: ProjectFile[] = []
  const sm = `${project}.SemanticModel`
  const rp = `${project}.Report`
  files.push({ path: `${project}.pbip`, content: JSON.stringify({ $schema: SCHEMA.pbip, version: '1.0', artifacts: [{ report: { path: rp } }], settings: { enableAutoRecovery: true } }, null, 2) })
  files.push({ path: '.gitignore', content: '**/.pbi/localSettings.json\n**/.pbi/cache.abf\n' })
  files.push({ path: `${sm}/definition.pbism`, content: JSON.stringify({ $schema: SCHEMA.pbism, version: '4.2', settings: { qnaEnabled: false } }, null, 2) })
  files.push({ path: `${sm}/.platform`, content: JSON.stringify({ $schema: SCHEMA.platform, metadata: { type: 'SemanticModel', displayName: project }, config: { version: '2.0', logicalId: guid(`${project}|semanticmodel`) } }, null, 2) })
  files.push({ path: `${sm}/definition/database.tmdl`, content: `database\n${TAB}compatibilityLevel: 1600\n` })
  const tableOrder = [...request.tables.map((t) => t.name), ...(dateRange ? ['Date'] : [])]
  files.push({ path: `${sm}/definition/model.tmdl`, content: [`model Model`, `${TAB}culture: en-US`, `${TAB}defaultPowerBIDataSourceVersion: powerBI_V3`, `${TAB}sourceQueryCulture: en-US`, `${TAB}dataAccessOptions`, `${TAB}${TAB}legacyRedirects`, `${TAB}${TAB}returnErrorValuesAsNull`, '', `annotation __PBI_TimeIntelligenceEnabled = 0`, '', `annotation PBI_QueryOrder = ${JSON.stringify(['DataFolder', ...request.tables.map((t) => t.name)])}`, '', ...tableOrder.map((name) => `ref table ${tmdlName(name)}`), ''].join('\n') })
  files.push({ path: `${sm}/definition/expressions.tmdl`, content: [`expression DataFolder = ${mString(request.dataFolder.replace(/\\/g, '/'))} meta [IsParameterQuery = true, Type = "Text", IsParameterQueryRequired = true]`, `${TAB}lineageTag: ${guid(`${project}|expression|DataFolder`)}`, '', `${TAB}annotation PBI_ResultType = Text`, ''].join('\n') })
  for (const table of request.tables) files.push({ path: `${sm}/definition/tables/${table.name}.tmdl`, content: tmdlTable(table, columnModels.get(table.name)!, allMeasures.filter((m) => m.table === table.name), project) })
  if (dateRange) files.push({ path: `${sm}/definition/tables/Date.tmdl`, content: dateTableTmdl(dateRange[0], dateRange[1], project) })
  const relationshipLines: string[] = []
  for (const r of relationships) relationshipLines.push(`relationship ${guid(`${project}|rel|${r.fromTable}|${r.fromColumn}|${r.toTable}`)}`, `${TAB}fromColumn: ${tmdlName(r.fromTable)}.${tmdlName(r.fromColumn)}`, `${TAB}toColumn: ${tmdlName(r.toTable)}.${tmdlName(r.toColumn)}`, '')
  if (dateRange) for (const { table, column } of dateColumns) relationshipLines.push(`relationship ${guid(`${project}|rel|${table}|${column}|Date`)}`, `${TAB}fromColumn: ${tmdlName(table)}.${tmdlName(column)}`, `${TAB}toColumn: Date.Date`, '')
  if (relationshipLines.length) files.push({ path: `${sm}/definition/relationships.tmdl`, content: relationshipLines.join('\n') })
  // Report
  const resolve = (ref: string): FieldRef => {
    const match = /^(.+?)\.(.+)$/.exec(ref) ?? (measureNames.has(ref) ? [ref, allMeasures.find((m) => m.name === ref)!.table, ref] : null)
    if (!match) throw new Error(`field "${ref}" must be "Table.Column" or a measure name`)
    const [, table, name] = match as unknown as [string, string, string]
    if (measureNames.has(name) && allMeasures.find((m) => m.name === name)!.table === table) return { kind: 'measure', table, name }
    if (modelColumns.get(table)?.has(name)) return { kind: 'column', table, name }
    if (measureNames.has(ref)) return { kind: 'measure', table: allMeasures.find((m) => m.name === ref)!.table, name: ref }
    throw new Error(`report field "${ref}" does not exist in the model (tables: ${[...modelColumns.keys()].join(', ')}; measures: ${[...measureNames].slice(0, 30).join(', ')})`)
  }
  const pages = request.pages ?? defaultPages(request, allMeasures, relationships, Boolean(dateRange))
  files.push({ path: `${rp}/definition.pbir`, content: JSON.stringify({ $schema: SCHEMA.pbir, version: '4.0', datasetReference: { byPath: { path: `../${sm}` } } }, null, 2) })
  files.push({ path: `${rp}/.platform`, content: JSON.stringify({ $schema: SCHEMA.platform, metadata: { type: 'Report', displayName: project }, config: { version: '2.0', logicalId: guid(`${project}|report`) } }, null, 2) })
  files.push({ path: `${rp}/definition/version.json`, content: JSON.stringify({ $schema: SCHEMA.version, version: '2.0.0' }, null, 2) })
  const customThemeName = `elia-theme-${hexId(`${project}|theme`).slice(0, 8)}.json`
  files.push({ path: `${rp}/definition/report.json`, content: JSON.stringify({
    $schema: SCHEMA.report,
    themeCollection: {
      baseTheme: { name: BASE_THEME_NAME, reportVersionAtImport: THEME_VERSIONS, type: 'SharedResources' },
      customTheme: { name: customThemeName, reportVersionAtImport: THEME_VERSIONS, type: 'RegisteredResources' },
    },
    resourcePackages: [
      { name: 'SharedResources', type: 'SharedResources', items: [{ name: BASE_THEME_NAME, path: `BaseThemes/${BASE_THEME_NAME}.json`, type: 'BaseTheme' }] },
      { name: 'RegisteredResources', type: 'RegisteredResources', items: [{ name: customThemeName, path: customThemeName, type: 'CustomTheme' }] },
    ],
    settings: { useStylableVisualContainerHeader: true, defaultDrillFilterOtherVisuals: true, allowChangeFilterTypes: true, useEnhancedTooltips: true, useDefaultAggregateDisplayName: true },
  }, null, 2) })
  files.push({ path: `${rp}/StaticResources/SharedResources/BaseThemes/${BASE_THEME_NAME}.json`, content: JSON.stringify(BASE_THEME, null, 2) })
  files.push({ path: `${rp}/StaticResources/RegisteredResources/${customThemeName}`, content: JSON.stringify({ name: customThemeName.replace(/\.json$/, ''), dataColors: ['#2A78D6', '#EB6834', '#1BAF7A', '#EDA100', '#E87BA4', '#008300', '#4A3AA7', '#E34948'], background: '#FFFFFF', foreground: '#252423', tableAccent: '#2A78D6', good: '#0CA30C', neutral: '#FAB219', bad: '#D03B3B', maximum: '#2A78D6', center: '#F0EFEC', minimum: '#E34948' }, null, 2) })
  const pageNames = pages.map((page) => hexId(`${project}|page|${page.name}`))
  files.push({ path: `${rp}/definition/pages/pages.json`, content: JSON.stringify({ $schema: SCHEMA.pages, pageOrder: pageNames, activePageName: pageNames[0] }, null, 2) })
  pages.forEach((page, p) => {
    const pageName = pageNames[p]!
    files.push({ path: `${rp}/definition/pages/${pageName}/page.json`, content: JSON.stringify({ $schema: SCHEMA.page, name: pageName, displayName: page.name.slice(0, 100), displayOption: 'FitToPage', height: 720, width: 1280 }, null, 2) })
    const positions = layoutPage(page.visuals)
    page.visuals.forEach((visual, v) => {
      const name = hexId(`${project}|${page.name}|visual|${v}`)
      files.push({ path: `${rp}/definition/pages/${pageName}/visuals/${name}/visual.json`, content: JSON.stringify(visualJson(visual, resolve, positions[v]!, name, (v + 1) * 1000), null, 2) })
    })
  })
  checks.push({ name: 'report bindings resolve', status: 'pass', detail: `${pages.reduce((n, p) => n + p.visuals.length, 0)} visuals on ${pages.length} page(s); every field reference exists in the model` })
  const csv = request.tables.map((t) => ({ table: t.name, path: `Data/${t.name}.csv`, rows: t.frame.rows.length }))
  const measuresDoc = allMeasures.map((m) => `-- ${m.table}\n${daxTable(m.table)}[${m.name}] =\n${m.expression}\n`).join('\n')
  files.push({ path: 'measures.dax', content: measuresDoc })
  const limitations = [
    'Generated without Power BI Desktop (it runs only on Windows); the files follow Microsoft\'s published schemas and were cross-reference checked, but the first open in Desktop is the final validation.',
    'Power BI Projects (PBIP) are a preview feature: enable File › Options › Preview features › "Power BI Project (.pbip) save option" and "Store semantic model using TMDL format" if Desktop asks.',
    'A .pbix cannot be produced programmatically; open the .pbip in Power BI Desktop and use File › Save as › .pbix if a single file is required.',
    `The model imports CSV files from the DataFolder parameter (${request.dataFolder}); on another machine, change it under Transform data › Manage parameters, then refresh.`,
    'Visual formatting uses Power BI defaults with the elia colour theme; refine layout and formatting in Desktop as needed.',
  ]
  files.push({ path: 'README.md', content: [`# ${project} — Power BI project`, '', 'Generated by elia data science mode.', '', '## Open it', '', `1. Copy this folder to a Windows machine with Power BI Desktop (Microsoft Store or download).`, `2. Open \`${project}.pbip\`.`, '3. If prompted, set the **DataFolder** parameter to the absolute path of this folder\'s `Data` directory and refresh.', '', '## Contents', '', `- \`${sm}/definition\` — TMDL semantic model: ${request.tables.length} tables${dateRange ? ' + Date' : ''}, ${relationships.length + (dateRange ? dateColumns.length : 0)} relationships, ${allMeasures.length} measures`, `- \`${rp}/definition\` — PBIR report: ${pages.map((p) => `${p.name} (${p.visuals.length} visuals)`).join(', ')}`, '- `Data/` — the exact datasets the analysis used, as UTF-8 CSV', '- `measures.dax` — every measure for review', '', '## Limitations', '', ...limitations.map((l) => `- ${l}`), ''].join('\n') })
  return { files, csv, measures: allMeasures, relationships, pages, checks, limitations }
}

function defaultPages(request: PowerBiRequest, measures: ModelMeasure[], relationships: ModelRelationship[], hasDate: boolean): PageSpec[] {
  const totals = measures.filter((m) => m.displayFolder === 'Base measures' || m.displayFolder === 'Counts').sort((a, b) => Number(b.formatString === '#,0.00') - Number(a.formatString === '#,0.00')).slice(0, 4).map((m) => `${m.table}.${m.name}`)
  const primary = totals[0]
  if (!primary) throw new Error('no numeric measure could be derived for a dashboard; pass measures explicitly')
  const dimensionColumns = request.tables.filter((t) => t.role === 'dimension').flatMap((t) => t.frame.columns.filter((c) => t.frame.types[c] === 'string' && !relationships.some((r) => r.toTable === t.name && r.toColumn === c)).map((c) => ({ ref: `${t.name}.${c}`, distinct: new Set(t.frame.rows.map((row) => row[c])).size }))).filter((c) => c.distinct >= 2 && c.distinct <= 50).sort((a, b) => a.distinct - b.distinct)
  const factCategories = request.tables.filter((t) => t.role === 'fact').flatMap((t) => t.frame.columns.filter((c) => t.frame.types[c] === 'string' && !relationships.some((r) => r.fromTable === t.name && r.fromColumn === c)).map((c) => ({ ref: `${t.name}.${c}`, distinct: new Set(t.frame.rows.map((row) => row[c])).size }))).filter((c) => c.distinct >= 2 && c.distinct <= 30)
  const categories = [...dimensionColumns, ...factCategories]
  const visuals: VisualSpec[] = []
  if (categories[0]) visuals.push({ kind: 'slicer', category: categories[0].ref, title: prettyName(categories[0].ref.split('.').pop()!) })
  if (hasDate) visuals.push({ kind: 'slicer', category: 'Date.Year', title: 'Year' })
  visuals.push({ kind: 'kpis', measures: totals, title: 'Key metrics' })
  if (hasDate) visuals.push({ kind: 'line', category: 'Date.Year Month', measures: [primary], title: `${primary.split('.').pop()} by month` })
  if (categories[0]) visuals.push({ kind: 'bar', category: categories[0].ref, measures: [primary], title: `${primary.split('.').pop()} by ${prettyName(categories[0].ref.split('.').pop()!)}` })
  if (categories[1]) visuals.push({ kind: 'column', category: categories[1].ref, measures: [primary], title: `${primary.split('.').pop()} by ${prettyName(categories[1].ref.split('.').pop()!)}` })
  const detail: PageSpec = { name: 'Detail', visuals: [{ kind: 'matrix', rows: categories.slice(0, 2).map((c) => c.ref).length ? categories.slice(0, 2).map((c) => c.ref) : [hasDate ? 'Date.Year Month' : primary], measures: totals, title: 'Breakdown' }] }
  return [{ name: request.audience ? `${prettyName(request.audience)} overview` : 'Overview', visuals }, ...(categories.length || hasDate ? [detail] : [])]
}

export { toNumber }

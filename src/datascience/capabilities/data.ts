import ExcelJS from 'exceljs'
import { resolveWorkspacePath, isPathWithinWorkspace } from '../../autonomy/context.ts'
import { registerCapability, type ActionContext } from '../engine.ts'
import { previewRows, type Frame } from '../frame.ts'
import { describeDatabase, loadSource, type LoadRequest } from '../ingest.ts'
import { driftAgainstProfile, trainingProfile } from '../ml/automl.ts'
import { frameToCsv } from '../powerbi/project.ts'
import { assessQuality } from '../quality.ts'
import { explainFrames, queryFrames } from '../sqlwork.ts'
import { runPipeline, transformUsage } from '../transform.ts'
import { discoverRelationships, understandDataset } from '../understand.ts'
import { assertDatasetName, refOf } from '../workspace.ts'
import { DATASET, list, outputName, preview, str, WHERE } from './common.ts'

function sourceEffect(params: Record<string, unknown>) {
  const connection = typeof params.connection === 'string' ? params.connection.toLowerCase() : ''
  if (connection && connection !== 'sqlite') return 'database-read' as const
  if (typeof params.url === 'string' || typeof params.urlEnv === 'string') return 'network-read' as const
  return 'local-write' as const
}

function summarizeQuality(frame: Frame, ctx: ActionContext, extra: Parameters<typeof assessQuality>[2] = {}) {
  const understanding = understandDataset(frame)
  const report = assessQuality(frame, understanding, extra)
  return { understanding, report }
}

registerCapability({
  tool: 'ds_data',
  action: 'load',
  summary: 'load a file, database table/query, REST API, or s3:// object into the workspace as a versioned dataset (sources are never modified)',
  effect: sourceEffect,
  params: {
    name: { type: 'string', required: true, description: 'dataset name to register (letters, digits, _ or -)' },
    path: { type: 'string', description: 'workspace file: csv, tsv, txt, json, jsonl, xlsx, xls, parquet, feather, arrow, avro, orc, xml, md, pdf, docx, sqlite/duckdb' },
    format: { type: 'string', description: 'override the detected format' },
    sheet: { type: 'string', description: 'xlsx/xls sheet name' },
    delimiter: { type: 'string', description: 'override the sniffed delimiter' },
    connection: { type: 'string', enum: ['sqlite', 'postgres', 'mysql', 'redshift', 'duckdb', 'sqlserver', 'oracle', 'snowflake', 'bigquery'], description: 'database kind' },
    dsnEnv: { type: 'string', description: 'NAME of the environment variable holding the connection string (never the value)' },
    table: { type: 'string', description: 'database table to read' },
    query: { type: 'string', description: 'read-only SQL (SELECT/WITH) to run against the database' },
    url: { type: 'string', description: 'REST endpoint returning JSON or CSV, or s3://bucket/key' },
    urlEnv: { type: 'string', description: 'NAME of an environment variable holding a URL that embeds a secret (e.g. an Azure SAS URL)' },
    headers: { type: 'object', description: 'HTTP headers; secrets must be "${ENV_VAR}" references, e.g. { "Authorization": "Bearer ${API_TOKEN}" }' },
    apiParams: { type: 'object', description: 'query-string parameters for the API' },
    pageParam: { type: 'string', description: 'query parameter used for page numbers' },
    maxPages: { type: 'integer', description: 'maximum pages to fetch (default 10)' },
    recordPath: { type: 'string', description: 'JSON/API dot path to the record array; XML record element; DOCX/Markdown table index' },
    allowLocal: { type: 'boolean', description: 'allow an API on localhost (requires approval)' },
    limit: { type: 'integer', description: 'maximum rows to load (default 1,000,000; truncation is reported, never silent)' },
    dayFirst: { type: 'boolean', description: 'read ambiguous dates like 03/04/2025 as day-first' },
    description: { type: 'string', description: 'what this dataset is' },
  },
  example: { action: 'load', name: 'orders', path: 'data/orders.csv' },
  async run(ctx) {
    const name = assertDatasetName(str(ctx, 'name'))
    const p = ctx.params
    const request: LoadRequest = {
      ...(typeof p.path === 'string' ? { path: p.path } : {}),
      ...(typeof p.format === 'string' ? { format: p.format } : {}),
      ...(typeof p.sheet === 'string' ? { sheet: p.sheet } : {}),
      ...(typeof p.delimiter === 'string' ? { delimiter: p.delimiter } : {}),
      ...(typeof p.connection === 'string' ? { connection: p.connection } : {}),
      ...(typeof p.dsnEnv === 'string' ? { dsnEnv: p.dsnEnv } : {}),
      ...(typeof p.table === 'string' ? { table: p.table } : {}),
      ...(typeof p.query === 'string' ? { query: p.query } : {}),
      ...(typeof p.url === 'string' ? { url: p.url } : {}),
      ...(typeof p.urlEnv === 'string' ? { urlEnv: p.urlEnv } : {}),
      ...(p.headers && typeof p.headers === 'object' ? { headers: p.headers as Record<string, string> } : {}),
      ...(p.apiParams && typeof p.apiParams === 'object' ? { params: p.apiParams as Record<string, string> } : {}),
      ...(typeof p.pageParam === 'string' ? { pageParam: p.pageParam } : {}),
      ...(typeof p.maxPages === 'number' ? { maxPages: p.maxPages } : {}),
      ...(typeof p.recordPath === 'string' ? { recordPath: p.recordPath } : {}),
      ...(p.allowLocal === true ? { allowLocal: true } : {}),
      ...(typeof p.limit === 'number' ? { limit: p.limit } : {}),
      ...(typeof p.dayFirst === 'boolean' ? { dayFirst: p.dayFirst } : {}),
    }
    if (request.query) ctx.record.code('sql', request.query)
    const loaded = await loadSource(request)
    for (const warning of loaded.warnings) ctx.record.warn(warning)
    const understanding = understandDataset(loaded.frame)
    const quality = assessQuality(loaded.frame, understanding, { inference: loaded.inference, ...(loaded.source.truncatedAt ? { truncatedAt: loaded.source.truncatedAt } : {}) })
    const { entry, reused } = ctx.workspace.registerDataset({ name, frame: loaded.frame, kind: 'source', source: loaded.source, ...(typeof p.description === 'string' ? { description: p.description } : {}), grain: understanding.grain.statement, notes: loaded.warnings })
    ctx.record.outputDataset(refOf(entry))
    ctx.record.input(refOf(entry), entry.fingerprint, entry.rows)
    ctx.record.expect('source has rows', loaded.frame.rows.length > 0, `${loaded.frame.rows.length} rows × ${loaded.frame.columns.length} columns`)
    ctx.record.check('complete load', loaded.source.truncatedAt ? 'warn' : 'pass', loaded.source.truncatedAt ? `truncated at ${loaded.source.truncatedAt} rows (not a random sample)` : 'every row in the source was read')
    if (loaded.warnings.length) ctx.record.check('parse warnings', 'warn', loaded.warnings.slice(0, 5).join(' | '))
    return {
      dataset: refOf(entry),
      reusedExistingVersion: reused,
      source: { ...loaded.source, sha256: loaded.source.sha256?.slice(0, 16) },
      rows: loaded.frame.rows.length,
      columns: loaded.frame.columns.map((column) => ({ name: column, type: loaded.frame.types[column], semantic: understanding.profiles.find((profile) => profile.name === column)?.semanticType })),
      grain: understanding.grain,
      candidateKeys: understanding.keys.slice(0, 3).map((key) => key.columns),
      timeColumns: understanding.timeColumns,
      suggestedTargets: understanding.suggestedTargets,
      quality: { score: quality.score, grade: quality.grade, highIssues: quality.issues.filter((issue) => issue.severity === 'high' || issue.severity === 'critical').slice(0, 6).map((issue) => `${issue.column ? `${issue.column}: ` : ''}${issue.detail}`) },
      preview: previewRows(loaded.frame, 5),
      next: 'run ds_data inspect for the full data dictionary and ds_data quality for every issue before analysing',
    }
  },
})

registerCapability({
  tool: 'ds_data',
  action: 'schema',
  summary: 'list the tables and columns of a database before loading anything',
  effect: sourceEffect,
  params: {
    connection: { type: 'string', required: true, enum: ['sqlite', 'postgres', 'mysql', 'redshift'], description: 'database kind' },
    path: { type: 'string', description: 'SQLite file' },
    dsnEnv: { type: 'string', description: 'NAME of the environment variable with the connection string' },
  },
  async run(ctx) {
    const schema = await describeDatabase({ connection: str(ctx, 'connection'), ...(typeof ctx.params.path === 'string' ? { path: ctx.params.path } : {}), ...(typeof ctx.params.dsnEnv === 'string' ? { dsnEnv: ctx.params.dsnEnv } : {}) })
    ctx.record.check('schema read', 'pass', `${(schema as unknown[]).length} tables`)
    return { tables: schema }
  },
})

registerCapability({
  tool: 'ds_data',
  action: 'list',
  summary: 'list datasets (latest versions), trained models, and recent runs in this workspace',
  effect: 'compute',
  params: {},
  run(ctx) {
    const state = ctx.workspace.read()
    ctx.record.check('workspace read', 'pass', `${state.datasets.length} dataset versions`)
    return {
      datasets: ctx.workspace.latestDatasets().map((entry) => ({ dataset: refOf(entry), kind: entry.kind, rows: entry.rows, columns: entry.columns.length, grain: entry.grain, description: entry.description, derivedFrom: entry.derivation?.inputs })),
      models: state.models.map((model) => ({ model: `${model.name}@${model.version}`, status: model.status, task: model.task, algorithm: model.algorithm, target: model.target, metric: (model.metrics as { primaryMetric?: string }).primaryMetric })),
      activePlan: ctx.workspace.activePlan()?.objective ?? null,
      runs: ctx.workspace.listRecords(1000).length,
    }
  },
})

registerCapability({
  tool: 'ds_data',
  action: 'inspect',
  summary: 'data dictionary: per-column type, semantic meaning, role, cardinality, missingness, distribution, examples; plus grain, keys, time columns',
  effect: 'compute',
  params: { dataset: DATASET, where: WHERE, export: { type: 'boolean', description: 'also write the dictionary as a Markdown artifact' } },
  run(ctx) {
    const { entry, frame } = ctx.dataset(str(ctx, 'dataset'))
    const u = understandDataset(frame)
    ctx.workspace.setGrain(refOf(entry), u.grain.statement)
    const dictionary = u.profiles.map((profile) => ({
      column: profile.name,
      type: profile.type,
      semantic: profile.semanticType,
      role: profile.role,
      confidence: profile.confidence,
      missing: profile.missing,
      missingRate: profile.missingRate,
      distinct: profile.distinct,
      unique: profile.uniqueness === 1,
      examples: profile.examples.slice(0, 3),
      ...(profile.numeric ? { summary: { min: profile.numeric.min, p25: profile.numeric.p25, median: profile.numeric.median, mean: profile.numeric.mean, p75: profile.numeric.p75, max: profile.numeric.max, std: profile.numeric.std, skewness: profile.numeric.skewness } } : {}),
      ...(profile.topValues && profile.distinct <= 100 ? { top: profile.topValues.slice(0, 5).map((t) => `${String(t.value)} (${(t.share * 100).toFixed(1)}%)`) } : {}),
      ...(profile.temporal ? { range: `${profile.temporal.min.slice(0, 10)} → ${profile.temporal.max.slice(0, 10)}` } : {}),
      ...(profile.unit ? { unit: profile.unit } : {}),
      description: profile.description,
      evidence: profile.evidence,
    }))
    if (ctx.params.export === true) {
      const md = [`# Data dictionary — ${refOf(entry)}`, '', `${u.rows} rows × ${u.columns} columns. Grain: ${u.grain.statement} (${u.grain.level}).`, '', '| column | type | semantic | role | missing | distinct | description |', '|---|---|---|---|---|---|---|', ...dictionary.map((d) => `| ${d.column} | ${d.type} | ${d.semantic} | ${d.role} | ${(d.missingRate * 100).toFixed(1)}% | ${d.distinct} | ${d.description.replace(/\|/g, '/')} |`)].join('\n')
      ctx.artifact(`dictionaries/${entry.name}.v${entry.version}.md`, md, 'data-dictionary')
    }
    ctx.record.check('profiled every column', 'pass', `${u.profiles.length} columns`)
    const lowConfidence = u.profiles.filter((p) => p.confidence === 'low').map((p) => p.name)
    if (lowConfidence.length) ctx.record.check('semantic types', 'warn', `low-confidence inferences for ${lowConfidence.join(', ')} — confirm their meaning before relying on them`)
    return { dataset: refOf(entry), rows: u.rows, grain: u.grain, keys: u.keys.map((k) => k.columns), roles: u.roles, timeColumns: u.timeColumns, suggestedTargets: u.suggestedTargets, dictionary }
  },
})

registerCapability({
  tool: 'ds_data',
  action: 'quality',
  summary: 'data-quality report with a transparent score: missingness, duplicates, invalid/impossible values, inconsistent labels/units, outliers, sentinels, referential integrity, sampling, and optional drift against another dataset',
  effect: 'compute',
  params: {
    dataset: DATASET,
    keys: { type: 'string|array', description: 'columns that must uniquely identify a row' },
    target: { type: 'string', description: 'target column, to check class imbalance' },
    compareTo: { type: 'string', description: 'reference dataset (e.g. last month) for schema drift and distribution drift (PSI)' },
    where: WHERE,
  },
  run(ctx) {
    const { entry, frame } = ctx.dataset(str(ctx, 'dataset'))
    const others = ctx.workspace.latestDatasets().filter((other) => other.name !== entry.name).slice(0, 12)
    const understanding = understandDataset(frame)
    const related = others.map((other) => { const loaded = ctx.workspace.frame(refOf(other)); return { name: other.name, frame: loaded.frame, profiles: understandDataset(loaded.frame).profiles } })
    const { relationships } = discoverRelationships([{ name: entry.name, frame, profiles: understanding.profiles }, ...related])
    const report = assessQuality(frame, understanding, { relationships, datasetName: entry.name, ...(entry.source?.truncatedAt ? { truncatedAt: entry.source.truncatedAt } : {}), ...(ctx.params.keys ? { keys: list(ctx.params.keys, 'keys') } : {}), ...(typeof ctx.params.target === 'string' ? { target: ctx.params.target } : {}) })
    let drift: unknown
    if (typeof ctx.params.compareTo === 'string') {
      const reference = ctx.dataset(ctx.params.compareTo, { where: '' })
      const added = frame.columns.filter((c) => !reference.frame.columns.includes(c))
      const removed = reference.frame.columns.filter((c) => !frame.columns.includes(c))
      const retyped = frame.columns.filter((c) => reference.frame.columns.includes(c) && reference.frame.types[c] !== frame.types[c]).map((c) => `${c}: ${reference.frame.types[c]} → ${frame.types[c]}`)
      const shared = frame.columns.filter((c) => reference.frame.columns.includes(c))
      const profile = trainingProfile(reference.frame, reference.frame.rows.map((_, i) => i), shared)
      const psi = driftAgainstProfile(profile, frame).sort((a, b) => b.psi - a.psi)
      drift = { reference: refOf(reference.entry), schema: { added, removed, retyped }, distribution: psi.slice(0, 30) }
      ctx.record.check('schema drift', added.length || removed.length || retyped.length ? 'warn' : 'pass', `${added.length} added, ${removed.length} removed, ${retyped.length} retyped columns`)
      const significant = psi.filter((d) => d.level === 'significant')
      ctx.record.check('distribution drift', significant.length ? 'warn' : 'pass', significant.length ? `PSI ≥ 0.25 for ${significant.map((d) => d.feature).join(', ')}` : 'no column with PSI ≥ 0.25')
    }
    const serious = report.issues.filter((issue) => issue.severity === 'critical' || issue.severity === 'high')
    ctx.record.check('quality assessed', 'pass', `score ${report.score} (${report.grade}) from ${report.components.filter((c) => c.score !== null).length} assessed components`)
    if (serious.length) ctx.record.check('serious data issues', 'warn', serious.slice(0, 5).map((issue) => `${issue.column ?? 'table'}: ${issue.check}`).join('; '))
    ctx.record.metric('qualityScore', report.score)
    return { dataset: refOf(entry), ...report, relationships: relationships.map((r) => `${r.from.dataset}.${r.from.column} → ${r.to.dataset}.${r.to.column} (${(r.containment * 100).toFixed(1)}% contained, ${r.orphanRows} orphan rows)`), ...(drift ? { drift } : {}) }
  },
})

registerCapability({
  tool: 'ds_data',
  action: 'relationships',
  summary: 'discover foreign-key relationships between datasets by value containment (never by names alone), with cardinality and orphan counts',
  effect: 'compute',
  params: { datasets: { type: 'string|array', description: 'datasets to compare (default: all latest)' }, minContainment: { type: 'number', description: 'share of child values that must exist in the parent (default 0.9)' } },
  run(ctx) {
    const refs = list(ctx.params.datasets, 'datasets')
    const entries = refs.length ? refs.map((ref) => ctx.workspace.resolve(ref)) : ctx.workspace.latestDatasets()
    if (entries.length < 2) throw new Error('relationship discovery needs at least two datasets')
    const inputs = entries.map((entry) => { const { frame } = ctx.dataset(refOf(entry), { where: '' }); return { name: entry.name, frame, profiles: understandDataset(frame).profiles } })
    const result = discoverRelationships(inputs, typeof ctx.params.minContainment === 'number' ? ctx.params.minContainment : 0.9)
    for (const warning of result.warnings) ctx.record.warn(warning)
    ctx.record.check('relationships validated against values', 'pass', `${result.relationships.length} found among ${entries.length} datasets`)
    return {
      relationships: result.relationships,
      joinSpecs: result.relationships.map((r) => ({ op: 'join', right: r.to.dataset, leftOn: [r.from.column], rightOn: [r.to.column], how: 'left', validate: r.cardinality === 'one-to-one' ? 'one_to_one' : 'many_to_one' })),
      warnings: result.warnings,
      grains: inputs.map((input) => ({ dataset: input.name, grain: understandDataset(input.frame).grain.statement })),
    }
  },
})

registerCapability({
  tool: 'ds_data',
  action: 'transform',
  summary: `clean and reshape a dataset with a recorded pipeline, producing a new versioned dataset. Steps: select, drop, rename, filter, derive, cast, parse_number, fill_missing, drop_missing, dedupe, standardize_categories, replace, clip, bin, sort, sample, limit, aggregate, pivot, melt, window, join, union, text_clean, convert_units, retype`,
  effect: 'local-write',
  params: { dataset: DATASET, steps: { type: 'array', required: true, description: 'ordered operations, e.g. [{ "op": "filter", "where": "status == \\"paid\\"" }, { "op": "aggregate", "groupBy": ["region"], "metrics": [{ "column": "amount", "fn": "sum", "as": "revenue" }] }]' }, output: { type: 'string', required: true, description: 'name of the resulting dataset' }, description: { type: 'string', description: 'what the result represents' }, where: WHERE },
  example: { action: 'transform', dataset: 'orders', output: 'orders_clean', steps: [{ op: 'dedupe', columns: ['order_id'] }, { op: 'derive', columns: { month: 'month_start(order_date)' } }] },
  run(ctx) {
    const input = ctx.dataset(str(ctx, 'dataset'))
    const steps = ctx.params.steps as unknown[]
    const referenced = new Set<string>()
    const result = runPipeline(input.frame, steps, (ref) => {
      const loaded = ctx.dataset(ref, { where: '' })
      referenced.add(refOf(loaded.entry))
      return { ref: refOf(loaded.entry), frame: loaded.frame }
    })
    ctx.record.code('pipeline', JSON.stringify(steps, null, 1))
    for (const check of result.checks) ctx.record.check(check.name, check.status, check.detail)
    if (result.checks.length === 0) ctx.record.check('pipeline ran', 'pass', `${steps.length} steps`)
    const output = outputName(ctx, `${input.entry.name}_t`)
    const saved = ctx.saveDataset(output, result.frame, 'transform', [refOf(input.entry), ...referenced], steps, { ...(typeof ctx.params.description === 'string' ? { description: ctx.params.description } : {}), grain: understandDataset(result.frame).grain.statement })
    return { output: refOf(saved), steps: result.perStep, notes: result.notes, ...preview(result.frame) }
  },
})

registerCapability({
  tool: 'ds_data',
  action: 'sql',
  summary: 'run read-only SQL (SQLite dialect) over workspace datasets as tables; optionally save the result as a dataset',
  effect: 'compute',
  params: { query: { type: 'string', required: true, description: 'SELECT/WITH query; datasets are tables by name' }, datasets: { type: 'string|array', description: 'datasets to expose as tables (default: all latest)' }, output: { type: 'string', description: 'save the result as this dataset' }, explain: { type: 'boolean', description: 'only validate the query and return its plan' }, limit: { type: 'integer', description: 'maximum result rows (default 100,000)' } },
  example: { action: 'sql', query: "select region, strftime('%Y-%m', order_date) as month, sum(amount) as revenue from orders group by 1, 2" },
  run(ctx) {
    const query = str(ctx, 'query')
    ctx.record.code('sql', query)
    const refs = list(ctx.params.datasets, 'datasets')
    const entries = refs.length ? refs.map((ref) => ctx.workspace.resolve(ref)) : ctx.workspace.latestDatasets()
    const tables = entries.filter((entry) => refs.length || new RegExp(`\\b${entry.name}\\b`, 'i').test(query)).map((entry) => ({ name: entry.name, frame: ctx.dataset(refOf(entry), { where: '' }).frame }))
    if (ctx.params.explain === true) {
      const plan = explainFrames(tables, query)
      ctx.record.check('query compiles', 'pass', `${plan.length} plan steps`)
      return { valid: true, plan, tables: tables.map((t) => t.name) }
    }
    const result = queryFrames(tables, query, typeof ctx.params.limit === 'number' ? ctx.params.limit : 100_000)
    ctx.record.check('query returned rows', result.frame.rows.length ? 'pass' : 'warn', `${result.frame.rows.length} rows${result.truncated ? ' (truncated)' : ''}`)
    let output: string | undefined
    if (typeof ctx.params.output === 'string') output = refOf(ctx.saveDataset(outputName(ctx, 'sql_result'), result.frame, 'sql', tables.map((t) => refOf(ctx.workspace.resolve(t.name))), [{ sql: query }]))
    return { ...(output ? { output } : {}), truncated: result.truncated, ...preview(result.frame, 20) }
  },
})

registerCapability({
  tool: 'ds_data',
  action: 'export',
  summary: 'export a dataset to csv, json, jsonl, or xlsx (default location .elia/datascience/artifacts/exports/)',
  effect: (params) => (typeof params.path === 'string' ? 'local-write' : 'artifact-write'),
  params: { dataset: DATASET, format: { type: 'string', enum: ['csv', 'json', 'jsonl', 'xlsx'], description: 'file format (default csv)' }, path: { type: 'string', description: 'workspace-relative destination instead of the artifacts folder (requires approval; never overwrites a source dataset)' }, where: WHERE },
  async run(ctx) {
    const { entry, frame } = ctx.dataset(str(ctx, 'dataset'))
    const format = str(ctx, 'format', 'csv')
    let content: string | Uint8Array
    if (format === 'csv') content = frameToCsv(frame)
    else if (format === 'json') content = JSON.stringify(frame.rows, null, 1)
    else if (format === 'jsonl') content = frame.rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
    else {
      const workbook = new ExcelJS.Workbook()
      const sheet = workbook.addWorksheet(entry.name.slice(0, 31))
      sheet.addRow(frame.columns)
      for (const row of frame.rows) sheet.addRow(frame.columns.map((c) => row[c] ?? null))
      content = new Uint8Array(await workbook.xlsx.writeBuffer())
    }
    const fileName = `${entry.name}.v${entry.version}.${format}`
    if (typeof ctx.params.path === 'string') {
      if (!isPathWithinWorkspace(ctx.params.path)) throw new Error('export path must be inside the workspace')
      const target = resolveWorkspacePath(ctx.params.path)
      const sources = ctx.workspace.datasets().filter((d) => d.source?.path).map((d) => resolveWorkspacePath(d.source!.path!))
      if (sources.includes(target)) throw new Error('refusing to overwrite a source dataset; export to a new path')
      await Bun.write(target, content)
      const artifact = ctx.workspace.recordArtifact(target, 'dataset-export', ctx.record.id, `export of ${refOf(entry)}`)
      ctx.record.outputArtifact(artifact.path, artifact.sha256, artifact.bytes)
      ctx.record.check('export written', 'pass', `${frame.rows.length} rows → ${artifact.path}`)
      return { path: artifact.path, rows: frame.rows.length, sha256: artifact.sha256 }
    }
    const saved = ctx.artifact(`exports/${fileName}`, content, 'dataset-export', `export of ${refOf(entry)}`)
    ctx.record.check('export written', 'pass', `${frame.rows.length} rows → ${saved.path}`)
    return { path: saved.path, rows: frame.rows.length, sha256: saved.sha256 }
  },
})

registerCapability({
  tool: 'ds_data',
  action: 'lineage',
  summary: 'trace a dataset back to its sources: SOURCE → TRANSFORMATION → OUTPUT, with the exact steps and run ids',
  effect: 'compute',
  params: { dataset: DATASET },
  run(ctx) {
    const chain = ctx.workspace.lineage(str(ctx, 'dataset'))
    ctx.record.check('lineage resolved', 'pass', `${chain.length} nodes`)
    return { lineage: chain }
  },
})

registerCapability({
  tool: 'ds_data',
  action: 'preview',
  summary: 'show rows of a dataset (optionally filtered, sorted, and column-selected)',
  effect: 'compute',
  params: { dataset: DATASET, where: WHERE, columns: { type: 'string|array', description: 'columns to show' }, sort: { type: 'string', description: 'column to sort by (prefix with - for descending)' }, n: { type: 'integer', description: 'rows to show (default 20, max 200)' } },
  run(ctx) {
    const { entry, frame } = ctx.dataset(str(ctx, 'dataset'))
    const cols = list(ctx.params.columns, 'columns')
    let rows = frame.rows
    if (typeof ctx.params.sort === 'string') {
      const desc = ctx.params.sort.startsWith('-')
      const key = ctx.params.sort.replace(/^-/, '')
      rows = [...rows].sort((a, b) => { const x = a[key]; const y = b[key]; const c = x === y ? 0 : x === null || x === undefined ? 1 : y === null || y === undefined ? -1 : x < y ? -1 : 1; return desc ? -c : c })
    }
    const n = Math.min(200, typeof ctx.params.n === 'number' ? ctx.params.n : 20)
    const shown = { ...frame, columns: cols.length ? cols : frame.columns, rows: rows.slice(0, n) }
    ctx.record.check('preview', 'pass', `${shown.rows.length} rows`)
    return { dataset: refOf(entry), totalRows: frame.rows.length, rows: previewRows(shown, n) }
  },
})

export const TRANSFORM_HELP = transformUsage()

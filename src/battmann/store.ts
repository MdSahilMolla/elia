import { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname } from 'node:path'
import { currentAgent, resolveWorkspacePath } from '../autonomy/context.ts'
import { ensureSecureDirectory, hardenSecureFile } from '../securePersistence.ts'

const DEFAULT_STORE_PATH = '.elia/battmann.sqlite'
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/
const CLASSIFICATION_LEVELS = ['public', 'internal', 'confidential', 'restricted'] as const
type Classification = (typeof CLASSIFICATION_LEVELS)[number]
const classificationRank = (value: unknown): number => Math.max(0, CLASSIFICATION_LEVELS.indexOf(String(value ?? 'internal') as Classification))

type Row = Record<string, unknown>

function requiredText(value: unknown, name: string, max = 10_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must be a non-empty string of at most ${max} characters`)
  return value.trim()
}

function optionalText(value: unknown, name: string, max = 10_000): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return requiredText(value, name, max)
}

function identifier(value: unknown, name: string): string {
  const result = value === undefined ? randomUUID() : requiredText(value, name, 100)
  if (!ID_PATTERN.test(result)) throw new Error(`${name} must contain only letters, numbers, dot, underscore, colon, or hyphen`)
  return result
}

function isoDate(value: unknown, name: string): string {
  const raw = requiredText(value, name, 100)
  if (!Number.isFinite(Date.parse(raw))) throw new Error(`${name} must be an ISO date or timestamp`)
  return new Date(raw).toISOString()
}

function observedDate(value: unknown, name: string): string {
  const result = isoDate(value, name)
  if (Date.parse(result) > Date.now() + 60_000) throw new Error(`${name} (${result}) cannot be in the future; the current time is ${new Date().toISOString()} — pass a real past or present date, not a projected one`)
  return result
}

function probability(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.001 || value > 0.999) throw new Error(`${name} must be between 0.001 and 0.999`)
  return value
}

function boundedNumber(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`)
  return value
}

function integer(value: unknown, name: string, min: number, max: number): number {
  const result = boundedNumber(value, name, min, max)
  if (!Number.isInteger(result)) throw new Error(`${name} must be an integer`)
  return result
}

function httpUrl(value: unknown, name: string): string {
  const raw = requiredText(value, name, 2_000)
  const parsed = new URL(raw)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${name} must be an http(s) URL`)
  return raw
}

function stringArray(value: unknown, name: string, maxItems = 100): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${name} must be an array of at most ${maxItems} strings`)
  return value.map((item, index) => requiredText(item, `${name}[${index}]`, 2_000))
}

function objectArray(value: unknown, name: string, maxItems = 100): Row[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${name} must be an array of at most ${maxItems} objects`)
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${name}[${index}] must be an object`)
    return item as Row
  })
}

function jsonObject(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  const encoded = JSON.stringify(value)
  if (encoded.length > 100_000) throw new Error(`${name} is too large`)
  return value as Record<string, unknown>
}

function oneOf<T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
  const result = requiredText(value, name, 50) as T
  if (!allowed.includes(result)) throw new Error(`${name} must be one of ${allowed.join(', ')}`)
  return result
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}

function round(value: number, places = 6): number {
  return Number(value.toFixed(places))
}

function latitude(value: unknown, name: string): number {
  return boundedNumber(value, name, -90, 90)
}

function longitude(value: unknown, name: string): number {
  return boundedNumber(value, name, -180, 180)
}

/** Great-circle distance in kilometres. */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/** A read may pass `clearance`; when it does, records classified above that level are withheld. Omitting it returns everything. */
function clearanceRank(input: Row): number | null {
  if (input.clearance === undefined || input.clearance === null || input.clearance === '') return null
  return classificationRank(oneOf(input.clearance, 'clearance', CLASSIFICATION_LEVELS))
}

function withinClearance(row: Row, rank: number | null, field = 'security_classification'): boolean {
  return rank === null || classificationRank(row[field]) <= rank
}

function securityClassification(input: Row): Classification {
  return oneOf(input.securityClassification ?? 'internal', 'securityClassification', CLASSIFICATION_LEVELS)
}

/** Append one entry to the tamper-evident audit chain: each entry_hash covers the previous one. */
function appendAudit(db: Database, action: string, target: string | null, payload: Row): void {
  const agent = currentAgent()
  const createdAt = new Date().toISOString()
  const payloadCopy = { ...payload }
  delete payloadCopy.storePath
  const payloadHash = createHash('sha256').update(JSON.stringify(payloadCopy)).digest('hex')
  const previous = db.query('SELECT entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1').get() as Row | null
  const prevHash = previous ? String(previous.entry_hash) : ''
  const id = randomUUID()
  const entryHash = createHash('sha256').update([prevHash, id, action, agent.name, agent.role ?? '', target ?? '', payloadHash, createdAt].join('␟')).digest('hex')
  db.query('INSERT INTO audit_log (id, action, actor_name, actor_role, target, payload_hash, prev_hash, entry_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, action, agent.name, agent.role ?? 'lead', target, payloadHash, prevHash, entryHash, createdAt,
  )
}

function storePath(input: Row): string {
  return resolveWorkspacePath(optionalText(input.storePath, 'storePath', 1_000) ?? DEFAULT_STORE_PATH)
}

function openStore(input: Row, create: boolean): { db: Database; path: string } | undefined {
  const path = storePath(input)
  if (!create && !existsSync(path)) return undefined
  if (create) ensureSecureDirectory(dirname(path))
  const db = new Database(path, { create, strict: true })
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  if (create) {
    db.exec('PRAGMA journal_mode = WAL;')
    migrate(db)
  }
  hardenStoreFiles(path)
  return { db, path }
}

function hardenStoreFiles(path: string): void {
  hardenSecureFile(path)
  hardenSecureFile(`${path}-wal`)
  hardenSecureFile(`${path}-shm`)
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      domain TEXT NOT NULL,
      resolution_criteria TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      horizon TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','void')),
      outcome INTEGER CHECK(outcome IN (0,1)),
      resolved_at TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      publisher TEXT,
      source_type TEXT NOT NULL CHECK(source_type IN ('primary','secondary','dataset','model')),
      published_at TEXT NOT NULL,
      retrieved_at TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      independence_group TEXT NOT NULL,
      reliability REAL NOT NULL CHECK(reliability >= 0 AND reliability <= 1),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS claims (
      id TEXT PRIMARY KEY,
      statement TEXT NOT NULL,
      classification TEXT NOT NULL CHECK(classification IN ('observed_fact','reproducible_calculation','model_estimate','judgement')),
      confidence TEXT NOT NULL CHECK(confidence IN ('low','medium','high')),
      as_of TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS claim_evidence (
      claim_id TEXT NOT NULL REFERENCES claims(id),
      evidence_id TEXT NOT NULL REFERENCES evidence(id),
      relation TEXT NOT NULL CHECK(relation IN ('supports','contradicts','context')),
      supporting_excerpt TEXT NOT NULL,
      PRIMARY KEY(claim_id, evidence_id, relation)
    );
    CREATE TABLE IF NOT EXISTS claim_reviews (
      id TEXT PRIMARY KEY,
      claim_id TEXT NOT NULL REFERENCES claims(id),
      verdict TEXT NOT NULL CHECK(verdict IN ('supported','contradicted','unclear')),
      reviewer TEXT NOT NULL,
      reviewed_at TEXT NOT NULL,
      notes TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS forecast_revisions (
      id TEXT PRIMARY KEY,
      question_id TEXT NOT NULL REFERENCES questions(id),
      revision INTEGER NOT NULL,
      probability REAL NOT NULL CHECK(probability > 0 AND probability < 1),
      prior_probability REAL,
      as_of TEXT NOT NULL,
      method TEXT NOT NULL,
      model TEXT,
      forecaster TEXT NOT NULL,
      rationale TEXT NOT NULL,
      evidence_ids_json TEXT NOT NULL,
      forecast_class TEXT NOT NULL DEFAULT 'live' CHECK(forecast_class IN ('live','backtest')),
      parent_revision_id TEXT REFERENCES forecast_revisions(id),
      created_at TEXT NOT NULL,
      UNIQUE(question_id, revision)
    );
    CREATE INDEX IF NOT EXISTS forecast_question_asof ON forecast_revisions(question_id, as_of);
    CREATE TABLE IF NOT EXISTS resolution_events (
      id TEXT PRIMARY KEY,
      question_id TEXT NOT NULL REFERENCES questions(id),
      status TEXT NOT NULL CHECK(status IN ('accepted','disputed','void')),
      outcome INTEGER CHECK(outcome IN (0,1)),
      resolved_at TEXT NOT NULL,
      source_url TEXT NOT NULL,
      resolver TEXT NOT NULL,
      rationale TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ontology_objects (
      id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      confidence TEXT NOT NULL CHECK(confidence IN ('low','medium','high')),
      properties_json TEXT NOT NULL,
      evidence_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(id, revision)
    );
    CREATE TABLE IF NOT EXISTS ontology_links (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      type TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      confidence TEXT NOT NULL CHECK(confidence IN ('low','medium','high')),
      properties_json TEXT NOT NULL,
      evidence_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scenarios (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      base_as_of TEXT NOT NULL,
      horizon TEXT NOT NULL,
      probability REAL NOT NULL CHECK(probability > 0 AND probability < 1),
      assumptions_json TEXT NOT NULL,
      question_ids_json TEXT NOT NULL,
      evidence_ids_json TEXT NOT NULL,
      indicators_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft','active','superseded','resolved')),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      scenario_id TEXT REFERENCES scenarios(id),
      title TEXT NOT NULL,
      options_json TEXT NOT NULL,
      chosen_option TEXT,
      rationale TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('proposed','approved','rejected','executed')),
      approved_by TEXT,
      decided_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outcomes (
      id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL REFERENCES decisions(id),
      observed_at TEXT NOT NULL,
      summary TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      evidence_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS benchmark_runs (
      id TEXT PRIMARY KEY,
      evaluation_start TEXT NOT NULL,
      evaluation_end TEXT NOT NULL,
      minimum_training INTEGER NOT NULL,
      results_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS datasets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK(source_type IN ('ingested','derived','external-feed')),
      uri TEXT,
      row_count INTEGER,
      content_hash TEXT NOT NULL,
      parent_dataset_id TEXT REFERENCES datasets(id),
      transform TEXT,
      as_of TEXT NOT NULL,
      security_classification TEXT NOT NULL DEFAULT 'internal' CHECK(security_classification IN ('public','internal','confidential','restricted')),
      evidence_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS action_types (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applies_to TEXT NOT NULL,
      parameters_schema_json TEXT NOT NULL,
      requires_clearance TEXT NOT NULL DEFAULT 'confidential' CHECK(requires_clearance IN ('public','internal','confidential','restricted')),
      description TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS action_proposals (
      id TEXT PRIMARY KEY,
      action_type_id TEXT NOT NULL REFERENCES action_types(id),
      target_object_id TEXT,
      parameters_json TEXT NOT NULL,
      rationale TEXT NOT NULL,
      proposed_by TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','withdrawn')),
      decided_by TEXT,
      decided_at TEXT,
      decision_notes TEXT,
      proposal_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS geo_events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      latitude REAL NOT NULL CHECK(latitude >= -90 AND latitude <= 90),
      longitude REAL NOT NULL CHECK(longitude >= -180 AND longitude <= 180),
      occurred_at TEXT NOT NULL,
      severity INTEGER NOT NULL CHECK(severity >= 0 AND severity <= 100),
      affected_object_ids_json TEXT NOT NULL,
      source_url TEXT NOT NULL,
      security_classification TEXT NOT NULL DEFAULT 'internal' CHECK(security_classification IN ('public','internal','confidential','restricted')),
      evidence_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deployment_targets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('air-gap-export','sovereign-cloud','edge-node')),
      max_classification TEXT NOT NULL CHECK(max_classification IN ('public','internal','confidential','restricted')),
      formats_json TEXT NOT NULL,
      notes TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deployment_stages (
      id TEXT PRIMARY KEY,
      target_id TEXT NOT NULL REFERENCES deployment_targets(id),
      version INTEGER NOT NULL,
      report_path TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      staged_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(target_id, version)
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor_name TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      target TEXT,
      payload_hash TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      entry_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS indicators (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      unit TEXT NOT NULL,
      frequency TEXT NOT NULL CHECK(frequency IN ('daily','weekly','monthly','quarterly','annual','irregular')),
      higher_is TEXT NOT NULL CHECK(higher_is IN ('risk-on','risk-off','neutral')),
      source_name TEXT NOT NULL,
      security_classification TEXT NOT NULL DEFAULT 'internal' CHECK(security_classification IN ('public','internal','confidential','restricted')),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS indicator_readings (
      id TEXT PRIMARY KEY,
      indicator_id TEXT NOT NULL REFERENCES indicators(id),
      observed_at TEXT NOT NULL,
      value REAL NOT NULL,
      source_url TEXT NOT NULL,
      evidence_id TEXT REFERENCES evidence(id),
      created_at TEXT NOT NULL,
      UNIQUE(indicator_id, observed_at)
    );
  `)
  const forecastColumns = db.query('PRAGMA table_info(forecast_revisions)').all() as Row[]
  if (!forecastColumns.some((column) => column.name === 'forecast_class')) db.exec("ALTER TABLE forecast_revisions ADD COLUMN forecast_class TEXT NOT NULL DEFAULT 'live' CHECK(forecast_class IN ('live','backtest'))")
  const addColumn = (table: string, column: string, definition: string) => {
    if (!(db.query(`PRAGMA table_info(${table})`).all() as Row[]).some((row) => row.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
  // Cell-level classification is metadata on the sensitive records; reads that pass a clearance level filter above it.
  addColumn('evidence', 'security_classification', "TEXT NOT NULL DEFAULT 'internal'")
  addColumn('claims', 'security_classification', "TEXT NOT NULL DEFAULT 'internal'")
  addColumn('ontology_objects', 'security_classification', "TEXT NOT NULL DEFAULT 'internal'")
  addColumn('ontology_links', 'security_classification', "TEXT NOT NULL DEFAULT 'internal'")
  addColumn('ontology_objects', 'latitude', 'REAL')
  addColumn('ontology_objects', 'longitude', 'REAL')
  db.exec('PRAGMA user_version = 5;')
}

function withStore<T>(input: Row, create: boolean, operation: (db: Database, path: string) => T): T {
  const opened = openStore(input, create)
  if (!opened) throw new Error('Battmann store does not exist yet; create a question or evidence record first')
  try { return operation(opened.db, opened.path) } finally { opened.db.close(); hardenStoreFiles(opened.path) }
}

function transaction<T>(db: Database, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function assertEvidence(db: Database, ids: string[], asOf?: string): void {
  if (!ids.length) throw new Error('at least one evidence id is required')
  for (const id of new Set(ids)) {
    const row = db.query('SELECT id, published_at, retrieved_at FROM evidence WHERE id = ?').get(id) as Row | null
    if (!row) throw new Error(`unknown evidence id: ${id}`)
    if (asOf && (String(row.published_at) > asOf || String(row.retrieved_at) > asOf)) throw new Error(`evidence ${id} (published ${row.published_at}, retrieved ${row.retrieved_at}) was not available by the asOf time ${asOf}; set asOf to when the analysis is being made, not a past cutoff`)
  }
}

function currentObject(db: Database, id: string): Row | null {
  return db.query('SELECT * FROM ontology_objects WHERE id = ? ORDER BY revision DESC LIMIT 1').get(id) as Row | null
}

function createQuestion(input: Row): Row {
  return withStore(input, true, (db, path) => transaction(db, () => {
    const id = identifier(input.questionId, 'questionId')
    const openedAt = observedDate(input.openedAt ?? input.asOf, 'openedAt')
    const horizon = isoDate(input.horizon, 'horizon')
    if (horizon <= openedAt) throw new Error('horizon must be after openedAt')
    const createdAt = new Date().toISOString()
    db.query('INSERT INTO questions (id, question, domain, resolution_criteria, opened_at, horizon, tags_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, requiredText(input.question, 'question'), requiredText(input.domain ?? 'strategic-intelligence', 'domain', 100), requiredText(input.resolutionCriteria, 'resolutionCriteria'), openedAt, horizon, JSON.stringify(stringArray(input.tags, 'tags', 30)), createdAt,
    )
    return { status: 'created', storePath: path, questionId: id, openedAt, horizon }
  }))
}

function registerEvidence(input: Row): Row {
  return withStore(input, true, (db, path) => transaction(db, () => {
    const id = identifier(input.evidenceId, 'evidenceId')
    const publishedAt = isoDate(input.publishedAt, 'publishedAt')
    const retrievedAt = observedDate(input.retrievedAt, 'retrievedAt')
    if (publishedAt > retrievedAt) throw new Error('publishedAt cannot be after retrievedAt')
    const excerpt = requiredText(input.excerpt, 'excerpt', 4_000)
    const contentHash = createHash('sha256').update(excerpt).digest('hex')
    db.query('INSERT INTO evidence (id, title, url, publisher, source_type, published_at, retrieved_at, excerpt, content_hash, independence_group, reliability, security_classification, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, requiredText(input.title, 'title', 500), httpUrl(input.url, 'url'), optionalText(input.publisher, 'publisher', 300) ?? null, oneOf(input.sourceType ?? 'primary', 'sourceType', ['primary', 'secondary', 'dataset', 'model'] as const), publishedAt, retrievedAt, excerpt, contentHash, requiredText(input.independenceGroup, 'independenceGroup', 100), boundedNumber(input.reliability, 'reliability', 0, 1), securityClassification(input), new Date().toISOString(),
    )
    return { status: 'created', storePath: path, evidenceId: id, contentHash, securityClassification: securityClassification(input) }
  }))
}

function registerClaim(input: Row): Row {
  return withStore(input, true, (db, path) => transaction(db, () => {
    const id = identifier(input.claimId, 'claimId')
    const asOf = observedDate(input.asOf, 'asOf')
    const links = objectArray(input.evidenceLinks, 'evidenceLinks', 30).map((link, index) => ({
      evidenceId: identifier(link.evidenceId, `evidenceLinks[${index}].evidenceId`),
      relation: oneOf(link.relation ?? 'supports', `evidenceLinks[${index}].relation`, ['supports', 'contradicts', 'context'] as const),
      supportingExcerpt: requiredText(link.supportingExcerpt, `evidenceLinks[${index}].supportingExcerpt`, 2_000),
    }))
    assertEvidence(db, links.map((link) => link.evidenceId), asOf)
    db.query('INSERT INTO claims (id, statement, classification, confidence, as_of, security_classification, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id, requiredText(input.statement, 'statement'), oneOf(input.classification, 'classification', ['observed_fact', 'reproducible_calculation', 'model_estimate', 'judgement'] as const), oneOf(input.confidence, 'confidence', ['low', 'medium', 'high'] as const), asOf, securityClassification(input), new Date().toISOString(),
    )
    const insert = db.query('INSERT INTO claim_evidence (claim_id, evidence_id, relation, supporting_excerpt) VALUES (?, ?, ?, ?)')
    for (const link of links) insert.run(id, link.evidenceId, link.relation, link.supportingExcerpt)
    return { status: 'created', storePath: path, claimId: id, evidenceLinks: links.length, reviewStatus: 'unreviewed' }
  }))
}

function reviewClaim(input: Row): Row {
  return withStore(input, true, (db, path) => transaction(db, () => {
    const claimId = identifier(input.claimId, 'claimId')
    const claim = db.query('SELECT id, as_of FROM claims WHERE id = ?').get(claimId) as Row | null
    if (!claim) throw new Error(`unknown claim id: ${claimId}`)
    const reviewId = identifier(input.reviewId, 'reviewId')
    const reviewedAt = observedDate(input.reviewedAt, 'reviewedAt')
    if (reviewedAt < String(claim.as_of)) throw new Error('reviewedAt cannot be before claim asOf')
    const verdict = oneOf(input.verdict, 'verdict', ['supported', 'contradicted', 'unclear'] as const)
    db.query('INSERT INTO claim_reviews (id, claim_id, verdict, reviewer, reviewed_at, notes) VALUES (?, ?, ?, ?, ?, ?)').run(
      reviewId, claimId, verdict, requiredText(input.reviewer, 'reviewer', 200), reviewedAt, requiredText(input.notes, 'notes', 5_000),
    )
    return { status: 'recorded', storePath: path, reviewId, claimId, verdict }
  }))
}

function submitForecast(input: Row): Row {
  return withStore(input, true, (db, path) => transaction(db, () => {
    const questionId = identifier(input.questionId, 'questionId')
    const question = db.query('SELECT * FROM questions WHERE id = ?').get(questionId) as Row | null
    if (!question) throw new Error(`unknown question id: ${questionId}`)
    if (question.status !== 'open') throw new Error(`question ${questionId} is not open`)
    const asOf = observedDate(input.asOf, 'asOf')
    if (asOf < String(question.opened_at) || asOf > String(question.horizon)) throw new Error('forecast asOf must be between question openedAt and horizon')
    const evidenceIds = stringArray(input.evidenceIds, 'evidenceIds', 100).map((id, index) => identifier(id, `evidenceIds[${index}]`))
    assertEvidence(db, evidenceIds, asOf)
    const previous = db.query('SELECT id, revision FROM forecast_revisions WHERE question_id = ? ORDER BY revision DESC LIMIT 1').get(questionId) as Row | null
    const revision = previous ? Number(previous.revision) + 1 : 1
    const forecastId = identifier(input.forecastId, 'forecastId')
    const value = probability(input.probability, 'probability')
    const prior = input.priorProbability === undefined ? null : probability(input.priorProbability, 'priorProbability')
    const forecastClass = oneOf(input.forecastClass ?? 'live', 'forecastClass', ['live', 'backtest'] as const)
    db.query('INSERT INTO forecast_revisions (id, question_id, revision, probability, prior_probability, as_of, method, model, forecaster, rationale, evidence_ids_json, forecast_class, parent_revision_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      forecastId, questionId, revision, value, prior, asOf, requiredText(input.method, 'method', 500), optionalText(input.model, 'model', 300) ?? null, requiredText(input.forecaster, 'forecaster', 200), requiredText(input.rationale, 'rationale', 10_000), JSON.stringify([...new Set(evidenceIds)]), forecastClass, previous ? String(previous.id) : null, new Date().toISOString(),
    )
    return { status: 'recorded', storePath: path, forecastId, questionId, revision, probability: value, forecastClass, parentRevisionId: previous?.id ?? null }
  }))
}

function resolveQuestion(input: Row): Row {
  return withStore(input, true, (db, path) => transaction(db, () => {
    const questionId = identifier(input.questionId, 'questionId')
    const question = db.query('SELECT * FROM questions WHERE id = ?').get(questionId) as Row | null
    if (!question) throw new Error(`unknown question id: ${questionId}`)
    const status = oneOf(input.resolutionStatus ?? 'accepted', 'resolutionStatus', ['accepted', 'disputed', 'void'] as const)
    if (status !== 'disputed' && question.status !== 'open') throw new Error(`question ${questionId} already has a terminal resolution`)
    const outcome = status === 'accepted' ? boundedNumber(input.outcome, 'outcome', 0, 1) : null
    if (outcome !== null && outcome !== 0 && outcome !== 1) throw new Error('outcome must be 0 or 1')
    const resolvedAt = observedDate(input.resolvedAt, 'resolvedAt')
    if (resolvedAt < String(question.opened_at)) throw new Error('resolvedAt cannot be before openedAt')
    const resolutionId = identifier(input.resolutionId, 'resolutionId')
    db.query('INSERT INTO resolution_events (id, question_id, status, outcome, resolved_at, source_url, resolver, rationale) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      resolutionId, questionId, status, outcome, resolvedAt, httpUrl(input.resolutionSourceUrl, 'resolutionSourceUrl'), requiredText(input.resolver, 'resolver', 200), requiredText(input.rationale, 'rationale', 10_000),
    )
    if (status === 'accepted') db.query("UPDATE questions SET status = 'resolved', outcome = ?, resolved_at = ? WHERE id = ?").run(outcome, resolvedAt, questionId)
    if (status === 'void') db.query("UPDATE questions SET status = 'void', outcome = NULL, resolved_at = ? WHERE id = ?").run(resolvedAt, questionId)
    return { status: 'recorded', storePath: path, resolutionId, questionId, resolutionStatus: status, outcome }
  }))
}

function questionDetail(input: Row): Row {
  return withStore(input, false, (db, path) => {
    const questionId = identifier(input.questionId, 'questionId')
    const question = db.query('SELECT * FROM questions WHERE id = ?').get(questionId) as Row | null
    if (!question) throw new Error(`unknown question id: ${questionId}`)
    const forecasts = db.query('SELECT * FROM forecast_revisions WHERE question_id = ? ORDER BY revision').all(questionId) as Row[]
    const resolutions = db.query('SELECT * FROM resolution_events WHERE question_id = ? ORDER BY resolved_at').all(questionId) as Row[]
    return { storePath: path, question: hydrateQuestion(question), forecasts: forecasts.map(hydrateForecast), resolutions }
  })
}

function listQuestions(input: Row): Row {
  const opened = openStore(input, false)
  if (!opened) return { storePath: storePath(input), questions: [] }
  try {
    const status = input.status === undefined ? undefined : oneOf(input.status, 'status', ['open', 'resolved', 'void'] as const)
    const rows = (status ? opened.db.query('SELECT * FROM questions WHERE status = ? ORDER BY horizon').all(status) : opened.db.query('SELECT * FROM questions ORDER BY horizon').all()) as Row[]
    return { storePath: opened.path, questions: rows.map(hydrateQuestion) }
  } finally { opened.db.close() }
}

function hydrateQuestion(row: Row): Row {
  return { id: row.id, question: row.question, domain: row.domain, resolutionCriteria: row.resolution_criteria, openedAt: row.opened_at, horizon: row.horizon, status: row.status, outcome: row.outcome, resolvedAt: row.resolved_at, tags: parseJson(row.tags_json, []) }
}

function hydrateForecast(row: Row): Row {
  return { id: row.id, questionId: row.question_id, revision: row.revision, probability: row.probability, priorProbability: row.prior_probability, asOf: row.as_of, method: row.method, model: row.model, forecaster: row.forecaster, rationale: row.rationale, evidenceIds: parseJson(row.evidence_ids_json, []), forecastClass: row.forecast_class ?? 'live', parentRevisionId: row.parent_revision_id, recordedAt: row.created_at }
}

interface ScoredForecast { questionId: string; probability: number; outcome: number; asOf: string; domain: string; resolvedAt: string; recordedAt: string; forecastClass: 'live' | 'backtest' }

function resolvedLatestForecasts(db: Database, forecastClass: 'live' | 'backtest' = 'live'): ScoredForecast[] {
  const questions = db.query("SELECT * FROM questions WHERE status = 'resolved' ORDER BY id").all() as Row[]
  const rows: ScoredForecast[] = []
  for (const question of questions) {
    const resolutionTime = String(question.resolved_at ?? question.horizon)
    const forecast = (forecastClass === 'live'
      ? db.query('SELECT probability, as_of, created_at, forecast_class FROM forecast_revisions WHERE question_id = ? AND as_of <= ? AND created_at <= ? AND forecast_class = ? ORDER BY as_of DESC, revision DESC LIMIT 1').get(String(question.id), resolutionTime, resolutionTime, forecastClass)
      : db.query('SELECT probability, as_of, created_at, forecast_class FROM forecast_revisions WHERE question_id = ? AND as_of <= ? AND forecast_class = ? ORDER BY as_of DESC, revision DESC LIMIT 1').get(String(question.id), resolutionTime, forecastClass)) as Row | null
    if (forecast) rows.push({ questionId: String(question.id), probability: Number(forecast.probability), outcome: Number(question.outcome), asOf: String(forecast.as_of), domain: String(question.domain), resolvedAt: String(question.resolved_at), recordedAt: String(forecast.created_at), forecastClass })
  }
  return rows
}

function scoreRows(rows: ScoredForecast[]): Row {
  if (!rows.length) return { sampleSize: 0, brierScore: null, logLoss: null, baseRate: null, baselineBrierScore: null, brierSkillScore: null, calibrationBins: [], warning: 'No resolved questions with eligible forecasts.' }
  const round = (value: number) => Number(value.toFixed(6))
  const brier = rows.reduce((sum, row) => sum + (row.probability - row.outcome) ** 2, 0) / rows.length
  const logLoss = -rows.reduce((sum, row) => sum + row.outcome * Math.log(row.probability) + (1 - row.outcome) * Math.log(1 - row.probability), 0) / rows.length
  const baseRate = rows.reduce((sum, row) => sum + row.outcome, 0) / rows.length
  const baseline = rows.reduce((sum, row) => sum + (baseRate - row.outcome) ** 2, 0) / rows.length
  const calibrationBins = Array.from({ length: 10 }, (_, index) => {
    const selected = rows.filter((row) => Math.min(9, Math.floor(row.probability * 10)) === index)
    return selected.length ? { range: `${index * 10}-${(index + 1) * 10}%`, count: selected.length, meanForecast: round(selected.reduce((sum, row) => sum + row.probability, 0) / selected.length), observedRate: round(selected.reduce((sum, row) => sum + row.outcome, 0) / selected.length) } : undefined
  }).filter(Boolean)
  const reliability = calibrationBins.reduce((sum, raw) => {
    const bin = raw as { count: number; meanForecast: number; observedRate: number }
    return sum + (bin.count / rows.length) * (bin.meanForecast - bin.observedRate) ** 2
  }, 0)
  const resolution = calibrationBins.reduce((sum, raw) => {
    const bin = raw as { count: number; observedRate: number }
    return sum + (bin.count / rows.length) * (bin.observedRate - baseRate) ** 2
  }, 0)
  const expectedCalibrationError = calibrationBins.reduce((sum, raw) => {
    const bin = raw as { count: number; meanForecast: number; observedRate: number }
    return sum + (bin.count / rows.length) * Math.abs(bin.meanForecast - bin.observedRate)
  }, 0)
  const meanProbability = rows.reduce((sum, row) => sum + row.probability, 0) / rows.length
  const sharpness = Math.sqrt(rows.reduce((sum, row) => sum + (row.probability - meanProbability) ** 2, 0) / rows.length)
  return {
    sampleSize: rows.length,
    brierScore: round(brier),
    logLoss: round(logLoss),
    baseRate: round(baseRate),
    baselineBrierScore: round(baseline),
    brierSkillScore: baseline > 0 ? round(1 - brier / baseline) : null,
    expectedCalibrationError: round(expectedCalibrationError),
    sharpness: round(sharpness),
    brierDecomposition: { reliability: round(reliability), resolution: round(resolution), uncertainty: round(baseRate * (1 - baseRate)) },
    calibrationBins,
    warning: rows.length < 100 ? 'Sample is too small for a production accuracy claim.' : undefined,
  }
}

function scorecard(input: Row): Row {
  const opened = openStore(input, false)
  if (!opened) return { storePath: storePath(input), ...scoreRows([]) }
  try {
    const rows = resolvedLatestForecasts(opened.db)
    const domains = [...new Set(rows.map((row) => row.domain))]
    return { storePath: opened.path, scoringPolicy: 'Latest forecast whose declared asOf and physical recordedAt are both at or before accepted resolution time; forecasts after the horizon are rejected at write time.', ...scoreRows(rows), byDomain: domains.map((domain) => ({ domain, ...scoreRows(rows.filter((row) => row.domain === domain)) })) }
  } finally { opened.db.close() }
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function pairedInterval(values: number[]): { mean: number; lower95: number | null; upper95: number | null } {
  const round = (value: number) => Number(value.toFixed(6))
  const average = mean(values)
  if (values.length < 2) return { mean: round(average), lower95: null, upper95: null }
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1)
  const margin = 1.96 * Math.sqrt(variance / values.length)
  return { mean: round(average), lower95: round(average - margin), upper95: round(average + margin) }
}

function runBenchmark(input: Row): Row {
  return withStore(input, true, (db, path) => transaction(db, () => {
    const forecastClass = oneOf(input.forecastClass ?? 'live', 'forecastClass', ['live', 'backtest'] as const)
    const rows = resolvedLatestForecasts(db, forecastClass).sort((a, b) => a.asOf.localeCompare(b.asOf) || a.questionId.localeCompare(b.questionId))
    if (!rows.length) throw new Error('benchmark requires at least one resolved question with an eligible forecast')
    const resolutionTimes = rows.map((row) => row.resolvedAt).sort()
    const evaluationStart = input.evaluationStart === undefined ? resolutionTimes[0]! : isoDate(input.evaluationStart, 'evaluationStart')
    const evaluationEnd = input.evaluationEnd === undefined ? resolutionTimes[resolutionTimes.length - 1]! : isoDate(input.evaluationEnd, 'evaluationEnd')
    if (evaluationEnd < evaluationStart) throw new Error('evaluationEnd must not be before evaluationStart')
    const minimumTraining = input.minimumTraining === undefined ? 10 : integer(input.minimumTraining, 'minimumTraining', 0, 100_000)
    const evaluated = rows.filter((row) => row.resolvedAt >= evaluationStart && row.resolvedAt <= evaluationEnd)
    if (!evaluated.length) throw new Error('no resolved forecasts fall inside the evaluation window')
    const cases = evaluated.map((row) => {
      const domainHistory = rows.filter((candidate) => candidate.domain === row.domain && candidate.resolvedAt < row.asOf)
      const globalHistory = rows.filter((candidate) => candidate.resolvedAt < row.asOf)
      const training = domainHistory.length >= minimumTraining ? domainHistory : globalHistory.length >= minimumTraining ? globalHistory : []
      const historicalProbability = training.length ? mean(training.map((candidate) => candidate.outcome)) : 0.5
      const modelLoss = (row.probability - row.outcome) ** 2
      const historicalLoss = (historicalProbability - row.outcome) ** 2
      return { ...row, historicalProbability, trainingSampleSize: training.length, baselineScope: training === domainHistory ? 'domain' : training === globalHistory ? 'global' : 'uninformed-0.5', modelBrier: modelLoss, historicalBrier: historicalLoss, pairedImprovement: historicalLoss - modelLoss }
    })
    const modelBrier = mean(cases.map((item) => item.modelBrier))
    const historicalBrier = mean(cases.map((item) => item.historicalBrier))
    const results = {
      sampleSize: cases.length,
      evaluationStart,
      evaluationEnd,
      minimumTraining,
      forecastClass,
      modelBrierScore: Number(modelBrier.toFixed(6)),
      chronologicalBaselineBrierScore: Number(historicalBrier.toFixed(6)),
      brierSkillScore: historicalBrier > 0 ? Number((1 - modelBrier / historicalBrier).toFixed(6)) : null,
      pairedBrierImprovement: pairedInterval(cases.map((item) => item.pairedImprovement)),
      leakageAudit: {
        policy: 'Each baseline uses only outcomes whose accepted resolution time is earlier than the evaluated forecast asOf time.',
        violations: 0,
        fallbackToUninformedCount: cases.filter((item) => item.baselineScope === 'uninformed-0.5').length,
      },
      byDomain: [...new Set(cases.map((item) => item.domain))].map((domain) => {
        const selected = cases.filter((item) => item.domain === domain)
        return { domain, sampleSize: selected.length, modelBrierScore: Number(mean(selected.map((item) => item.modelBrier)).toFixed(6)), baselineBrierScore: Number(mean(selected.map((item) => item.historicalBrier)).toFixed(6)), pairedBrierImprovement: pairedInterval(selected.map((item) => item.pairedImprovement)) }
      }),
      cases: cases.map(({ questionId, domain, asOf, resolvedAt, probability, outcome, historicalProbability, trainingSampleSize, baselineScope }) => ({ questionId, domain, asOf, resolvedAt, probability, outcome, historicalProbability, trainingSampleSize, baselineScope })),
      statisticalGatePassed: forecastClass === 'live' && cases.length >= 500 && (pairedInterval(cases.map((item) => item.pairedImprovement)).lower95 ?? -1) > 0,
      warning: forecastClass === 'backtest'
        ? 'Historical backtest results cannot establish live forecast superiority.'
        : cases.length < 500
          ? 'Fewer than 500 live held-out resolutions: do not claim forecast superiority.'
          : (pairedInterval(cases.map((item) => item.pairedImprovement)).lower95 ?? -1) <= 0
            ? 'The paired 95% interval does not show positive Brier improvement: do not claim forecast superiority.'
            : 'The internal statistical gate passed, but independent external evaluation is still required before a public superiority claim.',
    }
    const benchmarkId = identifier(input.benchmarkId, 'benchmarkId')
    db.query('INSERT INTO benchmark_runs (id, evaluation_start, evaluation_end, minimum_training, results_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(benchmarkId, evaluationStart, evaluationEnd, minimumTraining, JSON.stringify(results), new Date().toISOString())
    return { status: 'recorded', storePath: path, benchmarkId, ...results }
  }))
}

function upsertObject(input: Row): Row {
  return withStore(input, true, (db, path) => transaction(db, () => {
    const id = identifier(input.objectId, 'objectId')
    const previous = currentObject(db, id)
    const revision = previous ? Number(previous.revision) + 1 : 1
    const validFrom = isoDate(input.validFrom ?? input.asOf, 'validFrom')
    const validTo = input.validTo === undefined ? null : isoDate(input.validTo, 'validTo')
    if (validTo && validTo <= validFrom) throw new Error('validTo must be after validFrom')
    const evidenceIds = stringArray(input.evidenceIds, 'evidenceIds').map((value, index) => identifier(value, `evidenceIds[${index}]`))
    assertEvidence(db, evidenceIds, validFrom)
    const prevLat = previous && previous.latitude !== null && previous.latitude !== undefined ? Number(previous.latitude) : null
    const prevLon = previous && previous.longitude !== null && previous.longitude !== undefined ? Number(previous.longitude) : null
    const lat = input.latitude === undefined ? prevLat : latitude(input.latitude, 'latitude')
    const lon = input.longitude === undefined ? prevLon : longitude(input.longitude, 'longitude')
    if ((lat === null) !== (lon === null)) throw new Error('latitude and longitude must be supplied together')
    db.query('INSERT INTO ontology_objects (id, revision, type, name, valid_from, valid_to, confidence, security_classification, latitude, longitude, properties_json, evidence_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, revision, requiredText(input.objectType, 'objectType', 100), requiredText(input.name, 'name', 500), validFrom, validTo, oneOf(input.confidence, 'confidence', ['low', 'medium', 'high'] as const), securityClassification(input), lat, lon, JSON.stringify(jsonObject(input.properties, 'properties')), JSON.stringify([...new Set(evidenceIds)]), new Date().toISOString(),
    )
    return { status: previous ? 'revised' : 'created', storePath: path, objectId: id, revision }
  }))
}

function linkObjects(input: Row): Row {
  return withStore(input, true, (db, path) => transaction(db, () => {
    const fromId = identifier(input.fromId, 'fromId'); const toId = identifier(input.toId, 'toId')
    if (!currentObject(db, fromId)) throw new Error(`unknown ontology object: ${fromId}`)
    if (!currentObject(db, toId)) throw new Error(`unknown ontology object: ${toId}`)
    const validFrom = isoDate(input.validFrom ?? input.asOf, 'validFrom')
    const validTo = input.validTo === undefined ? null : isoDate(input.validTo, 'validTo')
    if (validTo && validTo <= validFrom) throw new Error('validTo must be after validFrom')
    const evidenceIds = stringArray(input.evidenceIds, 'evidenceIds').map((value, index) => identifier(value, `evidenceIds[${index}]`))
    assertEvidence(db, evidenceIds, validFrom)
    const linkId = identifier(input.linkId, 'linkId')
    db.query('INSERT INTO ontology_links (id, from_id, to_id, type, valid_from, valid_to, confidence, security_classification, properties_json, evidence_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      linkId, fromId, toId, requiredText(input.linkType, 'linkType', 100), validFrom, validTo, oneOf(input.confidence, 'confidence', ['low', 'medium', 'high'] as const), securityClassification(input), JSON.stringify(jsonObject(input.properties, 'properties')), JSON.stringify([...new Set(evidenceIds)]), new Date().toISOString(),
    )
    return { status: 'created', storePath: path, linkId, fromId, toId }
  }))
}

function hydrateObject(row: Row): Row {
  return { id: row.id, revision: row.revision, type: row.type, name: row.name, validFrom: row.valid_from, validTo: row.valid_to, confidence: row.confidence, securityClassification: row.security_classification ?? 'internal', latitude: row.latitude ?? null, longitude: row.longitude ?? null, properties: parseJson(row.properties_json, {}), evidenceIds: parseJson(row.evidence_ids_json, []), recordedAt: row.created_at }
}

function hydrateLink(row: Row): Row {
  return { id: row.id, fromId: row.from_id, toId: row.to_id, type: row.type, validFrom: row.valid_from, validTo: row.valid_to, confidence: row.confidence, securityClassification: row.security_classification ?? 'internal', properties: parseJson(row.properties_json, {}), evidenceIds: parseJson(row.evidence_ids_json, []), recordedAt: row.created_at }
}

/** A revision or link is in force at `asOf` when its validity window covers that instant; with no `asOf` everything is in force. */
function activeAt(row: Row, asOf: string | undefined): boolean {
  if (!asOf) return true
  return String(row.valid_from) <= asOf && (row.valid_to === null || row.valid_to === undefined || String(row.valid_to) > asOf)
}

function objectRevisionAt(revisions: Row[], asOf: string | undefined): Row | null {
  if (!revisions.length) return null
  if (!asOf) return revisions[revisions.length - 1]!
  return [...revisions].reverse().find((row) => String(row.valid_from) <= asOf) ?? null
}

function objectDetail(input: Row): Row {
  return withStore(input, false, (db, path) => {
    const objectId = identifier(input.objectId, 'objectId')
    const asOf = input.asOf === undefined ? undefined : isoDate(input.asOf, 'asOf')
    const revisions = db.query('SELECT * FROM ontology_objects WHERE id = ? ORDER BY revision').all(objectId) as Row[]
    if (!revisions.length) throw new Error(`unknown ontology object: ${objectId}`)
    const current = objectRevisionAt(revisions, asOf)
    if (!current) throw new Error(`ontology object ${objectId} has no revision valid at ${asOf}`)
    const rank = clearanceRank(input)
    if (!withinClearance(current, rank)) throw new Error(`ontology object ${objectId} is classified above the supplied clearance`)
    const nameOf = (id: string) => { const row = currentObject(db, id); return row ? String(row.name) : null }
    const cleared = new Set(clearedLinks(db, rank, asOf).map((row) => String(row.id)))
    const outgoing = db.query('SELECT * FROM ontology_links WHERE from_id = ? ORDER BY created_at').all(objectId) as Row[]
    const incoming = db.query('SELECT * FROM ontology_links WHERE to_id = ? ORDER BY created_at').all(objectId) as Row[]
    return {
      storePath: path,
      object: hydrateObject(current),
      revisionHistory: revisions.map((row) => ({ revision: row.revision, name: row.name, validFrom: row.valid_from, validTo: row.valid_to, confidence: row.confidence, recordedAt: row.created_at })),
      outgoingLinks: outgoing.filter((row) => activeAt(row, asOf) && cleared.has(String(row.id))).map((row) => ({ ...hydrateLink(row), counterpart: { id: row.to_id, name: nameOf(String(row.to_id)) } })),
      incomingLinks: incoming.filter((row) => activeAt(row, asOf) && cleared.has(String(row.id))).map((row) => ({ ...hydrateLink(row), counterpart: { id: row.from_id, name: nameOf(String(row.from_id)) } })),
    }
  })
}

function listObjects(input: Row): Row {
  const opened = openStore(input, false)
  if (!opened) return { storePath: storePath(input), objects: [] }
  try {
    const objectType = optionalText(input.objectType, 'objectType', 100)
    const asOf = input.asOf === undefined ? undefined : isoDate(input.asOf, 'asOf')
    const ids = (opened.db.query('SELECT DISTINCT id FROM ontology_objects').all() as Row[]).map((row) => String(row.id))
    const rank = clearanceRank(input)
    const objects = ids
      .map((id) => objectRevisionAt(opened.db.query('SELECT * FROM ontology_objects WHERE id = ? ORDER BY revision').all(id) as Row[], asOf))
      .filter((row): row is Row => row !== null)
      .filter((row) => !objectType || String(row.type) === objectType)
      .filter((row) => activeAt(row, asOf))
      .filter((row) => withinClearance(row, rank))
      .map(hydrateObject)
      .sort((a, b) => String(a.type).localeCompare(String(b.type)) || String(a.name).localeCompare(String(b.name)))
    return { storePath: opened.path, objectType: objectType ?? null, asOf: asOf ?? null, objects }
  } finally { opened.db.close() }
}

const CONFIDENCE_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 }
const CONFIDENCE_WEIGHT: Record<string, number> = { low: 0.3, medium: 0.6, high: 0.9 }

/** Links traversable at a clearance level: the link and both endpoint objects must all sit at or below it. */
function clearedLinks(db: Database, rank: number | null, asOf: string | undefined): Row[] {
  const links = (db.query('SELECT * FROM ontology_links').all() as Row[]).filter((row) => activeAt(row, asOf))
  if (rank === null) return links
  const objectRank = (id: string) => classificationRank(currentObject(db, id)?.security_classification)
  return links.filter((row) => classificationRank(row.security_classification) <= rank && objectRank(String(row.from_id)) <= rank && objectRank(String(row.to_id)) <= rank)
}

function findObjectPath(input: Row): Row {
  return withStore(input, false, (db, path) => {
    const fromId = identifier(input.fromId, 'fromId')
    const toId = identifier(input.toId, 'toId')
    if (fromId === toId) throw new Error('fromId and toId must differ')
    if (!currentObject(db, fromId)) throw new Error(`unknown ontology object: ${fromId}`)
    if (!currentObject(db, toId)) throw new Error(`unknown ontology object: ${toId}`)
    const maxDepth = input.maxDepth === undefined ? 4 : integer(input.maxDepth, 'maxDepth', 1, 6)
    const direction = oneOf(input.direction ?? 'any', 'direction', ['out', 'in', 'any'] as const)
    const asOf = input.asOf === undefined ? undefined : isoDate(input.asOf, 'asOf')
    const links = clearedLinks(db, clearanceRank(input), asOf)
    const nameOf = (id: string) => { const row = currentObject(db, id); return row ? String(row.name) : id }
    interface Step { linkId: string; linkType: string; toNode: string; traversed: 'forward' | 'backward'; confidence: string; evidenceIds: string[] }
    const adjacency = (nodeId: string): Step[] => {
      const steps: Step[] = []
      for (const row of links) {
        const evidenceIds: string[] = parseJson(row.evidence_ids_json, [])
        if ((direction === 'out' || direction === 'any') && String(row.from_id) === nodeId) steps.push({ linkId: String(row.id), linkType: String(row.type), toNode: String(row.to_id), traversed: 'forward', confidence: String(row.confidence), evidenceIds })
        if ((direction === 'in' || direction === 'any') && String(row.to_id) === nodeId) steps.push({ linkId: String(row.id), linkType: String(row.type), toNode: String(row.from_id), traversed: 'backward', confidence: String(row.confidence), evidenceIds })
      }
      return steps
    }
    const paths: { nodes: { id: string; name: string }[]; edges: Step[]; hops: number; minConfidence: string }[] = []
    const walk = (nodeId: string, visited: Set<string>, edges: Step[]) => {
      if (paths.length >= 50 || edges.length >= maxDepth) return
      for (const step of adjacency(nodeId)) {
        if (visited.has(step.toNode)) continue
        const nextEdges = [...edges, step]
        if (step.toNode === toId) {
          const nodeIds = [fromId, ...nextEdges.map((edge) => edge.toNode)]
          paths.push({ nodes: nodeIds.map((id) => ({ id, name: nameOf(id) })), edges: nextEdges, hops: nextEdges.length, minConfidence: nextEdges.reduce((min, edge) => (CONFIDENCE_RANK[edge.confidence]! < CONFIDENCE_RANK[min]! ? edge.confidence : min), 'high') })
        } else walk(step.toNode, new Set([...visited, step.toNode]), nextEdges)
      }
    }
    walk(fromId, new Set([fromId]), [])
    paths.sort((a, b) => a.hops - b.hops || CONFIDENCE_RANK[b.minConfidence]! - CONFIDENCE_RANK[a.minConfidence]!)
    return { storePath: path, fromId, toId, direction, maxDepth, pathCount: paths.length, truncated: paths.length >= 50, paths }
  })
}

function explainCausality(input: Row): Row {
  return withStore(input, false, (db, path) => {
    const targetId = identifier(input.targetObjectId, 'targetObjectId')
    const target = currentObject(db, targetId)
    if (!target) throw new Error(`unknown ontology object: ${targetId}`)
    const asOf = input.asOf === undefined ? undefined : isoDate(input.asOf, 'asOf')
    const maxDepth = input.maxDepth === undefined ? 3 : integer(input.maxDepth, 'maxDepth', 1, 5)
    const decay = 0.6
    const rank = clearanceRank(input)
    if (!withinClearance(target, rank)) throw new Error(`ontology object ${targetId} is classified above the supplied clearance`)
    const links = clearedLinks(db, rank, asOf)
    const nameOf = (id: string) => { const row = currentObject(db, id); return row ? String(row.name) : id }
    const mostRecentEvidence = (ids: string[]) => {
      const dates = ids.map((id) => { const row = db.query('SELECT published_at FROM evidence WHERE id = ?').get(id) as Row | null; return row ? String(row.published_at) : null }).filter((value): value is string => value !== null)
      return dates.length ? dates.sort().at(-1)! : null
    }
    interface Edge { linkId: string; linkType: string; fromId: string; toId: string; confidence: string; evidenceIds: string[]; mostRecentEvidence: string | null }
    const found: { sourceId: string; via: Edge[]; hops: number; contribution: number; weakestEdge: string }[] = []
    const walk = (nodeId: string, visited: Set<string>, via: Edge[]) => {
      if (via.length >= maxDepth) return
      for (const row of links) {
        if (String(row.to_id) !== nodeId) continue
        const sourceId = String(row.from_id)
        if (visited.has(sourceId)) continue
        const evidenceIds: string[] = parseJson(row.evidence_ids_json, [])
        const edge: Edge = { linkId: String(row.id), linkType: String(row.type), fromId: sourceId, toId: nodeId, confidence: String(row.confidence), evidenceIds, mostRecentEvidence: mostRecentEvidence(evidenceIds) }
        const nextVia = [edge, ...via]
        const contribution = round(nextVia.reduce((product, item) => product * (CONFIDENCE_WEIGHT[item.confidence] ?? 0.3), 1) * decay ** (nextVia.length - 1))
        found.push({ sourceId, via: nextVia, hops: nextVia.length, contribution, weakestEdge: nextVia.reduce((min, item) => ((CONFIDENCE_WEIGHT[item.confidence] ?? 0.3) < (CONFIDENCE_WEIGHT[min] ?? 0.3) ? item.confidence : min), 'high') })
        walk(sourceId, new Set([...visited, sourceId]), nextVia)
      }
    }
    walk(targetId, new Set([targetId]), [])
    // Each found path starts at a distinct upstream node (via[0].fromId); a node reached by several paths sums its contributions.
    const bySource = new Map<string, number>()
    for (const item of found) {
      const origin = item.via[0]!.fromId
      bySource.set(origin, Math.min(0.99, round((bySource.get(origin) ?? 0) + item.contribution)))
    }
    const gaps = new Set<string>()
    for (const item of found) for (const edge of item.via) {
      if (!edge.evidenceIds.length) gaps.add(`link ${edge.linkId} (${nameOf(edge.fromId)} → ${nameOf(edge.toId)}) carries no evidence`)
      else if (edge.confidence === 'low') gaps.add(`link ${edge.linkId} (${nameOf(edge.fromId)} → ${nameOf(edge.toId)}) is low-confidence`)
    }
    return {
      storePath: path,
      target: { id: targetId, name: target.name, type: target.type, confidence: target.confidence, activeAsOf: asOf ?? null },
      propagationPaths: [...found].sort((a, b) => b.contribution - a.contribution).map((item) => ({ sourceId: item.sourceId, sourceName: nameOf(item.sourceId), hops: item.hops, via: item.via.map((edge) => edge.linkType), edges: item.via, aggregateContribution: item.contribution, weakestEdge: item.weakestEdge })),
      drivers: [...bySource.entries()].map(([id, contribution]) => ({ sourceId: id, sourceName: nameOf(id), aggregateContribution: round(contribution) })).sort((a, b) => b.aggregateContribution - a.aggregateContribution),
      gaps: [...gaps],
      methodology: 'Structural causal trace: contribution along a path is the product of link-confidence weights (low 0.3, medium 0.6, high 0.9) times a per-hop decay of 0.6. Contributions from every path reaching one immediate source are summed and capped at 0.99. This is a static provenance trace over the evidence-linked ontology, not a dynamical propagation model.',
      limitations: ['Link confidences are analyst judgements; the weights and decay are fixed conventions, not fitted parameters.', 'A missing link is invisible here: absence of a path is not evidence of causal independence.', 'The trace models the existence and confidence of causal structure, not timing, feedback, or shock magnitude.'],
    }
  })
}

// ---------------------------------------------------------------------------
// Foundry — datasets, lineage, and the governed action (Kinetic) engine
// ---------------------------------------------------------------------------

function registerDataset(input: Row): Row {
  return withStore(input, true, (db, path) => transaction(db, () => {
    const id = identifier(input.datasetId, 'datasetId')
    const sourceType = oneOf(input.sourceType ?? 'ingested', 'sourceType', ['ingested', 'derived', 'external-feed'] as const)
    const parentDatasetId = input.parentDatasetId === undefined ? null : identifier(input.parentDatasetId, 'parentDatasetId')
    if (parentDatasetId && !(db.query('SELECT id FROM datasets WHERE id = ?').get(parentDatasetId))) throw new Error(`unknown parent dataset: ${parentDatasetId}`)
    const transform = parentDatasetId ? requiredText(input.transform, 'transform', 4_000) : optionalText(input.transform, 'transform', 4_000) ?? null
    const asOf = observedDate(input.asOf, 'asOf')
    const rowCount = input.rowCount === undefined ? null : integer(input.rowCount, 'rowCount', 0, 1_000_000_000)
    const contentHash = requiredText(input.contentHash, 'contentHash', 200)
    const evidenceIds = stringArray(input.evidenceIds, 'evidenceIds').map((value, index) => identifier(value, `evidenceIds[${index}]`))
    if (evidenceIds.length) assertEvidence(db, evidenceIds, asOf)
    db.query('INSERT INTO datasets (id, name, source_type, uri, row_count, content_hash, parent_dataset_id, transform, as_of, security_classification, evidence_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, requiredText(input.name, 'name', 500), sourceType, optionalText(input.uri, 'uri', 2_000) ?? null, rowCount, contentHash, parentDatasetId, transform, asOf, securityClassification(input), JSON.stringify([...new Set(evidenceIds)]), new Date().toISOString(),
    )
    return { status: 'created', storePath: path, datasetId: id, parentDatasetId, contentHash }
  }))
}

function listDatasets(input: Row): Row {
  const opened = openStore(input, false)
  if (!opened) return { storePath: storePath(input), datasets: [] }
  try {
    const rank = clearanceRank(input)
    const sourceType = input.sourceType === undefined ? undefined : oneOf(input.sourceType, 'sourceType', ['ingested', 'derived', 'external-feed'] as const)
    const rows = (opened.db.query('SELECT * FROM datasets ORDER BY created_at').all() as Row[])
      .filter((row) => withinClearance(row, rank))
      .filter((row) => !sourceType || String(row.source_type) === sourceType)
      .map((row) => ({ id: row.id, name: row.name, sourceType: row.source_type, uri: row.uri, rowCount: row.row_count, contentHash: row.content_hash, parentDatasetId: row.parent_dataset_id, transform: row.transform, asOf: row.as_of, securityClassification: row.security_classification, evidenceIds: parseJson(row.evidence_ids_json, []) }))
    return { storePath: opened.path, datasets: rows }
  } finally { opened.db.close() }
}

function datasetLineage(input: Row): Row {
  return withStore(input, false, (db, path) => {
    const datasetId = identifier(input.datasetId, 'datasetId')
    const rank = clearanceRank(input)
    const chain: Row[] = []
    let current = db.query('SELECT * FROM datasets WHERE id = ?').get(datasetId) as Row | null
    if (!current) throw new Error(`unknown dataset: ${datasetId}`)
    const seen = new Set<string>()
    while (current) {
      if (seen.has(String(current.id))) throw new Error('dataset lineage contains a cycle')
      seen.add(String(current.id))
      if (!withinClearance(current, rank)) { chain.push({ id: current.id, redacted: true }); break }
      chain.push({ id: current.id, name: current.name, sourceType: current.source_type, contentHash: current.content_hash, transform: current.transform, asOf: current.as_of, securityClassification: current.security_classification, evidenceIds: parseJson(current.evidence_ids_json, []) })
      current = current.parent_dataset_id ? db.query('SELECT * FROM datasets WHERE id = ?').get(String(current.parent_dataset_id)) as Row | null : null
    }
    const provenance = [...chain].reverse()
    return { storePath: path, datasetId, depth: chain.length, rootDatasetId: provenance[0]?.id ?? null, provenance, hashChain: provenance.map((entry) => ({ id: entry.id, contentHash: entry.contentHash ?? null })) }
  })
}

function defineAction(input: Row): Row {
  return withStore(input, true, (db, path) => transaction(db, () => {
    const id = identifier(input.actionTypeId, 'actionTypeId')
    const name = requiredText(input.actionTypeName, 'actionTypeName', 100)
    if (db.query('SELECT id FROM action_types WHERE name = ?').get(name)) throw new Error(`action type ${name} already exists`)
    const schema = jsonObject(input.parametersSchema, 'parametersSchema')
    for (const [key, spec] of Object.entries(schema)) {
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`parametersSchema.${key} must be an object like { type, required }`)
      const type = (spec as Row).type
      if (!['string', 'number', 'boolean', 'object', 'array'].includes(String(type))) throw new Error(`parametersSchema.${key}.type must be string, number, boolean, object, or array`)
    }
    db.query('INSERT INTO action_types (id, name, applies_to, parameters_schema_json, requires_clearance, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id, name, requiredText(input.appliesTo, 'appliesTo', 100), JSON.stringify(schema), oneOf(input.requiresClearance ?? 'confidential', 'requiresClearance', CLASSIFICATION_LEVELS), requiredText(input.description, 'description', 2_000), new Date().toISOString(),
    )
    return { status: 'created', storePath: path, actionTypeId: id, name }
  }))
}

function proposeAction(input: Row): Row {
  return withStore(input, true, (db, path) => transaction(db, () => {
    const actionType = (input.actionTypeId !== undefined
      ? db.query('SELECT * FROM action_types WHERE id = ?').get(identifier(input.actionTypeId, 'actionTypeId'))
      : db.query('SELECT * FROM action_types WHERE name = ?').get(requiredText(input.actionTypeName, 'actionTypeName', 100))) as Row | null
    if (!actionType) throw new Error('unknown action type; define it with define_action first')
    const targetObjectId = input.targetObjectId === undefined ? null : identifier(input.targetObjectId, 'targetObjectId')
    if (targetObjectId && !currentObject(db, targetObjectId)) throw new Error(`unknown ontology object: ${targetObjectId}`)
    const schema = parseJson<Record<string, { type: string; required?: boolean }>>(actionType.parameters_schema_json, {})
    const parameters = jsonObject(input.parameters, 'parameters')
    for (const [key, spec] of Object.entries(schema)) {
      if (spec.required && !(key in parameters)) throw new Error(`parameters.${key} is required by action type ${actionType.name}`)
    }
    for (const [key, value] of Object.entries(parameters)) {
      const spec = schema[key]
      if (!spec) throw new Error(`parameters.${key} is not declared on action type ${actionType.name}`)
      const actual = Array.isArray(value) ? 'array' : typeof value
      if (actual !== spec.type) throw new Error(`parameters.${key} must be a ${spec.type}`)
    }
    const id = identifier(input.proposalId, 'proposalId')
    const proposedBy = requiredText(input.proposedBy, 'proposedBy', 200)
    const canonical = JSON.stringify({ actionType: actionType.name, targetObjectId, parameters, rationale: requiredText(input.rationale, 'rationale', 10_000) })
    const proposalHash = createHash('sha256').update(canonical).digest('hex')
    db.query('INSERT INTO action_proposals (id, action_type_id, target_object_id, parameters_json, rationale, proposed_by, proposal_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, String(actionType.id), targetObjectId, JSON.stringify(parameters), requiredText(input.rationale, 'rationale', 10_000), proposedBy, proposalHash, new Date().toISOString(),
    )
    return { status: 'pending', storePath: path, proposalId: id, actionType: actionType.name, requiresClearance: actionType.requires_clearance, proposalHash, note: 'A proposal records an intent to act; it executes nothing. approve_action records the signed human decision, and any real side effect is still governed at the tool boundary.' }
  }))
}

function decideActionProposal(input: Row): Row {
  return withStore(input, true, (db, path) => transaction(db, () => {
    const proposalId = identifier(input.proposalId, 'proposalId')
    const proposal = db.query('SELECT * FROM action_proposals WHERE id = ?').get(proposalId) as Row | null
    if (!proposal) throw new Error(`unknown proposal: ${proposalId}`)
    if (proposal.status !== 'pending') throw new Error(`proposal ${proposalId} is already ${proposal.status}`)
    const decision = oneOf(input.decision, 'decision', ['approved', 'rejected', 'withdrawn'] as const)
    const decidedBy = requiredText(input.decidedBy, 'decidedBy', 200)
    const decidedAt = observedDate(input.decidedAt, 'decidedAt')
    db.query('UPDATE action_proposals SET status = ?, decided_by = ?, decided_at = ?, decision_notes = ? WHERE id = ?').run(
      decision, decidedBy, decidedAt, requiredText(input.decisionNotes, 'decisionNotes', 5_000), proposalId,
    )
    return { status: decision, storePath: path, proposalId, decidedBy, proposalHash: proposal.proposal_hash }
  }))
}

function listActionProposals(input: Row): Row {
  const opened = openStore(input, false)
  if (!opened) return { storePath: storePath(input), proposals: [] }
  try {
    const status = input.status === undefined ? undefined : oneOf(input.status, 'status', ['pending', 'approved', 'rejected', 'withdrawn'] as const)
    const rows = (opened.db.query(`SELECT p.*, t.name AS action_type_name, t.requires_clearance FROM action_proposals p JOIN action_types t ON t.id = p.action_type_id ORDER BY p.created_at`).all() as Row[])
      .filter((row) => !status || String(row.status) === status)
      .map((row) => ({ id: row.id, actionType: row.action_type_name, targetObjectId: row.target_object_id, parameters: parseJson(row.parameters_json, {}), rationale: row.rationale, proposedBy: row.proposed_by, status: row.status, decidedBy: row.decided_by, decidedAt: row.decided_at, decisionNotes: row.decision_notes, requiresClearance: row.requires_clearance, proposalHash: row.proposal_hash }))
    return { storePath: opened.path, proposals: rows }
  } finally { opened.db.close() }
}

// ---------------------------------------------------------------------------
// Gotham / Maven — geolocated events, radius queries, a common operating picture
// ---------------------------------------------------------------------------

function registerGeoEvent(input: Row): Row {
  return withStore(input, true, (db, path) => transaction(db, () => {
    const id = identifier(input.geoEventId, 'geoEventId')
    const occurredAt = observedDate(input.occurredAt, 'occurredAt')
    const affectedObjectIds = stringArray(input.affectedObjectIds, 'affectedObjectIds', 100).map((value, index) => identifier(value, `affectedObjectIds[${index}]`))
    for (const objectId of affectedObjectIds) if (!currentObject(db, objectId)) throw new Error(`unknown ontology object: ${objectId}`)
    const evidenceIds = stringArray(input.evidenceIds, 'evidenceIds', 100).map((value, index) => identifier(value, `evidenceIds[${index}]`))
    assertEvidence(db, evidenceIds, occurredAt)
    db.query('INSERT INTO geo_events (id, title, category, latitude, longitude, occurred_at, severity, affected_object_ids_json, source_url, security_classification, evidence_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, requiredText(input.title, 'title', 500), requiredText(input.category, 'category', 100), latitude(input.latitude, 'latitude'), longitude(input.longitude, 'longitude'), occurredAt, integer(input.severity, 'severity', 0, 100), JSON.stringify(affectedObjectIds), httpUrl(input.sourceUrl, 'sourceUrl'), securityClassification(input), JSON.stringify([...new Set(evidenceIds)]), new Date().toISOString(),
    )
    return { status: 'created', storePath: path, geoEventId: id }
  }))
}

function resolveCenter(db: Database, input: Row): { latitude: number; longitude: number; label: string } {
  if (input.objectId !== undefined) {
    const object = currentObject(db, identifier(input.objectId, 'objectId'))
    if (!object) throw new Error(`unknown ontology object: ${String(input.objectId)}`)
    if (object.latitude === null || object.latitude === undefined) throw new Error(`ontology object ${String(input.objectId)} has no coordinates`)
    return { latitude: Number(object.latitude), longitude: Number(object.longitude), label: String(object.name) }
  }
  return { latitude: latitude(input.latitude, 'latitude'), longitude: longitude(input.longitude, 'longitude'), label: 'supplied coordinate' }
}

function geoQuery(input: Row): Row {
  return withStore(input, false, (db, path) => {
    const center = resolveCenter(db, input)
    const radiusKm = boundedNumber(input.radiusKm, 'radiusKm', 0.1, 20_037)
    const since = input.since === undefined ? undefined : isoDate(input.since, 'since')
    const asOf = input.asOf === undefined ? undefined : isoDate(input.asOf, 'asOf')
    const rank = clearanceRank(input)
    const events = (db.query('SELECT * FROM geo_events ORDER BY occurred_at DESC').all() as Row[])
      .filter((row) => withinClearance(row, rank))
      .filter((row) => (!since || String(row.occurred_at) >= since) && (!asOf || String(row.occurred_at) <= asOf))
      .map((row) => ({
        id: row.id, title: row.title, category: row.category, severity: row.severity, occurredAt: row.occurred_at,
        latitude: row.latitude, longitude: row.longitude, affectedObjectIds: parseJson(row.affected_object_ids_json, []),
        securityClassification: row.security_classification,
        distanceKm: round(haversineKm(center.latitude, center.longitude, Number(row.latitude), Number(row.longitude)), 2),
      }))
      .filter((row) => row.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm)
    const objectIds = (db.query('SELECT DISTINCT id FROM ontology_objects').all() as Row[]).map((row) => String(row.id))
    const objects = objectIds
      .map((id) => objectRevisionAt(db.query('SELECT * FROM ontology_objects WHERE id = ? ORDER BY revision').all(id) as Row[], asOf))
      .filter((row): row is Row => row !== null && row.latitude !== null && row.latitude !== undefined)
      .filter((row) => withinClearance(row, rank) && activeAt(row, asOf))
      .map((row) => ({ id: row.id, name: row.name, type: row.type, distanceKm: round(haversineKm(center.latitude, center.longitude, Number(row.latitude), Number(row.longitude)), 2) }))
      .filter((row) => row.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm)
    return { storePath: path, center, radiusKm, eventCount: events.length, events, objects }
  })
}

function situationSnapshot(input: Row): Row {
  return withStore(input, false, (db, path) => {
    const asOf = observedDate(input.asOf, 'asOf')
    const rank = clearanceRank(input)
    const bbox = input.bbox === undefined ? null : (() => {
      const box = jsonObject(input.bbox, 'bbox') as { minLat?: unknown; maxLat?: unknown; minLon?: unknown; maxLon?: unknown }
      return { minLat: latitude(box.minLat, 'bbox.minLat'), maxLat: latitude(box.maxLat, 'bbox.maxLat'), minLon: longitude(box.minLon, 'bbox.minLon'), maxLon: longitude(box.maxLon, 'bbox.maxLon') }
    })()
    const inBox = (lat: number, lon: number) => !bbox || (lat >= bbox.minLat && lat <= bbox.maxLat && lon >= bbox.minLon && lon <= bbox.maxLon)
    const events = (db.query('SELECT * FROM geo_events WHERE occurred_at <= ? ORDER BY occurred_at DESC').all(asOf) as Row[])
      .filter((row) => withinClearance(row, rank) && inBox(Number(row.latitude), Number(row.longitude)))
    const categories = [...new Set(events.map((row) => String(row.category)))].map((category) => {
      const selected = events.filter((row) => String(row.category) === category)
      return { category, count: selected.length, maxSeverity: Math.max(...selected.map((row) => Number(row.severity))), mostRecent: selected[0]?.occurred_at ?? null }
    }).sort((a, b) => b.maxSeverity - a.maxSeverity)
    const pressuredObjects = new Map<string, { objectId: string; events: number; maxSeverity: number }>()
    for (const row of events) for (const objectId of parseJson<string[]>(row.affected_object_ids_json, [])) {
      const entry = pressuredObjects.get(objectId) ?? { objectId, events: 0, maxSeverity: 0 }
      entry.events += 1
      entry.maxSeverity = Math.max(entry.maxSeverity, Number(row.severity))
      pressuredObjects.set(objectId, entry)
    }
    const nameOf = (id: string) => { const row = currentObject(db, id); return row ? String(row.name) : id }
    const openQuestions = Number((db.query("SELECT COUNT(*) AS count FROM questions WHERE status = 'open'").get() as Row).count)
    return {
      storePath: path, asOf, bbox, totalEvents: events.length,
      categories,
      topEvents: events.slice().sort((a, b) => Number(b.severity) - Number(a.severity)).slice(0, 10).map((row) => ({ id: row.id, title: row.title, category: row.category, severity: row.severity, occurredAt: row.occurred_at, latitude: row.latitude, longitude: row.longitude })),
      objectsUnderPressure: [...pressuredObjects.values()].sort((a, b) => b.maxSeverity - a.maxSeverity).map((entry) => ({ ...entry, name: nameOf(entry.objectId) })),
      openQuestions,
      limitations: ['A common operating picture is only as complete as the geolocated events registered in the store; it does not ingest live sensor feeds.', 'Objects without coordinates are absent from this picture even when they are exposed.'],
    }
  })
}

// ---------------------------------------------------------------------------
// Apollo — constraint-checked deployment of the intelligence product
// ---------------------------------------------------------------------------

function defineDeploymentTarget(input: Row): Row {
  return withStore(input, true, (db, path) => transaction(db, () => {
    const id = identifier(input.targetId, 'targetId')
    const formats = stringArray(input.formats, 'formats', 3).map((value, index) => oneOf(value, `formats[${index}]`, ['md', 'json', 'html'] as const))
    if (!formats.length) throw new Error('formats must list at least one of md, json, html')
    db.query('INSERT INTO deployment_targets (id, name, kind, max_classification, formats_json, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id, requiredText(input.name, 'name', 300), oneOf(input.kind, 'kind', ['air-gap-export', 'sovereign-cloud', 'edge-node'] as const), oneOf(input.maxClassification ?? 'internal', 'maxClassification', CLASSIFICATION_LEVELS), JSON.stringify([...new Set(formats)]), requiredText(input.notes ?? 'No deployment notes.', 'notes', 4_000), new Date().toISOString(),
    )
    return { status: 'created', storePath: path, targetId: id }
  }))
}

function stageDeployment(input: Row): Row {
  return withStore(input, true, (db, path) => transaction(db, () => {
    const targetId = identifier(input.targetId, 'targetId')
    const target = db.query('SELECT * FROM deployment_targets WHERE id = ?').get(targetId) as Row | null
    if (!target) throw new Error(`unknown deployment target: ${targetId}`)
    const reportPath = resolveWorkspacePath(requiredText(input.reportPath, 'reportPath', 1_000))
    if (extname(reportPath).toLowerCase() !== '.md' || !existsSync(reportPath)) throw new Error('reportPath must be an existing .md report produced by report_from_store')
    const sidecarPath = reportPath.slice(0, -3) + '.json'
    const htmlPath = reportPath.slice(0, -3) + '.html'
    if (!existsSync(sidecarPath)) throw new Error('the report JSON sidecar is missing; regenerate the report with report_from_store')
    const bundle = JSON.parse(readFileSync(sidecarPath, 'utf8')) as { documentClassification?: string; reportId?: string; reportVersion?: string; reportStatus?: string; title?: string }
    const reportClassification = bundle.documentClassification ?? 'internal'
    if (classificationRank(reportClassification) > classificationRank(target.max_classification)) throw new Error(`report is classified ${reportClassification}; target ${targetId} accepts at most ${target.max_classification}`)
    const formats: string[] = parseJson(target.formats_json, [])
    const fileFor: Record<string, string> = { md: reportPath, json: sidecarPath, html: htmlPath }
    const missing = formats.filter((format) => !existsSync(fileFor[format]!))
    if (missing.length) throw new Error(`target requires formats [${formats.join(', ')}] but these are missing: ${missing.join(', ')}`)
    const previous = db.query('SELECT version FROM deployment_stages WHERE target_id = ? ORDER BY version DESC LIMIT 1').get(targetId) as Row | null
    const version = previous ? Number(previous.version) + 1 : 1
    const files = formats.map((format) => {
      const filePath = fileFor[format]!
      const content = readFileSync(filePath)
      return { format, path: filePath, bytes: statSync(filePath).size, sha256: createHash('sha256').update(content).digest('hex') }
    })
    const stagedBy = requiredText(input.stagedBy, 'stagedBy', 200)
    const stagedAt = new Date().toISOString()
    const manifest = {
      manifestSchemaVersion: 1, targetId, targetName: target.name, targetKind: target.kind, version,
      previousVersion: previous ? Number(previous.version) : null,
      report: { id: bundle.reportId ?? null, version: bundle.reportVersion ?? null, status: bundle.reportStatus ?? null, title: bundle.title ?? null, classification: reportClassification },
      maxClassification: target.max_classification, stagedBy, stagedAt, files,
    }
    const slug = String(target.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || targetId.toLowerCase()
    const manifestPath = resolveWorkspacePath(`.elia/artifacts/deploy/${slug}/v${version}/manifest.json`)
    const manifestJson = JSON.stringify(manifest, null, 2)
    const manifestHash = createHash('sha256').update(manifestJson).digest('hex')
    const stageId = identifier(input.stageId, 'stageId')
    db.query('INSERT INTO deployment_stages (id, target_id, version, report_path, manifest_json, manifest_hash, staged_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      stageId, targetId, version, reportPath, manifestJson, manifestHash, stagedBy, stagedAt,
    )
    mkdirSync(dirname(manifestPath), { recursive: true })
    writeFileSync(manifestPath, manifestJson)
    return { status: 'staged', storePath: path, stageId, targetId, version, manifestPath, manifestHash, manifest, note: 'The manifest is written to the workspace; nothing is transmitted. Handing the bundle to the target is a separate governed step.' }
  }))
}

function deploymentStatus(input: Row): Row {
  const opened = openStore(input, false)
  if (!opened) return { storePath: storePath(input), targets: [] }
  try {
    const targets = (opened.db.query('SELECT * FROM deployment_targets ORDER BY created_at').all() as Row[]).map((target) => {
      const stages = (opened.db.query('SELECT * FROM deployment_stages WHERE target_id = ? ORDER BY version').all(String(target.id)) as Row[])
        .map((stage) => ({ stageId: stage.id, version: stage.version, reportPath: stage.report_path, manifestHash: stage.manifest_hash, stagedBy: stage.staged_by, stagedAt: stage.created_at }))
      return { id: target.id, name: target.name, kind: target.kind, maxClassification: target.max_classification, formats: parseJson(target.formats_json, []), stageCount: stages.length, latestVersion: stages.at(-1)?.version ?? null, stages }
    })
    return { storePath: opened.path, targets }
  } finally { opened.db.close() }
}

function auditTrail(input: Row): Row {
  const opened = openStore(input, false)
  if (!opened) return { storePath: storePath(input), entries: [], chainValid: true }
  try {
    const limit = input.limit === undefined ? 200 : integer(input.limit, 'limit', 1, 10_000)
    const all = opened.db.query('SELECT * FROM audit_log ORDER BY seq').all() as Row[]
    let prevHash = ''
    let chainValid = true
    let brokenAt: number | null = null
    for (const row of all) {
      const expected = createHash('sha256').update([prevHash, row.id, row.action, row.actor_name, row.actor_role ?? '', row.target ?? '', row.payload_hash, row.created_at].join('␟')).digest('hex')
      if (expected !== String(row.entry_hash) || String(row.prev_hash) !== prevHash) { chainValid = false; brokenAt = brokenAt ?? Number(row.seq) }
      prevHash = String(row.entry_hash)
    }
    const entries = all.slice(-limit).map((row) => ({ seq: row.seq, action: row.action, actor: { name: row.actor_name, role: row.actor_role }, target: row.target, payloadHash: row.payload_hash, entryHash: row.entry_hash, recordedAt: row.created_at }))
    return { storePath: opened.path, totalEntries: all.length, chainValid, brokenAt, entries }
  } finally { opened.db.close() }
}

// ---------------------------------------------------------------------------
// Financial / economic — a dated macro-indicator ledger
// ---------------------------------------------------------------------------

function defineIndicator(input: Row): Row {
  return withStore(input, true, (db, path) => transaction(db, () => {
    const id = identifier(input.indicatorId, 'indicatorId')
    if (db.query('SELECT id FROM indicators WHERE id = ?').get(id)) throw new Error(`indicator ${id} already exists`)
    db.query('INSERT INTO indicators (id, name, unit, frequency, higher_is, source_name, security_classification, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, requiredText(input.name, 'name', 300), requiredText(input.unit, 'unit', 60), oneOf(input.frequency, 'frequency', ['daily', 'weekly', 'monthly', 'quarterly', 'annual', 'irregular'] as const), oneOf(input.higherIs, 'higherIs', ['risk-on', 'risk-off', 'neutral'] as const), requiredText(input.sourceName, 'sourceName', 200), securityClassification(input), new Date().toISOString(),
    )
    return { status: 'created', storePath: path, indicatorId: id }
  }))
}

function recordIndicatorReading(input: Row): Row {
  return withStore(input, true, (db, path) => transaction(db, () => {
    const indicatorId = identifier(input.indicatorId, 'indicatorId')
    if (!db.query('SELECT id FROM indicators WHERE id = ?').get(indicatorId)) throw new Error(`unknown indicator: ${indicatorId}; define it with define_indicator first`)
    const observedAt = observedDate(input.observedAt, 'observedAt')
    const value = boundedNumber(input.value, 'value', -1e15, 1e15)
    const evidenceId = input.evidenceId === undefined ? null : identifier(input.evidenceId, 'evidenceId')
    if (evidenceId) assertEvidence(db, [evidenceId], observedAt)
    if (db.query('SELECT id FROM indicator_readings WHERE indicator_id = ? AND observed_at = ?').get(indicatorId, observedAt)) throw new Error(`indicator ${indicatorId} already has a reading at ${observedAt}`)
    const id = identifier(input.readingId, 'readingId')
    db.query('INSERT INTO indicator_readings (id, indicator_id, observed_at, value, source_url, evidence_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id, indicatorId, observedAt, value, httpUrl(input.sourceUrl, 'sourceUrl'), evidenceId, new Date().toISOString(),
    )
    return { status: 'recorded', storePath: path, indicatorId, readingId: id, observedAt, value }
  }))
}

function listIndicators(input: Row): Row {
  const opened = openStore(input, false)
  if (!opened) return { storePath: storePath(input), indicators: [] }
  try {
    const rank = clearanceRank(input)
    const indicators = (opened.db.query('SELECT * FROM indicators ORDER BY name').all() as Row[])
      .filter((row) => withinClearance(row, rank))
      .map((row) => ({ id: row.id, name: row.name, unit: row.unit, frequency: row.frequency, higherIs: row.higher_is, sourceName: row.source_name, securityClassification: row.security_classification, readingCount: Number((opened.db.query('SELECT COUNT(*) AS count FROM indicator_readings WHERE indicator_id = ?').get(String(row.id)) as Row).count) }))
    return { storePath: opened.path, indicators }
  } finally { opened.db.close() }
}

function indicatorSeries(input: Row): Row {
  return withStore(input, false, (db, path) => {
    const indicatorId = identifier(input.indicatorId, 'indicatorId')
    const indicator = db.query('SELECT * FROM indicators WHERE id = ?').get(indicatorId) as Row | null
    if (!indicator) throw new Error(`unknown indicator: ${indicatorId}`)
    if (!withinClearance(indicator, clearanceRank(input))) throw new Error(`indicator ${indicatorId} is classified above the supplied clearance`)
    const since = input.since === undefined ? undefined : isoDate(input.since, 'since')
    const asOf = input.asOf === undefined ? undefined : isoDate(input.asOf, 'asOf')
    const readings = (db.query('SELECT * FROM indicator_readings WHERE indicator_id = ? ORDER BY observed_at').all(indicatorId) as Row[])
      .filter((row) => (!since || String(row.observed_at) >= since) && (!asOf || String(row.observed_at) <= asOf))
      .map((row) => ({ observedAt: row.observed_at, value: Number(row.value), sourceUrl: row.source_url, evidenceId: row.evidence_id }))
    if (!readings.length) return { storePath: path, indicator: { id: indicator.id, name: indicator.name, unit: indicator.unit, higherIs: indicator.higher_is }, readings: [], statistics: null }
    const values = readings.map((reading) => reading.value)
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length
    const variance = values.length > 1 ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1) : 0
    const stdev = Math.sqrt(variance)
    const latest = readings[readings.length - 1]!
    const previous = readings.length > 1 ? readings[readings.length - 2]! : null
    const tail = readings.slice(-3).map((reading) => reading.value)
    const trend = tail.length >= 2 ? Math.sign(tail[tail.length - 1]! - tail[0]!) : 0
    const zScore = stdev > 0 ? (latest.value - mean) / stdev : 0
    return {
      storePath: path,
      indicator: { id: indicator.id, name: indicator.name, unit: indicator.unit, frequency: indicator.frequency, higherIs: indicator.higher_is },
      readings,
      statistics: {
        sampleSize: readings.length, mean: round(mean), stdev: round(stdev),
        latest: { observedAt: latest.observedAt, value: latest.value },
        changeFromPrevious: previous ? { absolute: round(latest.value - previous.value), percent: previous.value !== 0 ? round((latest.value - previous.value) / Math.abs(previous.value)) : null } : null,
        latestZScore: round(zScore),
        trendDirection: trend > 0 ? 'rising' : trend < 0 ? 'falling' : 'flat',
        regime: Math.abs(zScore) <= 1 ? 'within one standard deviation of its own history' : zScore > 1 ? 'elevated versus its own history' : 'depressed versus its own history',
      },
      limitations: ['Statistics are computed against this indicator’s own recorded history only, which may be short and irregular.', 'A z-score is not a probability; it does not imply mean reversion.'],
    }
  })
}

function createScenario(input: Row): Row {
  return withStore(input, true, (db, path) => transaction(db, () => {
    const baseAsOf = observedDate(input.baseAsOf ?? input.asOf, 'baseAsOf'); const horizon = isoDate(input.horizon, 'horizon')
    if (horizon <= baseAsOf) throw new Error('scenario horizon must be after baseAsOf')
    const questionIds = stringArray(input.questionIds, 'questionIds').map((value, index) => identifier(value, `questionIds[${index}]`))
    for (const questionId of questionIds) {
      const question = db.query('SELECT id, opened_at FROM questions WHERE id = ?').get(questionId) as Row | null
      if (!question) throw new Error(`unknown question id: ${questionId}`)
      if (String(question.opened_at) > baseAsOf) throw new Error(`question ${questionId} was not open at scenario baseAsOf`)
    }
    const evidenceIds = stringArray(input.evidenceIds, 'evidenceIds').map((value, index) => identifier(value, `evidenceIds[${index}]`))
    assertEvidence(db, evidenceIds, baseAsOf)
    const scenarioId = identifier(input.scenarioId, 'scenarioId')
    db.query('INSERT INTO scenarios (id, title, base_as_of, horizon, probability, assumptions_json, question_ids_json, evidence_ids_json, indicators_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      scenarioId, requiredText(input.title, 'title', 500), baseAsOf, horizon, probability(input.probability, 'probability'), JSON.stringify(stringArray(input.assumptions, 'assumptions', 100)), JSON.stringify(questionIds), JSON.stringify([...new Set(evidenceIds)]), JSON.stringify(stringArray(input.indicators, 'indicators', 100)), oneOf(input.status ?? 'draft', 'status', ['draft', 'active', 'superseded', 'resolved'] as const), new Date().toISOString(),
    )
    return { status: 'created', storePath: path, scenarioId }
  }))
}

function recordDecision(input: Row): Row {
  return withStore(input, true, (db, path) => transaction(db, () => {
    const scenarioId = input.scenarioId === undefined ? null : identifier(input.scenarioId, 'scenarioId')
    const scenario = scenarioId ? db.query('SELECT id, base_as_of FROM scenarios WHERE id = ?').get(scenarioId) as Row | null : null
    if (scenarioId && !scenario) throw new Error(`unknown scenario id: ${scenarioId}`)
    const status = oneOf(input.status ?? 'proposed', 'status', ['proposed', 'approved', 'rejected', 'executed'] as const)
    const approvedBy = optionalText(input.approvedBy, 'approvedBy', 200) ?? null
    if ((status === 'approved' || status === 'executed') && !approvedBy) throw new Error(`${status} decisions require approvedBy`)
    const decisionId = identifier(input.decisionId, 'decisionId')
    const decidedAt = observedDate(input.decidedAt, 'decidedAt')
    if (scenario && decidedAt < String(scenario.base_as_of)) throw new Error('decidedAt cannot be before scenario baseAsOf')
    db.query('INSERT INTO decisions (id, scenario_id, title, options_json, chosen_option, rationale, status, approved_by, decided_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      decisionId, scenarioId, requiredText(input.title, 'title', 500), JSON.stringify(objectArray(input.options, 'options', 30)), optionalText(input.chosenOption, 'chosenOption', 500) ?? null, requiredText(input.rationale, 'rationale', 10_000), status, approvedBy, decidedAt, new Date().toISOString(),
    )
    return { status: 'recorded', storePath: path, decisionId, decisionStatus: status }
  }))
}

function recordOutcome(input: Row): Row {
  return withStore(input, true, (db, path) => transaction(db, () => {
    const decisionId = identifier(input.decisionId, 'decisionId')
    const decision = db.query('SELECT id, decided_at FROM decisions WHERE id = ?').get(decisionId) as Row | null
    if (!decision) throw new Error(`unknown decision id: ${decisionId}`)
    const observedAt = observedDate(input.observedAt, 'observedAt')
    if (observedAt < String(decision.decided_at)) throw new Error('observedAt cannot be before decision decidedAt')
    const evidenceIds = stringArray(input.evidenceIds, 'evidenceIds').map((value, index) => identifier(value, `evidenceIds[${index}]`))
    assertEvidence(db, evidenceIds, observedAt)
    const outcomeId = identifier(input.outcomeId, 'outcomeId')
    db.query('INSERT INTO outcomes (id, decision_id, observed_at, summary, metrics_json, evidence_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      outcomeId, decisionId, observedAt, requiredText(input.summary, 'summary', 10_000), JSON.stringify(jsonObject(input.metrics, 'metrics')), JSON.stringify([...new Set(evidenceIds)]), new Date().toISOString(),
    )
    return { status: 'recorded', storePath: path, outcomeId, decisionId }
  }))
}

function workspaceSnapshot(input: Row): Row {
  const opened = openStore(input, false)
  if (!opened) return { storePath: storePath(input), counts: {}, openQuestions: [], scorecard: scoreRows([]) }
  try {
    const count = (table: string) => Number((opened.db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as Row).count)
    const openQuestions = opened.db.query("SELECT * FROM questions WHERE status = 'open' ORDER BY horizon LIMIT 50").all() as Row[]
    const claims = opened.db.query(`SELECT c.id, c.statement, c.confidence,
      (SELECT verdict FROM claim_reviews r WHERE r.claim_id = c.id ORDER BY reviewed_at DESC LIMIT 1) AS latest_review
      FROM claims c ORDER BY c.created_at DESC LIMIT 50`).all() as Row[]
    return {
      storePath: opened.path,
      schemaVersion: Number((opened.db.query('PRAGMA user_version').get() as Row).user_version),
      counts: Object.fromEntries(['questions', 'evidence', 'claims', 'claim_reviews', 'forecast_revisions', 'resolution_events', 'ontology_objects', 'ontology_links', 'scenarios', 'decisions', 'outcomes', 'benchmark_runs', 'datasets', 'action_types', 'action_proposals', 'geo_events', 'deployment_targets', 'deployment_stages', 'audit_log', 'indicators', 'indicator_readings'].map((table) => [table, count(table)])),
      openQuestions: openQuestions.map(hydrateQuestion),
      recentClaims: claims,
      pendingActionProposals: Number((opened.db.query("SELECT COUNT(*) AS count FROM action_proposals WHERE status = 'pending'").get() as Row).count),
      scorecard: scoreRows(resolvedLatestForecasts(opened.db)),
    }
  } finally { opened.db.close() }
}

export function loadBattmannReportData(input: Row): Row {
  const asOf = observedDate(input.asOf, 'asOf')
  return withStore(input, false, (db, path) => {
    const requestedQuestionIds = stringArray(input.questionIds, 'questionIds', 100).map((value, index) => identifier(value, `questionIds[${index}]`))
    const questionRows = db.query('SELECT * FROM questions WHERE opened_at <= ? ORDER BY horizon').all(asOf) as Row[]
    const selectedQuestions = questionRows.filter((question) => !requestedQuestionIds.length || requestedQuestionIds.includes(String(question.id)))
    for (const id of requestedQuestionIds) if (!selectedQuestions.some((question) => String(question.id) === id)) throw new Error(`unknown or not-yet-open question id at report asOf: ${id}`)
    const questions = selectedQuestions.map((question) => {
      const latestForecast = db.query('SELECT * FROM forecast_revisions WHERE question_id = ? AND as_of <= ? ORDER BY as_of DESC, revision DESC LIMIT 1').get(String(question.id), asOf) as Row | null
      const resolution = db.query("SELECT * FROM resolution_events WHERE question_id = ? AND status IN ('accepted','void') AND resolved_at <= ? ORDER BY resolved_at DESC LIMIT 1").get(String(question.id), asOf) as Row | null
      return { ...hydrateQuestion(question), status: resolution ? resolution.status === 'accepted' ? 'resolved' : 'void' : 'open', outcome: resolution?.outcome ?? null, resolvedAt: resolution?.resolved_at ?? null, latestForecast: latestForecast ? hydrateForecast(latestForecast) : null }
    })
    const claimRows = db.query('SELECT * FROM claims WHERE as_of <= ? ORDER BY created_at').all(asOf) as Row[]
    const claims = claimRows.map((claim) => {
      const links = db.query(`SELECT ce.evidence_id, ce.relation, ce.supporting_excerpt, e.title, e.url, e.publisher, e.source_type, e.published_at, e.retrieved_at, e.content_hash, e.independence_group, e.reliability
        FROM claim_evidence ce JOIN evidence e ON e.id = ce.evidence_id WHERE ce.claim_id = ? AND e.published_at <= ? AND e.retrieved_at <= ? ORDER BY ce.evidence_id`).all(String(claim.id), asOf, asOf) as Row[]
      const review = db.query('SELECT verdict, reviewer, reviewed_at, notes FROM claim_reviews WHERE claim_id = ? AND reviewed_at <= ? ORDER BY reviewed_at DESC LIMIT 1').get(String(claim.id), asOf) as Row | null
      return { id: claim.id, statement: claim.statement, classification: claim.classification, confidence: claim.confidence, asOf: claim.as_of, evidence: links.map((link) => ({ evidenceId: link.evidence_id, relation: link.relation, supportingExcerpt: link.supporting_excerpt })), review: review ? { verdict: review.verdict, reviewer: review.reviewer, reviewedAt: review.reviewed_at, notes: review.notes } : { verdict: 'unreviewed' } }
    })
    const evidence = db.query('SELECT * FROM evidence WHERE published_at <= ? AND retrieved_at <= ? ORDER BY published_at, id').all(asOf, asOf) as Row[]
    const scenarios = (db.query('SELECT * FROM scenarios WHERE base_as_of <= ? ORDER BY horizon').all(asOf) as Row[]).map((row) => ({ id: row.id, title: row.title, baseAsOf: row.base_as_of, horizon: row.horizon, probability: row.probability, assumptions: parseJson(row.assumptions_json, []), questionIds: parseJson(row.question_ids_json, []), evidenceIds: parseJson(row.evidence_ids_json, []), indicators: parseJson(row.indicators_json, []), status: row.status }))
    const decisions = (db.query('SELECT * FROM decisions WHERE decided_at <= ? ORDER BY decided_at').all(asOf) as Row[]).map((row) => ({ id: row.id, scenarioId: row.scenario_id, title: row.title, options: parseJson(row.options_json, []), chosenOption: row.chosen_option, rationale: row.rationale, status: row.status, approvedBy: row.approved_by, decidedAt: row.decided_at }))
    const outcomes = (db.query('SELECT * FROM outcomes WHERE observed_at <= ? ORDER BY observed_at').all(asOf) as Row[]).map((row) => ({ id: row.id, decisionId: row.decision_id, observedAt: row.observed_at, summary: row.summary, metrics: parseJson(row.metrics_json, {}), evidenceIds: parseJson(row.evidence_ids_json, []) }))
    const objectCount = Number((db.query('SELECT COUNT(DISTINCT id) AS count FROM ontology_objects WHERE valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)').get(asOf, asOf) as Row).count)
    const linkCount = Number((db.query('SELECT COUNT(*) AS count FROM ontology_links WHERE valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)').get(asOf, asOf) as Row).count)
    const score = scoreRows(resolvedLatestForecasts(db).filter((row) => row.resolvedAt <= asOf))
    return {
      storePath: path,
      schemaVersion: Number((db.query('PRAGMA user_version').get() as Row).user_version),
      asOf,
      questions,
      claims,
      evidence: evidence.map((row) => ({ id: row.id, title: row.title, url: row.url, publisher: row.publisher, sourceType: row.source_type, publishedAt: row.published_at, retrievedAt: row.retrieved_at, excerpt: row.excerpt, contentHash: row.content_hash, independenceGroup: row.independence_group, reliability: row.reliability })),
      scenarios,
      decisions,
      outcomes,
      ontology: { activeObjects: objectCount, activeLinks: linkCount },
      scorecard: score,
    }
  })
}

/** One read that assembles every panel of the intelligence dashboard as of a cutoff, honouring clearance. */
export function loadBattmannDashboardData(input: Row): Row {
  const asOf = input.asOf === undefined ? new Date().toISOString() : observedDate(input.asOf, 'asOf')
  const rank = clearanceRank(input)
  return withStore(input, false, (db, path) => {
    const nameOf = (id: string) => { const row = currentObject(db, id); return row ? String(row.name) : id }
    const questions = (db.query("SELECT * FROM questions WHERE status = 'open' AND opened_at <= ? ORDER BY horizon").all(asOf) as Row[]).map((question) => {
      const revisions = db.query('SELECT probability, as_of FROM forecast_revisions WHERE question_id = ? AND as_of <= ? ORDER BY as_of DESC, revision DESC LIMIT 2').all(String(question.id), asOf) as Row[]
      const latest = revisions[0] ? Number(revisions[0].probability) : null
      const prior = revisions[1] ? Number(revisions[1].probability) : null
      return { id: question.id, question: question.question, domain: question.domain, horizon: question.horizon, probability: latest, previousProbability: prior, delta: latest !== null && prior !== null ? round(latest - prior) : null, latestForecastAsOf: revisions[0]?.as_of ?? null }
    })
    const scenarios = (db.query('SELECT * FROM scenarios WHERE base_as_of <= ? ORDER BY probability DESC').all(asOf) as Row[]).map((row) => ({ id: row.id, title: row.title, probability: Number(row.probability), horizon: row.horizon, status: row.status }))
    const geoRows = (db.query('SELECT * FROM geo_events WHERE occurred_at <= ? ORDER BY occurred_at DESC').all(asOf) as Row[]).filter((row) => withinClearance(row, rank))
    const geoCategories = [...new Set(geoRows.map((row) => String(row.category)))].map((category) => {
      const selected = geoRows.filter((row) => String(row.category) === category)
      return { category, count: selected.length, maxSeverity: Math.max(...selected.map((row) => Number(row.severity))), mostRecent: selected[0]?.occurred_at ?? null }
    }).sort((a, b) => b.maxSeverity - a.maxSeverity)
    const topGeoEvents = [...geoRows].sort((a, b) => Number(b.severity) - Number(a.severity)).slice(0, 8).map((row) => ({ id: row.id, title: row.title, category: row.category, severity: Number(row.severity), occurredAt: row.occurred_at, latitude: row.latitude, longitude: row.longitude }))
    const pressured = new Map<string, { objectId: string; events: number; maxSeverity: number }>()
    for (const row of geoRows) for (const objectId of parseJson<string[]>(row.affected_object_ids_json, [])) {
      const entry = pressured.get(objectId) ?? { objectId, events: 0, maxSeverity: 0 }
      entry.events += 1
      entry.maxSeverity = Math.max(entry.maxSeverity, Number(row.severity))
      pressured.set(objectId, entry)
    }
    const objectsUnderPressure = [...pressured.values()].sort((a, b) => b.maxSeverity - a.maxSeverity).map((entry) => ({ ...entry, name: nameOf(entry.objectId) }))
    const indicators = (db.query('SELECT * FROM indicators ORDER BY name').all() as Row[]).filter((row) => withinClearance(row, rank)).map((indicator) => {
      const readings = (db.query('SELECT value FROM indicator_readings WHERE indicator_id = ? AND observed_at <= ? ORDER BY observed_at').all(String(indicator.id), asOf) as Row[]).map((row) => Number(row.value))
      if (!readings.length) return { id: indicator.id, name: indicator.name, unit: indicator.unit, higherIs: indicator.higher_is, latest: null, zScore: null, trend: 'flat' }
      const mean = readings.reduce((sum, value) => sum + value, 0) / readings.length
      const stdev = readings.length > 1 ? Math.sqrt(readings.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (readings.length - 1)) : 0
      const latest = readings[readings.length - 1]!
      const tail = readings.slice(-3)
      const trendSign = tail.length >= 2 ? Math.sign(tail[tail.length - 1]! - tail[0]!) : 0
      return { id: indicator.id, name: indicator.name, unit: indicator.unit, higherIs: indicator.higher_is, latest, zScore: stdev > 0 ? round((latest - mean) / stdev) : 0, trend: trendSign > 0 ? 'rising' : trendSign < 0 ? 'falling' : 'flat' }
    })
    const pendingProposals = (db.query("SELECT p.id, p.rationale, p.proposed_by, t.name AS action_type_name FROM action_proposals p JOIN action_types t ON t.id = p.action_type_id WHERE p.status = 'pending' ORDER BY p.created_at").all() as Row[])
      .map((row) => ({ id: row.id, actionType: row.action_type_name, proposedBy: row.proposed_by, rationale: row.rationale }))
    const scorecard = scoreRows(resolvedLatestForecasts(db).filter((row) => row.resolvedAt <= asOf))
    const unreviewedClaims = Number((db.query("SELECT COUNT(*) AS count FROM claims c WHERE c.as_of <= ? AND NOT EXISTS (SELECT 1 FROM claim_reviews r WHERE r.claim_id = c.id AND r.verdict = 'supported')").get(asOf) as Row).count)
    const alerts: { severity: 'high' | 'medium'; kind: string; detail: string }[] = []
    for (const question of questions) if (question.delta !== null && question.delta >= 0.15) alerts.push({ severity: 'high', kind: 'forecast-rising', detail: `"${question.question}" rose ${Math.round(question.delta * 100)} points to ${Math.round((question.probability ?? 0) * 100)}%` })
    for (const event of topGeoEvents) if (event.severity >= 70) alerts.push({ severity: event.severity >= 85 ? 'high' : 'medium', kind: 'geo-event', detail: `${event.title} (${event.category}, severity ${event.severity})` })
    for (const indicator of indicators) if (indicator.zScore !== null && Math.abs(indicator.zScore) >= 1.5) alerts.push({ severity: 'medium', kind: 'indicator-outlier', detail: `${indicator.name} at z=${indicator.zScore} (${indicator.trend})` })
    for (const scenario of scenarios) if (scenario.status === 'active' && scenario.probability >= 0.5) alerts.push({ severity: 'medium', kind: 'scenario', detail: `${scenario.title} at ${Math.round(scenario.probability * 100)}%` })
    if (unreviewedClaims > 0) alerts.push({ severity: 'medium', kind: 'review-backlog', detail: `${unreviewedClaims} claim(s) without a supported review` })
    const counts = Object.fromEntries(['questions', 'evidence', 'claims', 'forecast_revisions', 'ontology_objects', 'ontology_links', 'scenarios', 'decisions', 'geo_events', 'indicators', 'datasets'].map((table) => [table, Number((db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as Row).count)]))
    return {
      storePath: path, asOf, clearance: rank === null ? null : String(input.clearance),
      counts, questions, scenarios,
      geo: { categories: geoCategories, topEvents: topGeoEvents, objectsUnderPressure },
      indicators, pendingProposals, scorecard, unreviewedClaims,
      alerts: [...alerts].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1)),
    }
  })
}

export const BATTMANN_STORE_ACTIONS = [
  'create_question', 'register_evidence', 'register_claim', 'review_claim', 'submit_forecast', 'resolve_question',
  'question_detail', 'list_questions', 'scorecard', 'run_benchmark', 'upsert_object', 'link_objects', 'create_scenario',
  'record_decision', 'record_outcome', 'workspace_snapshot',
  'object_detail', 'list_objects', 'find_path', 'explain_causality',
  'register_dataset', 'list_datasets', 'dataset_lineage', 'define_action', 'propose_action', 'decide_action_proposal', 'list_action_proposals',
  'register_geo_event', 'geo_query', 'situation_snapshot',
  'define_deployment_target', 'stage_deployment', 'deployment_status', 'audit_trail',
  'define_indicator', 'record_indicator_reading', 'list_indicators', 'indicator_series',
] as const

/** Actions that write to the store; each success appends one entry to the audit hash chain. */
const MUTATING_STORE_ACTIONS = new Set<string>([
  'create_question', 'register_evidence', 'register_claim', 'review_claim', 'submit_forecast', 'resolve_question',
  'run_benchmark', 'upsert_object', 'link_objects', 'create_scenario', 'record_decision', 'record_outcome',
  'register_dataset', 'define_action', 'propose_action', 'decide_action_proposal',
  'register_geo_event', 'define_deployment_target', 'stage_deployment',
  'define_indicator', 'record_indicator_reading',
])

const AUDIT_TARGET_KEYS = ['questionId', 'evidenceId', 'claimId', 'forecastId', 'objectId', 'linkId', 'scenarioId', 'decisionId', 'outcomeId', 'datasetId', 'actionTypeId', 'proposalId', 'geoEventId', 'targetId', 'benchmarkId', 'indicatorId', 'readingId'] as const

export function executeBattmannStoreAction(input: Row): string {
  const action = requiredText(input.action, 'action', 50)
  const handlers: Record<string, (value: Row) => Row> = {
    create_question: createQuestion,
    register_evidence: registerEvidence,
    register_claim: registerClaim,
    review_claim: reviewClaim,
    submit_forecast: submitForecast,
    resolve_question: resolveQuestion,
    question_detail: questionDetail,
    list_questions: listQuestions,
    scorecard,
    run_benchmark: runBenchmark,
    upsert_object: upsertObject,
    link_objects: linkObjects,
    create_scenario: createScenario,
    record_decision: recordDecision,
    record_outcome: recordOutcome,
    workspace_snapshot: workspaceSnapshot,
    object_detail: objectDetail,
    list_objects: listObjects,
    find_path: findObjectPath,
    explain_causality: explainCausality,
    register_dataset: registerDataset,
    list_datasets: listDatasets,
    dataset_lineage: datasetLineage,
    define_action: defineAction,
    propose_action: proposeAction,
    decide_action_proposal: decideActionProposal,
    list_action_proposals: listActionProposals,
    register_geo_event: registerGeoEvent,
    geo_query: geoQuery,
    situation_snapshot: situationSnapshot,
    define_deployment_target: defineDeploymentTarget,
    stage_deployment: stageDeployment,
    deployment_status: deploymentStatus,
    audit_trail: auditTrail,
    define_indicator: defineIndicator,
    record_indicator_reading: recordIndicatorReading,
    list_indicators: listIndicators,
    indicator_series: indicatorSeries,
  }
  const handler = handlers[action]
  if (!handler) throw new Error(`unsupported Battmann store action: ${action}`)
  const result = handler(input)
  if (MUTATING_STORE_ACTIONS.has(action)) {
    try {
      const opened = openStore(input, false)
      if (opened) {
        try {
          const target = AUDIT_TARGET_KEYS.map((key) => result[key]).find((value) => typeof value === 'string') as string | undefined
          transaction(opened.db, () => appendAudit(opened.db, action, target ?? null, input))
        } finally { opened.db.close() }
      }
    } catch { /* the audit chain is best-effort; a write must not fail because its audit row could not be appended */ }
  }
  return JSON.stringify({ action, ...result }, null, 2)
}

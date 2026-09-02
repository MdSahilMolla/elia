import { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolveWorkspacePath } from '../autonomy/context.ts'
import { ensureSecureDirectory, hardenSecureFile } from '../securePersistence.ts'

const DEFAULT_STORE_PATH = '.elia/battmann.sqlite'
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/

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
  if (Date.parse(result) > Date.now() + 60_000) throw new Error(`${name} cannot be in the future`)
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
  `)
  const forecastColumns = db.query('PRAGMA table_info(forecast_revisions)').all() as Row[]
  if (!forecastColumns.some((column) => column.name === 'forecast_class')) db.exec("ALTER TABLE forecast_revisions ADD COLUMN forecast_class TEXT NOT NULL DEFAULT 'live' CHECK(forecast_class IN ('live','backtest'))")
  db.exec('PRAGMA user_version = 3;')
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
    if (asOf && (String(row.published_at) > asOf || String(row.retrieved_at) > asOf)) throw new Error(`evidence ${id} was not available by ${asOf}`)
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
    db.query('INSERT INTO evidence (id, title, url, publisher, source_type, published_at, retrieved_at, excerpt, content_hash, independence_group, reliability, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, requiredText(input.title, 'title', 500), httpUrl(input.url, 'url'), optionalText(input.publisher, 'publisher', 300) ?? null, oneOf(input.sourceType ?? 'primary', 'sourceType', ['primary', 'secondary', 'dataset', 'model'] as const), publishedAt, retrievedAt, excerpt, contentHash, requiredText(input.independenceGroup, 'independenceGroup', 100), boundedNumber(input.reliability, 'reliability', 0, 1), new Date().toISOString(),
    )
    return { status: 'created', storePath: path, evidenceId: id, contentHash }
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
    db.query('INSERT INTO claims (id, statement, classification, confidence, as_of, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id, requiredText(input.statement, 'statement'), oneOf(input.classification, 'classification', ['observed_fact', 'reproducible_calculation', 'model_estimate', 'judgement'] as const), oneOf(input.confidence, 'confidence', ['low', 'medium', 'high'] as const), asOf, new Date().toISOString(),
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
    db.query('INSERT INTO ontology_objects (id, revision, type, name, valid_from, valid_to, confidence, properties_json, evidence_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, revision, requiredText(input.objectType, 'objectType', 100), requiredText(input.name, 'name', 500), validFrom, validTo, oneOf(input.confidence, 'confidence', ['low', 'medium', 'high'] as const), JSON.stringify(jsonObject(input.properties, 'properties')), JSON.stringify([...new Set(evidenceIds)]), new Date().toISOString(),
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
    db.query('INSERT INTO ontology_links (id, from_id, to_id, type, valid_from, valid_to, confidence, properties_json, evidence_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      linkId, fromId, toId, requiredText(input.linkType, 'linkType', 100), validFrom, validTo, oneOf(input.confidence, 'confidence', ['low', 'medium', 'high'] as const), JSON.stringify(jsonObject(input.properties, 'properties')), JSON.stringify([...new Set(evidenceIds)]), new Date().toISOString(),
    )
    return { status: 'created', storePath: path, linkId, fromId, toId }
  }))
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
      counts: Object.fromEntries(['questions', 'evidence', 'claims', 'claim_reviews', 'forecast_revisions', 'resolution_events', 'ontology_objects', 'ontology_links', 'scenarios', 'decisions', 'outcomes', 'benchmark_runs'].map((table) => [table, count(table)])),
      openQuestions: openQuestions.map(hydrateQuestion),
      recentClaims: claims,
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

export const BATTMANN_STORE_ACTIONS = [
  'create_question', 'register_evidence', 'register_claim', 'review_claim', 'submit_forecast', 'resolve_question',
  'question_detail', 'list_questions', 'scorecard', 'run_benchmark', 'upsert_object', 'link_objects', 'create_scenario',
  'record_decision', 'record_outcome', 'workspace_snapshot',
] as const

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
  }
  const handler = handlers[action]
  if (!handler) throw new Error(`unsupported Battmann store action: ${action}`)
  return JSON.stringify({ action, ...handler(input) }, null, 2)
}

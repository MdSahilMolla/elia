import { randomUUID } from 'node:crypto'
import { platform, arch, release } from 'node:os'

/**
 * Execution records: the reproducibility and validation evidence for every data-science
 * action. A record says what went in (dataset versions and fingerprints), what ran (the
 * parameters, SQL, expressions, code, and seed), what came out (datasets, models,
 * artifacts with hashes, metrics), and whether the result passed its validation checks.
 * A run with no checks is reported as "unvalidated", never as a success.
 */

export type CheckStatus = 'pass' | 'warn' | 'fail'

export interface Check {
  name: string
  status: CheckStatus
  detail: string
}

export type ValidationStatus = 'passed' | 'passed-with-warnings' | 'failed' | 'unvalidated' | 'error'

export interface ExecutionRecord {
  id: string
  tool: string
  action: string
  startedAt: string
  finishedAt?: string
  durationMs?: number
  status: ValidationStatus
  inputs: Array<{ dataset: string; fingerprint: string; rows: number }>
  params: Record<string, unknown>
  code: Array<{ language: 'sql' | 'python' | 'expression' | 'dax' | 'tmdl' | 'pipeline'; text: string }>
  seed?: number
  environment: Record<string, string>
  outputs: {
    datasets: string[]
    models: string[]
    artifacts: Array<{ path: string; sha256: string; bytes: number }>
  }
  metrics: Record<string, unknown>
  checks: Check[]
  warnings: string[]
  error?: string
}

const SECRETISH = /(password|passwd|secret|token|api[_-]?key|authorization|cookie|credential|dsn)$/i

export function redactParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (SECRETISH.test(key) && !key.endsWith('Env')) out[key] = '[REDACTED]'
    else if (typeof value === 'string' && value.length > 4000) out[key] = `${value.slice(0, 4000)}… (${value.length} chars)`
    else if (Array.isArray(value) && value.length > 200) out[key] = [...value.slice(0, 200), `… ${value.length - 200} more`]
    else out[key] = value
  }
  return out
}

let eliaVersion: string | undefined
function version(): string {
  if (eliaVersion) return eliaVersion
  try {
    eliaVersion = (require('../../package.json') as { version: string }).version
  } catch {
    eliaVersion = 'unknown'
  }
  return eliaVersion
}

export function environmentInfo(): Record<string, string> {
  return { elia: version(), engine: 'elia-datascience/1', bun: Bun.version, platform: `${platform()} ${release()} ${arch()}` }
}

export class RecordBuilder {
  readonly record: ExecutionRecord
  private readonly started = Date.now()

  constructor(tool: string, action: string, params: Record<string, unknown>) {
    this.record = {
      id: randomUUID().slice(0, 12),
      tool,
      action,
      startedAt: new Date(this.started).toISOString(),
      status: 'unvalidated',
      inputs: [],
      params: redactParams(params),
      code: [],
      environment: environmentInfo(),
      outputs: { datasets: [], models: [], artifacts: [] },
      metrics: {},
      checks: [],
      warnings: [],
    }
  }

  get id(): string {
    return this.record.id
  }

  input(dataset: string, fingerprint: string, rows: number): void {
    if (!this.record.inputs.some((input) => input.dataset === dataset)) this.record.inputs.push({ dataset, fingerprint, rows })
  }

  code(language: ExecutionRecord['code'][number]['language'], text: string): void {
    this.record.code.push({ language, text })
  }

  seed(seed: number): void {
    this.record.seed = seed
  }

  outputDataset(ref: string): void {
    this.record.outputs.datasets.push(ref)
  }

  outputModel(ref: string): void {
    this.record.outputs.models.push(ref)
  }

  outputArtifact(path: string, sha256: string, bytes: number): void {
    this.record.outputs.artifacts.push({ path, sha256, bytes })
  }

  metric(name: string, value: unknown): void {
    this.record.metrics[name] = value
  }

  check(name: string, status: CheckStatus, detail: string): void {
    this.record.checks.push({ name, status, detail })
  }

  /** Records a boolean postcondition: pass when `ok`, otherwise `failStatus`. */
  expect(name: string, ok: boolean, detail: string, failStatus: CheckStatus = 'fail'): boolean {
    this.check(name, ok ? 'pass' : failStatus, detail)
    return ok
  }

  warn(message: string): void {
    if (!this.record.warnings.includes(message)) this.record.warnings.push(message)
  }

  finish(error?: unknown): ExecutionRecord {
    this.record.finishedAt = new Date().toISOString()
    this.record.durationMs = Date.now() - this.started
    if (error) {
      this.record.status = 'error'
      this.record.error = error instanceof Error ? error.message : String(error)
    } else if (this.record.checks.length === 0) this.record.status = 'unvalidated'
    else if (this.record.checks.some((check) => check.status === 'fail')) this.record.status = 'failed'
    else if (this.record.checks.some((check) => check.status === 'warn')) this.record.status = 'passed-with-warnings'
    else this.record.status = 'passed'
    return this.record
  }
}

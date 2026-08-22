import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from '../statePaths.ts'

export type SupervisorControlAction = 'pause' | 'stop'

export interface SupervisorControlRequest {
  version: 1
  action: SupervisorControlAction
  requestedAt: number
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function runControlPath(runId: string, runsRoot = paths.runs): string {
  assertRunId(runId)
  return join(runsRoot, runId, 'control.json')
}

export function requestRunControl(runId: string, action: SupervisorControlAction, runsRoot = paths.runs): boolean {
  const path = runControlPath(runId, runsRoot)
  const runDir = join(runsRoot, runId)
  if (!existsSync(runDir)) return false
  mkdirSync(runDir, { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify({ version: 1, action, requestedAt: Date.now() } satisfies SupervisorControlRequest)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
  return true
}

export function readRunControl(runId: string, runsRoot = paths.runs): SupervisorControlRequest | undefined {
  const path = runControlPath(runId, runsRoot)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SupervisorControlRequest>
    if (parsed.version !== 1 || (parsed.action !== 'pause' && parsed.action !== 'stop') || typeof parsed.requestedAt !== 'number' || !Number.isFinite(parsed.requestedAt)) return undefined
    return { version: 1, action: parsed.action, requestedAt: parsed.requestedAt }
  } catch {
    return undefined
  }
}

export function clearRunControl(runId: string, runsRoot = paths.runs): void {
  const path = runControlPath(runId, runsRoot)
  try {
    unlinkSync(path)
  } catch {
    // A missing control request is already clear.
  }
}

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new Error('Invalid run id')
}

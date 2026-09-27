/**
 * The autopilot's durable memory for one repository: `.elia/autopilot/`.
 *
 *   state.json     the whole pilot — understanding, backlog, outcomes — rewritten
 *                  atomically after every step, so a killed process resumes
 *   journal.jsonl  append-only events, one line each, for the report and audit
 *   REPORT.md      the human-readable account, regenerated as the pilot moves
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CorruptStateError, noteCorruptState, parseLocalJson } from '../localJson.ts'
import { appendSecureFile, writeSecureFile } from '../securePersistence.ts'
import type { PilotState } from './types.ts'

export function autopilotDir(root: string): string {
  return join(root, '.elia', 'autopilot')
}

export function statePath(root: string): string {
  return join(autopilotDir(root), 'state.json')
}

export function reportPath(root: string): string {
  return join(autopilotDir(root), 'REPORT.md')
}

export function newPilotId(now = new Date()): string {
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2')
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`
}

export function newPilotState(root: string, now = new Date()): PilotState {
  const stamp = now.toISOString()
  return { version: 1, id: newPilotId(now), root, startedAt: stamp, updatedAt: stamp, phase: 'survey', backlog: [], goalsRun: 0, needsHuman: [] }
}

export function loadPilotState(root: string): PilotState | undefined {
  const path = statePath(root)
  if (!existsSync(path)) return undefined
  try {
    const parsed = parseLocalJson(readFileSync(path, 'utf8'), path) as PilotState
    if (parsed?.version !== 1 || !Array.isArray(parsed.backlog)) throw new CorruptStateError(path, 'not an autopilot state file (version 1)')
    return parsed
  } catch (error) {
    noteCorruptState('autopilot.state', path, error, { keepCopy: true })
    return undefined
  }
}

export function savePilotState(state: PilotState, now = new Date()): void {
  state.updatedAt = now.toISOString()
  writeSecureFile(statePath(state.root), `${JSON.stringify(state, null, 2)}\n`)
}

export function appendJournal(root: string, event: string, data: Record<string, unknown> = {}, now = new Date()): void {
  try {
    appendSecureFile(join(autopilotDir(root), 'journal.jsonl'), `${JSON.stringify({ at: now.toISOString(), event, ...data })}\n`)
  } catch {
    // The journal is an audit trail, not a dependency: a full disk must not stop the pilot.
  }
}

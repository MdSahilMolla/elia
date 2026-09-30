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
import { isHashTrusted, sha256Hex, trustHash } from '../autonomy/projectTrust.ts'
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

/**
 * The saved pilot, or undefined. The file sits inside the repository, so a
 * repo could ship one whose branch, backlog and verification commands become
 * the pilot's own plan; it is honoured only when the user-level trust record
 * holds the hash of exactly these bytes — which {@link savePilotState}
 * records each time this machine's own pilot writes it. A state file that did
 * not come from a pilot run here (or was edited since) is treated as absent.
 */
export function loadPilotState(root: string): PilotState | undefined {
  const path = statePath(root)
  if (!existsSync(path)) return undefined
  try {
    const text = readFileSync(path, 'utf8')
    if (!isHashTrusted(path, sha256Hex(text))) return undefined
    const parsed = parseLocalJson(text, path) as PilotState
    if (parsed?.version !== 1 || !Array.isArray(parsed.backlog)) throw new CorruptStateError(path, 'not an autopilot state file (version 1)')
    return parsed
  } catch (error) {
    noteCorruptState('autopilot.state', path, error, { keepCopy: true })
    return undefined
  }
}

export function savePilotState(state: PilotState, now = new Date()): void {
  state.updatedAt = now.toISOString()
  const path = statePath(state.root)
  const text = `${JSON.stringify(state, null, 2)}\n`
  writeSecureFile(path, text)
  trustHash(path, sha256Hex(text))
}

/** True when a state file is present but not one this machine's pilot wrote (or it changed since) — it is ignored. */
export function hasUntrustedPilotState(root: string): boolean {
  const path = statePath(root)
  if (!existsSync(path)) return false
  try {
    return !isHashTrusted(path, sha256Hex(readFileSync(path, 'utf8')))
  } catch {
    return false
  }
}

export function appendJournal(root: string, event: string, data: Record<string, unknown> = {}, now = new Date()): void {
  try {
    appendSecureFile(join(autopilotDir(root), 'journal.jsonl'), `${JSON.stringify({ at: now.toISOString(), event, ...data })}\n`)
  } catch {
    // The journal is an audit trail, not a dependency: a full disk must not stop the pilot.
  }
}

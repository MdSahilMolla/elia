import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConversationMessage } from './agentLoop.ts'
import { SESSIONS_DIR } from './session.ts'
import { ensureSecureDirectory, hardenSecureFile, writeSecureBunFile } from './securePersistence.ts'

/**
 * Per-turn checkpoints for the interactive session: enough to put both the
 * conversation and any files elia touched back exactly where they were before a
 * given turn started, the way Claude Code's rewind or Cursor's checkpoints do.
 *
 * This is a different layer from autonomy/journal.ts, which checkpoints
 * planning decisions *inside* one `elia auto` run so it can be re-planned from a
 * decision point. This module checkpoints turn boundaries in the ordinary
 * interactive REPL, driven by index.ts.
 */

export type FileSnapshot = Record<string, string | null>

export interface Checkpoint {
  turn: number
  at: number
  label: string
  messagesBefore: ConversationMessage[]
  files: FileSnapshot
}

export interface FileTracker {
  /** Records a file's current content the first time it's touched this turn; a no-op afterward. */
  capture(path: string): Promise<void>
  snapshot(): FileSnapshot
}

export function createFileTracker(): FileTracker {
  const captured: FileSnapshot = {}
  return {
    async capture(path) {
      if (path in captured) return
      const file = Bun.file(path)
      captured[path] = (await file.exists()) ? await file.text() : null
    },
    snapshot() {
      return { ...captured }
    },
  }
}

/**
 * The tracker for whichever turn is currently running. Module-level rather than
 * threaded through call arguments because write_file/edit_file are also reached
 * from inside sub-agents spawned via the task tool — several call frames away
 * from the REPL loop that owns the turn — but sub-agents run in-process, so a
 * module-level pointer is visible to them too without plumbing a tracker through
 * every tool's input schema.
 */
let activeTracker: FileTracker | undefined

export function setActiveTracker(tracker: FileTracker | undefined): void {
  activeTracker = tracker
}

/** Called by write_file/edit_file just before they touch a file. No-op with no active tracker. */
export async function captureBeforeWrite(path: string): Promise<void> {
  await activeTracker?.capture(path)
}

function checkpointsPath(sessionId: string, dir: string): string {
  return join(dir, `${sessionId}.checkpoints.json`)
}

export async function loadCheckpoints(sessionId: string, dir: string = SESSIONS_DIR): Promise<Checkpoint[]> {
  const path = checkpointsPath(sessionId, dir)
  const file = Bun.file(path)
  if (!(await file.exists())) return []
  hardenSecureFile(path)
  try {
    return (await file.json()) as Checkpoint[]
  } catch {
    return []
  }
}

export async function saveCheckpoints(
  sessionId: string,
  checkpoints: Checkpoint[],
  dir: string = SESSIONS_DIR,
): Promise<void> {
  ensureSecureDirectory(dir)
  await writeSecureBunFile(checkpointsPath(sessionId, dir), JSON.stringify(checkpoints))
}

export interface RestoreResult {
  /** Files written back to their pre-turn content. */
  restored: number
  /** Files that didn't exist before the checkpoint's turn and were deleted. */
  deleted: number
}

/** Writes every file in the checkpoint's snapshot back to its state from before that turn ran. */
export async function restoreCheckpoint(checkpoint: Checkpoint): Promise<RestoreResult> {
  let restored = 0
  let deleted = 0
  for (const [path, content] of Object.entries(checkpoint.files)) {
    if (content === null) {
      if (existsSync(path)) {
        await unlink(path)
        deleted += 1
      }
      continue
    }
    await Bun.write(path, content)
    restored += 1
  }
  return { restored, deleted }
}

/**
 * Reads a file's snapshot from a checkpoint without writing anything to disk —
 * the read-only counterpart to restoreCheckpoint, used by the `recall` tool to
 * pull a file exactly as it was at the point an archived episode happened,
 * without disturbing the working tree. `undefined` means the checkpoint never
 * tracked that path at all; `null` means it tracked it as not-yet-existing.
 */
export function peekCheckpointFile(checkpoint: Checkpoint, path: string): string | null | undefined {
  return checkpoint.files[path]
}

export function renderCheckpointList(checkpoints: Checkpoint[]): string {
  if (checkpoints.length === 0) return 'No rewind points yet — nothing to rewind to.'
  const lines = checkpoints.map((checkpoint) => {
    const fileCount = Object.keys(checkpoint.files).length
    const filesNote = fileCount > 0 ? `, ${fileCount} file${fileCount === 1 ? '' : 's'} touched` : ''
    return `  ${checkpoint.turn}  "${checkpoint.label}"${filesNote}`
  })
  return `Rewind points (rewind <n> restores conversation + files to just before that turn):\n${lines.join('\n')}`
}

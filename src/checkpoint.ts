import { existsSync } from 'node:fs'
import { rename, unlink, writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ConversationMessage } from './agentLoop.ts'
import { SESSIONS_DIR } from './session.ts'
import { ensureSecureDirectory, hardenSecureFile, writeSecureBunFile } from './securePersistence.ts'
import { clearAllCaches } from './cacheRegistry.ts'
import { withFileLockAsync } from './fileLock.ts'
import { assertSelfEditAllowed } from './autonomy/selfEdit.ts'
import { logSwallowedError } from './diagnostics.ts'

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

/**
 * The copy of each conversation message that checkpoints hold, made once per
 * message and shared by every checkpoint that includes it.
 *
 * Each turn used to take `structuredClone(messages)` — a deep copy of the
 * entire history — and every checkpoint kept its own. Turn N therefore held N
 * full copies of the early conversation: memory grew as turns × context.
 * Messages are append-only once pushed (compaction splices the array; nothing
 * edits a message object in place), so one private copy per message is as
 * faithful as a fresh deep clone and makes the total O(messages).
 */
const checkpointCopy = new WeakMap<ConversationMessage, ConversationMessage>()

export function snapshotMessages(messages: ConversationMessage[]): ConversationMessage[] {
  return messages.map((message) => {
    let copy = checkpointCopy.get(message)
    if (!copy) {
      copy = structuredClone(message)
      checkpointCopy.set(message, copy)
    }
    return copy
  })
}

/**
 * The messages to put back into the live conversation on a rewind. A fresh
 * clone, so the live history never aliases the copies other checkpoints share.
 */
export function messagesForRestore(checkpoint: Checkpoint): ConversationMessage[] {
  return structuredClone(checkpoint.messagesBefore)
}

/** Loaded checkpoints repeat every earlier message; re-share identical ones so a resumed session isn't back to turns × context. */
function shareRepeatedMessages(checkpoints: Checkpoint[]): Checkpoint[] {
  const byContent = new Map<string, ConversationMessage>()
  for (const checkpoint of checkpoints) {
    if (!Array.isArray(checkpoint.messagesBefore)) continue
    checkpoint.messagesBefore = checkpoint.messagesBefore.map((message) => {
      const key = JSON.stringify(message)
      const existing = byContent.get(key)
      if (existing) return existing
      byContent.set(key, message)
      return message
    })
  }
  return checkpoints
}

export function createFileTracker(): FileTracker {
  const captured: FileSnapshot = {}
  const claimed = new Set<string>()
  return {
    async capture(path) {
      if (claimed.has(path)) return
      claimed.add(path)
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

/**
 * Called by every file tool just before it touches a file. Snapshots the file
 * for the active turn (no-op with no tracker) — and, being the one step every
 * write shares, is where a session running on elia's own source refuses a
 * write to it while self-edit is off (see autonomy/selfEdit.ts).
 */
export async function captureBeforeWrite(path: string): Promise<void> {
  assertSelfEditAllowed(path)
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
    return shareRepeatedMessages((await file.json()) as Checkpoint[])
  } catch (error) {
    logSwallowedError('checkpoint.load.corrupt', error, { path })
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

function restoreLockPath(): string {
  return join(process.cwd(), '.elia', 'checkpoint-restore.lock')
}

function restoreTempPath(path: string): string {
  return join(dirname(path), `.${path.split(/[\\/]/).pop() || 'file'}.elia-restore-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`)
}

/**
 * Writes every file in the checkpoint's snapshot back to its state from
 * before that turn ran. Staged in two phases so an interruption never leaves
 * a half-restored tree: first every file to restore is written to a sibling
 * temp file (the real tree is untouched, so a failure here changes nothing);
 * only once every write has succeeded does the commit phase apply them —
 * `rename` each temp file over its target (atomic per file) and delete each
 * file the checkpoint says didn't exist yet. A crash during commit can still
 * leave the batch partially applied (there is no cross-file filesystem
 * transaction), but that window is now just fast renames/unlinks, not slow
 * content writes, and any file it does touch is never torn.
 */
export async function restoreCheckpoint(checkpoint: Checkpoint): Promise<RestoreResult> {
  return withFileLockAsync(restoreLockPath(), async () => {
    const toRestore = Object.entries(checkpoint.files).filter((entry): entry is [string, string] => entry[1] !== null)
    const deletions = Object.entries(checkpoint.files)
      .filter(([, content]) => content === null)
      .map(([path]) => path)
      .filter((path) => existsSync(path))

    const staged: { tmp: string; target: string }[] = []
    try {
      for (const [path, content] of toRestore) {
        const tmp = restoreTempPath(path)
        await writeFile(tmp, content)
        staged.push({ tmp, target: path })
      }
    } catch (err) {
      await Promise.all(staged.map((s) => rm(s.tmp, { force: true })))
      throw err
    }

    let restored = 0
    let deleted = 0
    for (const { tmp, target } of staged) {
      await rename(tmp, target)
      restored += 1
    }
    for (const path of deletions) {
      await unlink(path)
      deleted += 1
    }

    // Every in-process cache — speculated reads, compiled greps, the brain
    // fingerprint — now describes a workspace that no longer exists on disk.
    clearAllCaches()
    return { restored, deleted }
  })
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

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ConversationMessage } from './agentLoop.ts'
import { writeError } from './ui/stream.ts'

export const SESSIONS_DIR = join(process.cwd(), '.elia', 'sessions')

export interface StoredSession {
  id: string
  updatedAt: number
  messages: ConversationMessage[]
}

export function newSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Persists a session. Failures are logged as a notice and never throw — a save error shouldn't kill the session. */
export async function saveSession(
  id: string,
  messages: ConversationMessage[],
  dir: string = SESSIONS_DIR,
): Promise<void> {
  const session: StoredSession = { id, updatedAt: Date.now(), messages }
  try {
    await Bun.write(join(dir, `${id}.json`), JSON.stringify(session))
  } catch (err) {
    writeError(`Warning: failed to save session: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function loadSession(id: string, dir: string = SESSIONS_DIR): Promise<StoredSession | undefined> {
  const file = Bun.file(join(dir, `${id}.json`))
  if (!(await file.exists())) return undefined
  return (await file.json()) as StoredSession
}

export async function loadLatestSession(dir: string = SESSIONS_DIR): Promise<StoredSession | undefined> {
  if (!existsSync(dir)) return undefined

  const files = readdirSync(dir).filter((name) => name.endsWith('.json'))
  if (files.length === 0) return undefined

  const newest = files
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]!

  return loadSession(newest.name.replace(/\.json$/, ''), dir)
}

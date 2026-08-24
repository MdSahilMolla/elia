import { existsSync, readdirSync, statSync } from 'node:fs'
import { ensureSecureDirectory, hardenSecureFile, writeSecureBunFile } from './securePersistence.ts'
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
  if (!isSafeSessionId(id)) {
    writeError('Warning: failed to save session: invalid session id')
    return
  }
  try {
    const path = join(dir, `${id}.json`)
    ensureSecureDirectory(dir)
    await writeSecureBunFile(path, JSON.stringify(session))
  } catch (err) {
    writeError(`Warning: failed to save session: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function loadSession(id: string, dir: string = SESSIONS_DIR): Promise<StoredSession | undefined> {
  if (!isSafeSessionId(id)) return undefined
  const path = join(dir, `${id}.json`)
  const file = Bun.file(path)
  if (!(await file.exists())) return undefined
  hardenSecureFile(path)
  try {
    const parsed: unknown = await file.json()
    return isStoredSession(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export async function loadLatestSession(dir: string = SESSIONS_DIR): Promise<StoredSession | undefined> {
  if (!existsSync(dir)) return undefined
  ensureSecureDirectory(dir)

  const files = readdirSync(dir).filter((name) => name.endsWith('.json'))
  if (files.length === 0) return undefined

  const newest = files
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]!

  return loadSession(newest.name.replace(/\.json$/, ''), dir)
}

function isSafeSessionId(id: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)?$/i.test(id) && id.length <= 100
}

function isStoredSession(value: unknown): value is StoredSession {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.id === 'string'
    && isSafeSessionId(candidate.id)
    && typeof candidate.updatedAt === 'number'
    && Number.isFinite(candidate.updatedAt)
    && Array.isArray(candidate.messages)
    && candidate.messages.every((message) => {
      if (!message || typeof message !== 'object') return false
      const item = message as Record<string, unknown>
      return (item.role === 'user' || item.role === 'assistant') && Array.isArray(item.content)
    })
}

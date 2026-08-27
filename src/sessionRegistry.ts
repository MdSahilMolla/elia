import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from './statePaths.ts'
import { ensureSecureDirectory, hardenSecureFile, writeSecureFile } from './securePersistence.ts'

/**
 * Lets one running `elia` process see what other `elia` processes in the same
 * project are doing — separate, deliberately lightweight machinery from
 * taskSessions.ts's own dashboard (which tracks this process's own turns/
 * sub-agents in-memory, backed by one shared file). Here, every process
 * writes only its own file (`<sessionId>.json`, atomic rename per write —
 * see securePersistence.ts), so concurrent processes can never race each
 * other's writes; a reader just lists and merges whatever files exist. No
 * process ever reads another's *conversation* — only this small status
 * summary — so this adds visibility without adding any new way for one
 * session to affect another's actual work.
 */

const STALE_MS = 2 * 60_000 // no heartbeat this recently while marked running => treat as stopped, not still going

export interface SessionHeartbeatInput {
  sessionId: string
  pid: number
  mode: string
  providerLabel: string
  model: string
  startedAt: number
  /** True while a turn is actively running; false while idle at the prompt. */
  busy: boolean
  lastAction: string
  taskSummary: string
  messageCount: number
}

export interface SessionHeartbeat extends SessionHeartbeatInput {
  updatedAt: number
  /** Set once, when the session exits cleanly. */
  endedAt?: number
}

export type SessionLiveStatus = 'running' | 'idle' | 'stopped' | 'ended'

export interface KnownSession extends SessionHeartbeat {
  liveStatus: SessionLiveStatus
}

function statusPath(sessionId: string, dir: string): string {
  return join(dir, `${sessionId}.json`)
}

/** Best-effort — cross-session visibility is a convenience, never load-bearing, so a write failure is silent. */
export function writeSessionHeartbeat(info: SessionHeartbeatInput, dir = paths.sessionStatus): void {
  try {
    ensureSecureDirectory(dir)
    const record: SessionHeartbeat = { ...info, updatedAt: Date.now() }
    writeSecureFile(statusPath(info.sessionId, dir), JSON.stringify(record))
  } catch {
    // See doc comment above.
  }
}

/** Marks a session as cleanly ended — called once, right before the process exits normally. */
export function writeSessionEnded(info: SessionHeartbeatInput, dir = paths.sessionStatus): void {
  try {
    ensureSecureDirectory(dir)
    const now = Date.now()
    const record: SessionHeartbeat = { ...info, busy: false, updatedAt: now, endedAt: now }
    writeSecureFile(statusPath(info.sessionId, dir), JSON.stringify(record))
  } catch {
    // See doc comment above.
  }
}

export function listKnownSessions(dir = paths.sessionStatus): KnownSession[] {
  if (!existsSync(dir)) return []
  let files: string[]
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }

  const now = Date.now()
  const results: KnownSession[] = []
  for (const file of files) {
    const path = join(dir, file)
    try {
      hardenSecureFile(path)
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SessionHeartbeat>
      if (!isValidHeartbeat(parsed)) continue
      const stale = !parsed.endedAt && now - parsed.updatedAt > STALE_MS
      const liveStatus: SessionLiveStatus = parsed.endedAt ? 'ended' : stale ? 'stopped' : parsed.busy ? 'running' : 'idle'
      results.push({ ...parsed, liveStatus })
    } catch {
      // A corrupt or half-written heartbeat file shouldn't hide every other session.
    }
  }
  return results.sort((a, b) => b.updatedAt - a.updatedAt)
}

function isValidHeartbeat(value: Partial<SessionHeartbeat>): value is SessionHeartbeat {
  return (
    typeof value.sessionId === 'string' &&
    typeof value.updatedAt === 'number' &&
    Number.isFinite(value.updatedAt) &&
    typeof value.pid === 'number' &&
    typeof value.busy === 'boolean'
  )
}

import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { isProcessAlive } from '../fileLock.ts'
import { ensureSecureDirectory } from '../securePersistence.ts'
import { stateDir } from '../statePaths.ts'

/**
 * One benchmark measurement at a time in a checkout.
 *
 * `elia bench`, `elia evolve` and the idle-time practice run all measure by
 * running real agent loops on this machine against one provider account, and
 * nothing stopped two of them overlapping. Each makes the other's numbers
 * wrong. The CPU is shared, so task time — half of the efficiency tie-break —
 * goes up for both. Unit tests time out and read as a candidate breaking them.
 * And the provider's quota is split, so tasks go unmeasured. Both kinds of
 * error have cost real generations: one was rejected for a unit test that only
 * timed out because a bench ran beside it, and one for "time +79%" measured
 * while a full sweep ran alongside. A generation is the expensive unit of
 * learning here; losing one to a collision is the slowest way to learn.
 *
 * So a measurement claims the checkout first. The claim is a file naming the
 * process, created exclusively, and it is only as strong as that process: when
 * the holder is gone — finished, crashed, killed by a sleeping laptop — the
 * next claimer takes the slot over. A holder older than `MAX_HOLD_MS` is taken
 * to be a reused pid, not a sweep, and is taken over too.
 */

export const MEASURE_SLOT_PATH = process.env.ELIA_MEASURE_SLOT_PATH || join(stateDir, 'bench', 'measuring.json')

/** Longer than a full sweep on a slow free tier; past it, a live pid is someone else's. */
export const MAX_HOLD_MS = 24 * 60 * 60_000

export interface SlotHolder {
  pid: number
  /** What is measuring, as the person would have typed it: `elia bench --all`. */
  command: string
  startedAt: number
  host: string
}

export interface SlotCheck {
  now?: number
  alive?: (pid: number) => boolean
  host?: string
}

export type SlotClaim = { ok: true; release: () => void } | { ok: false; holder: SlotHolder }

function readHolder(path: string): SlotHolder | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SlotHolder>
    if (typeof parsed.pid === 'number' && typeof parsed.command === 'string' && typeof parsed.startedAt === 'number' && typeof parsed.host === 'string') {
      return parsed as SlotHolder
    }
  } catch {
    // Missing, half-written, or not ours: no holder.
  }
  return undefined
}

/** Whether a recorded holder is still measuring. A holder on another machine (a shared disk) is trusted until it ages out. */
function holding(holder: SlotHolder, check: SlotCheck): boolean {
  const now = check.now ?? Date.now()
  if (now - holder.startedAt > MAX_HOLD_MS) return false
  if (holder.host !== (check.host ?? hostname())) return true
  return (check.alive ?? isProcessAlive)(holder.pid)
}

/** Who is measuring in this checkout right now, if anyone. */
export function measuringNow(path = MEASURE_SLOT_PATH, check: SlotCheck = {}): SlotHolder | undefined {
  const holder = readHolder(path)
  return holder && holding(holder, check) ? holder : undefined
}

/**
 * Claims the checkout for one measurement. On success the caller must call
 * `release` when it is done; it is also released when the process exits, and a
 * process that dies without either is taken over by the next claimer.
 */
export function claimMeasureSlot(command: string, path = MEASURE_SLOT_PATH, check: SlotCheck = {}): SlotClaim {
  const mine: SlotHolder = { pid: process.pid, command, startedAt: check.now ?? Date.now(), host: check.host ?? hostname() }
  ensureSecureDirectory(dirname(path))
  // Two attempts: the second only after clearing a holder that is gone.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number | undefined
    try {
      fd = openSync(path, 'wx', 0o600)
      writeSync(fd, `${JSON.stringify(mine)}\n`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const holder = readHolder(path)
      if (holder && holding(holder, check)) return { ok: false, holder }
      rmSync(path, { force: true })
      continue
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
    let released = false
    const release = () => {
      if (released) return
      released = true
      process.off('exit', release)
      // Only our own claim: a slot taken over after we were judged gone is not ours to clear.
      const current = readHolder(path)
      if (current?.pid === mine.pid && current.startedAt === mine.startedAt) rmSync(path, { force: true })
    }
    process.on('exit', release)
    return { ok: true, release }
  }
  // Another claimer won the race for a slot we had just cleared.
  return { ok: false, holder: readHolder(path) ?? { pid: 0, command: 'another measurement', startedAt: mine.startedAt, host: mine.host } }
}

/** The line a refused claimer prints: who holds the checkout and why that matters. */
export function describeHolder(holder: SlotHolder, now = Date.now()): string {
  const minutes = Math.max(1, Math.round((now - holder.startedAt) / 60_000))
  const since = minutes < 90 ? `${minutes} minute(s)` : `${Math.round(minutes / 60)} hour(s)`
  return `\`${holder.command}\` (pid ${holder.pid}) has been measuring in this checkout for ${since}. Two measurements at once slow each other's tasks and split the provider's quota, so both would be scored wrong; wait for it to finish, or stop it first.`
}

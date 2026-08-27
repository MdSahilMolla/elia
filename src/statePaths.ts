import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where elia's own source lives, independent of the caller's working directory. */
export const ELIA_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Per-project state directory (runs, evolution ledger, synthesized skills). */
export const stateDir = join(process.cwd(), '.elia')

/** Visible home for real work product, distinct from internal `.elia/` state. */
const workspaceDir = join(process.cwd(), 'workspace')

export const paths = {
  state: stateDir,
  sessions: join(stateDir, 'sessions'),
  // A separate directory (not sessions/) so a live heartbeat file, which ends
  // in .json like everything else here, can never be mistaken by
  // session.ts's own directory scan for a real conversation file.
  sessionStatus: join(stateDir, 'session-status'),
  runs: join(stateDir, 'runs'),
  evolution: join(stateDir, 'evolution'),
  lessons: join(stateDir, 'lessons.md'),
  workspace: workspaceDir,
}

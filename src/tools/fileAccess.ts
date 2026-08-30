// Tracks which files the agent has actually looked at, so write_file can refuse
// to blow away a non-empty file it has never read. In the session we watched,
// the agent overwrote a hand-written index.html it had never opened — a whole
// unified-diff card of destruction that a "read it first" gate would have
// stopped.
//
// Module-level (like checkpoint.ts's activeTracker) because read_file /
// edit_file / write_file are reached from deep inside sub-agents too. The set is
// session-lifetime: the risk being guarded is "never inspected", and write_file
// replaces the whole file anyway, so staleness is not the concern here.
import { resolve } from 'node:path'

const readPaths = new Set<string>()

function key(path: string): string {
  return resolve(path).replace(/\\/g, '/').toLowerCase()
}

/** Record that the agent has seen this file's contents (read_file / a successful edit_file). */
export function noteFileRead(path: string): void {
  readPaths.add(key(path))
}

/** Has the agent read this exact file at any point this session? */
export function hasReadFile(path: string): boolean {
  return readPaths.has(key(path))
}

/** Test hook. */
export function resetFileAccess(): void {
  readPaths.clear()
}

import { mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runGit } from './worktree.ts'

/**
 * A restorable snapshot of the working tree's *dirty* state — the changed,
 * added, and deleted files against HEAD. Used by the autonomous loop so a run
 * that has dug itself into a hole (the same failures surviving every repair
 * attempt) can be reverted to the last point verification was green and
 * re-planned from a clean slate, instead of piling more edits onto a broken
 * tree.
 *
 * It records only the dirty files (usually a handful), not the whole tree, and
 * uses `git` via an argv array so a repo path with spaces on Windows is safe.
 * It is not a filesystem-level snapshot: a file that was untracked *and*
 * present at snapshot time, then modified in place afterwards, keeps the later
 * content on restore (a `git reset` can't see it). That case is logged.
 */

export interface TreeSnapshot {
  /** Absolute repo root this snapshot belongs to. */
  root: string
  /** Where the file bytes are stashed. */
  dir: string
  /** One entry per dirty file at snapshot time. */
  files: { path: string; status: 'modified' | 'added' | 'deleted' }[]
  /** True when the repo had no dirty files — restore just reverts to HEAD. */
  clean: boolean
}

interface Entry {
  path: string
  status: 'modified' | 'added' | 'deleted'
}

/** Parses `git status --porcelain=v1 -z` into per-file dirty entries. */
function parsePorcelainZ(out: string): Entry[] {
  const entries: Entry[] = []
  for (const record of out.split('\0')) {
    if (record.length < 4) continue
    const code = record.slice(0, 2)
    let path = record.slice(3)
    if (path.includes(' -> ')) path = path.split(' -> ')[1] ?? path
    path = path.replace(/^"|"$/g, '')
    if (!path) continue
    const status: Entry['status'] = code === '??' || code.includes('A') ? 'added' : code.includes('D') ? 'deleted' : 'modified'
    entries.push({ path, status })
  }
  return entries
}

async function dirtyEntries(root: string): Promise<Entry[]> {
  const result = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], root)
  if (result.exitCode !== 0) return []
  return parsePorcelainZ(result.stdout)
}

export async function isGitRepo(root: string): Promise<boolean> {
  const result = await runGit(['rev-parse', '--is-inside-work-tree'], root)
  return result.exitCode === 0 && result.stdout.trim() === 'true'
}

/** Captures the current dirty state. Returns undefined if `root` is not a git repo. */
export async function captureTreeSnapshot(root: string, storeDir: string): Promise<TreeSnapshot | undefined> {
  if (!(await isGitRepo(root))) return undefined

  const entries = await dirtyEntries(root)
  const dir = join(storeDir, 'tree-snapshot')
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })

  for (const [index, entry] of entries.entries()) {
    if (entry.status === 'deleted') continue
    const src = join(root, entry.path)
    if (!existsSync(src)) continue
    const dest = join(dir, String(index))
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, await readFile(src))
  }

  return { root, dir, files: entries, clean: entries.length === 0 }
}

/**
 * Reverts the working tree to exactly the snapshot: every file dirty *now* is
 * put back to HEAD (or removed, if it is not in HEAD), then the snapshot's own
 * dirty files are written back. Returns the list of paths it touched, and any
 * it could not fully restore.
 */
export async function restoreTreeSnapshot(snapshot: TreeSnapshot): Promise<{ reverted: string[]; warnings: string[] }> {
  const { root } = snapshot
  const warnings: string[] = []
  const nowDirty = await dirtyEntries(root)

  // 1. Everything the run touched since the snapshot goes back to HEAD.
  for (const entry of nowDirty) {
    if (entry.status === 'added') {
      await rm(join(root, entry.path), { force: true }).catch(() => warnings.push(`could not remove ${entry.path}`))
    } else {
      const result = await runGit(['checkout', 'HEAD', '--', entry.path], root)
      if (result.exitCode !== 0) warnings.push(`could not revert ${entry.path}: ${result.stderr.trim()}`)
    }
  }

  // 2. Re-apply the snapshot's own dirty files.
  for (const [index, entry] of snapshot.files.entries()) {
    const target = join(root, entry.path)
    if (entry.status === 'deleted') {
      await rm(target, { force: true }).catch(() => {})
      continue
    }
    const saved = join(snapshot.dir, String(index))
    if (!existsSync(saved)) {
      warnings.push(`snapshot bytes for ${entry.path} missing — left at HEAD`)
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, await readFile(saved))
  }

  return { reverted: nowDirty.map((entry) => entry.path), warnings }
}

export async function discardTreeSnapshot(snapshot: TreeSnapshot): Promise<void> {
  await rm(snapshot.dir, { recursive: true, force: true }).catch(() => {})
}

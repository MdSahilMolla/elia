import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { ELIA_ROOT } from '../statePaths.ts'

/**
 * Whether a chat session started inside elia's own checkout may change elia.
 *
 * `elia auto` launched from its own repository already builds in a child
 * `workspace/<run>/` and needs `--workspace` to touch elia itself (see
 * taskWorkspace.ts). A chat turn had no such line: its root is simply the
 * directory elia was started in, so from the repository root every file of
 * elia's source was "inside the workspace". Seen live: "install ponytail skill"
 * searched twice, found nothing, and wrote `src/skills/ponytail.ts` plus a new
 * barrel for it — into the code every later run executes, past every guard
 * `elia evolve` has to clear before it may change that same code.
 *
 * So a session started inside the checkout treats elia's source as its own
 * class of action. Writes under `workspace/` (work product) and `.elia/` (state,
 * and trust-gated project skills) go ahead as usual. A write anywhere else in
 * the repository is `self_edit`: the governor asks first, naming it as elia's
 * own source, and the answer opens that file (Yes) or the whole session (don't
 * ask again). With nobody to ask it is refused. `--self`, `/self on`, or
 * `ELIA_SELF_EDIT=1` open the session up front, for work on elia itself.
 *
 * The governor asks; this module is the backstop every file tool hits through
 * `captureBeforeWrite`, so a write the governor never saw approved still
 * cannot land.
 *
 * This is a boundary for the file tools, not a sandbox. A shell command can
 * still write anywhere the command policy lets it.
 */

/** Top-level folders of the checkout that hold work product or state rather than elia. */
const OPEN_DIRS = ['workspace', '.elia']

export interface SelfEditGuard {
  /** Canonical root of the checkout being protected. */
  root: string
  /** Whether this session may change it. */
  allowed: boolean
}

/** The governor intent for a write to elia's own source. */
export const SELF_EDIT_INTENT = 'self_edit'

let guard: SelfEditGuard | undefined
/** Files the operator approved one at a time; they stay open for the session. */
const approvedFiles = new Set<string>()

/** Case-folded on Windows, where `D:\elia\SRC\a.ts` is the same file. */
function fileKey(path: string): string {
  const key = canonical(path)
  return process.platform === 'win32' ? key.toLowerCase() : key
}

/**
 * The real path, even for a file that does not exist yet — the usual case for a
 * write. Its nearest existing folder is resolved and the rest appended, so
 * `C:\Users\RUNNER~1\…\new.ts` and a root spelled `C:\Users\runneradmin\…`
 * still compare as one tree.
 */
function canonical(path: string): string {
  const absolute = resolve(path)
  const realpath = realpathSync.native ?? realpathSync
  const rest: string[] = []
  let current = absolute
  for (;;) {
    try {
      return join(realpath(current), ...rest)
    } catch {
      const parent = dirname(current)
      if (parent === current) return absolute
      rest.unshift(basename(current))
      current = parent
    }
  }
}

function inside(root: string, target: string): string | undefined {
  const rel = relative(root, target)
  if (rel === '') return ''
  return rel.startsWith('..') || isAbsolute(rel) ? undefined : rel
}

/** Whether `path` is part of elia itself: inside the checkout, outside its work-product and state folders. */
export function isEliaSource(path: string, root = ELIA_ROOT): boolean {
  const rel = inside(canonical(root), canonical(path))
  if (rel === undefined) return false
  const top = rel.split(/[\\/]/, 1)[0]!
  return !OPEN_DIRS.some((dir) => dir.toLowerCase() === top.toLowerCase())
}

/** `ELIA_SELF_EDIT=1` (or true/on/yes) turns self-edit on for scripted sessions. */
export function selfEditFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(?:1|true|on|yes)$/i.test(env.ELIA_SELF_EDIT?.trim() ?? '')
}

/**
 * Called once as a session starts. The guard only exists when the session runs
 * on elia's own source; anywhere else — any other project, or a project under
 * elia's `workspace/` — this returns undefined and changes nothing.
 */
export function armSelfEditGuard(cwd: string, allowed: boolean, root = ELIA_ROOT): SelfEditGuard | undefined {
  approvedFiles.clear()
  guard = isEliaSource(cwd, root) ? { root: canonical(root), allowed } : undefined
  return guard
}

export function disarmSelfEditGuard(): void {
  approvedFiles.clear()
  guard = undefined
}

/** The operator said yes to changing this one file of elia's source. */
export function approveSelfEditFile(path: string): void {
  if (guard) approvedFiles.add(fileKey(path))
}

export function selfEditGuard(): SelfEditGuard | undefined {
  return guard
}

/** Flips the switch. Returns undefined when the session is not on elia's source, so there is nothing to flip. */
export function setSelfEditAllowed(allowed: boolean): SelfEditGuard | undefined {
  if (guard) guard = { ...guard, allowed }
  return guard
}

/** What `/self` prints. */
export function describeSelfEdit(): string {
  if (!guard) return 'Self-edit does not apply here: this session is not running on elia’s own source.'
  return guard.allowed
    ? `Self-edit is ON — elia may change its own source in ${guard.root} without asking. /self off to ask again.`
    : `Self-edit is on ask — elia was started inside its own repository, so it asks before changing its own source (anything outside workspace/ and .elia/). /self on to stop asking for this session.`
}

/** The path relative to the protected checkout, for messages. */
export function selfEditLabel(path: string): string {
  return (guard && relative(guard.root, canonical(path))) || path
}

/** Whether a write to `path` needs the operator's yes first. */
export function needsSelfEditApproval(path: string): boolean {
  return Boolean(guard && !guard.allowed && isEliaSource(path, guard.root) && !approvedFiles.has(fileKey(path)))
}

/** Why a write to `path` is refused, or undefined when it may go ahead. */
export function selfEditRefusal(path: string): string | undefined {
  if (!needsSelfEditApproval(path)) return undefined
  return (
    `${selfEditLabel(path)} is part of elia's own source (elia was started inside its own repository), and nobody approved changing it. `
    + 'Do not retry this write or work around it with a shell command. If the user wants a project built, build it under workspace/<name>/. '
    + 'If they meant to change elia itself, stop and ask them: they can approve the change when elia asks, or run /self on.'
  )
}

/** Throws the refusal. Every file tool reaches this through `captureBeforeWrite`. */
export function assertSelfEditAllowed(path: string): void {
  const refusal = selfEditRefusal(path)
  if (refusal) throw new Error(refusal)
}

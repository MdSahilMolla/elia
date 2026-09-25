import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import * as readline from 'node:readline/promises'
import { emitEvent, machineReadable, plainOutput, quietOutput } from '../ui/runtime.ts'
import { writeError, writeNotice, writeUsageLine } from '../ui/stream.ts'
import { table } from '../ui/layout.ts'
import type { Asker } from '../ui/confirm.ts'
import { renderSessionBar, statusGlyph } from '../ui/sessionBar.ts'
import { parseStatus, runGit } from '../autonomy/worktree.ts'
import { makeSessionName, type SessionBus, type SessionHandle, type SessionId, type SyncChoice, type SyncConflict, type SyncReport } from '../session/types.ts'
import type { SyncDecision } from '../session/sync.ts'
import { sessionFlagName } from './argv.ts'
import { paths } from '../config.ts'

export interface SessionCliOut {
  json: boolean
  plain: boolean
  quiet: boolean
}

export interface ParallelSessionArgs {
  command: string | undefined
  positionals: string[]
  flags: Record<string, string>
  json: boolean
  plain: boolean
  quiet: boolean
}

export type ContextDropHandler<T extends 'drop' | 'subscribe'> = T extends 'drop'
  ? (opts: { name: string; payloadPath?: string; fromSession?: string; json?: boolean; quiet?: boolean }) => Promise<void>
  : (opts: { name: string; fromSession: string; json?: boolean; quiet?: boolean }) => Promise<void>

export interface ContextDropHandlers {
  runContextDrop: ContextDropHandler<'drop'>
  runContextSubscribe: ContextDropHandler<'subscribe'>
}

export type SyncSessionsFn = (
  aRef: string,
  bRef: string,
  bus: SessionBus,
  decide?: (conflicts: SyncConflict[]) => Promise<Array<{ key: string; choice: SyncChoice }>>,
) => Promise<SyncReport>

export interface ParallelSessionsDeps {
  loadBus(): Promise<SessionBus>
  createWorktree(name: string): Promise<string>
  removeWorktree(path: string | undefined): Promise<void>
  loadSync?(): Promise<{ syncSessions?: SyncSessionsFn }>
  loadContextDrop?(): Promise<Partial<ContextDropHandlers>>
  /** Test seam: decide conflict choices through this instead of spinning up a readline prompt. */
  asker?: Asker
}

const VALUE_FLAGS = new Set(['name', 'payload', 'from', 'session'])

export function parseParallelSessionsArgs(args: string[]): ParallelSessionArgs {
  const positionals: string[] = []
  const flags: Record<string, string> = {}
  let json = false
  let plain = false
  let quiet = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--json' || arg === '--jsonl') {
      json = true
      continue
    }
    if (arg === '--plain') {
      plain = true
      continue
    }
    if (arg === '--quiet') {
      quiet = true
      continue
    }
    if (arg === '--no-color' || arg === '-y' || arg === '--yolo' || arg === '--all' || arg === '-o') continue
    const withValue = /^--([a-z][a-z-]*)(?:=(.*))?$/.exec(arg)
    if (withValue) {
      const name = withValue[1]!
      if (withValue[2] !== undefined) {
        flags[name] = withValue[2]
      } else if (VALUE_FLAGS.has(name)) {
        const next = args[i + 1]
        if (next !== undefined && !next.startsWith('-')) {
          flags[name] = next
          i += 1
        } else {
          flags[name] = 'true'
        }
      } else {
        flags[name] = 'true'
      }
      continue
    }
    if (arg.startsWith('-')) continue
    positionals.push(arg)
  }
  return { command: positionals[0], positionals, flags, json, plain, quiet }
}

export function cliOutFor(parsed: ParallelSessionArgs): SessionCliOut {
  return {
    json: parsed.json || machineReadable,
    plain: parsed.plain || plainOutput,
    quiet: parsed.quiet || quietOutput,
  }
}

export function sessionRef(parsed: ParallelSessionArgs): string | undefined {
  return parsed.flags['session'] ?? sessionFlagName()
}

export function resolveTarget(bus: SessionBus, parsed: ParallelSessionArgs): SessionHandle | undefined {
  const ref = parsed.positionals[1] ?? sessionRef(parsed)
  if (ref) return bus.resolve(ref)
  const active = bus.activeSession
  return active === undefined ? undefined : bus.get(active) ?? bus.resolve(active)
}

function emitSessionEvent(out: SessionCliOut, type: string, data: Record<string, unknown> = {}): void {
  if (!out.json) return
  if (machineReadable) {
    emitEvent(type, data)
    return
  }
  process.stdout.write(`${JSON.stringify({ type, at: new Date().toISOString(), ...data })}\n`)
}

function notice(out: SessionCliOut, text: string): void {
  if (out.json) {
    emitSessionEvent(out, 'notice', { message: text })
    return
  }
  if (out.quiet) return
  writeNotice(text)
}

function fail(out: SessionCliOut, text: string): void {
  if (out.json) emitSessionEvent(out, 'error', { message: text })
  else writeError(text)
  process.exitCode = 1
}

function usageLine(out: SessionCliOut, text: string): void {
  if (out.json) {
    emitSessionEvent(out, 'usage', { message: text })
    return
  }
  if (out.quiet) return
  writeUsageLine(text)
}

function usage(out: SessionCliOut, command: string | undefined): void {
  fail(
    out,
    command === undefined
      ? 'Usage: elia sessions <new|list|status|attach|kill|prune|sync|drop|subscribe> [args]'
      : `Unknown "elia sessions" subcommand "${command}". Expected one of: new, list, status, attach, kill, prune, sync, drop, subscribe.`,
  )
}

export function createSessionWorktree(name: string, sourceRoot: string = process.cwd(), baseDir: string = paths.state): Promise<string> {
  return doCreateSessionWorktree(name, sourceRoot, baseDir)
}

async function doCreateSessionWorktree(name: string, sourceRoot: string, baseDir: string): Promise<string> {
  const path = join(baseDir, 'session-worktrees', name)
  const result = await runGit(['worktree', 'add', '-b', `elia/session-${name}`, path, 'HEAD'], sourceRoot)
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create session worktree: ${result.stderr || result.stdout}`)
  }
  const status = await runGit(['status', '--porcelain=v1'], sourceRoot)
  for (const change of parseStatus(status.stdout)) {
    const target = join(path, change.path)
    if (change.deleted) {
      await rm(target, { force: true })
      continue
    }
    const source = Bun.file(join(sourceRoot, change.path))
    if (await source.exists()) await Bun.write(target, await source.arrayBuffer())
  }
  return path
}

export async function removeSessionWorktree(path: string | undefined, sourceRoot: string = process.cwd()): Promise<void> {
  if (!path) return
  await rm(path, { recursive: true, force: true }).catch(() => undefined)
  try {
    await runGit(['worktree', 'prune'], sourceRoot)
  } catch {
    // best-effort cleanup never blocks the kill
  }
}

export interface LeftoverSessionWorktree {
  name: string
  path: string
  branch: string
  /** Uncommitted changes — prune leaves these alone. */
  dirty: boolean
}

/**
 * Session worktrees nothing is using: every `elia/session-*` worktree under
 * `<state>/session-worktrees/` whose session is not live in this process.
 *
 * The session bus lives in one process, so `elia sessions new` from a shell
 * created a worktree and a branch and then exited — no later command could
 * see the session, and `kill` could not remove what it could not see.
 */
export async function findLeftoverSessionWorktrees(sourceRoot: string = process.cwd(), baseDir: string = paths.state, live: string[] = []): Promise<LeftoverSessionWorktree[]> {
  const listed = await runGit(['worktree', 'list', '--porcelain'], sourceRoot)
  if (listed.exitCode !== 0) return []
  const root = join(baseDir, 'session-worktrees').replace(/\\/g, '/').toLowerCase()
  const leftovers: LeftoverSessionWorktree[] = []
  for (const block of listed.stdout.split(/\r?\n\r?\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1]?.trim()
    const branch = /^branch refs\/heads\/(elia\/session-.+)$/m.exec(block)?.[1]?.trim()
    if (!path || !branch) continue
    if (!path.replace(/\\/g, '/').toLowerCase().startsWith(`${root}/`)) continue
    const name = branch.slice('elia/session-'.length)
    if (live.includes(name)) continue
    const status = await runGit(['status', '--porcelain'], path)
    leftovers.push({ name, path, branch, dirty: status.exitCode !== 0 || status.stdout.trim() !== '' })
  }
  return leftovers
}

export interface PruneResult {
  removed: string[]
  /** Worktree removed; branch kept because it has commits that are not merged. */
  branchKept: string[]
  skipped: Array<{ name: string; reason: string }>
}

/**
 * Removes leftover session worktrees and their branches — only ones with no
 * uncommitted changes, and a branch only when `git branch -d` agrees it is
 * merged. Nothing is forced: work that exists nowhere else is never deleted.
 */
export async function pruneSessionWorktrees(leftovers: LeftoverSessionWorktree[], sourceRoot: string = process.cwd()): Promise<PruneResult> {
  const result: PruneResult = { removed: [], branchKept: [], skipped: [] }
  for (const leftover of leftovers) {
    if (leftover.dirty) {
      result.skipped.push({ name: leftover.name, reason: 'has uncommitted changes' })
      continue
    }
    const removed = await runGit(['worktree', 'remove', leftover.path], sourceRoot)
    if (removed.exitCode !== 0) {
      result.skipped.push({ name: leftover.name, reason: (removed.stderr || removed.stdout).trim().split('\n')[0] || 'git worktree remove failed' })
      continue
    }
    const branch = await runGit(['branch', '-d', leftover.branch], sourceRoot)
    if (branch.exitCode === 0) result.removed.push(leftover.name)
    else result.branchKept.push(leftover.name)
  }
  return result
}

async function loadBusDefault(): Promise<SessionBus> {
  const { getSessionBus } = await import('../session/bus.ts')
  return getSessionBus()
}

async function loadSyncDefault(): Promise<{ syncSessions?: SyncSessionsFn }> {
  return import('../session/sync.ts')
}

async function loadContextDropDefault(): Promise<Partial<ContextDropHandlers>> {
  return import('../session/contextDrop.ts')
}

const DEFAULT_DEPS: ParallelSessionsDeps = {
  loadBus: loadBusDefault,
  createWorktree: (name: string) => createSessionWorktree(name),
  removeWorktree: (path: string | undefined) => removeSessionWorktree(path),
  loadSync: loadSyncDefault,
  loadContextDrop: loadContextDropDefault,
}

export async function runParallelSessions(args: string[], deps: Partial<ParallelSessionsDeps> = {}): Promise<void> {
  const parsed = parseParallelSessionsArgs(args)
  const out = cliOutFor(parsed)
  const d: ParallelSessionsDeps = { ...DEFAULT_DEPS, ...deps }
  const command = parsed.command
  if (command === undefined) {
    usage(out, undefined)
    return
  }
  let bus: SessionBus
  try {
    bus = await d.loadBus()
  } catch (err) {
    // A load failure, not a missing feature: "not available in this build"
    // sent people looking for a different build.
    fail(out, `Could not load the session bus: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  switch (command) {
    case 'new':
      await runCommandNew(bus, d, parsed, out)
      return
    case 'list':
      await runCommandList(bus, parsed, out, false)
      return
    case 'status':
      await runCommandList(bus, parsed, out, true)
      return
    case 'attach':
      await runCommandAttach(bus, parsed, out)
      return
    case 'kill':
      await runCommandKill(bus, d, parsed, out)
      return
    case 'prune':
      await runCommandPrune(bus, d, parsed, out)
      return
    case 'sync':
      await runCommandSync(bus, d, parsed, out)
      return
    case 'drop':
      await runCommandDrop(bus, d, parsed, out)
      return
    case 'subscribe':
      await runCommandSubscribe(bus, d, parsed, out)
      return
    default:
      usage(out, command)
  }
}

async function runCommandNew(bus: SessionBus, deps: ParallelSessionsDeps, parsed: ParallelSessionArgs, out: SessionCliOut): Promise<void> {
  const name = parsed.flags['name'] ?? parsed.positionals[1] ?? ''
  if (!name || /(^|[\\/])\.\.([\\/]|$)/.test(name)) {
    fail(out, 'Usage: elia sessions new --name <name>')
    return
  }
  const handle = bus.create(makeSessionName(name))
  let worktree: string
  try {
    worktree = await deps.createWorktree(name)
  } catch (err) {
    bus.kill(handle.id)
    fail(out, err instanceof Error ? err.message : String(err))
    return
  }
  bus.update(handle.id, { worktree })
  bus.setStatus(handle.id, 'running')
  emitSessionEvent(out, 'session:started', { sessionId: handle.id, name: handle.name })
  if (out.quiet) return
  if (out.plain) {
    process.stdout.write(`${handle.id} ${worktree}\n`)
    return
  }
  notice(out, `Session "${handle.name}" started: ${handle.id}`)
  notice(out, `Worktree: ${worktree}`)
  // Sessions live in one process's bus: this one ends when the command does.
  // Say so, and where the work goes from here, instead of letting a later
  // `elia sessions list` find nothing.
  notice(out, `Work there with: cd ${worktree} && elia · a session started inside a running elia (/sessions new) stays on its session bar · elia sessions prune removes worktrees nothing uses`)
}

export function renderLiveSessionsTable(sessions: SessionHandle[]): string[] {
  return table(
    [
      { header: 'name' },
      { header: 'id' },
      { header: 'status' },
      { header: 'last task' },
      { header: 'active agents', align: 'right' },
    ],
    sessions.map((s) => [s.name, s.id, `${statusGlyph(s.status)} ${s.status}`, s.lastTask ?? '—', String(s.activeAgents)]),
  )
}

async function runCommandList(bus: SessionBus, parsed: ParallelSessionArgs, out: SessionCliOut, withBar: boolean): Promise<void> {
  const sessions = bus.list()
  emitSessionEvent(out, 'sessions', {
    sessions: sessions.map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      lastTask: s.lastTask,
      activeAgents: s.activeAgents,
    })),
  })
  if (out.json || out.quiet) return
  if (sessions.length === 0) {
    // Live sessions belong to the elia process that started them, so a
    // separate `elia sessions list` sees none — say that, and what is left on disk.
    const leftovers = await findLeftoverSessionWorktrees().catch(() => [])
    notice(out, 'No live sessions in this process — a session belongs to the elia that started it (its session bar shows them).')
    if (leftovers.length > 0) notice(out, `${leftovers.length} session worktree${leftovers.length === 1 ? '' : 's'} left on disk (${leftovers.map((l) => l.name).join(', ')}) — elia sessions prune removes the clean ones.`)
    return
  }
  if (withBar) {
    process.stdout.write(`${renderSessionBar(sessions.map((s) => ({ name: s.name, status: s.status, lastTask: s.lastTask })))}\n`)
  }
  for (const line of renderLiveSessionsTable(sessions)) {
    usageLine(out, `  ${line}`)
  }
  notice(out, 'Attach one with: elia sessions attach <id|name> · create one with: elia sessions new --name <name>')
}

async function runCommandAttach(bus: SessionBus, parsed: ParallelSessionArgs, out: SessionCliOut): Promise<void> {
  const handle = resolveTarget(bus, parsed)
  if (!handle) {
    fail(out, 'No live session to attach to. See them with: elia sessions list')
    return
  }
  bus.setActiveSession(handle.id)
  emitSessionEvent(out, 'sessions_attached', { sessionId: handle.id, name: handle.name })
  if (!out.quiet) {
    notice(out, `Attached to session "${handle.name}" (${handle.id})`)
  }
}

/**
 * `elia sessions prune [--yes]`: list the session worktrees nothing uses, ask,
 * and remove the clean ones (see `pruneSessionWorktrees` — nothing is forced).
 * Without a terminal to ask on, it needs `--yes`.
 */
async function runCommandPrune(bus: SessionBus, deps: ParallelSessionsDeps, parsed: ParallelSessionArgs, out: SessionCliOut): Promise<void> {
  const live = bus.list().map((handle) => String(handle.name))
  const leftovers = await findLeftoverSessionWorktrees(process.cwd(), paths.state, live)
  emitSessionEvent(out, 'sessions_leftovers', { leftovers })
  if (leftovers.length === 0) {
    notice(out, 'No leftover session worktrees.')
    return
  }
  for (const leftover of leftovers) usageLine(out, `  ${leftover.name}  ${leftover.path}${leftover.dirty ? '  (uncommitted changes — kept)' : ''}`)
  const removable = leftovers.filter((leftover) => !leftover.dirty)
  if (removable.length === 0) {
    notice(out, 'Every one has uncommitted changes, so none were removed.')
    return
  }
  let confirmed = parsed.flags['yes'] === 'true'
  if (!confirmed) {
    const canAsk = !out.json && !out.quiet && (deps.asker !== undefined || Boolean(process.stdin.isTTY))
    if (!canAsk) {
      fail(out, `Re-run with --yes to remove ${removable.length} worktree${removable.length === 1 ? '' : 's'} and their merged branches.`)
      return
    }
    const label = `Remove ${removable.length} worktree${removable.length === 1 ? '' : 's'} and ${removable.length === 1 ? 'its branch' : 'their branches'} (a branch with unmerged commits is kept)? [y/N] `
    let answer: string | null
    if (deps.asker) answer = await deps.asker.question(label)
    else {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      try {
        answer = await rl.question(label).catch(() => null)
      } finally {
        rl.close()
      }
    }
    confirmed = /^y(?:es)?$/i.test(answer?.trim() ?? '')
  }
  if (!confirmed) {
    notice(out, 'Nothing removed.')
    return
  }
  const result = await pruneSessionWorktrees(removable)
  emitSessionEvent(out, 'sessions_pruned', { ...result })
  if (result.removed.length > 0) notice(out, `Removed ${result.removed.join(', ')} (worktree and branch).`)
  if (result.branchKept.length > 0) notice(out, `Removed the worktree of ${result.branchKept.join(', ')}; kept ${result.branchKept.length === 1 ? 'its branch' : 'their branches'} — unmerged commits (git branch -D elia/session-<name> drops one).`)
  for (const skipped of result.skipped) notice(out, `Kept ${skipped.name}: ${skipped.reason}`)
}

async function runCommandKill(bus: SessionBus, deps: ParallelSessionsDeps, parsed: ParallelSessionArgs, out: SessionCliOut): Promise<void> {
  const handle = resolveTarget(bus, parsed)
  if (!handle) {
    fail(out, 'No live session to kill. See them with: elia sessions list')
    return
  }
  const worktree = handle.worktree
  bus.kill(handle.id)
  await deps.removeWorktree(worktree)
  emitSessionEvent(out, 'sessions_killed', { sessionId: handle.id, name: handle.name })
  if (!out.quiet) {
    notice(out, `Killed session "${handle.name}" (${handle.id})`)
  }
}

export function renderSyncReport(report: SyncReport): string[] {
  const rows: string[][] = []
  for (const key of report.diff.aOnly) rows.push(['a-only', key, '', ''])
  for (const key of report.diff.bOnly) rows.push(['b-only', key, '', ''])
  for (const conflict of report.diff.conflicts) rows.push(['conflict', conflict.key, conflict.a ?? '', conflict.b ?? ''])
  if (rows.length === 0) return []
  return table([{ header: 'kind' }, { header: 'key' }, { header: 'a' }, { header: 'b' }], rows)
}

/**
 * Pure conflict chooser for interactive `elia sessions sync`. Asks the user one
 * line per conflicted memory key and returns the decisions for the keys they
 * answered. `ask` returns null/undefined or an unrecognized choice for a
 * conflict that should stay unresolved — syncSessions then refuses to mutate
 * anything and reports the key as a conflict.
 */
export function parseConflictChoice(raw: string | null | undefined): SyncChoice | undefined {
  if (!raw) return undefined
  const value = raw.trim().toLowerCase()
  if (value === 'a' || value === 'first') return 'a'
  if (value === 'b' || value === 'second') return 'b'
  if (value === 'both') return 'both'
  if (value === 'drop') return 'drop'
  return undefined
}

/** Labels the conflicts one by one and collects the user's choices. */
export function conflictPromptLabel(conflict: SyncConflict, index: number): string {
  return `Memory conflict ${index + 1} · "${conflict.key}":\n  a) ${conflict.a}\n  b) ${conflict.b}\nKeep [a] first / [b] second / [both] / [drop] (nothing on an unresolved line): `
}

export async function promptForConflictDecisions(
  conflicts: SyncConflict[],
  ask: (label: string) => Promise<string | null>,
): Promise<SyncDecision[]> {
  const decisions: SyncDecision[] = []
  for (let index = 0; index < conflicts.length; index += 1) {
    const conflict = conflicts[index]!
    const raw = await ask(conflictPromptLabel(conflict, index))
    const choice = parseConflictChoice(raw)
    if (choice !== undefined) decisions.push({ key: conflict.key, choice })
  }
  return decisions
}

async function runCommandSync(bus: SessionBus, deps: ParallelSessionsDeps, parsed: ParallelSessionArgs, out: SessionCliOut): Promise<void> {
  const aRef = parsed.positionals[1] ?? sessionRef(parsed)
  const bRef = parsed.positionals[2]
  if (!aRef || !bRef) {
    fail(out, 'Usage: elia sessions sync <id|name> <id|name>')
    return
  }
  const a = bus.resolve(aRef)
  const b = bus.resolve(bRef)
  if (!a || !b) {
    fail(out, `Cannot resolve sync target "${!a ? aRef : bRef}" to a live session. See them with: elia sessions list`)
    return
  }
  let mod: { syncSessions?: SyncSessionsFn }
  try {
    mod = await (deps.loadSync ?? loadSyncDefault)()
  } catch {
    fail(out, 'sync is not yet available in this build.')
    return
  }
  if (typeof mod.syncSessions !== 'function') {
    fail(out, 'sync is not yet available in this build.')
    return
  }
  let report: SyncReport
  try {
    // Interactive terminals resolve conflicts by asking; --plain/--json/--quiet
    // and non-interactive pipes keep the deterministic report + unresolved
    // notice. An injected asker (tests, embedders) enables prompting regardless
    // of TTY state.
    const canPrompt = !out.plain && !out.json && !out.quiet && (deps.asker !== undefined || Boolean(process.stdin.isTTY))
    const decide = canPrompt
      ? async (conflicts: SyncConflict[]): Promise<SyncDecision[]> => {
          if (deps.asker) return promptForConflictDecisions(conflicts, (label) => deps.asker!.question(label))
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
          try {
            return await promptForConflictDecisions(conflicts, (label) => rl.question(label).catch(() => null))
          } finally {
            rl.close()
          }
        }
      : undefined
    report = await mod.syncSessions(aRef, bRef, bus, decide)
  } catch (err) {
    fail(out, `Sync failed: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  emitSessionEvent(out, 'sessions_sync', { from: a.id, to: b.id, report })
  if (out.json || out.quiet) return
  const lines = renderSyncReport(report)
  if (lines.length === 0) {
    notice(out, `Sessions "${a.name}" and "${b.name}" are in sync.`)
    return
  }
  for (const line of lines) {
    usageLine(out, `  ${line}`)
  }
  notice(out, `a-only: ${report.diff.aOnly.length} · b-only: ${report.diff.bOnly.length} · conflicts: ${report.diff.conflicts.length}`)
}

function resolveFromSession(bus: SessionBus, ref: string | undefined, out: SessionCliOut): SessionId | undefined {
  if (!ref) return undefined
  const handle = bus.resolve(ref)
  if (!handle) {
    fail(out, `No live session "${ref}". See them with: elia sessions list`)
    return undefined
  }
  return handle.id
}

async function runCommandDrop(bus: SessionBus, deps: ParallelSessionsDeps, parsed: ParallelSessionArgs, out: SessionCliOut): Promise<void> {
  const name = parsed.positionals[1] ?? parsed.flags['name']
  if (!name) {
    fail(out, 'Usage: elia sessions drop <name> [--payload <path>] [--from <session>]')
    return
  }
  const fromRef = parsed.flags['from'] ?? sessionRef(parsed)
  const fromSession = resolveFromSession(bus, fromRef, out)
  if (fromRef && !fromSession) return
  let mod: Partial<ContextDropHandlers>
  try {
    mod = await (deps.loadContextDrop ?? loadContextDropDefault)()
  } catch {
    fail(out, 'context drops are not yet available in this build.')
    return
  }
  const runContextDrop = mod.runContextDrop
  if (typeof runContextDrop !== 'function') {
    fail(out, 'context drops are not yet available in this build.')
    return
  }
  await runContextDrop({ name, payloadPath: parsed.flags['payload'], fromSession, json: out.json, quiet: out.quiet })
}

async function runCommandSubscribe(bus: SessionBus, deps: ParallelSessionsDeps, parsed: ParallelSessionArgs, out: SessionCliOut): Promise<void> {
  const name = parsed.positionals[1] ?? parsed.flags['name']
  const fromRef = parsed.flags['from'] ?? sessionRef(parsed)
  if (!name || !fromRef) {
    fail(out, 'Usage: elia sessions subscribe <name> --from <session>')
    return
  }
  const fromSession = resolveFromSession(bus, fromRef, out)
  if (!fromSession) return
  let mod: Partial<ContextDropHandlers>
  try {
    mod = await (deps.loadContextDrop ?? loadContextDropDefault)()
  } catch {
    fail(out, 'context drops are not yet available in this build.')
    return
  }
  const runContextSubscribe = mod.runContextSubscribe
  if (typeof runContextSubscribe !== 'function') {
    fail(out, 'context drops are not yet available in this build.')
    return
  }
  await runContextSubscribe({ name, fromSession, json: out.json, quiet: out.quiet })
}
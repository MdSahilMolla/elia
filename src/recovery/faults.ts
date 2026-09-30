import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import { eliaVersion } from '../provenance.ts'
import { appendSecureFile, rotateSecureFile } from '../securePersistence.ts'
import { ELIA_ROOT, paths } from '../statePaths.ts'
import { redactText } from '../ui/redact.ts'

/**
 * Errors in elia's own code, kept so elia can find its own bugs and repair them.
 *
 * The starting point is what counts as evidence. A model saying "I think there
 * is a bug in the verifier" is not a fault; an exception that escaped elia's own
 * code is. Two kinds of it are recorded here, and nothing else:
 *
 * 1. Anything that got past every handler — an uncaught exception or an
 *    unhandled rejection. Whatever the error was, elia failing to handle it is
 *    elia's bug, so these are recorded even when the stack is not in elia's code.
 * 2. A programming error (TypeError, ReferenceError, …) thrown from elia's
 *    source that a turn or command caught at the top. A 401 from a provider or
 *    an ENOENT in the person's project is the environment, not a bug, and
 *    recording those would bury the real ones — so they are left out.
 *
 * Each record carries a signature: the error class, its message with the
 * volatile parts (numbers, paths, ids) taken out, and the innermost frame in
 * elia's source. The same bug hit twice gets the same signature, which is what
 * turns a pile of crashes into a short list of things to fix — and what the
 * self-repair (selfRepair.ts) is keyed on.
 *
 * Nothing here may itself throw: it runs inside crash handlers.
 */

export type FaultSource =
  /** Escaped every handler and ended the process. */
  | 'uncaught-exception'
  /** A promise nobody awaited rejected. The process carries on. */
  | 'unhandled-rejection'
  /** A turn threw out of the REPL, a one-shot prompt, or the editor bridge. */
  | 'turn'
  /** A top-level `elia <command>` threw. */
  | 'command'
  /** Part of the reasoning layer failed and elia fell back to a simpler path. */
  | 'reasoning'

export interface FaultRecord {
  at: string
  pid: number
  version: string
  /** `repl`, `auto`, `mcp`, … — what was running. */
  command: string
  source: FaultSource
  /** Whether it ended the process. */
  fatal: boolean
  name: string
  /** Redacted and bounded. */
  message: string
  /** Innermost first, as `src/file.ts:line fn` — elia's own frames only. */
  frames: string[]
  signature: string
  sessionId?: string
}

export interface FaultContext {
  source: FaultSource
  command: string
  fatal?: boolean
  sessionId?: string
}

/** Error classes that mean the code is wrong, not the world around it. */
const PROGRAMMING_ERRORS = new Set(['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'EvalError', 'URIError', 'AssertionError'])

const MAX_LOG_BYTES = 1_000_000
const MAX_FRAMES = 8

export interface Frame {
  /** Relative to elia's root, forward slashes. */
  file: string
  line: number
  fn?: string
}

/** `at fn (path:line:col)` or `at path:line:col` — V8 and JavaScriptCore both print these. */
const FRAME = /^\s*at\s+(?:(.*?)\s+\()?((?:[A-Za-z]:)?[^():]+?):(\d+)(?::\d+)?\)?\s*$/

/**
 * The frames of a stack that are in elia's own source, innermost first.
 *
 * Dependencies are left out even though they sit under the same root: a bug is
 * fixed where elia called the library wrongly, not inside `node_modules`.
 */
export function eliaFrames(stack: string | undefined, root: string = ELIA_ROOT): Frame[] {
  if (!stack) return []
  const frames: Frame[] = []
  const normalizedRoot = root.replaceAll('\\', '/')
  for (const line of stack.split('\n')) {
    const match = FRAME.exec(line)
    if (!match) continue
    const path = match[2]!.replace(/^file:\/\//, '').replaceAll('\\', '/')
    if (!isAbsolute(path) && !/^[A-Za-z]:\//.test(path)) continue
    if (!path.startsWith(`${normalizedRoot}/`) || path.includes('/node_modules/')) continue
    const file = relative(normalizedRoot, path).replaceAll('\\', '/')
    const fn = match[1]?.trim()
    frames.push({ file, line: Number.parseInt(match[3]!, 10), ...(fn && fn !== '<anonymous>' ? { fn } : {}) })
    if (frames.length >= MAX_FRAMES) break
  }
  return frames
}

export function formatFrame(frame: Frame): string {
  return `${frame.file}:${frame.line}${frame.fn ? ` ${frame.fn}` : ''}`
}

/** The message with what changes between occurrences of one bug taken out. */
export function normalizeMessage(message: string): string {
  return message
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@-]+){2,}/g, '<path>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/**
 * The identity of a bug. The line number is left out on purpose: an unrelated
 * edit above the faulty line moves it, and the same bug must keep its
 * signature across versions for its count to mean anything.
 */
export function faultSignature(name: string, message: string, frames: readonly Frame[]): string {
  const top = frames[0]
  const key = [name, normalizeMessage(message), top ? `${top.file}#${top.fn ?? ''}` : '-'].join('|')
  return createHash('sha256').update(key).digest('hex').slice(0, 10)
}

function describeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) return { name: error.name || 'Error', message: error.message, stack: error.stack }
  if (error && typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
    const shaped = error as { name?: unknown; message: string; stack?: unknown }
    return { name: typeof shaped.name === 'string' ? shaped.name : 'Error', message: shaped.message, stack: typeof shaped.stack === 'string' ? shaped.stack : undefined }
  }
  return { name: 'NonError', message: String(error) }
}

/**
 * Whether this error is elia's bug, by the rules in the module comment. Pure,
 * so the rule is testable without throwing anything.
 */
export function isEliaFault(error: unknown, source: FaultSource, root: string = ELIA_ROOT): boolean {
  if (source === 'uncaught-exception' || source === 'unhandled-rejection') return true
  const { name, stack } = describeError(error)
  return PROGRAMMING_ERRORS.has(name) && eliaFrames(stack, root).length > 0
}

/** Builds the record without writing it. Undefined when the error is not elia's fault. */
export function faultRecord(error: unknown, context: FaultContext, options: { root?: string; now?: Date } = {}): FaultRecord | undefined {
  const root = options.root ?? ELIA_ROOT
  if (!isEliaFault(error, context.source, root)) return undefined
  const { name, message, stack } = describeError(error)
  const frames = eliaFrames(stack, root)
  return {
    at: (options.now ?? new Date()).toISOString(),
    pid: process.pid,
    version: eliaVersion(),
    command: context.command,
    source: context.source,
    fatal: context.fatal ?? context.source === 'uncaught-exception',
    name,
    message: redactText(message, 400),
    frames: frames.map(formatFrame),
    signature: faultSignature(name, message, frames),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
  }
}

/**
 * Records the error if it is elia's fault. Returns the record, or undefined
 * when it was not one or could not be written. Never throws.
 */
export function recordFault(error: unknown, context: FaultContext, path: string = paths.faults): FaultRecord | undefined {
  try {
    const record = faultRecord(error, context)
    if (!record) return undefined
    rotateSecureFile(path, MAX_LOG_BYTES)
    appendSecureFile(path, `${JSON.stringify(record)}\n`)
    return record
  } catch {
    return undefined
  }
}

export function readFaults(path: string = paths.faults): FaultRecord[] {
  if (!existsSync(path)) return []
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const records: FaultRecord[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as Partial<FaultRecord>
      if (typeof parsed.signature === 'string' && typeof parsed.at === 'string' && typeof parsed.name === 'string') records.push(parsed as FaultRecord)
    } catch {
      // A line cut off by a crash mid-write is expected here, of all places.
    }
  }
  return records
}

export interface FaultGroup {
  signature: string
  count: number
  fatal: number
  firstAt: string
  lastAt: string
  /** The most recent occurrence, whose message and frames stand for the group. */
  latest: FaultRecord
  commands: string[]
  versions: string[]
}

/** One entry per bug, the most frequent first — a crash counts for more than a caught error. */
export function groupFaults(records: readonly FaultRecord[]): FaultGroup[] {
  const groups = new Map<string, FaultGroup>()
  for (const record of records) {
    const group = groups.get(record.signature)
    if (!group) {
      groups.set(record.signature, {
        signature: record.signature,
        count: 1,
        fatal: record.fatal ? 1 : 0,
        firstAt: record.at,
        lastAt: record.at,
        latest: record,
        commands: [record.command],
        versions: [record.version],
      })
      continue
    }
    group.count += 1
    group.fatal += record.fatal ? 1 : 0
    if (record.at < group.firstAt) group.firstAt = record.at
    if (record.at >= group.lastAt) {
      group.lastAt = record.at
      group.latest = record
    }
    if (!group.commands.includes(record.command)) group.commands.push(record.command)
    if (!group.versions.includes(record.version)) group.versions.push(record.version)
  }
  return [...groups.values()].sort((a, b) => b.fatal - a.fatal || b.count - a.count || b.lastAt.localeCompare(a.lastAt))
}

/** `TypeError: x is undefined — src/a.ts:12 fn` */
export function describeFault(record: Pick<FaultRecord, 'name' | 'message' | 'frames'>): string {
  const where = record.frames[0] ? ` — ${record.frames[0]}` : ''
  return `${record.name}: ${redactText(record.message, 160)}${where}`
}

/** Within a day, twice: the same crash twice in a row is a loop, not bad luck. */
export function repeatedCrash(records: readonly FaultRecord[], now = Date.now(), windowMs = 24 * 60 * 60_000, threshold = 2): { signature: string; count: number; summary: string } | undefined {
  const recent = records.filter((record) => record.fatal && now - Date.parse(record.at) <= windowMs)
  const worst = groupFaults(recent).find((group) => group.fatal >= threshold)
  return worst ? { signature: worst.signature, count: worst.fatal, summary: describeFault(worst.latest) } : undefined
}

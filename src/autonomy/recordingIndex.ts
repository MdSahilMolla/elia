import { registerCache } from '../cacheRegistry.ts'
import { listRecordings, readRecording, recordingPath, type RecordedEvent } from './sessionRecorder.ts'
import { NOT_A_PROJECT_FACT, SLIP_TOOLS } from './turnLearning.ts'

/**
 * What a recording knows, made findable — and what many recordings know together.
 *
 * `sessionRecorder.ts` keeps everything; this reads it back. Two kinds of thing
 * come out of a recording without asking a model anything, so nothing here can be
 * invented: the *moments* worth returning to (what was asked and how it ended, a
 * failure that was put right, a dead end), and the *friction* — each failed tool
 * call with the call that fixed it. Every one carries a pointer,
 * `recording:<session>#<from>-<to>`, that `openRecording` turns back into the
 * raw events, so a search hit is never a summary you have to take on trust.
 *
 * Across recordings, friction becomes evidence. The same failure reached again in
 * another session, or a third time in this one, is not an incident any more, it
 * is a fact about the project or about elia — and if one fix keeps working it is
 * a lesson nobody had to write. `minePatterns` finds these by clustering failures
 * on a normalized signature (numbers, hashes, paths and URLs folded away, so
 * `ENOENT … '/tmp/a-91'` and `ENOENT … '/tmp/b-17'` are the same failure) and
 * counting which fix resolved them.
 */

const MAX_MOMENTS_PER_RECORDING = 150
/** How many recordings a search reads, newest first, and how large one may be; a bigger one is still openable by pointer. */
export const MAX_INDEXED_RECORDINGS = 25
export const MAX_INDEXED_BYTES = 12 * 1024 * 1024

export interface RecordedMoment {
  kind: 'request' | 'fix' | 'dead-end'
  sessionId: string
  from: number
  to: number
  turn: number
  at: number
  /** What a query is ranked against. */
  text: string
  render: string
  paths: string[]
  /** A multiplier on the search score: a turn that was verified, or a fix that worked, is worth more than a bare mention. */
  weight: number
  pointer: string
}

/** One failed tool call, and the later call of the same tool that worked, when there was one. */
export interface Friction {
  sessionId: string
  tool: string
  label: string
  error: string
  signature: string
  from: number
  to: number
  at: number
  fixedBy?: string
}

export interface IndexedRecording {
  sessionId: string
  /** When the recording last changed. */
  at: number
  moments: RecordedMoment[]
  friction: Friction[]
  /** Lessons a turn taught, with the events that taught them. */
  lessons: { text: string; pointer: string }[]
}

export interface FrictionPattern {
  signature: string
  tool: string
  occurrences: number
  sessions: string[]
  at: number
  example: { failed: string; error: string; pointer: string }
  /** The fix that resolved this failure most often, when any did. */
  fix?: { label: string; count: number; pointer: string }
  pointers: string[]
}

export function pointerFor(sessionId: string, from: number, to: number = from): string {
  return `recording:${sessionId}#${from}${to > from ? `-${to}` : ''}`
}

export function parsePointer(ref: string): { sessionId: string; from: number; to?: number } | undefined {
  const match = /^recording:([A-Za-z0-9][\w-]{0,99})#(\d+)(?:-(\d+))?$/.exec(ref.trim())
  if (!match) return undefined
  return { sessionId: match[1]!, from: Number(match[2]), ...(match[3] !== undefined ? { to: Number(match[3]) } : {}) }
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Tool and first argument, the way turn learning names a call. */
function callLabel(name: string, input: Record<string, unknown>): string {
  const target = ['command', 'path', 'program', 'url', 'query']
    .map((key) => input[key])
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
  return target ? `${name} ${clip(target, 160)}` : name
}

/**
 * A failure with what varies between occurrences folded away: colour codes,
 * URLs, paths, hashes and numbers. `enoent … open '/tmp/a-91.ts'` and the same
 * error for another file share one signature.
 */
export function failureSignature(tool: string, error: string): string {
  const flat = error
    .replace(/\x1b\[[0-9;]*m/g, '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/(?:[a-z]:)?[\w.@~-]*(?:[\\/][\w.@~-]+)+/g, '<path>')
    .replace(/\b[0-9a-f]{7,}\b/g, '<hex>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
  return `${tool}: ${flat.slice(0, 160)}`
}

/** A signature made of a few stock words ("run_command: error: exit code #") would cluster every failure there is. */
function isSpecific(signature: string): boolean {
  return signature.split(' ').filter((word) => /[a-z]/.test(word) && !word.startsWith('<')).length >= 5
}

const OPERATOR_CONTEXT = /<operator-context>[\s\S]*?<\/operator-context>\s*/g

/** A recording, read once into what is worth finding again. */
export function indexRecording(sessionId: string, events: readonly RecordedEvent[]): IndexedRecording {
  const moments: RecordedMoment[] = []
  const friction: Friction[] = []
  const lessons: { text: string; pointer: string }[] = []

  const turns = new Map<number, RecordedEvent[]>()
  for (const event of events) {
    const group = turns.get(event.turn)
    if (group) group.push(event)
    else turns.set(event.turn, [event])
  }

  for (const [turn, group] of turns) {
    const user = group.find((event) => event.kind === 'user')
    const end = group.findLast((event) => event.kind === 'turn-end')
    const reply = group.findLast((event) => event.kind === 'assistant')
    const last = group.at(-1)!

    // A failure is put right by a later call of the same tool *by the same
    // actor* — a sub-agent's failure fixed by the lead's next call fixed nothing.
    const open: { key: string; tool: string; label: string; error: string; from: number; at: number }[] = []
    const settle = (item: (typeof open)[number], fix?: { label: string; seq: number }) => {
      const signature = failureSignature(item.tool, item.error)
      friction.push({ sessionId, tool: item.tool, label: item.label, error: item.error, signature, from: item.from, to: fix?.seq ?? item.from, at: item.at, ...(fix ? { fixedBy: fix.label } : {}) })
      const pointer = pointerFor(sessionId, item.from, fix?.seq ?? item.from)
      const where = clip(item.error, 120)
      moments.push({
        kind: fix ? 'fix' : 'dead-end',
        sessionId,
        from: item.from,
        to: fix?.seq ?? item.from,
        turn,
        at: item.at,
        text: `${item.label} failed: ${item.error}${fix ? ` then worked: ${fix.label}` : ''}`,
        render: fix ? `fix: ${item.label} failed ("${where}") → ${fix.label} worked` : `dead end: ${item.label} failed ("${where}") and was not made to work`,
        paths: [],
        weight: fix ? 1.4 : 1,
        pointer,
      })
    }
    for (const event of group) {
      if (event.kind !== 'tool' || SLIP_TOOLS.has(event.name)) continue
      const key = `${event.actor ?? ''}\u0000${event.name}`
      if (event.status === 'error') {
        if (!NOT_A_PROJECT_FACT.test(event.result)) open.push({ key, tool: event.name, label: callLabel(event.name, event.input), error: clip(event.result, 300), from: event.seq, at: event.at })
        continue
      }
      const index = open.findIndex((item) => item.key === key)
      if (index >= 0) settle(open.splice(index, 1)[0]!, { label: callLabel(event.name, event.input), seq: event.seq })
    }
    for (const item of open) settle(item)

    if (user && user.kind === 'user') {
      const prompt = clip(user.text.replace(OPERATOR_CONTEXT, ''), 400)
      const files = end?.kind === 'turn-end' ? end.touched : []
      const verify = end?.kind === 'turn-end' ? end.verify : undefined
      const outcome = end?.kind === 'turn-end' ? end.outcome : undefined
      moments.push({
        kind: 'request',
        sessionId,
        from: user.seq,
        to: end?.seq ?? last.seq,
        turn,
        at: user.at,
        text: [prompt, reply?.kind === 'assistant' ? clip(reply.text, 300) : '', ...files].join(' '),
        render: `session ${sessionId} turn ${turn + 1}: "${clip(prompt, 140)}" → ${outcome ? `${outcome}, ${verify === undefined || verify === 'none' ? 'unverified' : `verify ${verify}`}` : 'no outcome recorded'}${files.length > 0 ? ` · files: ${files.slice(0, 4).join(', ')}` : ''}`,
        paths: files,
        weight: verify === 'pass' ? 1.3 : verify === 'fail' || outcome === 'failed' ? 0.8 : 1,
        pointer: pointerFor(sessionId, user.seq, end?.seq ?? last.seq),
      })
    }

    for (const event of group) {
      if (event.kind === 'lesson') lessons.push({ text: event.text, pointer: pointerFor(sessionId, event.from, event.seq) })
    }
  }

  return { sessionId, at: events.at(-1)?.at ?? 0, moments: moments.slice(0, MAX_MOMENTS_PER_RECORDING), friction, lessons }
}

/**
 * Failures that keep happening, across every recording given: same signature,
 * at least `minOccurrences` times, in this session or several. For each, the
 * fix that resolved it most often — grouped by tool and program, so `dir a` and
 * `dir b` count as one fix — with a pointer to the most recent time it worked.
 */
export function minePatterns(recordings: readonly IndexedRecording[], minOccurrences = 2): FrictionPattern[] {
  const groups = new Map<string, Friction[]>()
  for (const recording of recordings) {
    for (const item of recording.friction) {
      if (!isSpecific(item.signature)) continue
      const group = groups.get(item.signature)
      if (group) group.push(item)
      else groups.set(item.signature, [item])
    }
  }

  const patterns: FrictionPattern[] = []
  for (const [signature, group] of groups) {
    if (group.length < minOccurrences) continue
    const instances = [...group].sort((a, b) => b.at - a.at)
    const example = instances[0]!
    const fixes = new Map<string, { count: number; latest: Friction }>()
    for (const instance of instances) {
      if (!instance.fixedBy) continue
      const key = instance.fixedBy.split(/\s+/).slice(0, 2).join(' ')
      const seen = fixes.get(key)
      if (seen) seen.count += 1
      else fixes.set(key, { count: 1, latest: instance })
    }
    const best = [...fixes.values()].sort((a, b) => b.count - a.count || b.latest.at - a.latest.at)[0]
    patterns.push({
      signature,
      tool: example.tool,
      occurrences: instances.length,
      sessions: [...new Set(instances.map((instance) => instance.sessionId))],
      at: example.at,
      example: { failed: example.label, error: example.error, pointer: pointerFor(example.sessionId, example.from, example.to) },
      ...(best ? { fix: { label: best.latest.fixedBy!, count: best.count, pointer: pointerFor(best.latest.sessionId, best.latest.from, best.latest.to) } } : {}),
      pointers: instances.slice(0, 5).map((instance) => pointerFor(instance.sessionId, instance.from, instance.to)),
    })
  }
  return patterns.sort((a, b) => b.occurrences - a.occurrences || b.at - a.at)
}

// --- Reading a project's recordings, cheaply ----------------------------------

const indexed = new Map<string, { stamp: string; recording: IndexedRecording }>()
registerCache('recording-index', () => indexed.clear(), () => indexed.size)

/** Changes when any indexed recording is added, appended to, or removed; the brain's cache is keyed on it. */
export function recordingsFingerprint(cwd: string, currentSessionId?: string): string {
  return listRecordings(cwd)
    .filter((file) => file.sessionId !== currentSessionId)
    .slice(0, MAX_INDEXED_RECORDINGS)
    .map((file) => `${file.sessionId}:${file.mtimeMs}:${file.size}`)
    .join('|')
}

/**
 * The newest recordings other than the session in progress, indexed. That one is
 * already in the model's context window and grows every event, so reading it
 * back would cost a re-parse per turn for nothing. An unchanged file is not read
 * twice.
 */
export function loadRecordingIndex(cwd: string, options: { currentSessionId?: string } = {}): IndexedRecording[] {
  return listRecordings(cwd)
    .filter((file) => file.sessionId !== options.currentSessionId && file.size <= MAX_INDEXED_BYTES)
    .slice(0, MAX_INDEXED_RECORDINGS)
    .map((file) => {
      const stamp = `${file.mtimeMs}:${file.size}`
      const hit = indexed.get(file.path)
      if (hit?.stamp === stamp) return hit.recording
      const recording = indexRecording(file.sessionId, readRecording(file.path))
      indexed.set(file.path, { stamp, recording })
      return recording
    })
}

// --- Opening a pointer ---------------------------------------------------------

const MAX_OPEN_CHARS = 14_000

function renderEvent(event: RecordedEvent): string {
  const head = `#${event.seq}`
  switch (event.kind) {
    case 'session-start':
      return `${head} session started · ${event.mode} · ${event.model}${event.resumedFrom ? ` · resumed from ${event.resumedFrom}` : ''}`
    case 'tool': {
      const input = clip(JSON.stringify(event.input), 240)
      return `${head} tool ${event.name} [${event.status}]${event.actor ? ` (${event.actor})` : ''} ${input}\n  → ${clip(event.result, 1_200)}`
    }
    case 'turn-end':
      return `${head} turn ended · ${event.outcome} · verify ${event.verify} · ${event.repairAttempts} repair(s)${event.touched.length > 0 ? ` · files: ${event.touched.slice(0, 8).join(', ')}` : ''}`
    case 'lesson':
      return `${head} lesson learned: ${clip(event.text, 400)}`
    case 'truncated':
      return `${head} recording stopped: ${event.reason}`
    case 'session-end':
      return `${head} session ended${event.recovered ? ' (recovered after an unclean exit)' : ''}`
    default:
      return `${head} ${event.kind}: ${clip(event.text, 1_200)}`
  }
}

/**
 * The raw events behind a `recording:<session>#<from>[-<to>]` pointer. A single
 * event is shown with a little of what came before and after it. Bounded, with a
 * note on how to narrow the range when the slice is longer than that.
 */
export function openRecording(ref: string, cwd: string): string {
  const parsed = parsePointer(ref)
  if (!parsed) return `"${ref}" is not a recording reference. They look like recording:<session>#<from>-<to>.`
  const path = recordingPath(cwd, parsed.sessionId)
  const events = path ? readRecording(path) : []
  if (events.length === 0) return `There is no recording for session ${parsed.sessionId} — it may have been pruned.`
  const from = parsed.to === undefined ? Math.max(0, parsed.from - 2) : parsed.from
  const to = parsed.to ?? parsed.from + 6
  const slice = events.filter((event) => event.seq >= from && event.seq <= to)
  if (slice.length === 0) return `Session ${parsed.sessionId} has ${events.length} recorded events (0-${events.at(-1)!.seq}); none fall in ${from}-${to}.`

  const lines = [`session ${parsed.sessionId} · events ${slice[0]!.seq}-${slice.at(-1)!.seq} of ${events.length}`]
  let size = lines[0]!.length
  for (const [index, event] of slice.entries()) {
    const line = renderEvent(event)
    if (size + line.length > MAX_OPEN_CHARS) {
      lines.push(`… ${slice.length - index} more event(s) in this range — open a narrower one, e.g. ${pointerFor(parsed.sessionId, event.seq, Math.min(event.seq + 5, slice.at(-1)!.seq))}`)
      break
    }
    lines.push(line)
    size += line.length
  }
  return lines.join('\n')
}

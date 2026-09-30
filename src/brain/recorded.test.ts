import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordSessionAsBook } from '../eliaBook.ts'
import { createSessionRecorder } from '../autonomy/sessionRecorder.ts'
import { createTranscript, type Transcript } from '../ui/transcript.ts'
import { buildCard } from './cards.ts'
import { openBrainReference } from './open.ts'
import { searchBrain } from './search.ts'
import { loadBrainItems, type BrainItem } from './store.ts'

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const WINDOWS = "'ls' is not recognized as an internal or external command, operable program or batch file"
const LESSON = 'List directories with dir on this Windows machine; ls is not available in cmd'

function run(transcript: Transcript, command: string, result: string, isError = false): void {
  transcript.recordTool({ name: 'run_command', input: { command }, result, isError, cached: false, durationMs: 5 })
}

/** A finished session in which `ls` failed and `dir` worked. */
function record(cwd: string, id: string, options: { lesson?: string } = {}): void {
  const transcript = createTranscript()
  const recorder = createSessionRecorder({ cwd })
  recorder.attach(transcript)
  recorder.begin(id, { mode: 'dev', model: 'm' })
  transcript.appendUser(`survey the parser project in ${id}`)
  run(transcript, `ls -la ${id}`, WINDOWS, true)
  run(transcript, `dir ${id}`, 'Directory of D:\\work')
  transcript.appendAssistant('The project has a parser and its tests.')
  if (options.lesson) recorder.lesson(options.lesson)
  recorder.turnEnd({ outcome: 'completed', verify: 'pass', repairAttempts: 0, touched: ['src/parser.ts'], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1, elapsedMs: 10 } })
  transcript.endTurn()
  recorder.finish()
}

/** A project with three recorded sessions, one of which taught a lesson that is now in lessons.md. */
async function brain(currentSessionId?: string): Promise<{ cwd: string; items: BrainItem[] }> {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-brain-recorded-'))
  roots.push(cwd)
  record(cwd, 'sess-1', { lesson: LESSON })
  record(cwd, 'sess-2')
  record(cwd, 'sess-3')
  for (const id of ['sess-1', 'sess-2', 'sess-3']) recordSessionAsBook(id, cwd)
  mkdirSync(join(cwd, '.elia'), { recursive: true })
  const lessonsPath = join(cwd, '.elia', 'lessons.md')
  writeFileSync(lessonsPath, `# Lessons\n\n- ${LESSON} <!-- 2026-09-28T00:00:00.000Z source=interactive-auto confidence=0.70 -->\n`)
  const items = await loadBrainItems({
    cwd,
    sessionsDir: join(cwd, '.elia', 'sessions'),
    lessonsPath,
    rationalePath: join(cwd, '.elia', 'rationale.jsonl'),
    notesPath: join(cwd, '.elia', 'notes.jsonl'),
    currentSessionId,
  })
  return { cwd, items }
}

test('playbooks, recorded moments and recurring failures are searchable beside lessons', async () => {
  const { items } = await brain()
  const kinds = new Set(items.map((item) => item.kind))
  expect(kinds).toEqual(new Set(['lesson', 'book', 'moment', 'pattern']))

  // The same failure in three sessions is one pattern, with the fix that kept working.
  const [pattern] = items.filter((item) => item.kind === 'pattern')
  expect(pattern!.render).toContain('pattern ×3 across 3 session(s)')
  expect(pattern!.render).toContain('fixed by run_command dir')
  expect(pattern!.pointer).toMatch(/^recording:sess-\d#\d+-\d+$/)

  const hits = searchBrain(items, 'ls is not recognized dir', { limit: 5 })
  expect(hits[0]!.item.kind).toBe('pattern')
  expect(searchBrain(items, 'survey parser project', { kinds: ['book'] }).every((hit) => hit.item.kind === 'book')).toBe(true)
})

test('a lesson a recorded turn taught points back at the events that taught it, and the pointer opens', async () => {
  const { cwd, items } = await brain()
  const lesson = items.find((item) => item.kind === 'lesson')!
  expect(lesson.pointer).toMatch(/^recording:sess-1#\d+-\d+$/)
  expect(lesson.render).toContain(`[recorded · open: ${lesson.pointer}]`)

  const opened = await openBrainReference(lesson.pointer!, cwd)
  expect(opened).toContain('user: survey the parser project in sess-1')
  expect(opened).toContain(WINDOWS)
  expect(opened).toContain('lesson learned:')
})

test('a hit from a playbook or a recording opens to what it points at', async () => {
  const { cwd, items } = await brain()
  const book = items.find((item) => item.kind === 'book')!
  expect(book.render).toContain('[open: book:')
  const playbook = await openBrainReference(book.pointer!, cwd)
  expect(playbook).toContain('## Reusable procedure')
  expect(playbook).toContain('.elia/recordings/')

  const fix = items.find((item) => item.kind === 'moment' && item.text.includes('then worked'))!
  expect(await openBrainReference(fix.pointer!, cwd)).toContain('tool run_command [error]')
  expect(await openBrainReference('book:no-such-book', cwd)).toContain('There is no Elia Book')
  expect(await openBrainReference('book:../../etc', cwd)).toContain('Could not open')
  expect(await openBrainReference('', cwd)).toContain('Nothing to open')
})

test('the session in progress is not read back into its own memory', async () => {
  const { items } = await brain('sess-3')
  expect(items.some((item) => item.sessionId === 'sess-3')).toBe(false)
  const [pattern] = items.filter((item) => item.kind === 'pattern')
  expect(pattern!.render).toContain('across 2 session(s)')
})

test('file cards still hold only what they always did, so the prompt does not grow', async () => {
  const { items } = await brain()
  // Moments and books both mention src/parser.ts; neither belongs in a card.
  expect(items.filter((item) => item.paths.includes('src/parser.ts')).length).toBeGreaterThan(0)
  expect(buildCard(items, 'src/parser.ts')).toBeUndefined()
})

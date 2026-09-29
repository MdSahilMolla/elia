import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bookedSessionIds, listEliaBooks, readEliaBook, recordSessionAsBook, recoverRecordings } from './eliaBook.ts'
import { createSessionRecorder, readRecording, recordingPath, type RecordedUsage } from './autonomy/sessionRecorder.ts'
import { createTranscript, type Transcript } from './ui/transcript.ts'

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elia-auto-book-'))
  roots.push(dir)
  return dir
}

const USAGE: RecordedUsage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1, elapsedMs: 4_000 }

/** Records a session the way the REPL does: through a transcript, with the recorder listening. */
function record(cwd: string, id: string, script: (transcript: Transcript) => void, options: { close?: boolean; files?: string[]; verify?: string } = {}): void {
  const transcript = createTranscript()
  const recorder = createSessionRecorder({ cwd })
  recorder.attach(transcript)
  recorder.begin(id, { mode: 'dev', model: 'test-model' })
  script(transcript)
  recorder.turnEnd({ outcome: 'completed', verify: options.verify ?? 'pass', repairAttempts: 0, touched: options.files ?? ['src/parser.ts'], usage: USAGE })
  transcript.endTurn()
  if (options.close !== false) recorder.finish()
}

const run = (transcript: Transcript, command: string, result: string, isError = false) =>
  transcript.recordTool({ name: 'run_command', input: { command }, result, isError, cached: false, durationMs: 5 })

/** A session with some friction in it: `failures` failed calls before the one that worked. */
function parserSession(prompt: string, failures: number): (transcript: Transcript) => void {
  return (transcript) => {
    transcript.appendUser(prompt)
    for (let index = 0; index < failures; index += 1) run(transcript, `bun test try-${index}`, 'error: no test files found', true)
    run(transcript, 'bun test src/parser.test.ts', '1 pass')
    transcript.appendAssistant('The parser now handles empty input.')
  }
}

test('a recorded session becomes a Book on its own, pointing at the recording instead of copying it', () => {
  const cwd = project()
  record(cwd, 'sess-a', parserSession('fix the parser empty input bug', 1))

  const result = recordSessionAsBook('sess-a', cwd)
  expect(result.action).toBe('created')
  const book = readEliaBook(result.bookId!, cwd)!
  expect(book.status).toBe('recorded')
  expect(book.title).toBe('fix the parser empty input bug')
  const version = book.versions[0]!
  expect(version.evidence.sourceKind).toBe('interactive-session')
  expect(version.evidence.sourceSessionId).toBe('sess-a')
  expect(version.evidence.actionCount).toBe(2)
  expect(version.evidence.failedActions).toBe(1)
  expect(version.evidence.recordingFiles).toEqual(['.elia/recordings/sess-a.ndjson'])
  expect(version.evidence.successes).toContain("Of 1 turn(s), the project's own checks passed on 1, failed on 0, and did not run on 0.")
  expect(version.procedure.verification).toContain('bun test src/parser.test.ts')
  expect(version.procedure.steps[0]!.files).toEqual(['src/parser.ts'])
  // The raw recording is the record; the Book does not make a second copy of it.
  expect(existsSync(join(cwd, '.elia', 'books', book.id))).toBe(false)
  expect([...bookedSessionIds(cwd)]).toEqual(['sess-a'])
})

test('a session killed before its turn ended claims no cost, so it never looks like the cheapest run', () => {
  const cwd = project()
  record(cwd, 'sess-a', parserSession('fix the parser empty input bug', 0))
  const { bookId } = recordSessionAsBook('sess-a', cwd)

  // Killed mid-turn: tool calls recorded, but no turn-end row and so no usage.
  const transcript = createTranscript()
  const recorder = createSessionRecorder({ cwd })
  recorder.attach(transcript)
  recorder.begin('sess-killed', { mode: 'dev', model: 'test-model' })
  parserSession('fix the parser empty input bug once more', 0)(transcript)

  expect(recordSessionAsBook('sess-killed', cwd)).toMatchObject({ action: 'folded', bookId })
  const book = readEliaBook(bookId!, cwd)!
  const version = book.versions.at(-1)!
  expect(version.evidence.totalTokens).toBeUndefined()
  expect(version.evidence.elapsedMs).toBeUndefined()
  expect(version.improvement).not.toContain('tokens')
  expect(book.activeVersion).toBe(1)
})

test('a session where nothing ran makes no Book', () => {
  const cwd = project()
  record(cwd, 'sess-chat', (transcript) => {
    transcript.appendUser('what does a mutex do?')
    transcript.appendAssistant('It serialises access.')
  })
  expect(recordSessionAsBook('sess-chat', cwd)).toMatchObject({ action: 'skipped' })
  expect(listEliaBooks(cwd)).toEqual([])
  expect(recordSessionAsBook('never-recorded', cwd)).toMatchObject({ action: 'skipped', reason: 'there is no recording' })
})

test('the same work again joins its Book as a new version, and only clearly better work becomes the active one', () => {
  const cwd = project()
  record(cwd, 'sess-a', parserSession('fix the parser empty input bug', 2))
  const first = recordSessionAsBook('sess-a', cwd)

  // The same bug, a week later, fixed without the false starts.
  record(cwd, 'sess-b', parserSession('the parser bug on empty input is back, fix it again', 0))
  const second = recordSessionAsBook('sess-b', cwd)
  expect(second).toMatchObject({ action: 'folded', bookId: first.bookId })
  expect(second.match).toBeGreaterThan(0.5)
  let book = readEliaBook(first.bookId!, cwd)!
  expect(book.versions).toHaveLength(2)
  expect(book.activeVersion).toBe(2)
  expect(book.versions[1]!.improvement).toContain('failed actions 2 → 0')

  // Faster or cheaper is not better: the same failures in less time does not take the active slot.
  record(cwd, 'sess-quick', parserSession('fix the parser empty input bug quickly', 0))
  expect(recordSessionAsBook('sess-quick', cwd).action).toBe('folded')
  expect(readEliaBook(first.bookId!, cwd)!.activeVersion).toBe(2)

  // Worse work is kept on record but does not displace it.
  record(cwd, 'sess-c', parserSession('fix the parser empty input bug once more', 4))
  expect(recordSessionAsBook('sess-c', cwd).action).toBe('folded')
  book = readEliaBook(first.bookId!, cwd)!
  expect(book.versions).toHaveLength(4)
  expect(book.activeVersion).toBe(2)
})

test('a verified version is never displaced by a recorded session, however good it looks', () => {
  const cwd = project()
  record(cwd, 'sess-a', parserSession('fix the parser empty input bug', 2))
  const { bookId } = recordSessionAsBook('sess-a', cwd)
  const book = readEliaBook(bookId!, cwd)!
  book.status = 'verified'
  book.versions[0]!.evidence.verified = true
  writeFileSync(join(cwd, '.elia', 'books', `${bookId}.json`), JSON.stringify(book))

  record(cwd, 'sess-b', parserSession('fix the parser empty input bug again', 0))
  expect(recordSessionAsBook('sess-b', cwd).action).toBe('folded')
  const after = readEliaBook(bookId!, cwd)!
  expect(after.versions).toHaveLength(2)
  expect(after.activeVersion).toBe(1)
  expect(after.status).toBe('verified')
})

test('unrelated work starts its own Book', () => {
  const cwd = project()
  record(cwd, 'sess-a', parserSession('fix the parser empty input bug', 0))
  record(cwd, 'sess-z', (transcript) => {
    transcript.appendUser('write a haiku about databases into poems.txt')
    run(transcript, 'echo done', 'done')
  }, { files: ['poems.txt'] })
  const a = recordSessionAsBook('sess-a', cwd)
  const z = recordSessionAsBook('sess-z', cwd)
  expect(z.action).toBe('created')
  expect(z.bookId).not.toBe(a.bookId)
  expect(listEliaBooks(cwd)).toHaveLength(2)
})

test('recording the same session twice adds nothing; a session that carried on updates its own version', () => {
  const cwd = project()
  record(cwd, 'sess-a', parserSession('fix the parser empty input bug', 0))
  const { bookId } = recordSessionAsBook('sess-a', cwd)
  expect(recordSessionAsBook('sess-a', cwd)).toMatchObject({ action: 'skipped', reason: 'already recorded' })

  // The conversation is resumed and goes further: same session id, more actions.
  const transcript = createTranscript()
  transcript.endTurn()
  const recorder = createSessionRecorder({ cwd })
  recorder.attach(transcript)
  recorder.begin('sess-a', { mode: 'dev', model: 'test-model', resumedFrom: 'sess-a' })
  transcript.appendUser('now also cover the trailing newline case')
  run(transcript, 'bun test src/parser.test.ts', '2 pass')
  recorder.finish()

  expect(recordSessionAsBook('sess-a', cwd)).toEqual({ action: 'refreshed', bookId })
  const book = readEliaBook(bookId!, cwd)!
  expect(book.versions).toHaveLength(1)
  expect(book.versions[0]!.procedure.steps.map((step) => step.title)).toEqual(['fix the parser empty input bug', 'now also cover the trailing newline case'])
})

test('a Book keeps at most eight versions and never drops the active one', () => {
  const cwd = project()
  record(cwd, 'sess-0', parserSession('fix the parser empty input bug', 9))
  const { bookId } = recordSessionAsBook('sess-0', cwd)
  for (let index = 1; index <= 10; index += 1) {
    record(cwd, `sess-${index}`, parserSession('fix the parser empty input bug', 9))
    recordSessionAsBook(`sess-${index}`, cwd)
  }
  const book = readEliaBook(bookId!, cwd)!
  expect(book.versions).toHaveLength(8)
  expect(book.versions.some((version) => version.version === book.activeVersion)).toBe(true)
  expect(book.versions.at(-1)!.version).toBe(11)
})

test('a session that died is closed and made into a Book on the next start, unless it is still running', () => {
  const cwd = project()
  record(cwd, 'dead', parserSession('fix the parser empty input bug', 1), { close: false })
  record(cwd, 'alive', (transcript) => {
    transcript.appendUser('write the release notes into notes.md')
    run(transcript, 'echo notes', 'notes')
  }, { close: false, files: ['notes.md'] })
  record(cwd, 'now', (transcript) => {
    transcript.appendUser('this very session')
    run(transcript, 'echo hi', 'hi')
  }, { close: false })

  // Written a moment ago: that session may be running without having announced itself yet, so it waits.
  expect(recoverRecordings(cwd, { current: 'now', isLive: () => false })).toBe(0)
  expect(readRecording(recordingPath(cwd, 'dead')!).at(-1)!.kind).not.toBe('session-end')

  const later = Date.now() + 10 * 60_000
  const recovered = recoverRecordings(cwd, { current: 'now', isLive: (id) => id === 'alive', now: later })
  expect(recovered).toBe(1)
  expect(listEliaBooks(cwd).map((book) => book.title)).toEqual(['fix the parser empty input bug'])
  const events = readRecording(recordingPath(cwd, 'dead')!)
  expect(events.at(-1)).toMatchObject({ kind: 'session-end', recovered: true })
  // Untouched: still open, still theirs.
  expect(readRecording(recordingPath(cwd, 'alive')!).at(-1)!.kind).not.toBe('session-end')
  expect(readRecording(recordingPath(cwd, 'now')!).at(-1)!.kind).not.toBe('session-end')
  // Running it again finds nothing left to recover.
  expect(recoverRecordings(cwd, { current: 'now', isLive: (id) => id === 'alive', now: later })).toBe(0)
  expect(readFileSync(recordingPath(cwd, 'dead')!, 'utf8').split('\n').filter((line) => line.includes('session-end'))).toHaveLength(1)
})

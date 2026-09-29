import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { failureSignature, indexRecording, loadRecordingIndex, minePatterns, openRecording, parsePointer, pointerFor } from './recordingIndex.ts'
import { createSessionRecorder, recordingPath, type RecordedEvent } from './sessionRecorder.ts'
import { createTranscript } from '../ui/transcript.ts'

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

let clock = 1_000
/** A recorded event, numbered by the order the test writes them in. */
function events(turn: number, ...bodies: Record<string, unknown>[]): RecordedEvent[] {
  return bodies.map((body) => ({ seq: 0, at: (clock += 10), turn, ...body }) as unknown as RecordedEvent)
}
function numbered(...groups: RecordedEvent[][]): RecordedEvent[] {
  return groups.flat().map((event, seq) => ({ ...event, seq }))
}
const tool = (name: string, command: string, status: 'ok' | 'error', result: string, actor?: string) => ({ kind: 'tool', name, input: { command }, status, result, durationMs: 1, ...(actor ? { actor } : {}) })
const turnEnd = (verify: string, touched: string[] = []) => ({ kind: 'turn-end', outcome: 'completed', verify, repairAttempts: 0, touched, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1, elapsedMs: 1 } })

const WINDOWS = "'ls' is not recognized as an internal or external command, operable program or batch file"

test('a recording yields what was asked and how it ended, the failure that was put right, and the dead end', () => {
  const recording = numbered(
    events(0, { kind: 'session-start', sessionId: 's1', mode: 'dev', model: 'm' }),
    events(
      0,
      { kind: 'user', text: '<operator-context>hook</operator-context>\n\nlist the workspace' },
      tool('run_command', 'ls -la workspace', 'error', WINDOWS),
      tool('run_command', 'dir workspace', 'ok', 'Directory of D:\\workspace'),
      tool('run_command', 'make deploy', 'error', 'make: *** No rule to make target deploy'),
      tool('edit_file', 'a.ts', 'error', 'old_string not found in the file'),
      tool('run_command', 'npm publish', 'error', 'Action denied by the operator'),
      { kind: 'assistant', text: 'The workspace holds two folders.' },
      { kind: 'lesson', text: 'List directories with dir on this machine', from: 1 },
      turnEnd('pass', ['workspace/notes.md']),
    ),
  )
  const index = indexRecording('s1', recording)

  const request = index.moments.find((moment) => moment.kind === 'request')!
  expect(request.text).toContain('list the workspace')
  expect(request.text).not.toContain('operator-context')
  expect(request.text).toContain('The workspace holds two folders.')
  expect(request.weight).toBe(1.3)
  expect(request.paths).toEqual(['workspace/notes.md'])
  expect(request.pointer).toBe(pointerFor('s1', 1, 9))

  const fix = index.moments.find((moment) => moment.kind === 'fix')!
  expect(fix.text).toBe(`run_command ls -la workspace failed: ${WINDOWS} then worked: run_command dir workspace`)
  expect(fix.weight).toBe(1.4)
  expect(fix.pointer).toBe(pointerFor('s1', 2, 3))

  // Only what the project taught: not the edit slip, not the operator's refusal.
  const deadEnds = index.moments.filter((moment) => moment.kind === 'dead-end')
  expect(deadEnds.map((moment) => moment.text)).toEqual(['run_command make deploy failed: make: *** No rule to make target deploy'])
  expect(index.friction).toHaveLength(2)
  expect(index.lessons).toEqual([{ text: 'List directories with dir on this machine', pointer: pointerFor('s1', 1, 8) }])
})

test("a sub-agent's failure is not put right by the lead's next call", () => {
  const index = indexRecording(
    's2',
    numbered(events(0, { kind: 'user', text: 'survey' }, tool('run_command', 'ls', 'error', WINDOWS, 'scout#1'), tool('run_command', 'dir', 'ok', 'fine'), turnEnd('none'))),
  )
  expect(index.friction).toHaveLength(1)
  expect(index.friction[0]!.fixedBy).toBeUndefined()
  expect(index.moments.some((moment) => moment.kind === 'dead-end')).toBe(true)
})

test('two failures that differ only in paths, numbers and hashes share a signature; different failures do not', () => {
  const a = failureSignature('read_file', "ENOENT: no such file or directory, open '/tmp/build-91/a.ts'")
  const b = failureSignature('read_file', "ENOENT: no such file or directory, open 'C:\\work\\build-17\\b.ts'")
  expect(a).toBe(b)
  expect(a).toBe("read_file: enoent: no such file or directory, open '<path>'")
  expect(failureSignature('read_file', 'EACCES: permission denied, open /tmp/x')).not.toBe(a)
  expect(failureSignature('run_command', 'exited with 137 after 2041ms (a3f9c2e1b4)')).toBe('run_command: exited with # after #ms (<hex>)')
})

function session(id: string, ...failures: { command: string; fix?: string; error?: string }[]): ReturnType<typeof indexRecording> {
  return indexRecording(
    id,
    numbered(
      events(
        0,
        { kind: 'user', text: 'work' },
        ...failures.flatMap((failure) => [
          tool('run_command', failure.command, 'error', failure.error ?? WINDOWS),
          ...(failure.fix ? [tool('run_command', failure.fix, 'ok', 'fine')] : []),
        ]),
        turnEnd('pass'),
      ),
    ),
  )
}

test('a failure that recurs across sessions becomes a pattern, with the fix that keeps working', () => {
  const patterns = minePatterns([
    session('s1', { command: 'ls a', fix: 'dir a' }),
    session('s2', { command: 'ls b', fix: 'dir b' }),
    session('s3', { command: 'ls c' }),
    session('s4', { command: 'npm run x', error: 'boom' }),
    session('s5', { command: 'npm run y', error: 'boom' }),
    session('s6', { command: 'once', error: 'this failure happened one time only in one session' }),
  ])

  // The stock-word failure ("boom") is too generic to cluster on, and a single occurrence is an incident, not a pattern.
  expect(patterns).toHaveLength(1)
  const [pattern] = patterns
  expect(pattern!.occurrences).toBe(3)
  expect(pattern!.sessions.sort()).toEqual(['s1', 's2', 's3'])
  // `dir a` and `dir b` are the same fix.
  expect(pattern!.fix).toMatchObject({ count: 2 })
  expect(pattern!.fix!.label.startsWith('run_command dir')).toBe(true)
  expect(pattern!.example.failed).toBe('run_command ls c')
  expect(pattern!.pointers).toHaveLength(3)
})

test('a pointer opens back to the raw events, with context for a single one, and never past its budget', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-index-'))
  roots.push(cwd)
  const transcript = createTranscript()
  const recorder = createSessionRecorder({ cwd })
  recorder.attach(transcript)
  recorder.begin('open1', { mode: 'dev', model: 'm' })
  transcript.appendUser('read the logs')
  transcript.recordTool({ name: 'read_file', input: { path: 'app.log' }, result: 'line\n'.repeat(400), isError: false, cached: false, durationMs: 3 })
  for (let index = 0; index < 30; index += 1) transcript.recordTool({ name: 'read_file', input: { path: `f${index}.log` }, result: 'z'.repeat(900), isError: false, cached: false, durationMs: 1 })
  recorder.finish()

  expect(openRecording(pointerFor('open1', 1, 2), cwd)).toContain('read_file [ok]')
  expect(openRecording(pointerFor('open1', 1, 2), cwd)).toContain('#1 user: read the logs')
  // One event: shown with what surrounds it.
  const single = openRecording(pointerFor('open1', 2), cwd)
  expect(single).toContain('#0 session started')
  expect(single).toContain('#2 tool read_file')
  // A long range is cut off with the way to narrow it.
  const long = openRecording(pointerFor('open1', 0, 40), cwd)
  expect(long.length).toBeLessThan(15_500)
  expect(long).toContain('more event(s) in this range')
  expect(openRecording(pointerFor('nothere', 0), cwd)).toContain('may have been pruned')
  expect(openRecording('recording:../../etc#1', cwd)).toContain('is not a recording reference')
  expect(parsePointer('recording:abc-1#4-9')).toEqual({ sessionId: 'abc-1', from: 4, to: 9 })
  expect(parsePointer('book:x')).toBeUndefined()
})

test('the index leaves out the session in progress and re-reads a recording only when it changed', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-index-'))
  roots.push(cwd)
  for (const id of ['done1', 'live1']) {
    const transcript = createTranscript()
    const recorder = createSessionRecorder({ cwd })
    recorder.attach(transcript)
    recorder.begin(id, { mode: 'dev', model: 'm' })
    transcript.appendUser(`work in ${id}`)
    recorder.finish()
  }
  const first = loadRecordingIndex(cwd, { currentSessionId: 'live1' })
  expect(first.map((recording) => recording.sessionId)).toEqual(['done1'])
  expect(loadRecordingIndex(cwd, { currentSessionId: 'live1' })[0]).toBe(first[0]!)

  const transcript = createTranscript()
  const recorder = createSessionRecorder({ cwd })
  recorder.attach(transcript)
  recorder.begin('done1', { mode: 'dev', model: 'm' })
  // A resumed conversation carries on from the turn it had reached.
  transcript.endTurn()
  transcript.appendUser('one more request')
  recorder.finish()
  const again = loadRecordingIndex(cwd, { currentSessionId: 'live1' })[0]!
  expect(again).not.toBe(first[0]!)
  expect(again.moments.filter((moment) => moment.kind === 'request')).toHaveLength(2)
  expect(recordingPath(cwd, 'done1')).toBeDefined()
})

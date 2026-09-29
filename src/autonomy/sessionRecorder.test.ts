import { afterEach, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTranscript } from '../ui/transcript.ts'
import { createSessionRecorder, listRecordings, pruneRecordings, readRecording, recordingEnabled, recordingPath, recordingsDir, type RecordedUsage } from './sessionRecorder.ts'

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elia-recorder-'))
  roots.push(dir)
  return dir
}

const USAGE: RecordedUsage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1, elapsedMs: 900 }
const tool = (name: string, input: Record<string, unknown>, result: string, isError = false) => ({ name, input, result, isError, cached: false, durationMs: 12 })

test('every event lands on disk as it happens, in order, without private reasoning or secrets', () => {
  const cwd = project()
  const secret = 'sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c'
  const transcript = createTranscript()
  const recorder = createSessionRecorder({ cwd })
  recorder.attach(transcript)
  recorder.begin('s1', { mode: 'dev', model: 'test-model' })

  transcript.appendUser('fix the parser')
  transcript.appendThinking('PRIVATE REASONING that must never be written')
  transcript.recordTool(tool('run_command', { command: `curl -H "Authorization: Bearer ${secret}" x` }, 'error: boom', true))
  transcript.recordTool(tool('run_command', { command: 'bun test' }, '1 pass'))
  transcript.shell('ls', 'a.ts')
  transcript.notice('Verifying: bun test')
  transcript.error('a handled failure')
  transcript.appendAssistant(`done — the key was ${secret}`)
  recorder.turnEnd({ outcome: 'completed', verify: 'pass', repairAttempts: 0, touched: ['src/parser.ts'], usage: USAGE })
  recorder.lesson('Run the parser tests with bun test')
  recorder.finish()

  const path = recordingPath(cwd, 's1')!
  const events = readRecording(path)
  expect(events.map((event) => event.kind)).toEqual(['session-start', 'user', 'tool', 'tool', 'shell', 'notice', 'error', 'assistant', 'turn-end', 'lesson', 'session-end'])
  expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index))
  const raw = readFileSync(path, 'utf8')
  expect(raw).not.toContain(secret)
  expect(raw).not.toContain('PRIVATE REASONING')
  // The lesson points back at the turn that taught it.
  const lesson = events.find((event) => event.kind === 'lesson')
  expect(lesson).toMatchObject({ kind: 'lesson', from: 1 })
  const failed = events.find((event) => event.kind === 'tool' && event.status === 'error')
  expect(failed).toMatchObject({ kind: 'tool', name: 'run_command', result: 'error: boom' })
  expect(statSync(path).mode & 0o077).toBe(0)
})

test('an oversized result is clipped and says so; a recording at its limit stops with a row that says why, and still closes', () => {
  const cwd = project()
  const transcript = createTranscript()
  const recorder = createSessionRecorder({ cwd, maxBytes: 30_000 })
  recorder.attach(transcript)
  recorder.begin('s2', { mode: 'dev', model: 'm' })
  transcript.appendUser('read the big file')
  transcript.recordTool(tool('read_file', { path: 'big.txt' }, 'x'.repeat(50_000)))
  for (let index = 0; index < 5; index += 1) transcript.recordTool(tool('read_file', { path: `f${index}.txt` }, 'y'.repeat(15_000)))
  transcript.appendAssistant('never recorded')
  recorder.finish()

  const events = readRecording(recordingPath(cwd, 's2')!)
  const big = events.find((event) => event.kind === 'tool' && event.input.path === 'big.txt')
  expect(big && big.kind === 'tool' && big.result).toContain('more characters not recorded')
  expect(big && big.kind === 'tool' && big.result.length).toBeLessThan(21_000)
  expect(events.filter((event) => event.kind === 'truncated')).toHaveLength(1)
  expect(events.some((event) => event.kind === 'assistant')).toBe(false)
  expect(events.at(-1)?.kind).toBe('session-end')
})

test('a session id that is resumed keeps counting where its recording left off, and finish closes it once', () => {
  const cwd = project()
  const first = createSessionRecorder({ cwd })
  first.begin('s3', { mode: 'dev', model: 'm' })
  first.lesson('one')
  expect(first.finish()).toEqual({ sessionId: 's3', path: recordingPath(cwd, 's3')! })
  expect(first.finish()).toBeUndefined()

  const second = createSessionRecorder({ cwd })
  second.begin('s3', { mode: 'dev', model: 'm', resumedFrom: 's3' })
  expect(second.current()?.nextSeq).toBe(4)
  second.finish()
  const seqs = readRecording(recordingPath(cwd, 's3')!).map((event) => event.seq)
  expect(seqs).toEqual([0, 1, 2, 3, 4])
})

test('a recorder that is off, or handed an id that names a file, writes nothing', () => {
  const cwd = project()
  const off = createSessionRecorder({ cwd, enabled: false })
  off.begin('s4', { mode: 'dev', model: 'm' })
  off.lesson('x')
  expect(off.finish()).toBeUndefined()
  const odd = createSessionRecorder({ cwd })
  odd.begin('../../escape', { mode: 'dev', model: 'm' })
  expect(odd.current()).toBeUndefined()
  expect(existsSync(recordingsDir(cwd))).toBe(false)
  expect(recordingEnabled({ ELIA_RECORD: 'off' })).toBe(false)
  expect(recordingEnabled({ ELIA_RECORD: '0' })).toBe(false)
  expect(recordingEnabled({})).toBe(true)
  expect(recordingEnabled({ ELIA_RECORD: 'on' })).toBe(true)
})

test('a recording cut off mid-line by a killed process still reads back everything before it', () => {
  const cwd = project()
  const recorder = createSessionRecorder({ cwd })
  recorder.begin('s5', { mode: 'dev', model: 'm' })
  recorder.lesson('kept')
  const path = recordingPath(cwd, 's5')!
  appendFileSync(path, '{"seq":2,"at":1,"turn":0,"kind":"lesson","text":"torn')
  expect(readRecording(path).map((event) => event.kind)).toEqual(['session-start', 'lesson'])
})

test('pruning keeps the newest, the current session and anything a Book still points at', () => {
  const cwd = project()
  mkdirSync(recordingsDir(cwd), { recursive: true })
  const now = Date.now()
  const day = 86_400_000
  const make = (id: string, ageDays: number) => {
    const path = join(recordingsDir(cwd), `${id}.ndjson`)
    writeFileSync(path, '{"seq":0,"at":0,"turn":0,"kind":"session-end"}\n')
    utimesSync(path, new Date(now - ageDays * day), new Date(now - ageDays * day))
  }
  make('fresh-a', 1)
  make('fresh-b', 2)
  make('fresh-c', 3)
  make('old-current', 90)
  make('old-booked', 90)
  make('old-plain', 90)

  const removed = pruneRecordings(cwd, { keep: 3, maxAgeMs: 45 * day, now, current: 'old-current', protect: new Set(['old-booked']) })
  expect(removed).toBe(1)
  expect(listRecordings(cwd).map((file) => file.sessionId).sort()).toEqual(['fresh-a', 'fresh-b', 'fresh-c', 'old-booked', 'old-current'])
  // Newest past the keep limit goes even when young.
  expect(pruneRecordings(cwd, { keep: 2, maxAgeMs: 45 * day, now, current: 'old-current', protect: new Set(['old-booked']) })).toBe(1)
})

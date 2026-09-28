import { afterAll, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ELIA_ROOT } from '../statePaths.ts'
import {
  describeFault,
  eliaFrames,
  faultRecord,
  faultSignature,
  groupFaults,
  isEliaFault,
  normalizeMessage,
  readFaults,
  recordFault,
  repeatedCrash,
  type FaultRecord,
} from './faults.ts'

const dir = mkdtempSync(join(tmpdir(), 'elia-faults-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const root = ELIA_ROOT.replaceAll('\\', '/')

/** An error thrown from a named place in elia's source, the way Bun prints it. */
function eliaError(name: string, message: string, file = 'src/cli/interactive.ts', fn = 'runRecordedTurn', line = 1012): Error {
  const error = new Error(message)
  error.name = name
  error.stack = [
    `${name}: ${message}`,
    `    at ${fn} (${root}/${file}:${line}:17)`,
    `    at <anonymous> (${root}/node_modules/ink/build/render.js:40:3)`,
    `    at processTicksAndRejections (native:7:39)`,
    `    at runCheckpointedTurn (${root}/src/cli/interactive.ts:925:9)`,
  ].join('\n')
  return error
}

test('only frames in elia\'s own source are kept — not dependencies, not natives', () => {
  const frames = eliaFrames(eliaError('TypeError', 'x').stack)
  expect(frames).toEqual([
    { file: 'src/cli/interactive.ts', line: 1012, fn: 'runRecordedTurn' },
    { file: 'src/cli/interactive.ts', line: 925, fn: 'runCheckpointedTurn' },
  ])
  expect(eliaFrames(`Error: y\n    at /somewhere/else/app.ts:3:1`)).toEqual([])
})

test('the same bug keeps its signature when the line moves or the ids differ', () => {
  const a = eliaError('TypeError', "Cannot read properties of undefined (reading 'id') at 4f2a91c07b", 'src/a.ts', 'load', 10)
  const b = eliaError('TypeError', "Cannot read properties of undefined (reading 'id') at 99ab31d7e0", 'src/a.ts', 'load', 55)
  const other = eliaError('TypeError', "Cannot read properties of undefined (reading 'id')", 'src/b.ts', 'load', 10)
  const sig = (error: Error) => faultSignature(error.name, error.message, eliaFrames(error.stack))
  expect(sig(a)).toBe(sig(b))
  expect(sig(a)).not.toBe(sig(other))
  expect(normalizeMessage('failed after 3 tries at /Users/x/project/file.ts')).toBe('failed after N tries at <path>')
})

test('a programming error in elia\'s code is a fault; the environment is not', () => {
  expect(isEliaFault(eliaError('TypeError', 'x is not a function'), 'turn')).toBe(true)
  // A provider refusing the key is not a bug to repair.
  expect(isEliaFault(eliaError('Error', '401 Incorrect API key provided'), 'turn')).toBe(false)
  // A TypeError that never passed through elia's source is not elia's to fix.
  const foreign = new TypeError('x')
  foreign.stack = 'TypeError: x\n    at f (/elsewhere/lib.js:1:1)'
  expect(isEliaFault(foreign, 'turn')).toBe(false)
  // Anything that escaped every handler is elia's fault for not handling it.
  expect(isEliaFault(new Error('ECONNRESET'), 'uncaught-exception')).toBe(true)
  expect(isEliaFault('a bare string', 'unhandled-rejection')).toBe(true)
})

test('a record is redacted, bounded, and carries what a repair needs', () => {
  const record = faultRecord(eliaError('TypeError', 'bad key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 used'), { source: 'turn', command: 'repl', sessionId: 's1' })!
  expect(record.message).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789')
  expect(record.frames[0]).toBe('src/cli/interactive.ts:1012 runRecordedTurn')
  expect(record).toMatchObject({ source: 'turn', command: 'repl', fatal: false, name: 'TypeError', sessionId: 's1' })
  expect(record.signature).toMatch(/^[0-9a-f]{10}$/)
  expect(faultRecord(new Error('offline'), { source: 'command', command: 'auto' })).toBeUndefined()
})

test('faults are appended, read back past a torn line, and grouped by bug', () => {
  const path = join(dir, 'faults.ndjson')
  recordFault(eliaError('TypeError', 'boom'), { source: 'turn', command: 'repl' }, path)
  appendFileSync(path, '{"torn": \n')
  recordFault(eliaError('TypeError', 'boom'), { source: 'uncaught-exception', command: 'auto', fatal: true }, path)
  recordFault(eliaError('RangeError', 'too deep', 'src/b.ts', 'walk'), { source: 'turn', command: 'repl' }, path)
  // Not a fault: written nowhere.
  expect(recordFault(new Error('ENOTFOUND api.example.com'), { source: 'turn', command: 'repl' }, path)).toBeUndefined()

  const records = readFaults(path)
  expect(records).toHaveLength(3)
  const groups = groupFaults(records)
  expect(groups).toHaveLength(2)
  // The one that crashed the process ranks first.
  expect(groups[0]).toMatchObject({ count: 2, fatal: 1, commands: ['repl', 'auto'] })
  expect(describeFault(groups[0]!.latest)).toBe('TypeError: boom — src/cli/interactive.ts:1012 runRecordedTurn')
})

test('the same crash twice in a day is a loop; once, or long ago, is not', () => {
  const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString()
  const crash = (hoursAgo: number, signature = 'abc'): FaultRecord => ({
    at: at(hoursAgo), pid: 1, version: '0', command: 'repl', source: 'uncaught-exception', fatal: true, name: 'TypeError', message: 'x', frames: ['src/a.ts:1 f'], signature,
  })
  expect(repeatedCrash([crash(1)])).toBeUndefined()
  expect(repeatedCrash([crash(1), crash(30)])).toBeUndefined()
  expect(repeatedCrash([crash(1), crash(2, 'other')])).toBeUndefined()
  expect(repeatedCrash([crash(1), crash(3)])).toMatchObject({ signature: 'abc', count: 2 })
})

test('a real stack from this runtime parses to elia frames', () => {
  function throwsFromHere(): never {
    const value = undefined as unknown as { id: string }
    return value.id as never
  }
  let caught: unknown
  try {
    throwsFromHere()
  } catch (error) {
    caught = error
  }
  const record = faultRecord(caught, { source: 'turn', command: 'repl' })
  expect(record?.name).toBe('TypeError')
  expect(record?.frames[0]).toMatch(/^src\/recovery\/faults\.test\.ts:\d+ throwsFromHere$/)
})

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAgentIdentity } from '../autonomy/context.ts'
import { ZERO_USAGE } from '../usage.ts'
import { digestText, runDigest, splitIntoParts, type Ask } from './digest.ts'

let dir: string
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'elia-digest-'))) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const usage = { ...ZERO_USAGE, inputTokens: 10, outputTokens: 2 }

/** A stand-in model: a part's note is the numbered lines that mention "ERROR"; the answer lists them. */
const scripted = (calls: string[]): Ask => async (system, prompt) => {
  calls.push(system.startsWith('You read one part') ? 'note' : 'answer')
  if (system.startsWith('You read one part')) {
    const hits = prompt.split('\n').filter((line) => /^\d+\t.*ERROR/.test(line))
    return { text: hits.length ? hits.map((line) => `- line ${line.split('\t')[0]}: ${line.split('\t')[1]}`).join('\n') : 'NONE', usage }
  }
  return { text: `Answer from: ${prompt.match(/line \d+/g)?.join(', ')}`, usage }
}

test('parts cover every line in order, overlap a little, and stay near the size', () => {
  const text = Array.from({ length: 5000 }, (_, index) => `line ${index + 1} ${'x'.repeat(40)}`).join('\n')
  const parts = splitIntoParts(text, 20_000, 500)
  expect(parts[0]!.firstLine).toBe(1)
  expect(parts.at(-1)!.lastLine).toBe(5000)
  for (let index = 1; index < parts.length; index += 1) {
    expect(parts[index]!.firstLine).toBeLessThanOrEqual(parts[index - 1]!.lastLine)
    expect(parts[index]!.firstLine).toBeGreaterThan(parts[index - 1]!.firstLine)
  }
  expect(Math.max(...parts.map((part) => part.text.length))).toBeLessThan(20_000 + 5 * 500)
})

test('every part is read, only relevant notes are kept, and the answer cites their lines', async () => {
  const lines = Array.from({ length: 30_000 }, (_, index) => `${index === 120 || index === 29_000 ? 'ERROR disk full' : 'ok'} event ${index}`)
  const calls: string[] = []
  const result = await digestText(lines.join('\n'), 'what failed?', scripted(calls))
  expect(calls.filter((call) => call === 'note').length).toBe(splitIntoParts(lines.join('\n')).length)
  expect(calls.at(-1)).toBe('answer')
  expect(result.answer).toContain('line 121')
  expect(result.answer).toContain('line 29001')
  expect(result.usage.inputTokens).toBe(10 * calls.length)
})

test('a part the model cannot read is reported, not silently skipped', async () => {
  let first = true
  const flaky: Ask = async (system, prompt) => {
    if (first && system.startsWith('You read one part')) { first = false; throw new Error('503') }
    return scripted([])(system, prompt)
  }
  const result = await digestText('ERROR one\nfine', 'what failed?', flaky)
  expect(result.failed).toBe(1)
  expect(result.notes[0]!.note).toContain('could not be read')
})

test('a local file is read whole and the report says how much was read', async () => {
  writeFileSync(join(dir, 'app.log'), Array.from({ length: 2000 }, (_, index) => (index === 1500 ? 'ERROR timeout' : `ok ${index}`)).join('\n'))
  const report = await withAgentIdentity({ name: 't', role: 'lead', cwd: dir }, () => runDigest({ source: 'app.log', question: 'what failed?' }, scripted([])))
  expect(report).toContain('Read app.log whole: 2000 lines in 1 part(s).')
  expect(report).toContain('line 1501')
  expect(report).toContain('Notes it was answered from')
})

test('nothing relevant is said plainly, without a final call', async () => {
  const calls: string[] = []
  const result = await digestText('ok\nok', 'what failed?', scripted(calls))
  expect(result.answer).toContain('Nothing in the 1 part(s) bears on the question')
  expect(calls).toEqual(['note'])
})

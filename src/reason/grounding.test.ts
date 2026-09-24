import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkGrounding, describeGrounding, extractCitations, groundingBriefing } from './grounding.ts'

const repo = mkdtempSync(join(tmpdir(), 'elia-grounding-'))
mkdirSync(join(repo, 'src', 'net'), { recursive: true })
writeFileSync(join(repo, 'src', 'net', 'retry.ts'), 'line 1\nline 2\nline 3\n')
writeFileSync(join(repo, 'README.md'), '# readme\n')
afterAll(() => rmSync(repo, { recursive: true, force: true }))

const check = (answer: string, touched: string[] = []) => checkGrounding(extractCitations(answer), repo, { touched })

test('path:line citations and local markdown links are extracted; mentions and URLs are not', () => {
  const citations = extractCitations(
    'The retry is in src/net/retry.ts:2 and [the readme](README.md). See https://example.com:8080/x.ts:4, example.com:443 and [docs](https://docs.dev/a.md). I would add src/net/backoff.ts.',
  )
  expect(citations.map((citation) => `${citation.path}:${citation.line ?? ''}`)).toEqual(['README.md:', 'src/net/retry.ts:2'])
})

test('a link label that repeats its target is not cited a second time at the root', () => {
  const citations = extractCitations('See [retry.ts:2](src/net/retry.ts:2).')
  expect(citations).toEqual([{ raw: '[retry.ts:2](src/net/retry.ts:2)', path: 'src/net/retry.ts', line: 2 }])
})

test('citations that hold are grounded', () => {
  expect(check('see src/net/retry.ts:3 and [readme](README.md)')).toEqual({ checked: 2, ungrounded: [] })
})

test('an invented file and a line past the end are both caught', () => {
  const result = check('the backoff is at src/net/backoff.ts:10, the retry at src/net/retry.ts:40')
  expect(result.checked).toBe(2)
  expect(result.ungrounded.map((entry) => entry.why)).toEqual(['no such file in this workspace', 'the file has 3 lines'])
  expect(groundingBriefing(result)).toContain('src/net/backoff.ts:10 — no such file')
  expect(describeGrounding(result)).toContain('2 of 2 cited location(s) do not exist')
})

test('a file the turn deleted may be cited, since the answer is about deleting it', () => {
  expect(check('I removed src/net/old.ts:12', [join(repo, 'src', 'net', 'old.ts')]).ungrounded).toEqual([])
})

test('a bare file name not at the root is not guessed at', () => {
  expect(check('retry.ts:2 does it')).toEqual({ checked: 0, ungrounded: [] })
})

test('paths outside the workspace and code in fences are left alone', () => {
  expect(check('../elsewhere/x.ts:3 and\n```\nsrc/made/up.ts:9\n```')).toEqual({ checked: 0, ungrounded: [] })
})

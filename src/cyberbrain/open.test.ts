import { expect, test } from 'bun:test'
import { writeFixtureCorpus } from './fixture.ts'
import { openCyberReference, renderRecord } from './open.ts'
import { loadCorpus } from './store.ts'
import type { CyberCorpus, CyberRecord } from './types.ts'

async function fixtureCorpus(): Promise<{ corpus: CyberCorpus; record: CyberRecord }> {
  const fixture = writeFixtureCorpus()
  const corpus = await loadCorpus({ dir: fixture.dir, force: true })
  return { corpus, record: corpus.recordById.get('r_pwn1')! }
}

test('renderRecord renders the whole finding, including the verification check', async () => {
  const { record } = await fixtureCorpus()
  const rendered = renderRecord(record)

  expect(rendered).toContain(record.title)
  expect(rendered).toContain('r_pwn1')
  expect(rendered).toContain('- category: pwn')
  expect(rendered).toContain('- vulnerability: Buffer Overflow (CWE-120)')
  expect(rendered).toContain('suspicious Buffer Overflow signal')
  expect(rendered).toContain('1. recon — identify Buffer Overflow')
  expect(rendered).toContain('command: `file ./chall`')
  expect(rendered).toContain('expected: shell')
  expect(rendered).toContain('## Impact')
  expect(rendered).toContain('- code execution')
  expect(rendered).toContain('validate input with explicit bounds')
  expect(rendered).toContain('verification: fuzz the parser and confirm the crash no longer reproduces')
  expect(rendered).toContain('short payload: never reaches the return address')
  expect(rendered).toContain('- https://example.test/w — github · TestCTF 2024 · 2024 · a')
})

test('renderRecord truncates oversized output with an explicit marker', async () => {
  const { record } = await fixtureCorpus()
  const rendered = renderRecord(record, 300)

  expect(rendered.length).toBeLessThanOrEqual(300)
  expect(rendered).toContain('truncated')
  expect(rendered).not.toContain('## Source')
})

test('openCyberReference resolves record:, bare ids, and chunk:', async () => {
  const { corpus } = await fixtureCorpus()

  const byRecord = openCyberReference(corpus, 'record:r_web1')
  expect(byRecord).toContain('# Stored XSS on web challenge')
  expect(openCyberReference(corpus, 'r_web1')).toBe(byRecord)
  expect(openCyberReference(corpus, 'chunk:r_pwn1_remediation')).toContain('Buffer Overflow')
  expect(openCyberReference(corpus, ' chunk:r_pwn1_remediation ')).toContain('Buffer Overflow')
})

test('a bad reference returns an honest one-line message', async () => {
  const { corpus } = await fixtureCorpus()

  for (const ref of ['record:r_missing', 'r_missing', 'chunk:nope']) {
    const message = openCyberReference(corpus, ref)
    expect(message).toContain('no record')
    expect(message).toContain(ref)
    expect(message).not.toContain('\n')
  }
})

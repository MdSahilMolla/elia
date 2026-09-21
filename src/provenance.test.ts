import { afterEach, expect, test } from 'bun:test'
import { fingerprintTrailers, signCommitMessage, withProvenance, activeProvenance, setProcessProvenance, type RunFingerprint } from './provenance.ts'

const RUN: RunFingerprint = { sessionId: 'mf2k9x-a7b3c1', surface: 'auto', model: 'mercury-2.5', version: '0.4.1' }

afterEach(() => {
  setProcessProvenance(undefined)
  delete process.env.ELIA_COMMIT_BYLINE
  delete process.env.ELIA_FINGERPRINT
})

test('a signed message keeps its subject and body, and adds one trailer paragraph', () => {
  const signed = signCommitMessage('fix(x): a thing\n\nWhy it mattered.', RUN)
  expect(signed.startsWith('fix(x): a thing\n\nWhy it mattered.\n\n')).toBe(true)
  expect(signed).toContain('Elia-Run: mf2k9x-a7b3c1')
  expect(signed).toContain('Elia-Surface: auto')
  expect(signed).toContain('Elia-Model: mercury-2.5')
  expect(signed).toContain('Elia-Version: 0.4.1')
})

test('signing twice does not stack the trailers — a retried commit stays clean', () => {
  const once = signCommitMessage('fix(x): a thing', RUN)
  expect(signCommitMessage(once, RUN)).toBe(once)
  expect([...once.matchAll(/^Elia-Run:/gm)]).toHaveLength(1)
})

test('trailers join an existing trailer block instead of starting a second one', () => {
  // Git reads trailers from the last paragraph only. A second block after a
  // blank line would push the first out of the run and make both unparseable.
  const signed = signCommitMessage('fix(x): a thing\n\nCo-Authored-By: Someone <s@example.com>', RUN)
  const paragraphs = signed.trimEnd().split('\n\n')
  expect(paragraphs).toHaveLength(2)
  expect(paragraphs[1]).toContain('Co-Authored-By: Someone <s@example.com>')
  expect(paragraphs[1]).toContain('Elia-Run: mf2k9x-a7b3c1')
})

test('a subject-only message gets a blank line before the block', () => {
  const signed = signCommitMessage('fix(x): a thing', RUN)
  expect(signed).toStartWith('fix(x): a thing\n\nElia-Run:')
})

test('outside a run nothing is signed — a commit made by hand stays plain', () => {
  expect(signCommitMessage('fix(x): a thing')).toBe('fix(x): a thing')
})

test('ELIA_FINGERPRINT=off leaves history plain', () => {
  process.env.ELIA_FINGERPRINT = 'off'
  expect(signCommitMessage('fix(x): a thing', RUN)).toBe('fix(x): a thing')
})

test('the byline is configurable, and can be dropped without losing provenance', () => {
  process.env.ELIA_COMMIT_BYLINE = 'Elia <someone@example.com>'
  expect(fingerprintTrailers(RUN)).toContain('Co-Authored-By: Elia <someone@example.com>')

  process.env.ELIA_COMMIT_BYLINE = ''
  const trailers = fingerprintTrailers(RUN)
  expect(trailers.some((line) => line.startsWith('Co-Authored-By:'))).toBe(false)
  expect(trailers).toContain('Elia-Run: mf2k9x-a7b3c1')
})

test('a value that spans lines is flattened — a trailer is one line', () => {
  const folded = signCommitMessage('fix(x): a thing', { ...RUN, model: 'mercury\n2.5' })
  expect(folded).toContain('Elia-Model: mercury 2.5')
  expect([...folded.matchAll(/^Elia-/gm)]).toHaveLength(4)
})

test('an optional field simply does not appear', () => {
  const trailers = fingerprintTrailers({ sessionId: 's1', surface: 'interactive' })
  expect(trailers.some((line) => line.startsWith('Elia-Model:'))).toBe(false)
  expect(trailers.some((line) => line.startsWith('Elia-Version:'))).toBe(false)
  expect(trailers).toContain('Elia-Surface: interactive')
})

test('a scope wins over the process default, and the default outlives it', async () => {
  setProcessProvenance(RUN)
  expect(activeProvenance()?.surface).toBe('auto')
  const inner: RunFingerprint = { sessionId: 'sub-1', surface: 'subagent' }
  await withProvenance(inner, async () => {
    expect(activeProvenance()?.sessionId).toBe('sub-1')
    expect(signCommitMessage('x')).toContain('Elia-Surface: subagent')
  })
  expect(activeProvenance()?.sessionId).toBe(RUN.sessionId)
})

test('the commit paths actually sign — the wiring, not just the helper', async () => {
  const githubTool = await Bun.file(new URL('./tools/github.ts', import.meta.url)).text()
  expect(githubTool).toContain("signCommitMessage(message)")
  const scaffold = await Bun.file(new URL('./autonomy/scaffold.ts', import.meta.url)).text()
  expect(scaffold).toContain('signCommitMessage(message)')
})

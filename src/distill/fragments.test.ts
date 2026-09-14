import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addFragment, learnedSuffixFrom } from './fragments.ts'
import { promptForRoleIn } from '../autonomy/roles.ts'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'elia-frag-'))
  mkdirSync(join(root, 'src', 'distill'), { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

test('addFragment creates the file and records the fragment under the role', () => {
  const path = addFragment('builder', '  Always run the migration check   before editing schema files. ', root)
  expect(path).toBe('src/distill/fragments.generated.json')
  const data = JSON.parse(readFileSync(join(root, path), 'utf8'))
  expect(data.fragments.builder).toEqual(['Always run the migration check before editing schema files.'])
  expect(typeof data._comment).toBe('string')
})

test('addFragment is idempotent on the same text and appends distinct ones', () => {
  addFragment('critic', 'Check the diff against the acceptance criteria first.', root)
  addFragment('critic', 'check the diff against the acceptance criteria first.', root) // case-only dup
  addFragment('critic', 'Run the tests before approving.', root)
  const data = JSON.parse(readFileSync(join(root, 'src/distill/fragments.generated.json'), 'utf8'))
  expect(data.fragments.critic).toHaveLength(2)
})

test('addFragment preserves other roles when adding a new one', () => {
  writeFileSync(
    join(root, 'src/distill/fragments.generated.json'),
    JSON.stringify({ fragments: { backend: ['Validate at the boundary.'] } }),
  )
  addFragment('frontend', 'Handle the empty and error states.', root)
  const data = JSON.parse(readFileSync(join(root, 'src/distill/fragments.generated.json'), 'utf8'))
  expect(data.fragments.backend).toEqual(['Validate at the boundary.'])
  expect(data.fragments.frontend).toEqual(['Handle the empty and error states.'])
})

test('learnedSuffixFrom reads a specific tree rather than the live one', () => {
  // What lets the distillation gate test the candidate's role prompt: the
  // sandbox's fragments file is the live one plus the fragment under review, and
  // probing the live prompt on both sides would compare a subject to itself.
  writeFileSync(
    join(root, 'src/distill/fragments.generated.json'),
    JSON.stringify({ fragments: { critic: ['Run the tests before approving.'] } }),
  )
  const suffix = learnedSuffixFrom('critic', root)
  expect(suffix).toContain('Run the tests before approving.')
  expect(suffix).toContain('Learned from past verified runs')
})

test('learnedSuffixFrom is empty for a role with nothing distilled', () => {
  writeFileSync(join(root, 'src/distill/fragments.generated.json'), JSON.stringify({ fragments: {} }))
  expect(learnedSuffixFrom('critic', root)).toBe('')
})

test('learnedSuffixFrom is empty rather than throwing when the tree has no file', () => {
  expect(learnedSuffixFrom('critic', join(root, 'nope'))).toBe('')
})

test('promptForRoleIn puts the candidate fragment into the role prompt', () => {
  writeFileSync(
    join(root, 'src/distill/fragments.generated.json'),
    JSON.stringify({ fragments: { critic: ['Re-read the diff in full context.'] } }),
  )
  const prompt = promptForRoleIn('critic', root)
  expect(prompt).toContain('You are a critic.')
  expect(prompt).toContain('Re-read the diff in full context.')
})

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addFragment } from './fragments.ts'

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

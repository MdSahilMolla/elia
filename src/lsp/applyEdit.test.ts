import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyTextEdits, applyWorkspaceEdit } from './applyEdit.ts'
import type { TextEdit, WorkspaceEdit } from './protocol.ts'

test('applyTextEdits replaces a single-line span', () => {
  const content = 'const x = oldName;\nconsole.log(oldName);\n'
  const edits: TextEdit[] = [{ range: { start: { line: 0, character: 10 }, end: { line: 0, character: 17 } }, newText: 'newName' }]
  expect(applyTextEdits(content, edits)).toBe('const x = newName;\nconsole.log(oldName);\n')
})

test('applyTextEdits applies multiple non-overlapping edits across lines correctly, regardless of input order', () => {
  const content = 'let a = 1;\nlet b = 2;\nlet c = 3;\n'
  const edits: TextEdit[] = [
    { range: { start: { line: 2, character: 4 }, end: { line: 2, character: 5 } }, newText: 'cc' },
    { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 5 } }, newText: 'aa' },
    { range: { start: { line: 1, character: 4 }, end: { line: 1, character: 5 } }, newText: 'bb' },
  ]
  expect(applyTextEdits(content, edits)).toBe('let aa = 1;\nlet bb = 2;\nlet cc = 3;\n')
})

test('applyTextEdits can insert (zero-width range) and delete (empty newText)', () => {
  const content = 'foo()\n'
  const withInsert = applyTextEdits(content, [{ range: { start: { line: 0, character: 3 }, end: { line: 0, character: 3 } }, newText: 'Bar' }])
  expect(withInsert).toBe('fooBar()\n')

  const withDelete = applyTextEdits(content, [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: '' }])
  expect(withDelete).toBe('()\n')
})

test('applyWorkspaceEdit writes only the files with a real change, calls beforeWrite for each, and skips a no-op edit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-lsp-apply-'))
  const fileA = join(dir, 'a.ts')
  const fileB = join(dir, 'b.ts')
  writeFileSync(fileA, 'const x = old;\n')
  writeFileSync(fileB, 'const y = 1;\n')

  const edit: WorkspaceEdit = {
    changes: {
      [pathToFileURL(fileA).href]: [{ range: { start: { line: 0, character: 10 }, end: { line: 0, character: 13 } }, newText: 'new' }],
      // A "no-op" edit: newText identical to what's already there.
      [pathToFileURL(fileB).href]: [{ range: { start: { line: 0, character: 10 }, end: { line: 0, character: 11 } }, newText: '1' }],
    },
  }

  const beforeWriteCalls: string[] = []
  const { applied } = await applyWorkspaceEdit(edit, async (path) => {
    beforeWriteCalls.push(path)
  })

  expect(readFileSync(fileA, 'utf8')).toBe('const x = new;\n')
  expect(readFileSync(fileB, 'utf8')).toBe('const y = 1;\n') // untouched
  expect(applied).toEqual([fileA])
  expect(beforeWriteCalls).toEqual([fileA])
})

test('applyWorkspaceEdit with no changes is a no-op', async () => {
  const { applied } = await applyWorkspaceEdit({})
  expect(applied).toEqual([])
})

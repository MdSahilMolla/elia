import { expect, test } from 'bun:test'
import { shellWords } from './localProgram.ts'

test('shellWords returns the words sh passes, or nothing when expansion would change them', () => {
  expect(shellWords('node bin/notes.js add "Test note"', 'darwin')).toEqual(['node', 'bin/notes.js', 'add', 'Test note'])
  expect(shellWords(`node bin/notes.js add 'it''s' ""`, 'linux')).toEqual(['node', 'bin/notes.js', 'add', 'its', ''])
  expect(shellWords('node bin/notes.js "a*b?" \'~/x\'', 'linux')).toEqual(['node', 'bin/notes.js', 'a*b?', '~/x'])
  expect(shellWords('node bin/notes.js item#3', 'linux')).toEqual(['node', 'bin/notes.js', 'item#3'])
  for (const command of ['node x.js *', 'node x.js ~/y', 'node x.js {a,b}', 'node x.js [ab]', 'node x.js a\\ b', 'node x.js "a\\"b"', 'node x.js #c', '(node x.js)', 'node x.js "open']) {
    expect(shellWords(command, 'linux'), command).toBeUndefined()
  }
})

test('shellWords follows cmd.exe on Windows: double quotes only, backslashes are paths, expansion refused', () => {
  expect(shellWords('node bin\\notes.js add "Test note"', 'win32')).toEqual(['node', 'bin\\notes.js', 'add', 'Test note'])
  expect(shellWords("node x.js 'a b'", 'win32')).toEqual(['node', 'x.js', "'a", "b'"])
  for (const command of ['node x.js %USERPROFILE%\\.ssh\\id_rsa', 'node x.js !X!', 'node x.js ^& calc', 'node x.js "a\\" b"', '(node x.js)']) {
    expect(shellWords(command, 'win32'), command).toBeUndefined()
  }
})

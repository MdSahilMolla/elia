import { expect, test } from 'bun:test'
import { languageServerFor } from './servers.ts'

test('maps each supported extension to a language server, case-insensitively', () => {
  expect(languageServerFor('src/index.ts')?.command).toBe('typescript-language-server')
  expect(languageServerFor('main.py')?.command).toBe('pyright-langserver')
  expect(languageServerFor('cmd/main.go')?.command).toBe('gopls')
  expect(languageServerFor('src/lib.rs')?.command).toBe('rust-analyzer')
  expect(languageServerFor('src/main/java/App.JAVA')?.command).toBe('jdtls')
})

test('C and C++ extensions all route to clangd with matching language ids', () => {
  expect(languageServerFor('a.c')).toEqual({ languageId: 'c', command: 'clangd', args: ['--background-index'] })
  expect(languageServerFor('a.h')?.languageId).toBe('c')
  for (const path of ['a.cc', 'a.cpp', 'a.cxx', 'a.hpp', 'a.hh', 'a.hxx']) {
    expect(languageServerFor(path)).toEqual({ languageId: 'cpp', command: 'clangd', args: ['--background-index'] })
  }
})

test('an unknown extension has no server', () => {
  expect(languageServerFor('notes.md')).toBeUndefined()
  expect(languageServerFor('Makefile')).toBeUndefined()
})

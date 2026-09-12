import { expect, test } from 'bun:test'
import { symbolIndexSupportedExtensions, symbolLanguageFor, symbolsInFile } from './symbolIndex.ts'

test('symbolLanguageFor recognizes every documented extension and rejects the rest', () => {
  for (const ext of symbolIndexSupportedExtensions()) {
    expect(symbolLanguageFor(`foo${ext}`)).toBeDefined()
  }
  expect(symbolLanguageFor('README.md')).toBeUndefined()
  expect(symbolLanguageFor('data.json')).toBeUndefined()
})

test('symbolsInFile returns undefined for an unsupported extension without ever parsing anything', async () => {
  expect(await symbolsInFile('README.md', '# hello')).toBeUndefined()
})

test('extracts TypeScript function, class, method, and interface definitions with correct names and 1-based positions', async () => {
  const content = ['export function foo(a) { return a }', 'export class Bar {', '  method(x) { return x }', '}', 'interface Baz { x: number }'].join('\n')
  const symbols = await symbolsInFile('sample.ts', content)
  expect(symbols).toBeDefined()
  const byName = Object.fromEntries(symbols!.map((s) => [s.name, s]))
  expect(byName.foo).toMatchObject({ kind: 'function_declaration', line: 1 })
  expect(byName.Bar).toMatchObject({ kind: 'class_declaration', line: 2 })
  expect(byName.method).toMatchObject({ kind: 'method_definition', line: 3 })
  expect(byName.Baz).toMatchObject({ kind: 'interface_declaration', line: 5 })
}, 15_000)

test('extracts Python function and class definitions, including a method nested in a class', async () => {
  const content = 'def foo(a, b):\n    return a + b\n\nclass Bar:\n    def method(self):\n        pass\n'
  const symbols = await symbolsInFile('sample.py', content)
  const names = symbols!.map((s) => s.name)
  expect(names).toContain('foo')
  expect(names).toContain('Bar')
  expect(names).toContain('method')
}, 15_000)

test('extracts Go function, method, and type declarations', async () => {
  const content = 'package main\nfunc Foo(a int) int { return a }\ntype Bar struct { X int }\nfunc (b *Bar) Method() {}'
  const symbols = await symbolsInFile('sample.go', content)
  const names = symbols!.map((s) => s.name)
  expect(names).toContain('Foo')
  expect(names).toContain('Bar')
  expect(names).toContain('Method')
}, 15_000)

test('extracts Rust function and struct items, including a method inside an impl block', async () => {
  const content = 'fn foo(a: i32) -> i32 { a }\nstruct Bar { x: i32 }\nimpl Bar { fn method(&self) -> i32 { self.x } }'
  const symbols = await symbolsInFile('sample.rs', content)
  const names = symbols!.map((s) => s.name)
  expect(names).toContain('foo')
  expect(names).toContain('Bar')
  expect(names).toContain('method')
}, 15_000)

test('extracts C function and struct names through the nested declarator grammar (no direct "name" field)', async () => {
  const content = 'int foo(int a) { return a; }\nstruct Bar { int x; };'
  const symbols = await symbolsInFile('sample.c', content)
  expect(symbols).toEqual([
    { name: 'foo', kind: 'function_definition', line: 1, column: 1 },
    { name: 'Bar', kind: 'struct_specifier', line: 2, column: 1 },
  ])
}, 15_000)

test('extracts Java class and method declarations', async () => {
  const content = 'class Bar {\n  int method(int x) { return x; }\n}'
  const symbols = await symbolsInFile('sample.java', content)
  const names = symbols!.map((s) => s.name)
  expect(names).toContain('Bar')
  expect(names).toContain('method')
}, 15_000)

test('a real elia source file parses cleanly and every symbol name is a plausible identifier', async () => {
  const { readFileSync } = await import('node:fs')
  const content = readFileSync('src/usage.ts', 'utf8')
  const symbols = await symbolsInFile('src/usage.ts', content)
  expect(symbols!.length).toBeGreaterThan(5)
  for (const symbol of symbols!) {
    expect(symbol.name).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]*$/)
    expect(symbol.line).toBeGreaterThan(0)
  }
}, 15_000)

test('a syntactically broken file does not throw — tree-sitter is error-tolerant by design', async () => {
  await expect(symbolsInFile('broken.ts', 'function foo( { this is not valid typescript at all [[[')).resolves.toBeDefined()
}, 15_000)

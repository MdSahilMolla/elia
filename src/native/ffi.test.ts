import { afterEach, expect, test } from 'bun:test'
import {
  langTagFor,
  nativeAvailable,
  nativeParseCheck,
  nativeUnavailableReason,
  nativeVersion,
  resetNativeForTests,
} from './ffi.ts'

const originalEnv = { ...process.env }
afterEach(() => {
  process.env = { ...originalEnv }
  resetNativeForTests()
})

test('langTagFor maps extensions and hints, rejects prose/config', () => {
  expect(langTagFor('src/a.tsx')).toBe(1)
  expect(langTagFor('m.py')).toBe(2)
  expect(langTagFor('lib.rs')).toBe(3)
  expect(langTagFor('main.go')).toBe(4)
  expect(langTagFor('x.h')).toBe(0)
  expect(langTagFor(undefined, 'typescript')).toBe(1)
  expect(langTagFor('weird.name', 'rust')).toBe(3)
  expect(langTagFor('README.md')).toBeUndefined()
  expect(langTagFor('data.json')).toBeUndefined()
  expect(langTagFor(undefined, undefined)).toBeUndefined()
})

test('ELIA_NO_NATIVE disables the fast path with a clear reason', () => {
  process.env.ELIA_NO_NATIVE = '1'
  resetNativeForTests()
  expect(nativeAvailable()).toBe(false)
  expect(nativeUnavailableReason()).toContain('ELIA_NO_NATIVE')
  expect(nativeParseCheck('function f() {\n', { path: 'a.ts' })).toBeUndefined()
})

// Everything below needs the built library.
const withNative = nativeAvailable() ? test : test.skip

withNative('reports a version', () => {
  expect(nativeVersion()).toMatch(/^\d+\.\d+\.\d+/)
})

withNative('clean code returns ok, broken code returns positions', () => {
  expect(nativeParseCheck('const x = [1, 2, 3]\n', { path: 'a.ts' })).toEqual({ ok: true, errors: [] })

  const broken = nativeParseCheck('function f() {\n  return 1\n', { path: 'a.ts' })
  expect(broken?.ok).toBe(false)
  expect(broken?.errors[0]?.message).toContain("unclosed '{'")
  expect(broken?.errors[0]?.line).toBe(1)
})

withNative('per-language lexing: rust raw strings, python triple-quotes', () => {
  expect(nativeParseCheck('let s = r#"a "q" { unbalanced"#; let t = 1;\n', { path: 'x.rs' })?.ok).toBe(true)
  expect(nativeParseCheck('x = """\nunbalanced ( in a docstring\n"""\ny = 1\n', { path: 'y.py' })?.ok).toBe(true)
})

withNative('unknown / unlexable file types return undefined (not a false block)', () => {
  expect(nativeParseCheck('# [half a link](', { path: 'notes.md' })).toBeUndefined()
})

withNative('handles a large input without crashing', () => {
  const big = 'const a = {\n  b: [1, 2, 3],\n}\n'.repeat(20_000)
  expect(nativeParseCheck(big, { path: 'big.ts' })?.ok).toBe(true)
})

withNative('is fast — 2000 checks in well under a second', () => {
  const src = 'export function f(x: number) { return x * 2 }\n'
  const t0 = performance.now()
  for (let i = 0; i < 2000; i++) nativeParseCheck(src, { path: 'a.ts' })
  expect(performance.now() - t0).toBeLessThan(500)
})

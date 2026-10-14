import { expect, test } from 'bun:test'
import { canonicalKey, canonicalizeKeys } from './canonicalize.ts'

test('canonicalKey trims, collapses inner whitespace and lowercases', () => {
  expect(canonicalKey('  Insecure\t Deserialization ')).toBe('insecure deserialization')
  expect(canonicalKey('Buffer Over-Read')).toBe('buffer over-read')
})

test('the two deserialization variants merge into one entry under the canonical key (the D1 fix)', () => {
  const { value, merged, collisions } = canonicalizeKeys({
    'Insecure Deserialization': { count: 4 },
    'Insecure deserialization': { count: 7 },
  })
  expect(collisions).toEqual(['Insecure Deserialization', 'Insecure deserialization'])
  expect(merged).toEqual([['Insecure Deserialization', 'Insecure deserialization']])
  expect(Object.keys(value)).toEqual(['insecure deserialization'])
  expect(value['insecure deserialization']).toEqual({ count: 11 })
})

test('genuinely different keys are left alone', () => {
  const input = { 'SQL Injection': { count: 2 }, 'Buffer Over-Read': { count: 3 } }
  const { value, merged, collisions } = canonicalizeKeys(input)
  expect(merged).toEqual([])
  expect(collisions).toEqual([])
  expect(value).toEqual(input)
})

test('a lone key keeps its own casing when nothing collides with it', () => {
  const { value, collisions } = canonicalizeKeys({ 'Local File Inclusion': { count: 1 } })
  expect(collisions).toEqual([])
  expect(value).toEqual({ 'Local File Inclusion': { count: 1 } })
})

test('colliding arrays union in first-seen order and non-mergeable values keep the first', () => {
  const { value, merged } = canonicalizeKeys({
    'Buffer Over-read': ['ret2libc', 'rop'],
    'Buffer Over-Read': ['rop', 'heap spray'],
    'Local File Inclusion': 'first',
    'Local file inclusion': 'second',
  })
  expect(merged).toHaveLength(2)
  expect(value['buffer over-read']).toEqual(['ret2libc', 'rop', 'heap spray'])
  expect(value['local file inclusion']).toBe('first')
})

test('clean input yields zero collisions', () => {
  expect(canonicalizeKeys({}).collisions).toEqual([])
  expect(canonicalizeKeys({ 'XSS': { count: 1 }, 'Buffer Overflow': { count: 2 } }).collisions).toEqual([])
})

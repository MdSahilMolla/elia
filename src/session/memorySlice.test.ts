import { describe, expect, test } from 'bun:test'
import type { MemorySlice } from './types.ts'
import { forkMemorySlice, promoteLocalLessons } from './memorySlice.ts'

describe('forkMemorySlice', () => {
  test('a root slice has frozen project arrays and fresh local arrays', () => {
    const slice = forkMemorySlice(undefined)
    expect(slice.lessons).toEqual([])
    expect(slice.projectNotes).toEqual([])
    expect(Object.isFrozen(slice.lessons)).toBe(true)
    expect(Object.isFrozen(slice.projectNotes)).toBe(true)
    expect(slice.localLessons).toEqual([])
    expect(slice.localNotes).toEqual([])
  })

  test('deep-copies local arrays and shares frozen project arrays', () => {
    const parent = forkMemorySlice(undefined)
    parent.localLessons.push('parent-local')
    parent.localNotes.push('parent-note')
    const child = forkMemorySlice(parent)
    expect(child.localLessons).toEqual(['parent-local'])
    expect(child.localNotes).toEqual(['parent-note'])
    child.localLessons.push('child-local')
    expect(parent.localLessons).toEqual(['parent-local'])
    expect(child.localLessons).toEqual(['parent-local', 'child-local'])
    expect(child.lessons).toBe(parent.lessons)
    expect(child.projectNotes).toBe(parent.projectNotes)
    expect(Object.isFrozen(child.lessons)).toBe(true)
  })

  test('a mutable parent project array is frozen when forked', () => {
    const parent: MemorySlice = {
      lessons: ['a', 'b'],
      projectNotes: ['note'],
      localLessons: [],
      localNotes: [],
    }
    const child = forkMemorySlice(parent)
    expect(child.lessons).toEqual(['a', 'b'])
    expect(child.projectNotes).toEqual(['note'])
    expect(Object.isFrozen(child.lessons)).toBe(true)
    expect(Object.isFrozen(child.projectNotes)).toBe(true)
    expect(child.localLessons).not.toBe(parent.localLessons)
  })
})

describe('promoteLocalLessons', () => {
  test('moves chosen lessons out of localLessons and returns them in first-chosen order', () => {
    const mem = forkMemorySlice({ lessons: [], projectNotes: [], localLessons: ['dupe', 'first', 'second'], localNotes: [] })
    expect(promoteLocalLessons(mem, ['second', 'dupe'])).toEqual(['second', 'dupe'])
    expect(mem.localLessons).toEqual(['first'])
  })

  test('dedupes repeated chosen lessons', () => {
    const mem = forkMemorySlice({ lessons: [], projectNotes: [], localLessons: ['x', 'y'], localNotes: [] })
    expect(promoteLocalLessons(mem, ['x', 'x', 'y', 'x'])).toEqual(['x', 'y'])
    expect(mem.localLessons).toEqual([])
  })

  test('throws when a chosen lesson is absent from localLessons', () => {
    const mem = forkMemorySlice({ lessons: [], projectNotes: [], localLessons: ['known'], localNotes: [] })
    expect(() => promoteLocalLessons(mem, ['nope'])).toThrow(/absent from localLessons/)
    expect(mem.localLessons).toEqual(['known'])
  })

  test('leaves the slice untouched when validation fails', () => {
    const mem = forkMemorySlice({ lessons: [], projectNotes: [], localLessons: ['kept'], localNotes: [] })
    expect(() => promoteLocalLessons(mem, ['kept', 'missing'])).toThrow()
    expect(mem.localLessons).toEqual(['kept'])
  })
})
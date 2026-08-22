import { expect, test } from 'bun:test'
import { createBlackboard } from './blackboard.ts'

test('a posted note is readable back, with its author', () => {
  const board = createBlackboard()
  board.post('scout#1', 'auth-flow', 'the token refresh lives in src/auth/refresh.ts')

  const notes = board.read()
  expect(notes.length).toBe(1)
  expect(notes[0]!.from).toBe('scout#1')
  expect(notes[0]!.topic).toBe('auth-flow')
})

test('reading by topic filters on a substring match', () => {
  const board = createBlackboard()
  board.post('scout#1', 'auth-flow', 'a')
  board.post('scout#2', 'build-config', 'b')

  expect(board.read('auth').length).toBe(1)
  expect(board.read('config').length).toBe(1)
  expect(board.read('nothing-like-this')).toEqual([])
})

test('topic matching ignores case', () => {
  const board = createBlackboard()
  board.post('scout#1', 'Auth-Flow', 'a')

  expect(board.read('auth').length).toBe(1)
})

test('a blank topic files the note under general rather than an empty string', () => {
  const board = createBlackboard()
  board.post('scout#1', '   ', 'a finding with no topic')

  expect(board.read()[0]!.topic).toBe('general')
})

test('the rendered board is prompt-ready and attributes every note', () => {
  const board = createBlackboard()
  board.post('scout#1', 'gotchas', 'the config is generated — edit the template instead')

  const rendered = board.render()
  expect(rendered).toContain('[gotchas]')
  expect(rendered).toContain('scout#1')
  expect(rendered).toContain('edit the template instead')
})

test('an empty board renders as a statement, not as nothing', () => {
  // This text goes straight into a prompt, so it has to read as a fact.
  expect(createBlackboard().render()).toBe('(the board is empty)')
})

test('a very long note is truncated, since the board is injected into prompts', () => {
  const board = createBlackboard()
  board.post('scout#1', 'dump', 'x'.repeat(5000))

  const note = board.read()[0]!.note
  expect(note.length).toBeLessThan(5000)
  expect(note.endsWith('…')).toBe(true)
})

test('the board caps its size, keeping the most recent notes', () => {
  const board = createBlackboard()
  for (let i = 0; i < 250; i++) board.post('scout#1', 'topic', `note ${i}`)

  expect(board.size()).toBe(200)
  expect(board.read().at(-1)!.note).toBe('note 249')
  expect(board.read().some((note) => note.note === 'note 0')).toBe(false)
})

test('notes are kept in the order they were posted', () => {
  const board = createBlackboard()
  board.post('a', 't', 'first')
  board.post('b', 't', 'second')

  expect(board.read().map((note) => note.note)).toEqual(['first', 'second'])
})

import { describe, expect, test } from 'bun:test'
import { applyKey, filteredCommands, initialState, type PromptState, type SlashCommand } from './slashPrompt.ts'

const commands: SlashCommand[] = [
  { name: '/cyber', description: 'switch to cyber mode' },
  { name: '/normal', description: 'switch back to normal mode' },
  { name: '/rewind', description: 'list rewind points' },
]

function type(state: PromptState, text: string): PromptState {
  let next = state
  for (const ch of text) {
    const result = applyKey(next, ch, {}, commands)
    if (result.type !== 'update') throw new Error('expected update')
    next = result.state
  }
  return next
}

describe('filteredCommands', () => {
  test('empty when the buffer is not a slash or @ command', () => {
    expect(filteredCommands('hello', commands)).toEqual([])
    expect(filteredCommands('', commands)).toEqual([])
  })

  test('supports @skills inline completion', () => {
    const skillCommands = [{ name: '@skills', description: 'choose a skill' }]
    expect(filteredCommands('@sk', skillCommands)).toEqual(skillCommands)
  })

  test('matches by prefix, case-insensitively', () => {
    expect(filteredCommands('/cy', commands).map((c) => c.name)).toEqual(['/cyber'])
    expect(filteredCommands('/CY', commands).map((c) => c.name)).toEqual(['/cyber'])
    expect(filteredCommands('/', commands).map((c) => c.name)).toEqual(['/cyber', '/normal', '/rewind'])
  })
})

describe('typing and editing', () => {
  test('inserts characters at the cursor', () => {
    const state = type(initialState(), '/cy')
    expect(state.buffer).toBe('/cy')
    expect(state.cursor).toBe(3)
  })

  test('backspace removes the character before the cursor', () => {
    let state = type(initialState(), '/cy')
    const result = applyKey(state, undefined, { name: 'backspace' }, commands)
    if (result.type !== 'update') throw new Error('expected update')
    expect(result.state.buffer).toBe('/c')
    expect(result.state.cursor).toBe(2)
  })

  test('left/right move the cursor without changing the buffer', () => {
    let state = type(initialState(), '/cyber')
    let result = applyKey(state, undefined, { name: 'left' }, commands)
    if (result.type !== 'update') throw new Error('expected update')
    state = result.state
    expect(state.cursor).toBe(5)
    expect(state.buffer).toBe('/cyber')

    result = applyKey(state, undefined, { name: 'right' }, commands)
    if (result.type !== 'update') throw new Error('expected update')
    expect(result.state.cursor).toBe(6)
  })

  test('left does not go below zero, right does not exceed buffer length', () => {
    const start = initialState()
    const leftAtStart = applyKey(start, undefined, { name: 'left' }, commands)
    if (leftAtStart.type !== 'update') throw new Error('expected update')
    expect(leftAtStart.state.cursor).toBe(0)

    const buffer = type(initialState(), '/cy')
    const rightAtEnd = applyKey(buffer, undefined, { name: 'right' }, commands)
    if (rightAtEnd.type !== 'update') throw new Error('expected update')
    expect(rightAtEnd.state.cursor).toBe(3)
  })

  test('home and end jump the cursor to the edges', () => {
    const buffer = type(initialState(), '/cyber')
    const home = applyKey(buffer, undefined, { name: 'home' }, commands)
    if (home.type !== 'update') throw new Error('expected update')
    expect(home.state.cursor).toBe(0)

    const end = applyKey(home.state, undefined, { name: 'end' }, commands)
    if (end.type !== 'update') throw new Error('expected update')
    expect(end.state.cursor).toBe(6)
  })
})

describe('menu navigation', () => {
  test('down moves the highlight forward and wraps around', () => {
    let state = type(initialState(), '/')
    for (let i = 0; i < 3; i++) {
      const result = applyKey(state, undefined, { name: 'down' }, commands)
      if (result.type !== 'update') throw new Error('expected update')
      state = result.state
      if (i < 2) expect(state.selectedIndex).toBe(i + 1)
    }
    expect(state.selectedIndex).toBe(0) // wrapped back to the top after 3 downs on 3 items
  })

  test('up wraps backward from the top', () => {
    const state = type(initialState(), '/')
    const result = applyKey(state, undefined, { name: 'up' }, commands)
    if (result.type !== 'update') throw new Error('expected update')
    expect(result.state.selectedIndex).toBe(2)
  })

  test('enter submits the highlighted menu item, not the raw buffer', () => {
    let state = type(initialState(), '/cy')
    const down = applyKey(state, undefined, { name: 'down' }, commands) // only one match, stays put
    if (down.type !== 'update') throw new Error('expected update')
    const result = applyKey(down.state, undefined, { name: 'return' }, commands)
    if (result.type !== 'submit') throw new Error('expected submit')
    expect(result.line).toBe('/cyber')
  })

  test('enter submits an @skills selector', () => {
    const skillCommands = [{ name: '@skills', description: 'choose a skill' }]
    let state = initialState()
    for (const ch of '@sk') {
      const result = applyKey(state, ch, {}, skillCommands)
      if (result.type !== 'update') throw new Error('expected update')
      state = result.state
    }
    const result = applyKey(state, undefined, { name: 'return' }, skillCommands)
    if (result.type !== 'submit') throw new Error('expected submit')
    expect(result.line).toBe('@skills')
  })

  test('tab accepts the highlighted suggestion into the buffer without submitting', () => {
    const state = type(initialState(), '/re')
    const result = applyKey(state, undefined, { name: 'tab' }, commands)
    if (result.type !== 'update') throw new Error('expected update')
    expect(result.state.buffer).toBe('/rewind ')
    expect(result.state.cursor).toBe('/rewind '.length)
  })

  test('enter on free text with no menu match submits the raw buffer verbatim', () => {
    const state = type(initialState(), '/rewind 3')
    const result = applyKey(state, undefined, { name: 'return' }, commands)
    if (result.type !== 'submit') throw new Error('expected submit')
    expect(result.line).toBe('/rewind 3')
  })
})

describe('history', () => {
  test('a submitted line is recorded and reachable via up when the buffer is not a slash command', () => {
    const typed = type(initialState(), 'hello world')
    const submitted = applyKey(typed, undefined, { name: 'return' }, commands)
    if (submitted.type !== 'submit') throw new Error('expected submit')
    expect(submitted.line).toBe('hello world')

    const up = applyKey(submitted.state, undefined, { name: 'up' }, commands)
    if (up.type !== 'update') throw new Error('expected update')
    expect(up.state.buffer).toBe('hello world')
  })

  test('down past the most recent entry restores the in-progress draft', () => {
    const typed = type(initialState(), 'first')
    const submitted = applyKey(typed, undefined, { name: 'return' }, commands)
    if (submitted.type !== 'submit') throw new Error('expected submit')

    const draftState = type(submitted.state, 'draft text')
    const up = applyKey(draftState, undefined, { name: 'up' }, commands)
    if (up.type !== 'update') throw new Error('expected update')
    expect(up.state.buffer).toBe('first')

    const down = applyKey(up.state, undefined, { name: 'down' }, commands)
    if (down.type !== 'update') throw new Error('expected update')
    expect(down.state.buffer).toBe('draft text')
  })
})

describe('control keys', () => {
  test('ctrl+c always interrupts', () => {
    const result = applyKey(initialState(), undefined, { name: 'c', ctrl: true }, commands)
    expect(result.type).toBe('interrupt')
  })

  test('ctrl+d on an empty buffer signals eof', () => {
    const result = applyKey(initialState(), undefined, { name: 'd', ctrl: true }, commands)
    expect(result.type).toBe('eof')
  })

  test('ctrl+d with text in the buffer does nothing', () => {
    const state = type(initialState(), 'x')
    const result = applyKey(state, undefined, { name: 'd', ctrl: true }, commands)
    if (result.type !== 'update') throw new Error('expected update')
    expect(result.state.buffer).toBe('x')
  })
})

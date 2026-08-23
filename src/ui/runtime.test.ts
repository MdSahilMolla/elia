import { describe, expect, test } from 'bun:test'
import { isInteractiveTerminal } from './runtime.ts'

describe('runtime terminal modes', () => {
  test('quiet mode keeps a real TTY interactive', () => {
    expect(isInteractiveTerminal(true, true, 'quiet')).toBe(true)
  })

  test('plain and JSON modes avoid cursor-control interaction', () => {
    expect(isInteractiveTerminal(true, true, 'plain')).toBe(false)
    expect(isInteractiveTerminal(true, true, 'json')).toBe(false)
  })

  test('non-TTY streams never use the raw editor', () => {
    expect(isInteractiveTerminal(false, true, 'normal')).toBe(false)
    expect(isInteractiveTerminal(true, false, 'verbose')).toBe(false)
  })
})

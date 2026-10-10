import { describe, expect, test } from 'bun:test'
import { toolsForRole } from './roles.ts'

describe('toolsForRole', () => {
  test('read-only roles get cyberbrain', () => {
    expect(toolsForRole('scout').some((tool) => tool.name === 'cyberbrain')).toBe(true)
    expect(toolsForRole('critic').some((tool) => tool.name === 'cyberbrain')).toBe(true)
  })

  test('read-only roles stay read-only', () => {
    expect(toolsForRole('scout').some((tool) => tool.name === 'write_file')).toBe(false)
  })

  test('write roles inherit cyberbrain through FULL_TOOLS', () => {
    expect(toolsForRole('builder').some((tool) => tool.name === 'cyberbrain')).toBe(true)
  })
})

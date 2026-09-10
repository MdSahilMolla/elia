import { describe, expect, it } from 'bun:test'
import { causalDebugTool } from './causalDebug.ts'

describe('causalDebugTool', () => {
  it('has the correct tool metadata', () => {
    expect(causalDebugTool.name).toBe('causal_debug')
    expect(causalDebugTool.description).toContain('Trace the causal history')
    expect(causalDebugTool.input_schema.type).toBe('object')
    expect(causalDebugTool.input_schema.required).toContain('file')
  })

  it('rejects empty file path', async () => {
    await expect(causalDebugTool.execute({ file: '' })).rejects.toThrow('file is required')
  })

  it('rejects non-string file path', async () => {
    await expect(causalDebugTool.execute({ file: 123 })).rejects.toThrow('file must be a string')
  })

  it('rejects invalid depth', async () => {
    await expect(causalDebugTool.execute({ file: 'test.ts', depth: -1 })).rejects.toThrow()
  })

  it('has proper input schema properties', () => {
    const props = causalDebugTool.input_schema.properties
    expect(props.file).toBeDefined()
    expect(props.line).toBeDefined()
    expect(props.depth).toBeDefined()
    expect(props.keyword).toBeDefined()
  })

  it('execute returns a string', async () => {
    const result = await causalDebugTool.execute({ file: 'package.json' })
    expect(typeof result).toBe('string')
    expect(result).toContain('Causal Debug Report')
  })
})

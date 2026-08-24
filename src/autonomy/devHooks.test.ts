import { describe, expect, test } from 'bun:test'
import { evaluateToolHooks, loadDevelopmentToolHooks, parseToolHooks, withToolHooks, activeToolHooks } from './devHooks.ts'

describe('development tool hooks', () => {
  test('parses a literal validator and blocks only matching tool input', async () => {
    const hooks = parseToolHooks(JSON.stringify([
      { id: 'prefer-rg', tool: 'run_command', inputContains: 'grep ', message: 'Use rg instead of grep for repository searches.' },
    ]))
    const blocked = await evaluateToolHooks(hooks, { name: 'run_command', input: { command: 'grep -R goal src' } }, '/workspace', 'dev')
    expect(blocked).toEqual({ allowed: false, hookId: 'prefer-rg', message: 'Use rg instead of grep for repository searches.' })

    const allowed = await evaluateToolHooks(hooks, { name: 'run_command', input: { command: 'rg goal src' } }, '/workspace', 'dev')
    expect(allowed).toEqual({ allowed: true })
  })

  test('uses stable input serialization and supports tool-only rules', async () => {
    const hooks = parseToolHooks(JSON.stringify([
      { id: 'no-browser-mutations', tool: 'browser', message: 'Browser mutations require a supervised turn.' },
    ]))
    const result = await evaluateToolHooks(hooks, { name: 'browser', input: { url: 'https://example.test', action: 'click' } }, '/workspace', 'dev')
    expect(result.allowed).toBe(false)
    expect(await evaluateToolHooks(hooks, { name: 'read_file', input: { path: 'README.md' } }, '/workspace', 'dev')).toEqual({ allowed: true })
  })

  test('rejects malformed, duplicate, and oversized configuration', () => {
    expect(() => parseToolHooks('{')).toThrow('expected JSON')
    expect(() => parseToolHooks(JSON.stringify([{ id: 'x', message: 'one', tool: 'a' }, { id: 'x', message: 'two', tool: 'b' }]))).toThrow('duplicated')
    expect(() => parseToolHooks(JSON.stringify([{ id: 'x', message: 'one' }]))).toThrow('needs tool or inputContains')
    expect(() => parseToolHooks(JSON.stringify([{ id: 'x', message: 'one', inputContains: 'a'.repeat(2_001) }]))).toThrow('needs tool or inputContains')
    expect(() => parseToolHooks(JSON.stringify([{ id: 'x', message: 'a'.repeat(501), tool: 'run_command' }]))).toThrow('needs a non-empty message')
  })

  test('loads environment configuration before project configuration', () => {
    const hooks = loadDevelopmentToolHooks('/does/not/exist', {
      ELIA_DEV_HOOKS: JSON.stringify([{ id: 'env', tool: 'run_command', message: 'environment rule' }]),
    })
    expect(hooks).toHaveLength(1)
    expect(hooks[0]?.id).toBe('env')
  })

  test('scopes hooks to the current async context', async () => {
    const hooks = parseToolHooks(JSON.stringify([{ id: 'context', tool: 'run_command', message: 'blocked' }]))
    expect(activeToolHooks()).toEqual([])
    await withToolHooks(hooks, async () => {
      expect(activeToolHooks().map((hook) => hook.id)).toEqual(['context'])
    })
    expect(activeToolHooks()).toEqual([])
  })
})

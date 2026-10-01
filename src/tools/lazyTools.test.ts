import { expect, test } from 'bun:test'
import type { Tool } from './types.ts'
import { createLazyToolSet, lazyToolsEnabled, LOAD_TOOLS_NAME, toolSignature, toolSummary, toolsCuedBy, DEFERRED_DEV_TOOLS } from './lazyTools.ts'

const tool = (name: string, description = `${name} does a thing. More detail here.`): Tool => ({
  name, description, input_schema: { type: 'object', properties: { x: { type: 'string' } } }, async execute() { return name },
})

test('deferred tools are listed in the loader, not sent, until loaded', async () => {
  const loaded = new Set<string>()
  const lazy = createLazyToolSet([tool('read_file'), tool('github'), tool('finance')], new Set(['github', 'finance', 'absent']), loaded)
  expect(lazy.definitions().map((d) => d.name)).toEqual(['read_file', LOAD_TOOLS_NAME])
  expect(lazy.loader!.description).toContain('- github(x?): github does a thing.')
  expect(lazy.loader!.description).toContain('Call any of them directly')
  expect(lazy.loader!.description).not.toContain('absent')

  expect(await lazy.loader!.execute({ names: ['finance'] })).toContain('Loaded: finance')
  expect(lazy.definitions().map((d) => d.name)).toEqual(['read_file', LOAD_TOOLS_NAME, 'finance'])
  // A direct call loads too, appended after earlier loads.
  expect(lazy.markUsed('github')).toBe(true)
  expect(lazy.markUsed('github')).toBe(false)
  expect(lazy.definitions().map((d) => d.name)).toEqual(['read_file', LOAD_TOOLS_NAME, 'finance', 'github'])
})

test('loading answers core and unknown names without failing a useful call', async () => {
  const lazy = createLazyToolSet([tool('read_file'), tool('github')], new Set(['github']), new Set())
  const mixed = await lazy.loader!.execute({ names: ['github', 'read_file', 'nope'] })
  expect(mixed).toContain('Loaded: github')
  expect(mixed).toContain('Already available, no need to load: read_file')
  expect(mixed).toContain('No such tool: nope')
  await expect(lazy.loader!.execute({ names: ['nope'] })).rejects.toThrow('No such tool: nope')
})

test('nothing deferred means every definition and no loader', () => {
  const lazy = createLazyToolSet([tool('read_file'), tool('grep')], new Set(['github']), new Set())
  expect(lazy.loader).toBeUndefined()
  expect(lazy.definitions().map((d) => d.name)).toEqual(['read_file', 'grep'])
})

test('lazy tools are on except for Anthropic, and the env wins', () => {
  expect(lazyToolsEnabled('openai-compatible', {})).toBe(true)
  expect(lazyToolsEnabled('anthropic', {})).toBe(false)
  expect(lazyToolsEnabled('anthropic', { ELIA_LAZY_TOOLS: 'on' })).toBe(true)
  expect(lazyToolsEnabled('openai-compatible', { ELIA_LAZY_TOOLS: 'off' })).toBe(false)
})

test('a summary is the first sentence, capped', () => {
  expect(toolSummary('Do X (e.g. "y").  Then more.')).toBe('Do X (e.g. "y").')
  expect(toolSummary('a'.repeat(200), 20)).toHaveLength(20)
})

test('each mode keeps the specialists its work is built on', async () => {
  const { deferredToolsForMode, DEFERRED_DEV_TOOLS } = await import('./lazyTools.ts')
  expect(deferredToolsForMode('dev')).toEqual(new Set(DEFERRED_DEV_TOOLS))
  expect(deferredToolsForMode('battmann').has('paper')).toBe(false)
  expect(deferredToolsForMode('datascience').has('visualize')).toBe(false)
  expect(deferredToolsForMode('datascience').has('sports')).toBe(true)
  expect(deferredToolsForMode('unknown-mode')).toEqual(new Set(DEFERRED_DEV_TOOLS))
})

test('a signature lists required parameters first, action choices, and cuts long lists', () => {
  const schema = { type: 'object' as const, properties: { limit: {}, action: { enum: ['a', 'b'] }, path: {} }, required: ['action', 'path'] }
  expect(toolSignature(schema)).toBe('(action: a|b, path, limit?)')
  expect(toolSignature(schema, 2)).toBe('(action: a|b, path, …)')
})

test('a summary keeps the sentence that says when to prefer the tool', () => {
  expect(toolSummary('Work with git. Handles branches. Prefer this over raw git in run_command. More.')).toBe('Work with git. Prefer this over raw git in run_command.')
})

test('a summary keeps what the tool must never do', () => {
  expect(toolSummary('Control a browser. Use status first. Never bypass logins.')).toBe('Control a browser. Never bypass logins.')
})

test('a request attaches the tools its words call for, and not for everyday website work', () => {
  expect(toolsCuedBy('open a PR for this and run the migration on postgres', DEFERRED_DEV_TOOLS).sort()).toEqual(['database', 'github'])
  expect(toolsCuedBy('use the arch drift tool', DEFERRED_DEV_TOOLS)).toEqual(['arch_drift'])
  expect(toolsCuedBy('make the index.html page white with a contact form and a pricing table', DEFERRED_DEV_TOOLS)).toEqual([])
  expect(toolsCuedBy('', DEFERRED_DEV_TOOLS)).toEqual([])
})

test('preloading attaches a cued tool before the first call', () => {
  const lazy = createLazyToolSet([tool('read_file'), tool('github'), tool('finance')], new Set(['github', 'finance']), new Set())
  expect(lazy.preload('commit and push it')).toEqual(['github'])
  expect(lazy.definitions().map((d) => d.name)).toEqual(['read_file', LOAD_TOOLS_NAME, 'github'])
  expect(lazy.preload('commit again')).toEqual([])
})

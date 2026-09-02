import { expect, test } from 'bun:test'
import { catalogEntries, catalogEntryToConfig, findCatalogEntry, MCP_CATALOG, searchCatalog } from './catalog.ts'
import { isValidMcpServerName } from './config.ts'

test('every catalog entry has a usable shape and a name elia can key on', () => {
  for (const entry of MCP_CATALOG) {
    expect(isValidMcpServerName(entry.id)).toBe(true)
    if (entry.kind === 'connector') expect(entry.url).toMatch(/^https:\/\//)
    else expect(typeof entry.command).toBe('string')
  }
})

test('searchCatalog filters by kind and matches id/name/description substrings', () => {
  expect(searchCatalog('server', 'github').map((e) => e.id)).toContain('github')
  expect(searchCatalog('connector', 'github').every((e) => e.kind === 'connector')).toBe(true)
  expect(searchCatalog('connector', 'notion').map((e) => e.id)).toEqual(['notion'])
  expect(searchCatalog('server', '').length).toBe(catalogEntries('server').length)
})

test('catalogEntryToConfig turns a stdio entry + env answers into an McpServerConfig', () => {
  const gh = findCatalogEntry('github')!
  const config = catalogEntryToConfig(gh, 'gh', { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_x' })
  expect(config).toEqual({ name: 'gh', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_x' } })
})

test('catalogEntryToConfig omits an empty env / headers map', () => {
  const fetchEntry = findCatalogEntry('fetch')!
  expect(catalogEntryToConfig(fetchEntry, 'fetch', {}).env).toBeUndefined()

  const deepwiki = findCatalogEntry('deepwiki')!
  const connector = catalogEntryToConfig(deepwiki, 'deepwiki', {})
  expect(connector).toEqual({ name: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp', transport: undefined, headers: undefined })
})

test('catalogEntryToConfig carries an sse transport and a supplied auth header', () => {
  const linear = findCatalogEntry('linear')!
  const config = catalogEntryToConfig(linear, 'linear', { Authorization: 'Bearer lin_api_x' })
  expect(config.transport).toBe('sse')
  expect(config.headers).toEqual({ Authorization: 'Bearer lin_api_x' })
})

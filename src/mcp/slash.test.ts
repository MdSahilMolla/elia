import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mcpAddOutcome, mcpManageOutcome } from './slash.ts'
import { resetMcpLoadStateForTests } from './registry.ts'
import type { SlashOutcome, SlashPickerRequest, SlashPromptRequest } from '../ui/app/index.tsx'

// Keep the browse flow off the network — the curated catalog is what we assert on.
process.env.ELIA_NO_MCP_REGISTRY = '1'
// Don't dial real hosted connectors from a unit test; assert on what got written.
process.env.ELIA_MCP_NO_AUTOCONNECT = '1'

let cwd = process.cwd()
const realCwd = process.cwd()

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'elia-mcp-slash-'))
  process.chdir(cwd)
  // The "user" scope must never resolve to the real ~/.elia/mcp.json in a test.
  process.env.ELIA_MCP_USER_CONFIG = join(cwd, 'user-mcp.json')
})

afterEach(async () => {
  process.chdir(realCwd)
  delete process.env.ELIA_MCP_USER_CONFIG
  await resetMcpLoadStateForTests()
})

function picker(outcome: SlashOutcome | string | void): SlashPickerRequest {
  if (!outcome || typeof outcome === 'string' || !outcome.picker) throw new Error(`expected a picker, got ${JSON.stringify(outcome)}`)
  return outcome.picker
}
function prompt(outcome: SlashOutcome | string | void): SlashPromptRequest {
  if (!outcome || typeof outcome === 'string' || !outcome.prompt) throw new Error(`expected a prompt, got ${JSON.stringify(outcome)}`)
  return outcome.prompt
}

test('mcpAddOutcome(server) offers the custom option plus curated servers', async () => {
  const p = picker(await mcpAddOutcome('server'))
  expect(p.options[0]!.value).toBe('__custom__')
  expect(p.options.map((o) => o.value)).toContain('github')
})

test('adding a catalog connector with no auth writes .elia/mcp.json and reports the connect attempt', async () => {
  const browse = picker(await mcpAddOutcome('connector'))
  const scope = picker(await browse.onSelect('deepwiki'))
  expect(scope.title).toContain('deepwiki')

  const message = await scope.onSelect('project')
  expect(typeof message).toBe('string')
  const written = JSON.parse(readFileSync(join(cwd, '.elia', 'mcp.json'), 'utf8'))
  expect(written.mcpServers.deepwiki).toEqual({ url: 'https://mcp.deepwiki.com/mcp' })
})

test('a catalog connector with auth: pick "enter", supply the token, then scope', async () => {
  const browse = picker(await mcpAddOutcome('connector'))
  const authPicker = picker(await browse.onSelect('notion'))
  expect(authPicker.title).toContain('Authorization')
  const valueP = prompt(await authPicker.onSelect('enter'))
  const scope = picker(await valueP.onSubmit('Bearer ntn_abc'))
  await scope.onSelect('project')
  const written = JSON.parse(readFileSync(join(cwd, '.elia', 'mcp.json'), 'utf8'))
  expect(written.mcpServers.notion).toEqual({ url: 'https://mcp.notion.com/mcp', headers: { Authorization: 'Bearer ntn_abc' } })
})

test('a catalog connector with auth: "skip" writes a bare url entry', async () => {
  const browse = picker(await mcpAddOutcome('connector'))
  const authPicker = picker(await browse.onSelect('huggingface'))
  const scope = picker(await authPicker.onSelect('skip'))
  await scope.onSelect('project')
  const written = JSON.parse(readFileSync(join(cwd, '.elia', 'mcp.json'), 'utf8'))
  expect(written.mcpServers.huggingface).toEqual({ url: 'https://huggingface.co/mcp' })
})

test('a catalog server that needs a secret prompts for it before the scope picker', async () => {
  const browse = picker(await mcpAddOutcome('server'))
  const secretPrompt = prompt(await browse.onSelect('github'))
  expect(secretPrompt.label).toContain('GITHUB_PERSONAL_ACCESS_TOKEN')

  const scope = picker(await secretPrompt.onSubmit('ghp_test'))
  await scope.onSelect('user')

  const userFile = JSON.parse(readFileSync(join(cwd, 'user-mcp.json'), 'utf8'))
  expect(userFile.mcpServers.github.env).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_test' })
  expect(() => readFileSync(join(cwd, '.elia', 'mcp.json'), 'utf8')).toThrow()
})

test('custom connector flow: name -> url -> auth picker -> value -> scope', async () => {
  const browse = picker(await mcpAddOutcome('connector'))
  const nameP = prompt(await browse.onSelect('__custom__'))
  const urlP = prompt(await nameP.onSubmit('mycon'))
  const authPicker = picker(await urlP.onSubmit('https://mcp.example.com/mcp'))
  const valueP = prompt(await authPicker.onSelect('auth'))
  const scope = picker(await valueP.onSubmit('Bearer tok'))
  await scope.onSelect('project')

  const written = JSON.parse(readFileSync(join(cwd, '.elia', 'mcp.json'), 'utf8'))
  expect(written.mcpServers.mycon).toEqual({ url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer tok' } })
})

test('custom connector "no authentication" path writes a bare url entry', async () => {
  const browse = picker(await mcpAddOutcome('connector'))
  const nameP = prompt(await browse.onSelect('__custom__'))
  const urlP = prompt(await nameP.onSubmit('bare'))
  const authPicker = picker(await urlP.onSubmit('https://mcp.example.com/mcp'))
  const scope = picker(await authPicker.onSelect('none'))
  await scope.onSelect('project')
  const written = JSON.parse(readFileSync(join(cwd, '.elia', 'mcp.json'), 'utf8'))
  expect(written.mcpServers.bare).toEqual({ url: 'https://mcp.example.com/mcp' })
})

test('custom connector rejects a non-url and a malformed header', async () => {
  const browse = picker(await mcpAddOutcome('connector'))
  const nameP = prompt(await browse.onSelect('__custom__'))
  const badUrl = await (prompt(await nameP.onSubmit('c2'))).onSubmit('not-a-url')
  expect(badUrl).toMatchObject({ text: expect.stringContaining('not an http') })
})

test('mcpManageOutcome lists a configured connector and can remove it', async () => {
  // Seed a disabled connector so loadMcpTools does not dial a real host during the test.
  const { upsertMcpServer } = await import('./config.ts')
  upsertMcpServer('project', { name: 'context7', url: 'https://mcp.context7.com/mcp', disabled: true }, cwd)

  const { loadMcpTools } = await import('./registry.ts')
  await loadMcpTools(cwd)

  const manage = picker(await mcpManageOutcome('', true))
  const row = manage.options.find((o) => o.value === 'srv:context7')
  expect(row).toBeDefined()

  const actions = picker(await manage.onSelect('srv:context7'))
  const removeConfirm = picker(await actions.onSelect('remove'))
  const result = await removeConfirm.onSelect('yes')
  expect(result).toMatch(/Removed "context7"/)
  const written = JSON.parse(readFileSync(join(cwd, '.elia', 'mcp.json'), 'utf8'))
  expect(written.mcpServers.context7).toBeUndefined()
})

test('/mcp reload with nothing configured returns a friendly line', async () => {
  const outcome = await mcpManageOutcome('reload', false)
  expect(outcome.text).toContain('No MCP servers configured')
})

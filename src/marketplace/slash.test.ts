import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { marketplaceOutcome } from './slash.ts'
import type { SlashOutcome, SlashPickerRequest } from '../ui/app/index.tsx'

process.env.ELIA_NO_MCP_REGISTRY = '1'

let cwd = process.cwd()
const realCwd = process.cwd()

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'elia-mkt-slash-'))
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ dependencies: { react: '^19' }, devDependencies: { typescript: '5' } }))
  process.chdir(cwd)
})
afterEach(() => process.chdir(realCwd))

function picker(outcome: SlashOutcome | string | void): SlashPickerRequest {
  if (!outcome || typeof outcome === 'string' || !outcome.picker) throw new Error(`expected a picker, got ${JSON.stringify(outcome)}`)
  return outcome.picker
}

test('the top menu lists all five sources', async () => {
  const p = picker(await marketplaceOutcome())
  expect(p.options.map((o) => o.value)).toEqual(['npm', 'pip', 'skill', 'mcp', 'connector'])
})

test('npm → sub-menu has Installed, Suggested and Search', async () => {
  const sub = picker(await marketplaceOutcome('npm'))
  const labels = sub.options.map((o) => o.value)
  expect(labels).toEqual(['installed', 'suggested', 'search'])
  expect(sub.options[0]!.label).toMatch(/Installed \(\d+\)/)
})

test('npm → Installed lists the project deps and offers a remove command', async () => {
  const sub = picker(await marketplaceOutcome('npm'))
  const installed = picker(await sub.onSelect('installed'))
  expect(installed.options.map((o) => o.label).sort()).toEqual(['react', 'typescript'])

  const removal = await installed.onSelect('npm:react')
  expect(removal).toMatchObject({ runCommand: { command: expect.stringContaining('react') } })
})

test('npm → Suggested hides installed packages and installs the chosen one', async () => {
  const sub = picker(await marketplaceOutcome('npm'))
  const suggested = picker(await sub.onSelect('suggested'))
  const names = suggested.options.map((o) => o.value)
  expect(names).not.toContain('typescript') // already a devDependency
  expect(names).toContain('vitest')

  const install = await suggested.onSelect('vitest')
  expect(install).toMatchObject({ runCommand: { command: expect.stringContaining('vitest') } })
})

test('skills → Suggested reports synthesizable routines (or says there are none)', async () => {
  const sub = picker(await marketplaceOutcome('skill'))
  expect(sub.options.map((o) => o.value)).toEqual(['installed', 'suggested'])
  const suggested = await sub.onSelect('suggested')
  expect(typeof suggested === 'string' || (suggested && 'text' in suggested)).toBe(true)
})

test('mcp → sub-menu routes to configured / catalog / custom', async () => {
  const sub = picker(await marketplaceOutcome('mcp'))
  expect(sub.options.map((o) => o.value)).toEqual(['installed', 'suggested', 'custom'])

  const configured = picker(await sub.onSelect('installed'))
  expect(configured.title).toMatch(/MCP servers/)

  const suggested = picker(await sub.onSelect('suggested'))
  expect(suggested.options.map((o) => o.value)).toContain('github')

  const custom = await sub.onSelect('custom')
  expect(custom).toMatchObject({ prompt: { label: expect.stringContaining('Name for this server') } })
})

test('connector → Suggested shows connector catalog entries, not stdio servers', async () => {
  const sub = picker(await marketplaceOutcome('connector'))
  const suggested = picker(await sub.onSelect('suggested'))
  const values = suggested.options.map((o) => o.value)
  expect(values).toContain('deepwiki')
  expect(values).not.toContain('github') // that's a stdio server, not a connector
})

test('npm → Search opens a free-text prompt', async () => {
  const sub = picker(await marketplaceOutcome('npm'))
  const search = await sub.onSelect('search')
  expect(search).toMatchObject({ prompt: { label: expect.stringContaining('Search npm') } })
})

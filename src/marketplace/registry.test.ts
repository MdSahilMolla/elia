import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installCommand, listInstalled, parsePipList, removeCommand, suggestedInstalls } from './registry.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-mkt-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('installCommand picks the right manager and rejects unsafe names', () => {
  writeFileSync(join(dir, 'bun.lock'), '')
  expect(installCommand('npm', 'react', dir)).toBe('bun add react')
  expect(installCommand('pip', 'requests', dir)).toBe('pip install requests')
  expect(installCommand('bun', '@scope/pkg', dir)).toBe('bun add @scope/pkg')
  expect(() => installCommand('npm', 'react; rm -rf /', dir)).toThrow('unsafe package name')
})

test('removeCommand mirrors installCommand', () => {
  writeFileSync(join(dir, 'package-lock.json'), '{}')
  expect(removeCommand({ name: 'lodash', kind: 'npm', detail: '' }, dir)).toBe('npm uninstall lodash')
  expect(removeCommand({ name: 'flask', kind: 'pip', detail: '' }, dir)).toBe('pip uninstall -y flask')
  expect(removeCommand({ name: 'mine', kind: 'skill', detail: '', file: '/x/mine.skill.ts' }, dir)).toBe('')
})

test('listInstalled reports package.json deps and skills', () => {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '^19' }, devDependencies: { typescript: '7' } }))
  writeFileSync(join(dir, 'package-lock.json'), '{}')
  mkdirSync(join(dir, '.elia', 'skills'), { recursive: true })
  writeFileSync(join(dir, '.elia', 'skills', 'greet.skill.ts'), 'export default {}')
  const cwd = process.cwd()
  process.chdir(dir)
  try {
    const items = listInstalled(dir)
    expect(items.map((i) => i.name).sort()).toEqual(['greet', 'react', 'typescript'])
    expect(items.find((i) => i.name === 'greet')?.kind).toBe('skill')
  } finally {
    process.chdir(cwd)
  }
})

test('suggestedInstalls hides packages the project already has', () => {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { typescript: '5', prettier: '3' } }))
  const names = suggestedInstalls('npm', dir).map((s) => s.name)
  expect(names).not.toContain('typescript')
  expect(names).not.toContain('prettier')
  expect(names).toContain('vitest')
})

test('suggestedInstalls maps bun to the npm shortlist and pip to its own', () => {
  expect(suggestedInstalls('bun', dir).some((s) => s.name === 'zod')).toBe(true)
  expect(suggestedInstalls('pip', dir).some((s) => s.name === 'pytest')).toBe(true)
  expect(suggestedInstalls('pip', dir).some((s) => s.name === 'vitest')).toBe(false)
})

test('parsePipList turns pip json into rows', () => {
  const rows = parsePipList(JSON.stringify([{ name: 'requests', version: '2.31.0' }]))
  expect(rows).toEqual([{ name: 'requests', kind: 'pip', detail: 'pip · 2.31.0' }])
  expect(parsePipList('not json')).toEqual([])
})

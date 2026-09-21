import { expect, test } from 'bun:test'
import { classifySkillSource, recordSkillCapability, resetSkillCapabilities, skillCapability } from './capabilities.ts'

// A skill is an ordinary module, so the governor's unknown-tool fallthrough
// treated every one of them as critical: an unattended run refused a read-only
// scanner outright, and a supervised one asked on every call. These pin the line
// that lets an inert skill through — and, more importantly, where it does not.

test('a skill that only reads is the one thing allowed through unasked', () => {
  const source = [
    "import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'",
    "import { join, relative } from 'node:path'",
    'const text = readFileSync(file, "utf8")',
    'for (const entry of readdirSync(dir)) statSync(join(dir, entry))',
  ].join('\n')
  expect(classifySkillSource(source)).toEqual({ capability: 'read-only' })
})

test('anything that can reach outside the process is effectful, by what the source says', () => {
  const cases: Array<[string, string]> = [
    ["import { spawnSync } from 'node:child_process'", 'imports child_process'],
    ["import cp from 'child_process'", 'imports child_process'],
    ['Bun.spawn(["ls"])', 'runs a shell through Bun'],
    ["import net from 'node:net'", 'opens the network'],
    ['const res = await fetch("https://example.com")', 'makes network requests'],
    ['const ws = new WebSocket("wss://x")', 'opens a socket'],
    ["import { writeFileSync } from 'node:fs'\nwriteFileSync(p, s)", 'writes to the filesystem'],
    ['await Bun.write(path, body)', 'writes to the filesystem'],
    ['unlinkSync(path)', 'writes to the filesystem'],
    ['const f = new Function("return 1")', 'builds code at runtime'],
    ['eval(payload)', 'evaluates code'],
    ["import vm from 'node:vm'", 'evaluates code'],
    ['const mod = await import(chosenAtRuntime)', 'imports something chosen at runtime'],
    ['const mod = require(chosenAtRuntime)', 'requires something chosen at runtime'],
  ]
  for (const [source, why] of cases) {
    expect({ source, ...classifySkillSource(source) }).toEqual({ source, capability: 'effectful', why })
  }
})

test('a static import of a real module is still readable, so it stays read-only', () => {
  // The dynamic-import rule must not catch the ordinary spelling.
  expect(classifySkillSource("const mod = await import('node:path')").capability).toBe('read-only')
})

test('source it could not read is effectful — the scan fails closed', () => {
  expect(classifySkillSource('')).toEqual({ capability: 'effectful', why: 'empty or unreadable source' })
  expect(classifySkillSource('   \n  ')).toEqual({ capability: 'effectful', why: 'empty or unreadable source' })
})

test('a name that was never loaded has no capability at all, which is not permission', () => {
  resetSkillCapabilities()
  expect(skillCapability('never_loaded')).toBeUndefined()
  recordSkillCapability('a_real_skill', 'read-only')
  expect(skillCapability('a_real_skill')).toBe('read-only')
  resetSkillCapabilities()
  expect(skillCapability('a_real_skill')).toBeUndefined()
})

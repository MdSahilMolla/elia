import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  auditDeliverable,
  filesFromGitStatus,
  hardcodedSecrets,
  hygieneVerdict,
  importSpecifiers,
  scanProjectFiles,
  scratchArtifacts,
  stripComments,
  undeclaredDependencies,
} from './hygiene.ts'

let dir: string

function write(relative: string, content: string): string {
  const path = join(dir, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  return relative
}

function manifest(deps: Record<string, string>, dev: Record<string, string> = {}, at = 'package.json') {
  write(at, JSON.stringify({ name: 'demo', dependencies: deps, devDependencies: dev }))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-hygiene-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// --- import scanning ---

test('importSpecifiers finds static, type-only, re-exported, required and dynamic imports', () => {
  const found = importSpecifiers(
    [
      "import express from 'express'",
      "import type { Sql } from 'postgres'",
      "import { a as b, c } from '@scope/pkg/sub'",
      "export { x } from 'reexported'",
      "const y = require('required')",
      "const z = await import('dynamic')",
      "import './side-effect.ts'",
    ].join('\n'),
  )
  expect(found.sort()).toEqual(
    ['./side-effect.ts', '@scope/pkg/sub', 'dynamic', 'express', 'postgres', 'reexported', 'required'].sort(),
  )
})

test('stripComments removes commented-out imports but leaves URLs in strings alone', () => {
  const source = stripComments(["// import ghost from 'ghost'", '/* import blocked from "blocked" */', "const u = 'https://example.com/x'"].join('\n'))
  expect(importSpecifiers(source)).toEqual([])
  expect(source).toContain('https://example.com/x')
})

// --- undeclared dependencies ---

test('an imported package that is not in package.json is reported, with the file that imports it', () => {
  manifest({ express: '^4' })
  const file = write('src/server.ts', "import express from 'express'\nimport bcrypt from 'bcryptjs'\n")

  expect(undeclaredDependencies({ cwd: dir, addedFiles: [file], changedFiles: [file] })).toEqual([
    { name: 'bcryptjs', files: ['src/server.ts'] },
  ])
})

test('builtins, runtime schemes, relative paths and tsconfig aliases are not dependencies', () => {
  manifest({})
  write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '~/*': ['./src/*'] } } }))
  const file = write(
    'src/db.ts',
    [
      "import { readFileSync } from 'node:fs'",
      "import { Database } from 'bun:sqlite'",
      "import { join } from 'path'",
      "import { helper } from './helper.ts'",
      "import { thing } from '~/thing.ts'",
      "import config from '#config'",
    ].join('\n'),
  )

  expect(undeclaredDependencies({ cwd: dir, addedFiles: [], changedFiles: [file] })).toEqual([])
})

test('a subpackage that declares its own dependency is not reported against the root manifest', () => {
  manifest({})
  manifest({ zod: '^3' }, {}, 'packages/api/package.json')
  const file = write('packages/api/src/index.ts', "import { z } from 'zod'\n")

  expect(undeclaredDependencies({ cwd: dir, addedFiles: [], changedFiles: [file] })).toEqual([])
})

test('nothing is claimed when there is no manifest above the file at all', () => {
  const file = write('src/index.ts', "import express from 'express'\n")
  expect(undeclaredDependencies({ cwd: dir, addedFiles: [], changedFiles: [file] })).toEqual([])
})

test('an unparsable manifest proves nothing rather than reporting every import', () => {
  write('package.json', '{ this is not json')
  const file = write('src/index.ts', "import express from 'express'\n")
  expect(undeclaredDependencies({ cwd: dir, addedFiles: [], changedFiles: [file] })).toEqual([])
})

test('a devDependency counts as declared', () => {
  manifest({}, { vitest: '^1' })
  const file = write('src/x.test.ts', "import { test } from 'vitest'\n")
  expect(undeclaredDependencies({ cwd: dir, addedFiles: [], changedFiles: [file] })).toEqual([])
})

// --- scratch artifacts ---

test('unreferenced scratch files created by the run are reported', () => {
  manifest({})
  const files = [
    write('debug_test.js', 'console.log(1)'),
    write('tmp_check.ts', 'export const x = 1'),
    write('manual_test.js', 'console.log(2)'),
    write('server.log', 'listening'),
    write('src/index.ts', 'export const main = 1'),
  ]

  expect(scratchArtifacts({ cwd: dir, addedFiles: files, changedFiles: files })).toEqual([
    'debug_test.js',
    'manual_test.js',
    'server.log',
    'tmp_check.ts',
  ])
})

test('a scratch-looking file that the deliverable actually imports is left alone', () => {
  manifest({})
  const scratch = write('src/debug.ts', 'export const trace = () => {}')
  const used = write('src/index.ts', "import { trace } from './debug.ts'\n")

  expect(scratchArtifacts({ cwd: dir, addedFiles: [scratch], changedFiles: [scratch, used] })).toEqual([])
})

test('ordinary names that merely start with an ambiguous word are not scratch', () => {
  manifest({})
  const files = [write('run.ts', 'export const run = 1'), write('tmpdir.ts', 'export const d = 1'), write('manual.md', '# manual')]

  expect(scratchArtifacts({ cwd: dir, addedFiles: files, changedFiles: files })).toEqual([])
})

test('a scratch-looking file that was already in the repo is not this run to clean up', () => {
  manifest({})
  const existing = write('debug_test.js', 'console.log(1)')
  expect(scratchArtifacts({ cwd: dir, addedFiles: [], changedFiles: [existing] })).toEqual([])
})

// --- combined verdict ---

test('the audit votes revise, with the undeclared dependency as a blocker', () => {
  manifest({})
  const source = write('src/server.ts', "import jwt from 'jsonwebtoken'\n")
  const junk = write('tmp_scratch.ts', 'export const x = 1')

  const verdict = hygieneVerdict({ cwd: dir, addedFiles: [source, junk], changedFiles: [source, junk] })
  expect(verdict.verdict).toBe('revise')
  expect(verdict.issues.find((issue) => issue.detail.includes('jsonwebtoken'))?.severity).toBe('blocker')
  expect(verdict.issues.find((issue) => issue.detail.includes('tmp_scratch.ts'))?.severity).toBe('major')
})

test('a clean deliverable approves', () => {
  manifest({ express: '^4' })
  const file = write('src/server.ts', "import express from 'express'\n")

  const verdict = hygieneVerdict({ cwd: dir, addedFiles: [file], changedFiles: [file] })
  expect(verdict.verdict).toBe('approve')
  expect(auditDeliverable({ cwd: dir, addedFiles: [file], changedFiles: [file] })).toEqual([])
})

// --- file discovery ---

test('git status porcelain splits into added and changed, ignoring deletions', () => {
  const { added, changed } = filesFromGitStatus(['?? src/new.ts', ' M src/old.ts', 'A  src/staged.ts', ' D src/gone.ts', 'R  a.ts -> b.ts'].join('\n'))
  expect(added).toEqual(['src/new.ts', 'src/staged.ts', 'b.ts'])
  expect(changed).toEqual(['src/new.ts', 'src/old.ts', 'src/staged.ts', 'b.ts'])
})

test('scanning a non-git project finds its sources and skips dependency and tooling directories', () => {
  write('src/index.ts', 'export const x = 1')
  write('node_modules/pkg/index.js', 'module.exports = {}')
  write('.git/config', '[core]')
  write('dist/bundle.js', 'x')

  expect(scanProjectFiles(dir)).toEqual(['src/index.ts'])
})

test('scanning with modifiedSince only reports files touched during the run, so a pre-existing file is never blamed on it', () => {
  write('old_debug.log', 'from last week')
  const cutoff = Date.now() + 5
  Bun.sleepSync(20)
  write('debug_test.js', 'console.log(1)')

  expect(scanProjectFiles(dir, { modifiedSince: cutoff })).toEqual(['debug_test.js'])
})

test('code samples held in string literals are not imports of the file that holds them', () => {
  // Caught by running this check against elia's own repo: a test that builds
  // fake source as strings was reported as importing every package it names.
  const fixture = [
    'const samples = [',
    '  "import express from \'express\'",',
    '  "export { x } from \'reexported\'",',
    '  "const y = require(\'required\')",',
    '  "const z = await import(\'dynamic\')",',
    '].join("\n")',
    "import { real } from 'really-imported'",
  ].join('\n')

  expect(importSpecifiers(fixture)).toEqual(['really-imported'])
})

test('an import indented inside a block still counts', () => {
  expect(importSpecifiers("if (x) {\n  const mod = require('lodash')\n}\n")).toEqual(['lodash'])
})

// --- hardcoded secrets ---

test('the fallback-secret pattern that actually shipped is caught', () => {
  manifest({})
  // Two runs shipped exactly this, and one declared the intent in its own plan.
  const file = write('src/auth.ts', ['const JWT_SECRET = process.env.JWT_SECRET || "supersecret"', 'export const sign = () => JWT_SECRET'].join('\n'))

  const found = hardcodedSecrets({ cwd: dir, addedFiles: [file], changedFiles: [file] })
  expect(found).toHaveLength(1)
  expect(found[0]!.file).toBe('src/auth.ts')
  expect(found[0]!.line).toBe(1)
  expect(found[0]!.description).toContain('JWT_SECRET')
})

test('a secret-shaped name assigned a literal is caught, and the finding never quotes the value', () => {
  manifest({})
  const file = write('src/config.ts', 'export const apiKey = "abc123def456ghi"')

  const found = hardcodedSecrets({ cwd: dir, addedFiles: [file], changedFiles: [file] })
  expect(found).toHaveLength(1)
  // A receipt is written to disk and printed to a terminal; repeating the value spreads it.
  expect(JSON.stringify(found)).not.toContain('abc123def456ghi')
})

test('issuer-shaped credentials are caught by their format', () => {
  manifest({})
  const file = write('src/keys.ts', ['const a = "AKIAQ7RZ4NPLMWXC2VBD"', 'const b = "ghp_' + 'A'.repeat(36) + '"'].join('\n')) // pragma: allowlist secret

  const descriptions = hardcodedSecrets({ cwd: dir, addedFiles: [file], changedFiles: [file] }).map((entry) => entry.description)
  expect(descriptions.some((text) => text.includes('AWS'))).toBe(true)
  expect(descriptions.some((text) => text.includes('GitHub'))).toBe(true)
})

test('reading a secret from the environment — the correct pattern — is not flagged', () => {
  manifest({})
  const file = write(
    'src/good.ts',
    [
      'const JWT_SECRET = process.env.JWT_SECRET',
      'if (!JWT_SECRET) throw new Error("JWT_SECRET is required")',
      'const dbPassword = process.env.DB_PASSWORD ?? ""',
    ].join('\n'),
  )

  expect(hardcodedSecrets({ cwd: dir, addedFiles: [file], changedFiles: [file] })).toEqual([])
})

test('placeholders in examples and templates are not secrets', () => {
  manifest({})
  const file = write(
    'src/example.ts',
    [
      'const apiKey = "your-api-key-here"',
      'const token = "<REPLACE_ME>"',
      'const secret = "changeme"',
      'const password = "xxxxxxxx"',
      'const clientSecret = process.env.CLIENT_SECRET || "example-secret"',
    ].join('\n'),
  )

  expect(hardcodedSecrets({ cwd: dir, addedFiles: [file], changedFiles: [file] })).toEqual([])
})

test('a hardcoded secret blocks the run and says the credential must be rotated', () => {
  manifest({})
  const file = write('src/auth.ts', 'const JWT_SECRET = process.env.JWT_SECRET || "supersecret"')

  const verdict = hygieneVerdict({ cwd: dir, addedFiles: [file], changedFiles: [file] })
  expect(verdict.verdict).toBe('revise')
  expect(verdict.issues[0]!.severity).toBe('blocker')
  expect(verdict.issues[0]!.detail).toContain('rotated')
})

test('a name that merely contains a secret word is not a credential', () => {
  manifest({})
  const file = write('src/text.ts', ['const tokenizer = "gpt-4-tokenizer"', 'const tokenizerPath = "./models/tokenizer.json"'].join('\n'))

  expect(hardcodedSecrets({ cwd: dir, addedFiles: [file], changedFiles: [file] })).toEqual([])
})

test('a field holding the NAME of an environment variable is not a secret', () => {
  manifest({})
  // elia's own provider registry does this nine times; the first version of the
  // scan reported every one of them.
  const file = write('src/registry.ts', ['export const providers = [', "  { id: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' },", "  { id: 'openai', API_KEY_ENV: 'OPENAI_API_KEY' },", ']'].join('\n'))

  expect(hardcodedSecrets({ cwd: dir, addedFiles: [file], changedFiles: [file] })).toEqual([])
})

test('writing into process.env is test setup, not a hardcoded secret', () => {
  manifest({})
  const file = write('src/setup.ts', ["process.env.GEMINI_API_KEY = 'test-key-value'", "process.env.EXA_API_KEY = 'another-test-value'"].join('\n'))

  expect(hardcodedSecrets({ cwd: dir, addedFiles: [file], changedFiles: [file] })).toEqual([])
})

test('test files are scanned for real issuer-format keys but not for secret-shaped names', () => {
  manifest({})
  const fixtures = write('src/thing.test.ts', ['const JWT_SECRET = process.env.JWT_SECRET || "fixture-secret"', 'const password = "hunter2hunter2"'].join('\n'))
  const leak = write('src/other.test.ts', 'const key = "AKIAQ7RZ4NPLMWXC2VBD"') // pragma: allowlist secret

  expect(hardcodedSecrets({ cwd: dir, addedFiles: [], changedFiles: [fixtures] })).toEqual([])
  expect(hardcodedSecrets({ cwd: dir, addedFiles: [], changedFiles: [leak] })).toHaveLength(1)
})

test("an issuer's own documented example key is documentation, not a credential", () => {
  manifest({})
  const file = write('src/docs.ts', 'const example = "AKIAIOSFODNN7EXAMPLE"') // pragma: allowlist secret

  expect(hardcodedSecrets({ cwd: dir, addedFiles: [], changedFiles: [file] })).toEqual([])
})

test('a file whose directory announces it is throwaway is scratch, whatever it is called', () => {
  // A real run left tmp/check.js behind; "check.js" looks like nothing until you
  // notice where it lives.
  manifest({})
  const files = [write('tmp/check.js', 'console.log(1)'), write('src/check.ts', 'export const check = 1')]

  expect(scratchArtifacts({ cwd: dir, addedFiles: files, changedFiles: files })).toEqual(['tmp/check.js'])
})

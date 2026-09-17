import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fastenedStringWidthSource, fastRenderEnabled, productionEntrySource } from './fastRender.ts'

const ENTRY = (name: string) => `'use strict';

if (process.env.NODE_ENV === 'production') {
  module.exports = require('./cjs/${name}.production.js');
} else {
  module.exports = require('./cjs/${name}.development.js');
}
`

test('string-width keeps its own measurement where Bun would differ, and uses Bun everywhere else', () => {
  const source = 'import x from "y";\nexport default function stringWidth(input, options = {}) {\n  return 42;\n}\n'
  const out = fastenedStringWidthSource(source)
  expect(out).toContain('function packageStringWidth(input, options = {})')
  expect(out).toContain('export default function stringWidth(input, options = {})')
  expect(out).toContain('Bun.stringWidth(input')
  expect(out.match(/export default/g)).toHaveLength(1)
  // A package that no longer has the shape this expects is left alone.
  expect(fastenedStringWidthSource('export default (s) => s.length')).toBe('export default (s) => s.length')
})

test('a React entry file becomes a re-export of its production build, and anything else is left alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-fast-render-'))
  try {
    const entry = join(dir, 'constants.js')
    const production = join(dir, 'cjs', 'thing-constants.production.js')
    const load = () => ({ NoEventPriority: 0, DefaultEventPriority: 32, default: 'ignored', 'not-an-identifier': 1 })
    // The production build is not there: nothing changes.
    expect(productionEntrySource(entry, ENTRY('thing-constants'), load)).toBe(ENTRY('thing-constants'))
    mkdirp(join(dir, 'cjs'))
    writeFileSync(production, 'module.exports = {}')
    const out = productionEntrySource(entry, ENTRY('thing-constants'), load)
    expect(out).toContain(`require(${JSON.stringify(production)})`)
    expect(out).toContain('export const NoEventPriority = entry.NoEventPriority;')
    expect(out).toContain('export const DefaultEventPriority = entry.DefaultEventPriority;')
    expect(out).toContain('export default entry;')
    expect(out).not.toContain('not-an-identifier')
    expect(out).not.toContain('development')
    expect(productionEntrySource(entry, "module.exports = require('./somewhere-else.js')", load)).toBe("module.exports = require('./somewhere-else.js')")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the JSX dev runtime gets a jsxDEV built on the production jsx', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-fast-render-'))
  try {
    mkdirp(join(dir, 'cjs'))
    writeFileSync(join(dir, 'cjs', 'react-jsx-runtime.production.js'), 'module.exports = {}')
    const out = productionEntrySource(join(dir, 'jsx-dev-runtime.js'), ENTRY('react-jsx-dev-runtime'))
    expect(out).toContain('export function jsxDEV(type, config, maybeKey, isStaticChildren)')
    expect(out).toContain('runtime.jsx')
    expect(out).toContain('export const Fragment = runtime.Fragment;')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ELIA_FAST_RENDER=off turns it off', () => {
  expect(fastRenderEnabled({})).toBe(true)
  expect(fastRenderEnabled({ ELIA_FAST_RENDER: 'off' })).toBe(false)
  expect(fastRenderEnabled({ ELIA_FAST_RENDER: '0' })).toBe(false)
})

test('in a fresh process, Ink renders with React production builds and native text widths, NODE_ENV untouched', async () => {
  const root = join(import.meta.dir, '..', '..', '..')
  const probe = [
    "const { installFastRendering } = await import('./src/ui/app/fastRender.ts')",
    'const result = installFastRendering()',
    "const ink = await import('ink')",
    "const React = await import('react')",
    "const { default: stringWidth } = await import('string-width')",
    'const loaded = Object.keys(require.cache).filter((key) => /(react|react-reconciler|scheduler).cjs/.test(key))',
    'const started = performance.now()',
    'for (let i = 0; i < 500; i++) stringWidth(`Checking the request… ${i}`)',
    'console.log(JSON.stringify({',
    '  result,',
    '  nodeEnv: process.env.NODE_ENV ?? null,',
    "  development: loaded.filter((key) => key.includes('.development.')).length,",
    "  production: loaded.filter((key) => key.includes('.production.')).length,",
    '  fastWidth: performance.now() - started < 100,',
    '  jamo: stringWidth(String.fromCharCode(0x1100, 0x1161, 0x11a8)),',
    "  frame: ink.renderToString(React.createElement(ink.Text, { color: 'green' }, 'rendered ✦')),",
    '}))',
  ].join('\n')
  const env = { ...process.env }
  delete env.NODE_ENV
  delete env.ELIA_FAST_RENDER
  const child = Bun.spawn(['bun', '-e', probe], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  await child.exited
  expect(err).not.toContain('Error')
  const report = JSON.parse(out.trim().split('\n').pop() ?? '{}')
  expect(report.result).toEqual({ stringWidth: true, reactProduction: true })
  expect(report.nodeEnv).toBeNull()
  expect(report.development).toBe(0)
  expect(report.production).toBeGreaterThan(0)
  expect(report.fastWidth).toBe(true)
  expect(report.jamo).toBe(2)
  expect(report.frame).toContain('rendered ✦')
})

function mkdirp(path: string): void {
  require('node:fs').mkdirSync(path, { recursive: true })
}

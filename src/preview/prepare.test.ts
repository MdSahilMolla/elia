import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareAutoPreview } from './prepare.ts'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'elia-prepare-'))
}

test('plain self-contained HTML is served as a static page', () => {
  const root = scratch()
  const page = join(root, 'index.html')
  writeFileSync(page, '<!doctype html><h1>hello</h1>')
  const prep = prepareAutoPreview(page)
  expect(prep.kind).toBe('static')
  if (prep.kind === 'static') {
    expect(prep.serveRoot).toBe(root)
    expect(prep.servePath).toBe('index.html')
  }
})

test('an unbuilt Vite React app is skipped with a build hint, not served blank', () => {
  const root = scratch()
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' }, devDependencies: { vite: '^5', '@vitejs/plugin-react': '^4' } }),
  )
  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
  )
  const prep = prepareAutoPreview(join(root, 'index.html'))
  expect(prep.kind).toBe('skip')
  if (prep.kind === 'skip') {
    expect(prep.reason).toContain('unbuilt')
    expect(prep.reason.toLowerCase()).toContain('build')
  }
})

test('a Vite app that has already been built is served from dist/', () => {
  const root = scratch()
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' }, devDependencies: { vite: '^5' } }))
  writeFileSync(join(root, 'index.html'), '<script type="module" src="/src/main.tsx"></script>')
  mkdirSync(join(root, 'dist'))
  writeFileSync(join(root, 'dist', 'index.html'), '<script type="module" src="/assets/index-abc123.js"></script>')
  const prep = prepareAutoPreview(join(root, 'index.html'))
  expect(prep.kind).toBe('static')
  if (prep.kind === 'static') expect(prep.serveRoot).toBe(join(root, 'dist'))
})

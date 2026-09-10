import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findProject, isUnbuiltModuleEntry, pickBuildOutput } from './project.ts'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'elia-preview-project-'))
}

test('findProject detects a Vite project, its runner, and its scripts', () => {
  const root = scratch()
  writeFileSync(join(root, 'bun.lock'), '')
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' }, devDependencies: { vite: '^5' } }),
  )
  mkdirSync(join(root, 'src'))
  const info = findProject(join(root, 'src', 'main.tsx'))
  expect(info?.runner).toBe('bun')
  expect(info?.usesBundler).toBe(true)
  expect(info?.hasBuildScript).toBe(true)
  expect(info?.hasDevScript).toBe(true)
})

test('findProject returns undefined outside any package', () => {
  expect(findProject(join(scratch(), 'loose.html'))).toBeUndefined()
})

test('pickBuildOutput finds a built dist/', () => {
  const root = scratch()
  mkdirSync(join(root, 'dist'))
  writeFileSync(join(root, 'dist', 'index.html'), '<html></html>')
  expect(pickBuildOutput(root)).toBe(join(root, 'dist'))
})

test('isUnbuiltModuleEntry distinguishes source entries from bundled output', () => {
  const root = scratch()
  const source = join(root, 'index.html')
  writeFileSync(source, '<script type="module" src="/src/main.tsx"></script>')
  expect(isUnbuiltModuleEntry(source)).toBe(true)

  const built = join(root, 'built.html')
  writeFileSync(built, '<script type="module" src="/assets/index-abc123.js"></script>')
  expect(isUnbuiltModuleEntry(built)).toBe(false)

  const plain = join(root, 'plain.html')
  writeFileSync(plain, '<!doctype html><h1>static</h1>')
  expect(isUnbuiltModuleEntry(plain)).toBe(false)
})

// Regression: findProject walks *up* to the nearest package.json, so a page
// written anywhere inside the elia checkout resolved to elia's own manifest -
// whose `dev` is `bun run bin/elia.ts` and whose `test` is `bun test src/`.
// Previewing a static page then ran elia's own test suite against it.
test('findProject refuses elia own manifest as the previewed project', () => {
  const root = scratch()
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'elia-ai', bin: { elia: 'bin/elia.ts' }, scripts: { dev: 'bun run bin/elia.ts', test: 'bun test src/' } }),
  )
  const site = join(root, 'portfolio-demo')
  mkdirSync(site)
  const page = join(site, 'index.html')
  writeFileSync(page, '<h1>portfolio</h1>')
  // No project - the caller then serves the page's own directory statically.
  expect(findProject(page)).toBeUndefined()
})

test('a host manifest recognised by bin alone is also refused', () => {
  const root = scratch()
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'something-else', bin: { elia: 'bin/elia.ts' } }))
  writeFileSync(join(root, 'index.html'), '<h1>x</h1>')
  expect(findProject(join(root, 'index.html'))).toBeUndefined()
})

test('an ordinary project is still detected', () => {
  const root = scratch()
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'my-site', scripts: { dev: 'vite', build: 'vite build' }, devDependencies: { vite: '^5' } }))
  writeFileSync(join(root, 'index.html'), '<h1>x</h1>')
  const project = findProject(join(root, 'index.html'))
  expect(project?.dir).toBe(root)
  expect(project?.usesBundler).toBe(true)
})

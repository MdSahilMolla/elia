import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changedCodeFiles, changedStaticPages, checkRoot, detectChecks } from './detectChecks.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-checks-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('changedCodeFiles keeps source files, drops the rest', () => {
  expect(changedCodeFiles(['src/a.ts', 'README.md', 'x/b.py', 'style.css', 'c.go', 'Main.java', 'lib.cpp'])).toEqual(['src/a.ts', 'x/b.py', 'c.go', 'Main.java', 'lib.cpp'])
})

test('npm project: typecheck + test scripts', () => {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'vitest run' } }))
  writeFileSync(join(dir, 'package-lock.json'), '{}')
  expect(detectChecks(dir)).toEqual(['npm run typecheck', 'npm test'])
})

test('bun project via bun.lock', () => {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc', test: 'bun test src/' } }))
  writeFileSync(join(dir, 'bun.lock'), '')
  expect(detectChecks(dir)).toEqual(['bun run typecheck', 'bun run test'])
})

test('skips a watch-mode test script', () => {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest --watch' } }))
  writeFileSync(join(dir, 'yarn.lock'), '')
  expect(detectChecks(dir)).toEqual([])
})

test('no check when the project declares only unrelated scripts', () => {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc', start: 'node .' } }))
  writeFileSync(join(dir, 'tsconfig.json'), '{}')
  writeFileSync(join(dir, 'package-lock.json'), '{}')
  expect(detectChecks(dir)).toEqual([])
})

test('rust project', () => {
  writeFileSync(join(dir, 'Cargo.toml'), '[package]')
  expect(detectChecks(dir)).toEqual(['cargo check', 'cargo test'])
})

test('maven project', () => {
  writeFileSync(join(dir, 'pom.xml'), '<project/>')
  expect(detectChecks(dir)).toEqual(['mvn -q -B test'])
})

test('gradle project uses the wrapper when present', () => {
  writeFileSync(join(dir, 'build.gradle.kts'), '')
  writeFileSync(join(dir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'), '')
  expect(detectChecks(dir)).toEqual([process.platform === 'win32' ? 'gradlew.bat build' : './gradlew build'])
})

test('gradle project without a wrapper falls back to system gradle', () => {
  writeFileSync(join(dir, 'build.gradle'), '')
  expect(detectChecks(dir)).toEqual(['gradle build'])
})

test('cmake project configures then builds when there is no build tree', () => {
  writeFileSync(join(dir, 'CMakeLists.txt'), 'project(x)')
  expect(detectChecks(dir)).toEqual(['cmake -B build', 'cmake --build build'])
})

test('cmake project with an existing build tree only builds', () => {
  writeFileSync(join(dir, 'CMakeLists.txt'), 'project(x)')
  mkdirSync(join(dir, 'build'))
  expect(detectChecks(dir)).toEqual(['cmake --build build'])
})

test('plain Makefile project', () => {
  writeFileSync(join(dir, 'Makefile'), 'all:\n\ttrue\n')
  expect(detectChecks(dir)).toEqual(['make'])
})

test('python + pytest', () => {
  writeFileSync(join(dir, 'pytest.ini'), '')
  expect(detectChecks(dir)).toEqual(['pytest -q'])
})

test('empty when nothing is inferable', () => {
  expect(detectChecks(dir)).toEqual([])
})

test('checkRoot points at a sub-project when all changes are inside it', () => {
  const app = join(dir, 'workspace', 'my-app')
  mkdirSync(app, { recursive: true })
  writeFileSync(join(app, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }))
  writeFileSync(join(dir, 'package.json'), '{}')
  expect(checkRoot([join(app, 'src', 'a.ts'), join(app, 'src', 'b.ts')], dir)).toBe(app)
})

test('checkRoot falls back to the repo root when changes span projects', () => {
  writeFileSync(join(dir, 'package.json'), '{}')
  const app = join(dir, 'workspace', 'x')
  mkdirSync(app, { recursive: true })
  writeFileSync(join(app, 'package.json'), '{}')
  expect(checkRoot([join(app, 'a.ts'), join(dir, 'src', 'b.ts')], dir)).toBe(dir)
})

// Regression: checkRoot fell back to the repo root when no project marker was
// found above any changed file. That is the freshly-scaffolded case, and the
// fallback handed back the *host* repo — so detectChecks returned elia's own
// `bun run typecheck` / `bun test src/` and ran them against a static page.
test('checkRoot refuses the host repo for a deliverable its checks never touch', () => {
  const root = mkdtempSync(join(tmpdir(), 'elia-checkroot-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'host', scripts: { typecheck: 'tsc --noEmit', test: 'bun test src/' } }))
  const site = join(root, 'portfolio-demo')
  mkdirSync(site, { recursive: true })
  const page = join(site, 'index.html')
  writeFileSync(page, '<h1>hi</h1>')
  // `bun test src/` does not reach portfolio-demo/ — running it would prove nothing.
  expect(checkRoot([page], root)).toBeUndefined()
})

test('a project that declares no paths still covers its whole tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'elia-checkroot-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'host', scripts: { test: 'jest' } }))
  const nested = join(root, 'anything')
  mkdirSync(nested, { recursive: true })
  const file = join(nested, 'a.ts')
  writeFileSync(file, 'export const a = 1')
  expect(checkRoot([file], root)).toBe(root)
})

test('checkRoot still finds the host project for changes to its own source', () => {
  const root = mkdtempSync(join(tmpdir(), 'elia-checkroot-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'host', scripts: { test: 'bun test' } }))
  const src = join(root, 'src')
  mkdirSync(src, { recursive: true })
  const file = join(src, 'a.ts')
  writeFileSync(file, 'export const a = 1')
  expect(checkRoot([file], root)).toBe(root)
})

test('checkRoot still prefers a scaffolded sub-project that has its own manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'elia-checkroot-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'host' }))
  const app = join(root, 'workspace', 'my-app')
  mkdirSync(app, { recursive: true })
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'my-app', scripts: { test: 'vitest run' } }))
  const file = join(app, 'index.ts')
  writeFileSync(file, 'export const a = 1')
  expect(checkRoot([file], root)).toBe(app)
})

test('changedStaticPages picks out the HTML a turn wrote', () => {
  expect(changedStaticPages(['a/index.html', 'b/style.css', 'c/app.ts', 'd/page.HTM'])).toEqual(['a/index.html', 'd/page.HTM'])
})

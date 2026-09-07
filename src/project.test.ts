import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { detectProject } from './project.ts'

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'elia-project-'))
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative)
    const parent = path.slice(0, path.lastIndexOf('/'))
    mkdirSync(parent, { recursive: true })
    writeFileSync(path, content)
  }
  return root
}

test('detectProject identifies Python projects and Python verification', () => {
  const root = fixture({ 'pyproject.toml': '[tool.pytest.ini_options]\n', 'src/app.py': 'print(1)\n' })
  const profile = detectProject(root)
  expect(profile.stacks).toContain('python')
  expect(profile.verificationCommands).toContain('python:project-tests-or-pytest')
})

test('detectProject identifies TypeScript and Bun projects from manifests and scripts', () => {
  const root = fixture({
    'package.json': JSON.stringify({ packageManager: 'bun@1.3.0', scripts: { test: 'bun test', typecheck: 'tsc --noEmit' } }),
    'tsconfig.json': '{}',
    'bunfig.toml': '',
    'src/index.ts': 'export const ok = true\n',
  })
  const profile = detectProject(root)
  expect(profile.stacks).toContain('typescript')
  expect(profile.stacks).toContain('bun')
  expect(profile.packageManager).toBe('bun')
  expect(profile.verificationCommands).toContain('package-script:test')
  expect(profile.verificationCommands).toContain('typescript:tsc-or-project-typecheck')
})

test('detectProject identifies Rust and Go projects from their manifests', () => {
  const rust = fixture({ 'Cargo.toml': '[package]\nname = "x"\n', 'src/main.rs': 'fn main() {}\n' })
  const rustProfile = detectProject(rust)
  expect(rustProfile.stacks).toContain('rust')
  expect(rustProfile.verificationCommands).toContain('rust:cargo-check-and-test')

  const go = fixture({ 'go.mod': 'module x\n', 'main.go': 'package main\n' })
  const goProfile = detectProject(go)
  expect(goProfile.stacks).toContain('go')
  expect(goProfile.verificationCommands).toContain('go:build-and-test')
})

test('detectProject identifies Maven and Gradle Java projects', () => {
  const maven = fixture({ 'pom.xml': '<project/>', 'src/main/java/App.java': 'class App {}\n' })
  const mavenProfile = detectProject(maven)
  expect(mavenProfile.stacks).toContain('java')
  expect(mavenProfile.verificationCommands).toContain('java:mvn-test')

  const gradle = fixture({ 'build.gradle.kts': '', 'src/main/java/App.java': 'class App {}\n' })
  expect(detectProject(gradle).verificationCommands).toContain('java:gradle-build')
})

test('detectProject identifies a CMake C++ project', () => {
  const root = fixture({ 'CMakeLists.txt': 'project(x)\n', 'src/main.cpp': 'int main() { return 0; }\n' })
  const profile = detectProject(root)
  expect(profile.stacks).toContain('cpp')
  expect(profile.verificationCommands).toContain('cpp:cmake-build')
})

test('detectProject identifies React/TSX projects and preserves pnpm conventions', () => {
  const root = fixture({
    'package.json': JSON.stringify({ dependencies: { react: '^18.0.0' } }),
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'vite.config.ts': 'export default {}\n',
    'src/App.tsx': 'export function App() { return null }\n',
  })
  const profile = detectProject(root)
  expect(profile.stacks).toContain('react')
  expect(profile.stacks).toContain('typescript')
  expect(profile.packageManager).toBe('pnpm')
})

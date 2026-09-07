import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export type ProjectStack = 'python' | 'typescript' | 'bun' | 'react' | 'rust' | 'go' | 'java' | 'cpp'
export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm' | 'unknown'

export interface ProjectProfile {
  root: string
  stacks: ProjectStack[]
  packageManager: PackageManager
  signals: string[]
  verificationCommands: string[]
}

export function detectProject(root: string): ProjectProfile {
  const files = listTopLevelFiles(root)
  const packageJson = readJson(join(root, 'package.json'))
  const dependencies = { ...(packageJson?.dependencies as Record<string, unknown> | undefined), ...(packageJson?.devDependencies as Record<string, unknown> | undefined) }
  const scripts = packageJson?.scripts as Record<string, unknown> | undefined
  const sourceFiles = collectSourceExtensions(root)
  const signals: string[] = []
  const stacks: ProjectStack[] = []

  const python = files.some((file) => ['pyproject.toml', 'requirements.txt', 'setup.cfg', 'tox.ini', 'pytest.ini'].includes(file)) || sourceFiles.some((file) => file.endsWith('.py'))
  if (python) {
    stacks.push('python')
    signals.push('Python manifest or source detected')
  }

  const typescript = files.includes('tsconfig.json') || sourceFiles.some((file) => file.endsWith('.ts') || file.endsWith('.tsx'))
  if (typescript) {
    stacks.push('typescript')
    signals.push('TypeScript configuration or source detected')
  }

  const bun = files.some((file) => ['bunfig.toml', 'bun.lock', 'bun.lockb'].includes(file)) || typeof packageJson?.packageManager === 'string' && packageJson.packageManager.startsWith('bun') || Object.values(scripts ?? {}).some((value) => typeof value === 'string' && /\bbun\s+(run|test|x)\b/.test(value))
  if (bun) {
    stacks.push('bun')
    signals.push('Bun configuration, lockfile, or script detected')
  }

  const react = Boolean(dependencies.react || dependencies['react-dom']) || sourceFiles.some((file) => file.endsWith('.jsx') || file.endsWith('.tsx')) || files.some((file) => ['vite.config.ts', 'vite.config.js', 'next.config.js', 'next.config.mjs', 'next.config.ts'].includes(file))
  if (react) {
    stacks.push('react')
    signals.push('React dependency, component source, or framework configuration detected')
  }

  const rust = files.includes('Cargo.toml') || sourceFiles.some((file) => file.endsWith('.rs'))
  if (rust) {
    stacks.push('rust')
    signals.push('Cargo manifest or Rust source detected')
  }

  const go = files.includes('go.mod') || sourceFiles.some((file) => file.endsWith('.go'))
  if (go) {
    stacks.push('go')
    signals.push('Go module or source detected')
  }

  const gradle = files.some((file) => ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'].includes(file))
  const maven = files.includes('pom.xml')
  const java = gradle || maven || sourceFiles.some((file) => file.endsWith('.java'))
  if (java) {
    stacks.push('java')
    signals.push(maven ? 'Maven project detected' : gradle ? 'Gradle project detected' : 'Java source detected')
  }

  const cpp = files.some((file) => ['CMakeLists.txt', 'Makefile', 'makefile'].includes(file)) || sourceFiles.some((file) => /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(file))
  if (cpp) {
    stacks.push('cpp')
    signals.push(files.includes('CMakeLists.txt') ? 'CMake project detected' : 'C/C++ source or Makefile detected')
  }

  return {
    root,
    stacks,
    packageManager: detectPackageManager(files, packageJson?.packageManager),
    signals,
    verificationCommands: verificationCommands(packageJson, { python, typescript, rust, go, java, maven, gradle, cpp, cmake: files.includes('CMakeLists.txt') }),
  }
}

function listTopLevelFiles(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name)
  } catch {
    return []
  }
}

function collectSourceExtensions(root: string): string[] {
  const found: string[] = []
  const visit = (dir: string, depth: number): void => {
    if (depth > 3) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path, depth + 1)
      else if (/\.(py|ts|tsx|js|jsx|rs|go|java|c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(entry.name)) found.push(entry.name)
    }
  }
  visit(root, 0)
  return found
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function detectPackageManager(files: string[], declared: unknown): PackageManager {
  if (typeof declared === 'string') {
    if (declared.startsWith('bun')) return 'bun'
    if (declared.startsWith('pnpm')) return 'pnpm'
    if (declared.startsWith('yarn')) return 'yarn'
    if (declared.startsWith('npm')) return 'npm'
  }
  if (files.some((file) => ['bun.lock', 'bun.lockb'].includes(file))) return 'bun'
  if (files.includes('pnpm-lock.yaml')) return 'pnpm'
  if (files.includes('yarn.lock')) return 'yarn'
  if (files.includes('package-lock.json')) return 'npm'
  return 'unknown'
}

interface StackFlags {
  python: boolean
  typescript: boolean
  rust: boolean
  go: boolean
  java: boolean
  maven: boolean
  gradle: boolean
  cpp: boolean
  cmake: boolean
}

function verificationCommands(packageJson: Record<string, unknown> | undefined, flags: StackFlags): string[] {
  const scripts = packageJson?.scripts as Record<string, unknown> | undefined
  const commands: string[] = []
  for (const name of ['test', 'typecheck', 'lint', 'build']) {
    if (typeof scripts?.[name] === 'string') commands.push(`package-script:${name}`)
  }
  if (flags.python) commands.push('python:project-tests-or-pytest')
  if (flags.typescript) commands.push('typescript:tsc-or-project-typecheck')
  if (flags.rust) commands.push('rust:cargo-check-and-test')
  if (flags.go) commands.push('go:build-and-test')
  if (flags.maven) commands.push('java:mvn-test')
  else if (flags.gradle) commands.push('java:gradle-build')
  if (flags.cpp) commands.push(flags.cmake ? 'cpp:cmake-build' : 'cpp:make')
  return commands
}

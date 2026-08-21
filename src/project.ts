import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export type ProjectStack = 'python' | 'typescript' | 'bun' | 'react'
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

  return {
    root,
    stacks,
    packageManager: detectPackageManager(files, packageJson?.packageManager),
    signals,
    verificationCommands: verificationCommands(packageJson, python, typescript),
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
      else if (/\.(py|ts|tsx|js|jsx)$/.test(entry.name)) found.push(entry.name)
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

function verificationCommands(packageJson: Record<string, unknown> | undefined, python: boolean, typescript: boolean): string[] {
  const scripts = packageJson?.scripts as Record<string, unknown> | undefined
  const commands: string[] = []
  for (const name of ['test', 'typecheck', 'lint', 'build']) {
    if (typeof scripts?.[name] === 'string') commands.push(`package-script:${name}`)
  }
  if (python) commands.push('python:project-tests-or-pytest')
  if (typescript) commands.push('typescript:tsc-or-project-typecheck')
  return commands
}

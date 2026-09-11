// Behavioral reproduction: determine whether a suspected bug can be reproduced.

import type { ReproductionResult } from './types.ts'
import { runShell } from '../../shell.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const REPRODUCTION_TIMEOUT_MS = 30_000

/** Attempt to reproduce a bug using existing tests. */
export async function reproduceWithExistingTests(
  testPattern: string,
  cwd: string,
): Promise<ReproductionResult> {
  const result = await runShell(
    `bun test --timeout=10000 ${testPattern} 2>&1`,
    REPRODUCTION_TIMEOUT_MS,
    cwd,
  )

  if (result.exitCode !== 0) {
    return {
      established: true,
      command: `bun test ${testPattern}`,
      bugConfirmed: true,
      output: result.stdout + result.stderr,
      exitCode: result.exitCode,
    }
  }

  return {
    established: true,
    command: `bun test ${testPattern}`,
    bugConfirmed: false,
    output: result.stdout,
    exitCode: 0,
    limitation: 'Existing tests passed — bug may not be captured by current tests',
  }
}

/** Attempt to reproduce from a specific file/line by running relevant tests. */
export async function reproduceFromFile(
  filePath: string,
  cwd: string,
): Promise<ReproductionResult> {
  // Try running tests for this specific file
  const testPatterns = [
    `${filePath}.test.ts`,
    `${filePath}.test.tsx`,
    `${filePath}.spec.ts`,
    `${filePath.replace(/\.(ts|tsx|js|jsx)$/, '')}.test.ts`,
  ]

  for (const pattern of testPatterns) {
    if (existsSync(join(cwd, pattern))) {
      return reproduceWithExistingTests(pattern, cwd)
    }
  }

  // Try to find related test files via Bun.Glob (cross-platform)
  const baseName = filePath.split('/').pop()?.replace(/\.(ts|tsx|js|jsx)$/, '') ?? ''
  const glob = new Bun.Glob(`**/*${baseName}*{test,spec}*.{ts,tsx,js,jsx}`)
  const testFiles: string[] = []
  for (const p of glob.scanSync({ cwd, dot: false })) {
    if (!p.includes('node_modules') && !p.includes('.git')) testFiles.push(p)
    if (testFiles.length >= 3) break
  }

  if (testFiles.length > 0) {
    return reproduceWithExistingTests(testFiles[0]!, cwd)
  }

  return {
    established: false,
    bugConfirmed: false,
    output: '',
    limitation: `No test files found for ${filePath}. Cannot reproduce without tests.`,
  }
}

/** Generate a minimal reproduction command from an error description or stack trace. */
export function deriveReproductionCommand(
  errorDescription: string,
  stackTrace?: string,
  filePath?: string,
): string | null {
  // Try to extract a test command from the error
  const testMatch = errorDescription.match(/(?:test|spec|it)\s*['"(]([^'")]+)['")]/i)
  if (testMatch) return `bun test --timeout=10000 "${testMatch[1]}"`

  // Try to extract from stack trace
  if (stackTrace) {
    const fileMatch = stackTrace.match(/(?:at|in)\s+(.+?\.(?:ts|tsx|js|jsx)):(\d+)/)
    if (fileMatch) return `bun test --timeout=10000 "${fileMatch[1]}"`
  }

  // Try to extract from file path
  if (filePath) {
    const testName = filePath.replace(/\.(ts|tsx|js|jsx)$/, '.test.ts')
    return `bun test --timeout=10000 "${testName}"`
  }

  return null
}

/** Run a specific command to test a hypothesis. */
export async function runReproductionCommand(
  command: string,
  cwd: string,
): Promise<ReproductionResult> {
  const result = await runShell(command, REPRODUCTION_TIMEOUT_MS, cwd)

  return {
    established: true,
    command,
    bugConfirmed: result.exitCode !== 0,
    output: result.stdout + result.stderr,
    exitCode: result.exitCode,
  }
}

/** Run type checking as a form of verification. */
export async function runTypecheck(cwd: string): Promise<ReproductionResult> {
  const result = await runShell(
    'npx tsc --noEmit 2>&1',
    60000,
    cwd,
  )

  return {
    established: true,
    command: 'tsc --noEmit',
    bugConfirmed: result.exitCode !== 0,
    output: result.stdout + result.stderr,
    exitCode: result.exitCode,
  }
}

/** Run linting as a form of verification. */
export async function runLint(cwd: string): Promise<ReproductionResult> {
  const result = await runShell(
    'npx biome lint . 2>&1 || npx eslint . 2>&1 || echo "No linter configured"',
    30000,
    cwd,
  )

  return {
    established: true,
    command: 'lint',
    bugConfirmed: result.exitCode !== 0,
    output: result.stdout + result.stderr,
    exitCode: result.exitCode,
  }
}

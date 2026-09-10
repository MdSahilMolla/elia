// Regression test generation: create tests that capture the causal failure.

import type { RegressionTest, RootCauseCandidate, SemanticDiff } from './types.ts'
import { runShell } from '../../shell.ts'
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_TIMEOUT_MS = 30_000

/** Detect the test framework used in the project (file-based, cross-platform). */
async function detectTestFramework(cwd: string): Promise<string> {
  const pkgPath = join(cwd, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
      if (allDeps['vitest']) return 'vitest'
      if (allDeps['jest']) return 'jest'
      if (allDeps['@playwright/test']) return 'playwright'
    } catch {
      // Malformed package.json — fall through to default
    }
  }

  // Check for bun:test usage by scanning a handful of test files
  const glob = new Bun.Glob('**/*.test.ts')
  for (const p of glob.scanSync({ cwd, dot: false })) {
    if (p.includes('node_modules')) continue
    try {
      const content = readFileSync(join(cwd, p), 'utf-8')
      if (content.includes('bun:test')) return 'bun:test'
    } catch {
      // Ignore unreadable files
    }
  }

  return 'bun:test' // default
}

/** Detect existing test conventions (file-based, cross-platform). */
async function detectTestConventions(cwd: string): Promise<{ describe: string; it: string; expect: string }> {
  const glob = new Bun.Glob('**/*.test.ts')
  for (const p of glob.scanSync({ cwd, dot: false })) {
    if (p.includes('node_modules')) continue
    try {
      const content = readFileSync(join(cwd, p), 'utf-8')
      if (content.includes('describe(') && content.includes('it(') && content.includes('expect(')) {
        return { describe: 'describe', it: 'it', expect: 'expect' }
      }
    } catch {
      // Ignore unreadable files
    }
  }

  return { describe: 'describe', it: 'it', expect: 'expect' }
}

/** Detect how the target file exports symbols, so the test imports it correctly. */
function detectExportStyle(targetFile: string, cwd: string): { kind: 'named' | 'default' | 'none'; moduleName: string } {
  const moduleName = targetFile.split('/').pop()?.replace(/\.(ts|tsx|js|jsx)$/, '') ?? 'module'
  const fullPath = join(cwd, targetFile)
  if (!existsSync(fullPath)) return { kind: 'none', moduleName }

  try {
    const content = readFileSync(fullPath, 'utf-8')
    if (/export\s+default/.test(content)) return { kind: 'default', moduleName }
    if (/export\s+(const|function|class|let|async\s+function)/.test(content)) return { kind: 'named', moduleName }
    return { kind: 'none', moduleName }
  } catch {
    return { kind: 'none', moduleName }
  }
}

/** Generate a regression test for a root cause. */
export async function generateRegressionTest(
  candidate: RootCauseCandidate,
  targetFile: string,
  semanticDiffs: SemanticDiff[],
  cwd: string,
): Promise<RegressionTest> {
  const framework = await detectTestFramework(cwd)
  const conventions = await detectTestConventions(cwd)
  const exportStyle = detectExportStyle(targetFile, cwd)

  const relevantDiff = semanticDiffs.find((d) => d.commitHash.startsWith(candidate.commitHash))

  // Determine the test file path
  const testFilePath = targetFile.replace(/\.(ts|tsx|js|jsx)$/, '.test.ts')
  const fullTestPath = join(cwd, testFilePath)

  // Check if test file already exists
  const testFileExists = existsSync(fullTestPath)

  // Generate the test code
  const testCode = generateTestCode({
    framework,
    conventions,
    targetFile,
    candidate,
    relevantDiff,
    testFileExists,
    exportStyle,
  })

  // Determine the behavioral invariant
  const invariant = generateInvariantDescription(candidate, relevantDiff)

  return {
    filePath: testFilePath,
    code: testCode,
    invariant,
    framework,
    failsBeforeFix: false, // Will be set during verification
    passesAfterFix: false, // Will be set during verification
    limitation: testFileExists ? 'Test file already exists — new test should be added to existing file' : undefined,
  }
}

interface TestGenOptions {
  framework: string
  conventions: { describe: string; it: string; expect: string }
  targetFile: string
  candidate: RootCauseCandidate
  relevantDiff?: SemanticDiff
  testFileExists: boolean
  exportStyle?: { kind: 'named' | 'default' | 'none'; moduleName: string }
}

/** Generate test code based on the framework and conventions. */
function generateTestCode(options: TestGenOptions): string {
  const { framework, conventions, targetFile, candidate, relevantDiff, exportStyle } = options
  const moduleName = targetFile.split('/').pop()?.replace(/\.(ts|tsx|js|jsx)$/, '') ?? 'module'
  const { describe, it, expect } = conventions
  const kind = exportStyle?.kind ?? 'none'

  // Build the import statement based on the file's export style.
  const importLine = kind === 'default'
    ? `import ${moduleName} from './${moduleName}'`
    : kind === 'named'
      ? `import { ${moduleName} } from './${moduleName}'`
      : null

  const categories = relevantDiff?.categories ?? []
  const invariant = generateInvariantDescription(candidate, relevantDiff)

  if (framework === 'bun:test') {
    return `import { ${describe}, ${it}, ${expect} } from 'bun:test'
${importLine ? importLine + '\n' : ''}
${describe}('${moduleName} regression test', () => {
  ${it}('should ${invariant}', () => {
    // Regression test for root cause: ${candidate.commitHash.slice(0, 8)}
    // Confidence: ${Math.round(candidate.confidence * 100)}%
    // This test captures the behavioral invariant that was broken.

    // TODO: Add specific test assertions based on the failure
    // Example:
    // const result = ${moduleName}(...)
    // ${expect}(result).toBe(expectedValue)

    ${expect}(true).toBe(true) // Placeholder — replace with actual test
  })
})
`
  }

  if (framework === 'jest' || framework === 'vitest') {
    return `import { ${describe}, ${it}, ${expect} } from '${framework}'
${importLine ? importLine + '\n' : ''}
${describe}('${moduleName} regression test', () => {
  ${it}('should ${invariant}', () => {
    // Regression test for root cause: ${candidate.commitHash.slice(0, 8)}
    // Confidence: ${Math.round(candidate.confidence * 100)}%

    // TODO: Add specific test assertions
    ${expect}(true).toBe(true)
  })
})
`
  }

  // Default fallback — never import when we can't detect the export style
  return `import { ${describe}, ${it}, ${expect} } from 'bun:test'
${importLine ? importLine + '\n' : ''}
${describe}('regression test', () => {
  ${it}('should ${invariant}', () => {
    // Regression test for: ${candidate.commitHash.slice(0, 8)}
    ${expect}(true).toBe(true)
  })
})
`
}

/** Generate a human-readable invariant description. */
function generateInvariantDescription(
  candidate: RootCauseCandidate,
  relevantDiff?: SemanticDiff,
): string {
  const parts: string[] = []

  if (relevantDiff) {
    if (relevantDiff.categories.includes('error_handling')) {
      parts.push('handle errors correctly')
    }
    if (relevantDiff.categories.includes('control_flow')) {
      parts.push('follow the correct control flow path')
    }
    if (relevantDiff.categories.includes('return_value')) {
      parts.push('return the expected value')
    }
    if (relevantDiff.categories.includes('auth_change')) {
      parts.push('enforce authentication correctly')
    }
    if (relevantDiff.categories.includes('concurrency')) {
      parts.push('behave correctly under concurrent access')
    }
    if (relevantDiff.categories.includes('state_mutation')) {
      parts.push('manage state correctly')
    }
    if (relevantDiff.categories.includes('api_contract')) {
      parts.push('adhere to the API contract')
    }
  }

  if (parts.length === 0) {
    parts.push('maintain expected behavior')
  }

  return parts.join(' and ')
}

/** Verify a regression test fails before the fix, in an isolated self-contained scaffold. */
export async function verifyTestFailsBeforeFix(
  testCode: string,
  testFilePath: string,
  cwd: string,
): Promise<boolean> {
  // Scaffold a minimal temp project: the test plus a copy of the module it
  // imports, so relative imports resolve without touching the user's workspace.
  const tempDir = mkdtempSync(join(tmpdir(), 'elia-regression-'))
  try {
    const base = basename(testFilePath)
    const moduleBase = base.replace(/\.(test|spec)\.(ts|tsx|js|jsx)$/, '')
    const moduleExt = testFilePath.match(/\.(ts|tsx|js|jsx)$/)?.[0] ?? '.ts'
    const moduleFile = `${moduleBase}${moduleExt}`
    const srcModule = join(cwd, testFilePath.replace(/\.(test|spec)\.(ts|tsx|js|jsx)$/, `${moduleExt}`))

    // Copy the module under test into the scaffold so `import './module'` resolves.
    if (existsSync(srcModule)) {
      const scaffoldModule = join(tempDir, moduleFile)
      writeFileSync(scaffoldModule, readFileSync(srcModule, 'utf-8'))
    }

    const fullPath = join(tempDir, base)
    writeFileSync(fullPath, testCode)

    const result = await runShell(
      `bun test --timeout=10000 "${fullPath}" 2>&1`,
      TEST_TIMEOUT_MS,
      tempDir,
    )
    return result.exitCode !== 0 // Test should fail (bug exists)
  } finally {
    // Clean up temp files even on failure
    rmSync(tempDir, { recursive: true, force: true })
  }
}

/** Verify a regression test passes after the fix. */
export async function verifyTestPassesAfterFix(
  testFilePath: string,
  cwd: string,
): Promise<boolean> {
  const result = await runShell(
    `bun test --timeout=10000 "${testFilePath}" 2>&1`,
    TEST_TIMEOUT_MS,
    cwd,
  )

  return result.exitCode === 0 // Test should pass (bug is fixed)
}

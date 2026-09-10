// Verification orchestrator: run all available checks after a proposed fix.

import type { VerificationCheck, VerificationStatus } from './types.ts'
import { runShell } from '../../shell.ts'

const VERIFY_TIMEOUT_MS = 120_000

/** Run targeted reproduction. */
export async function verifyReproduction(
  command: string,
  cwd: string,
): Promise<VerificationCheck> {
  const result = await runShell(command, VERIFY_TIMEOUT_MS, cwd)
  return {
    name: 'reproduction',
    status: result.exitCode === 0 ? 'PASS' : 'FAIL',
    command,
    output: result.stdout + result.stderr,
    exitCode: result.exitCode,
  }
}

/** Run generated regression tests. */
export async function verifyRegressionTest(
  testFilePath: string,
  cwd: string,
): Promise<VerificationCheck> {
  const result = await runShell(
    `bun test --timeout=10000 "${testFilePath}" 2>&1`,
    VERIFY_TIMEOUT_MS,
    cwd,
  )
  return {
    name: 'regression_test',
    status: result.exitCode === 0 ? 'PASS' : 'FAIL',
    command: `bun test ${testFilePath}`,
    output: result.stdout + result.stderr,
    exitCode: result.exitCode,
  }
}

/** Run existing relevant tests. */
export async function verifyExistingTests(
  testPattern: string,
  cwd: string,
): Promise<VerificationCheck> {
  const result = await runShell(
    `bun test --timeout=20000 ${testPattern} 2>&1`,
    VERIFY_TIMEOUT_MS * 2,
    cwd,
  )
  return {
    name: 'existing_tests',
    status: result.exitCode === 0 ? 'PASS' : 'FAIL',
    command: `bun test ${testPattern}`,
    output: result.stdout + result.stderr,
    exitCode: result.exitCode,
  }
}

/** Run the full test suite. */
export async function verifyFullTestSuite(cwd: string): Promise<VerificationCheck> {
  const result = await runShell(
    'bun test --timeout=20000 src/ 2>&1',
    VERIFY_TIMEOUT_MS * 5,
    cwd,
  )
  return {
    name: 'full_test_suite',
    status: result.exitCode === 0 ? 'PASS' : 'FAIL',
    command: 'bun test src/',
    output: result.stdout.slice(0, 5000) + (result.stdout.length > 5000 ? '\n... (truncated)' : ''),
    exitCode: result.exitCode,
  }
}

/** Run type checking. */
export async function verifyTypecheck(cwd: string): Promise<VerificationCheck> {
  const result = await runShell(
    'npx tsc --noEmit 2>&1',
    VERIFY_TIMEOUT_MS * 2,
    cwd,
  )
  return {
    name: 'typecheck',
    status: result.exitCode === 0 ? 'PASS' : result.stdout.includes('error TS') ? 'FAIL' : 'NOT_AVAILABLE',
    command: 'tsc --noEmit',
    output: result.stdout.slice(0, 3000),
    exitCode: result.exitCode,
  }
}

/** Run linting. */
export async function verifyLint(cwd: string): Promise<VerificationCheck> {
  const result = await runShell(
    'npx biome lint . 2>&1 || npx eslint . 2>&1 || echo "No linter configured"',
    VERIFY_TIMEOUT_MS,
    cwd,
  )
  return {
    name: 'lint',
    status: result.exitCode === 0 ? 'PASS' : result.stdout.includes('No linter') ? 'NOT_AVAILABLE' : 'FAIL',
    command: 'lint',
    output: result.stdout.slice(0, 3000),
    exitCode: result.exitCode,
  }
}

/** Run all available verifications. */
export async function runAllVerifications(
  cwd: string,
  testPattern?: string,
  testFilePath?: string,
  reproductionCommand?: string,
): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = []

  // Type check (always available)
  checks.push(await verifyTypecheck(cwd))

  // Regression test if available
  if (testFilePath) {
    checks.push(await verifyRegressionTest(testFilePath, cwd))
  }

  // Existing tests if pattern provided
  if (testPattern) {
    checks.push(await verifyExistingTests(testPattern, cwd))
  }

  // Reproduction if command provided
  if (reproductionCommand) {
    checks.push(await verifyReproduction(reproductionCommand, cwd))
  }

  // Lint
  checks.push(await verifyLint(cwd))

  return checks
}

/** Summarize verification results. */
export function summarizeVerification(checks: VerificationCheck[]): string {
  const lines: string[] = []
  lines.push('=== Verification Results ===')

  let allPassed = true
  for (const check of checks) {
    const icon = check.status === 'PASS' ? '✓' : check.status === 'FAIL' ? '✗' : check.status === 'NOT_RUN' ? '○' : '?'
    lines.push(`  ${icon} ${check.name}: ${check.status}`)
    if (check.command) lines.push(`    Command: ${check.command}`)
    if (check.status === 'FAIL' && check.output) {
      const briefOutput = check.output.slice(0, 200)
      lines.push(`    Output: ${briefOutput}${check.output.length > 200 ? '...' : ''}`)
    }
    if (check.status === 'FAIL') allPassed = false
  }

  lines.push('')
  lines.push(allPassed ? 'All verifications passed.' : 'Some verifications failed.')

  return lines.join('\n')
}

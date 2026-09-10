// causal_verify tool: verify a proposed fix through multiple checks.

import type { Tool } from '../types.ts'
import { optionalString } from '../args.ts'
import { resolveWorkspacePath } from '../../autonomy/context.ts'
import { runAllVerifications, summarizeVerification } from './verify.ts'

export const causalVerifyTool: Tool = {
  name: 'causal_verify',
  description:
    'Run verification checks on a proposed fix: type checking, linting, test suites, and reproduction. Reports PASS/FAIL/NOT_RUN/NOT_AVAILABLE for each check.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Project directory to verify (default: current)' },
      test_pattern: { type: 'string', description: 'Specific test file or pattern to run' },
      test_file: { type: 'string', description: 'Regression test file to verify' },
      reproduction_command: { type: 'string', description: 'Command to reproduce the bug' },
    },
  },
  async execute(input) {
    const cwd = resolveWorkspacePath(optionalString(input.path, 'path') ?? '.')
    const testPattern = optionalString(input.test_pattern, 'test_pattern')
    const testFile = optionalString(input.test_file, 'test_file')
    const reproductionCommand = optionalString(input.reproduction_command, 'reproduction_command')

    const checks = await runAllVerifications(cwd, testPattern ?? undefined, testFile ?? undefined, reproductionCommand ?? undefined)
    return summarizeVerification(checks)
  },
}

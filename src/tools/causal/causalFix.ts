// causal_fix tool: generate a repair plan, patch, and regression test
// from a causal debug result. Applies fix only when explicitly requested.

import type { Tool } from '../types.ts'
import { optionalString } from '../args.ts'
import { resolveWorkspacePath } from '../../autonomy/context.ts'
import { runCausalDebug, runCausalFix } from './engine.ts'
import { formatCausalFixResult } from './format.ts'

export const causalFixTool: Tool = {
  name: 'causal_fix',
  description:
    'Generate a repair plan, patch, and regression test from causal analysis. Analyzes the root cause, produces a minimal fix, generates a regression test, and runs verification. Does NOT apply the patch by default — use apply=true to apply.',
  input_schema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Repo-relative file path with the bug' },
      line: { type: 'number', description: 'Specific line number (optional)' },
      commit: { type: 'string', description: 'Known root-cause commit hash (optional, skips debug phase)' },
      observed_behavior: { type: 'string', description: 'Description of the failure' },
      apply: { type: 'boolean', description: 'Apply the generated patch (default false — read-only)' },
    },
    required: ['file'],
  },
  async execute(input) {
    const file = optionalString(input.file, 'file')
    if (!file) throw new Error('file is required')

    const cwd = resolveWorkspacePath('.')
    const apply = input.apply === true

    // Run causal debug first to identify root cause
    const debugResult = await runCausalDebug({
      file,
      line: typeof input.line === 'number' ? input.line : undefined,
      observedBehavior: optionalString(input.observed_behavior, 'observed_behavior'),
      cwd,
    })

    if (debugResult.candidates.length === 0) {
      return 'No root cause identified with sufficient confidence. Run causal_debug for more details.'
    }

    // Generate fix
    const fixResult = await runCausalFix(debugResult, cwd)

    // Apply patch if requested
    if (apply && fixResult.patch.diff) {
      const { applyPatch } = await import('./patch.ts')
      const applyResult = await applyPatch(fixResult.patch, cwd)
      fixResult.fixApplied = applyResult.success
      if (!applyResult.success) {
        return `Failed to apply patch: ${applyResult.output}\n\n${formatCausalFixResult(fixResult)}`
      }
    }

    return formatCausalFixResult(fixResult)
  },
}

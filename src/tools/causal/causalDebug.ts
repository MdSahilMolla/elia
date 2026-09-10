// causal_debug tool: trace the causal history of a code location.
// Preserves existing API while using the new engine.

import type { Tool } from '../types.ts'
import { optionalString } from '../args.ts'
import { resolveWorkspacePath } from '../../autonomy/context.ts'
import { runCausalDebug, type EngineOptions } from './engine.ts'
import { formatCausalDebugResult } from './format.ts'

const MAX_DEPTH = 200

export const causalDebugTool: Tool = {
  name: 'causal_debug',
  description:
    'Trace the causal history of a code location through git commits, semantic analysis, and behavioral reproduction. Given a file path and optional line number, this tool builds a causal graph, scores root-cause candidates with multiple evidence signals, and produces an explainable report. Supports code provenance across renames/refactors, semantic diff analysis, behavioral reproduction, and counterfactual verification.',
  input_schema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Repo-relative file path to investigate' },
      line: { type: 'number', description: 'Specific line number to trace (optional)' },
      depth: { type: 'number', description: `Max commits to analyze (1-${MAX_DEPTH}, default 30)` },
      keyword: { type: 'string', description: 'Filter commits by keyword in message' },
      observed_behavior: { type: 'string', description: 'Description of the observed failure or behavior' },
    },
    required: ['file'],
  },
  async execute(input) {
    const file = optionalString(input.file, 'file')
    if (!file) throw new Error('file is required')

    if (typeof input.depth === 'number' && (input.depth < 1 || input.depth > MAX_DEPTH)) {
      throw new Error(`depth must be between 1 and ${MAX_DEPTH}`)
    }
    if (typeof input.line === 'number' && input.line < 1) {
      throw new Error('line must be a positive integer')
    }

    const cwd = resolveWorkspacePath('.')

    const options: EngineOptions = {
      file,
      line: typeof input.line === 'number' ? input.line : undefined,
      depth: typeof input.depth === 'number' ? input.depth : 30,
      keyword: optionalString(input.keyword, 'keyword'),
      observedBehavior: optionalString(input.observed_behavior, 'observed_behavior'),
      cwd,
    }

    const result = await runCausalDebug(options)
    return formatCausalDebugResult(result)
  },
}

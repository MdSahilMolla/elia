// Legacy `arch_drift` tool, now a thin read-only bridge to the architecture
// engine under `src/tools/arch/`. Kept the same name/schema so existing
// callers keep working, and the default remains full analysis with no writes.

import type { Tool } from './types.ts'
import { optionalString } from './args.ts'
import { resolveWorkspacePath } from '../autonomy/context.ts'
import { joinPath } from './arch/parser.ts'
import { buildReport, formatReport } from './arch/report.ts'
import { applyRepairPlans } from './arch/repair.ts'

const MAX_FILES = 200

export const archDriftTool: Tool = {
  name: 'arch_drift',
  description:
    'Detect architectural drift by analyzing module structure and dependencies: layer direction, cycles, forbidden imports, package boundaries, dependency inversion, god modules, orphans, and more. Reports health scores, hotspots, git drift, and mechanical repair plans. Read-only by default.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to analyze (default: current directory)' },
      maxFiles: { type: 'number', description: `Max files to analyze (1-${MAX_FILES}, default 200)` },
      includeTests: { type: 'boolean', description: 'Include test files in analysis (default false)' },
      configPath: { type: 'string', description: 'Explicit architecture config file (arch.json, .arch.json, arch.config.json, or an architecture block in package.json)' },
      base: { type: 'string', description: 'Git revision to measure drift since (e.g. HEAD~5, a short hash)' },
      baselineFile: { type: 'string', description: 'Baseline snapshot file (default arch.baseline.json in the project root)' },
      applyPlans: { type: 'boolean', description: 'EXPLICITLY write mechanical repair plans to source. Off by default; the report never modifies files.' },
    },
  },
  async execute(input) {
    const cwd = resolveWorkspacePath('.')
    const scanPath = optionalString(input.path, 'path') ?? '.'
    const projectRoot = resolveWorkspacePath(scanPath)
    const maxFiles = Math.min(Math.max(typeof input.maxFiles === 'number' ? input.maxFiles : 200, 1), MAX_FILES)
    const includeTests = input.includeTests === true
    const report = await buildReport({
      projectRoot,
      tsconfigPath: joinPath(projectRoot, 'tsconfig.json'),
      includeTests,
      maxFiles,
      configPath: optionalString(input.configPath, 'configPath'),
      base: optionalString(input.base, 'base'),
      baselineFile: optionalString(input.baselineFile, 'baselineFile'),
    })

    if (input.applyPlans === true) {
      const mechanical = report.repairs.plans.filter((p) => p.resolution === 'resolvable' && p.namesVerified)
      if (mechanical.length === 0) {
        return `${formatReport(report)}\n\nNo verified mechanical repairs were available; nothing was written.`
      }
      const result = applyRepairPlans(projectRoot, mechanical)
      const changed = result.applied.length > 0
      return `${formatReport(report)}\n\nApplied ${result.actions.length} verified repair(s) across ${result.applied.length} file(s):\n${result.applied.map((f) => `  - ${f}`).join('\n')}${changed ? '\nRe-run analysis to confirm residuals.' : '\nNothing to write.'}`
    }

    void cwd
    return formatReport(report)
  },
}
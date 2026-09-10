import type { Tool } from './types.ts'
import { optionalString } from './args.ts'
import { runShell } from '../shell.ts'
import { resolveWorkspacePath } from '../autonomy/context.ts'

const SHELL_TIMEOUT_MS = 30_000
const MAX_FILES = 200
const MAX_MODULES = 100

interface ModuleNode {
  name: string
  path: string
  imports: string[]
  exports: string[]
  dependencies: string[]
  dependents: string[]
}

interface DriftViolation {
  type: 'import_direction' | 'circular_dependency' | 'layer_violation' | 'god_module' | 'orphan_module'
  severity: 'warning' | 'error' | 'critical'
  source: string
  target: string
  description: string
  suggestion: string
}

interface DriftReport {
  modules: ModuleNode[]
  violations: DriftViolation[]
  layerStructure: Record<string, string[]>
  healthScore: number
  summary: string
}

async function getFileImports(filePath: string, cwd: string): Promise<string[]> {
  const result = await runShell(
    `head -50 "${filePath}" | grep -E "^import\\s|from\\s+['\"]" | sed -E "s/.*from\\s+['\"]([^'\"]+)['\"].*/\\1/" | sed -E "s/.*import\\s+['\"]([^'\"]+)['\"].*/\\1/" | grep -E "^\\." | sort -u`,
    SHELL_TIMEOUT_MS,
    cwd,
  )
  return result.stdout
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((imp) => {
      if (imp.endsWith('.ts') || imp.endsWith('.tsx') || imp.endsWith('.js')) return imp
      return imp + '.ts'
    })
}

async function getFileExports(filePath: string, cwd: string): Promise<string[]> {
  const result = await runShell(
    `grep -E "^export\\s+(const|function|class|interface|type|enum|let|var|async)\\s+" "${filePath}" 2>/dev/null | sed -E "s/^export\\s+(const|function|class|interface|type|enum|let|var|async)\\s+([a-zA-Z0-9_]+).*/\\2/" | head -20`,
    SHELL_TIMEOUT_MS,
    cwd,
  )
  return result.stdout.split('\n').filter((l) => l.trim().length > 0)
}

function inferLayers(modules: ModuleNode[]): Record<string, string[]> {
  const layers: Record<string, string[]> = {}
  for (const mod of modules) {
    const parts = mod.path.split('/')
    const layer = parts.length > 1 ? parts[0]! : 'root'
    if (!layers[layer]) layers[layer] = []
    layers[layer]!.push(mod.name)
  }
  return layers
}

function detectImportDirectionViolations(modules: ModuleNode[]): DriftViolation[] {
  const violations: DriftViolation[] = []
  const moduleMap = new Map(modules.map((m) => [m.path, m]))

  for (const mod of modules) {
    for (const dep of mod.dependencies) {
      const depModule = moduleMap.get(dep)
      if (!depModule) continue

      const sourceLayer = mod.path.split('/')[0] ?? 'root'
      const targetLayer = dep.split('/')[0] ?? 'root'

      if (sourceLayer === 'lib' && targetLayer === 'app') {
        violations.push({
          type: 'import_direction',
          severity: 'error',
          source: mod.path,
          target: dep,
          description: `Library module "${mod.name}" imports from app module "${depModule.name}". Libraries should not depend on application code.`,
          suggestion: `Extract the needed functionality into a shared module, or invert the dependency.`,
        })
      }
    }
  }
  return violations
}

function detectCircularDeps(modules: ModuleNode[]): DriftViolation[] {
  const violations: DriftViolation[] = []
  const moduleMap = new Map(modules.map((m) => [m.path, m]))

  function dfs(path: string, visited: Set<string>, stack: Set<string>): string[] | null {
    visited.add(path)
    stack.add(path)
    const mod = moduleMap.get(path)
    if (mod) {
      for (const dep of mod.dependencies) {
        if (!moduleMap.has(dep)) continue
        if (stack.has(dep)) return [path, dep]
        if (!visited.has(dep)) {
          const cycle = dfs(dep, visited, stack)
          if (cycle) return cycle
        }
      }
    }
    stack.delete(path)
    return null
  }

  const visited = new Set<string>()
  for (const mod of modules) {
    if (!visited.has(mod.path)) {
      const cycle = dfs(mod.path, visited, new Set())
      if (cycle) {
        violations.push({
          type: 'circular_dependency',
          severity: 'critical',
          source: cycle[0]!,
          target: cycle[1]!,
          description: `Circular dependency detected: ${cycle.join(' -> ')}`,
          suggestion: `Extract shared types/interfaces into a third module to break the cycle.`,
        })
      }
    }
  }
  return violations
}

function detectGodModules(modules: ModuleNode[]): DriftViolation[] {
  const violations: DriftViolation[] = []
  const avgDeps =
    modules.reduce((sum, m) => sum + m.dependencies.length + m.dependents.length, 0) / Math.max(modules.length, 1)

  for (const mod of modules) {
    const totalConnections = mod.dependencies.length + mod.dependents.length
    if (totalConnections > avgDeps * 3 && totalConnections > 10) {
      violations.push({
        type: 'god_module',
        severity: 'warning',
        source: mod.path,
        target: '',
        description: `Module "${mod.name}" has ${totalConnections} connections (${mod.dependencies.length} deps, ${mod.dependents.length} dependents) — ${Math.round(totalConnections / Math.max(avgDeps, 1))}x the average.`,
        suggestion: `Consider splitting this module into smaller, focused sub-modules.`,
      })
    }
  }
  return violations
}

function detectOrphans(modules: ModuleNode[]): DriftViolation[] {
  const violations: DriftViolation[] = []
  for (const mod of modules) {
    if (mod.dependencies.length === 0 && mod.dependents.length === 0 && modules.length > 5) {
      violations.push({
        type: 'orphan_module',
        severity: 'warning',
        source: mod.path,
        target: '',
        description: `Module "${mod.name}" has no imports from or exports to other modules.`,
        suggestion: `Consider if this module should be integrated or removed.`,
      })
    }
  }
  return violations
}

function computeHealthScore(violations: DriftViolation[]): number {
  let score = 100
  for (const v of violations) {
    if (v.severity === 'critical') score -= 20
    else if (v.severity === 'error') score -= 10
    else score -= 3
  }
  return Math.max(0, Math.min(100, score))
}

function formatReport(report: DriftReport): string {
  const lines: string[] = []
  lines.push('=== Architectural Drift Detection Report ===')
  lines.push(`Modules analyzed: ${report.modules.length}`)
  lines.push(`Health score: ${report.healthScore}/100`)
  lines.push('')
  lines.push(report.summary)

  if (report.violations.length > 0) {
    lines.push('')
    lines.push('--- Violations ---')
    for (const v of report.violations) {
      const icon = v.severity === 'critical' ? '!!!' : v.severity === 'error' ? '!!' : '!'
      lines.push(`  [${icon} ${v.type}] ${v.source}${v.target ? ` -> ${v.target}` : ''}`)
      lines.push(`    ${v.description}`)
      lines.push(`    Fix: ${v.suggestion}`)
      lines.push('')
    }
  } else {
    lines.push('')
    lines.push('No architectural violations detected.')
  }

  if (Object.keys(report.layerStructure).length > 0) {
    lines.push('--- Layer Structure ---')
    for (const [layer, mods] of Object.entries(report.layerStructure)) {
      lines.push(`  ${layer}: ${mods.join(', ')}`)
    }
  }

  return lines.join('\n')
}

export const archDriftTool: Tool = {
  name: 'arch_drift',
  description:
    'Detect architectural drift by analyzing import/export relationships, dependency direction, circular dependencies, god modules, and orphan modules. Returns a health score and actionable violation report.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to analyze (default: current directory)' },
      maxFiles: { type: 'number', description: `Max files to analyze (1-${MAX_FILES}, default 100)` },
      includeTests: { type: 'boolean', description: 'Include test files in analysis (default false)' },
    },
  },
  async execute(input) {
    const cwd = resolveWorkspacePath('.')
    const scanPath = optionalString(input.path, 'path') ?? '.'
    const maxFiles = Math.min(Math.max(typeof input.maxFiles === 'number' ? input.maxFiles : 100, 1), MAX_FILES)
    const includeTests = input.includeTests === true

    const findPattern = includeTests ? '-name "*.ts" -o -name "*.tsx" -o -name "*.js"' : '-name "*.ts" -o -name "*.tsx" -o -name "*.js" ! -name "*.test.ts" ! -name "*.test.tsx" ! -name "*.spec.ts"'
    const findResult = await runShell(
      `find "${scanPath}" -type f \\( ${findPattern} \\) -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" | head -${maxFiles}`,
      SHELL_TIMEOUT_MS,
      cwd,
    )
    const files = findResult.stdout.split('\n').filter((f) => f.trim().length > 0)

    if (files.length === 0) {
      return formatReport({
        modules: [],
        violations: [],
        layerStructure: {},
        healthScore: 100,
        summary: 'No source files found to analyze.',
      })
    }

    const modules: ModuleNode[] = []
    for (const file of files) {
      const imports = await getFileImports(file, cwd)
      const exports = await getFileExports(file, cwd)
      const resolvedImports = imports.map((imp) => {
        const base = file.replace(/[^/]+$/, '')
        return base + imp.replace(/^\.\//, '').replace(/^\.\.\//, '../../')
      })
      modules.push({
        name: file.split('/').pop()?.replace(/\.(ts|tsx|js)$/, '') ?? file,
        path: file,
        imports,
        exports,
        dependencies: resolvedImports.filter((r) => files.includes(r)),
        dependents: [],
      })
    }

    for (const mod of modules) {
      for (const dep of mod.dependencies) {
        const depMod = modules.find((m) => m.path === dep)
        if (depMod) depMod.dependents.push(mod.path)
      }
    }

    const violations: DriftViolation[] = [
      ...detectImportDirectionViolations(modules),
      ...detectCircularDeps(modules),
      ...detectGodModules(modules),
      ...detectOrphans(modules),
    ]

    const report: DriftReport = {
      modules: modules.slice(0, MAX_MODULES),
      violations,
      layerStructure: inferLayers(modules),
      healthScore: computeHealthScore(violations),
      summary: violations.length === 0
        ? `All ${modules.length} modules pass architectural checks.`
        : `Found ${violations.length} violation${violations.length > 1 ? 's' : ''} across ${modules.length} modules.`,
    }

    return formatReport(report)
  },
}

// Semantic diff analysis: understand what behavior a commit changed,
// not just what lines it modified.

import type { SemanticDiff, SemanticChangeCategory } from './types.ts'
import { structuredPatch } from 'diff'

/** Patterns that indicate specific semantic change categories. */
const SEMANTIC_PATTERNS: Array<{ category: SemanticChangeCategory; patterns: RegExp[] }> = [
  { category: 'control_flow', patterns: [/\b(if|else|switch|case|break|return|throw|catch|finally)\b/, /\b(?:for|while|do)\b/] },
  { category: 'return_value', patterns: [/return\s+/, /yield\s+/] },
  { category: 'error_handling', patterns: [/\b(try|catch|throw|Error|reject|finally)\b/, /\.catch\(/, /onError/] },
  { category: 'auth_change', patterns: [/\b(auth|login|password|token|session|cookie|jwt|oauth|permission|role|access)\b/i] },
  { category: 'concurrency', patterns: [/\b(async|await|Promise|setTimeout|setInterval|Worker|SharedArrayBuffer|Mutex|Lock)\b/, /\.then\(/] },
  { category: 'state_mutation', patterns: [/\b(this\.\w+\s*=|\w+\.\w+\s*(\+|-|\*|\/)?=|\b(push|pop|splice|shift|unshift|set|delete)\b)/, /useState/] },
  { category: 'api_contract', patterns: [/\b(fetch|axios|http|request|response|status|header|body|endpoint|route|middleware)\b/i, /\b(GET|POST|PUT|PATCH|DELETE)\b/] },
  { category: 'dependency_change', patterns: [/import\s+/, /require\s*\(/, /from\s+['"]/, /new\s+Worker/] },
  { category: 'config_change', patterns: [/\b(config|env|environment|settings|option|preference)\b/i, /process\.env/, /\.env/] },
  { category: 'type_change', patterns: [/\b(as\s+\w+|:\s*\w+|interface\s+\w+|type\s+\w+|enum\s+\w+|class\s+\w+)\b/] },
]

/** Classify the semantic category of a single line change. */
function classifyLine(line: string): SemanticChangeCategory[] {
  const cleaned = line.replace(/^[+-]\s*/, '')
  const categories: SemanticChangeCategory[] = []

  for (const { category, patterns } of SEMANTIC_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(cleaned)) {
        categories.push(category)
        break
      }
    }
  }

  return categories.length > 0 ? categories : ['naming']
}

/** Detect function/symbol names in a code line. */
function detectSymbols(line: string): string[] {
  const symbols: string[] = []
  const cleaned = line.replace(/^[+-]\s*/, '')

  // Function declarations
  const fnMatch = cleaned.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/)
  if (fnMatch) symbols.push(fnMatch[1]!)

  // Arrow functions
  const arrowMatch = cleaned.match(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/)
  if (arrowMatch) symbols.push(arrowMatch[1]!)

  // Class declarations
  const classMatch = cleaned.match(/class\s+(\w+)/)
  if (classMatch) symbols.push(classMatch[1]!)

  // Method definitions
  const methodMatch = cleaned.match(/(?:public|private|protected|static)?\s*(\w+)\s*\(/)
  if (methodMatch && !symbols.includes(methodMatch[1]!)) symbols.push(methodMatch[1]!)

  // Variable assignments that might be significant
  const varMatch = cleaned.match(/(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/)
  if (varMatch && !symbols.includes(varMatch[1]!)) symbols.push(varMatch[1]!)

  return symbols
}

/** Analyze a diff and extract semantic change information. */
export function analyzeSemanticDiff(
  oldText: string,
  newText: string,
  filePath: string,
  commitHash: string,
): SemanticDiff {
  const patch = structuredPatch(filePath, filePath, oldText, newText, '', '', { context: 0 })

  const allCategories = new Set<SemanticChangeCategory>()
  const behavioralChanges: SemanticDiff['behavioralChanges'] = []
  const affectedSymbols = new Set<string>()

  for (const hunk of patch.hunks) {
    const hunkCategories = new Set<SemanticChangeCategory>()
    const changedSymbols = new Set<string>()
    let changeStart = hunk.newStart

    for (const line of hunk.lines) {
      if (line.startsWith('+') || line.startsWith('-')) {
        const cats = classifyLine(line)
        for (const cat of cats) hunkCategories.add(cat)
        const syms = detectSymbols(line)
        for (const sym of syms) changedSymbols.add(sym)
      }
    }

    if (hunkCategories.size > 0) {
      const primaryCategory = [...hunkCategories][0]!
      const description = generateHunkDescription(hunk.lines, primaryCategory)

      behavioralChanges.push({
        startLine: changeStart,
        endLine: changeStart + hunk.newLines,
        description,
        category: primaryCategory,
      })

      for (const cat of hunkCategories) allCategories.add(cat)
      for (const sym of changedSymbols) affectedSymbols.add(sym)
    }
  }

  // Generate behavioral summary
  const behavioralSummary = generateBehavioralSummary([...allCategories], behavioralChanges, filePath)

  return {
    filePath,
    commitHash,
    categories: [...allCategories],
    behavioralSummary,
    behavioralChanges,
    affectedSymbols: [...affectedSymbols],
  }
}

/** Generate a human-readable description of what a hunk changed. */
function generateHunkDescription(lines: string[], category: SemanticChangeCategory): string {
  const added = lines.filter((l) => l.startsWith('+')).length
  const removed = lines.filter((l) => l.startsWith('-')).length

  const categoryDescriptions: Record<SemanticChangeCategory, string> = {
    control_flow: `Changed control flow (${added} lines added, ${removed} removed)`,
    return_value: `Modified return values or output (${added}+ ${removed}-)`,
    error_handling: `Altered error handling behavior (${added}+ ${removed}-)`,
    auth_change: `Changed authentication/authorization logic (${added}+ ${removed}-)`,
    concurrency: `Modified async/concurrent behavior (${added}+ ${removed}-)`,
    state_mutation: `Changed state mutation patterns (${added}+ ${removed}-)`,
    api_contract: `Modified API contract or interface (${added}+ ${removed}-)`,
    dependency_change: `Changed imports or dependencies (${added}+ ${removed}-)`,
    config_change: `Modified configuration (${added}+ ${removed}-)`,
    type_change: `Changed type definitions (${added}+ ${removed}-)`,
    naming: `Renamed or reorganized identifiers (${added}+ ${removed}-)`,
    dead_code: `Added or removed dead code (${added}+ ${removed}-)`,
    new_code: `Added new code (${added}+ ${removed}-)`,
    removal: `Removed code (${added}+ ${removed}-)`,
  }

  return categoryDescriptions[category] ?? `Changed ${added}+ ${removed}-`
}

/** Generate a behavioral summary of the entire diff. */
function generateBehavioralSummary(
  categories: SemanticChangeCategory[],
  changes: SemanticDiff['behavioralChanges'],
  filePath: string,
): string {
  if (categories.length === 0) {
    return `No significant behavioral changes detected in ${filePath}`
  }

  const parts: string[] = []

  if (categories.includes('control_flow')) parts.push('control flow was altered')
  if (categories.includes('return_value')) parts.push('return values changed')
  if (categories.includes('error_handling')) parts.push('error handling was modified')
  if (categories.includes('auth_change')) parts.push('authentication/authorization changed')
  if (categories.includes('concurrency')) parts.push('async behavior was modified')
  if (categories.includes('state_mutation')) parts.push('state management changed')
  if (categories.includes('api_contract')) parts.push('API contract changed')
  if (categories.includes('dependency_change')) parts.push('dependencies were modified')
  if (categories.includes('config_change')) parts.push('configuration changed')
  if (categories.includes('type_change')) parts.push('type definitions changed')

  return `${filePath}: ${parts.join('; ')}`
}

/** Analyze a commit's diff given the old and new content. */
export function analyzeCommitDiff(
  oldText: string,
  newText: string,
  filePath: string,
  commitHash: string,
): SemanticDiff {
  return analyzeSemanticDiff(oldText, newText, filePath, commitHash)
}

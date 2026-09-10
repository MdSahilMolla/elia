// Rule wiki and narrative explanations for architecture violations.
//
// Every rule the detectors can emit is documented here: why it exists, what it
// protects, the evidence that engages it, and how to remediate. `explainRule`
// drives the prose in reports so the human reader gets consistent, grounded
// rationale instead of hand-written one-offs.

import type { Severity, Violation, ViolationType } from './types.ts'

export interface RuleInfo {
  /** The violation kind this rule describes. */
  kind: ViolationType
  /** Short imperative title, e.g. "Break the dependency cycle". */
  title: string
  /** Lay summary of the rule. */
  summary: string
  /** Why the rule exists and what failure mode it guards against. */
  why: string
  /** Consequence of ignoring it, framed as a risk. */
  impact: string
  /** Recommended remediation steps. */
  howToFix: string
  /** Default severity assigned by the detector. */
  severity: Severity
}

const RULES: Record<ViolationType, RuleInfo> = {
  circular_dependency: {
    kind: 'circular_dependency',
    title: 'Break the dependency cycle',
    summary: 'Modules import one another in a loop, so none can be understood or reused without the others.',
    why: 'A cycle makes modules change together: any edit to one member forces re-verification of all of them, and initialization order becomes fragile.',
    impact: 'Cycles multiply test surface, make refactors risky, and can cause initialization-order bugs at runtime.',
    howToFix: 'Extract the shared types or behavior into a third module and have both ends of the cycle depend on it.',
    severity: 'error',
  },
  import_direction: {
    kind: 'import_direction',
    title: 'Respect layer direction',
    summary: 'A module imported from a layer it is not allowed to feed.',
    why: 'Layered dependency is the contract the architecture documents; an upward import lets low-level code reach into high-level policy, coupling them.',
    impact: 'Soon every high-level change must account for its low-level consumers, reversing the dependency you intended.',
    howToFix: 'Move the imported code into the lower layer, or restructure so the higher layer owns the abstraction and the lower layer depends on it.',
    severity: 'error',
  },
  unresolved_import: {
    kind: 'unresolved_import',
    title: 'Fix the unresolved import',
    summary: 'A specifier cannot be resolved to a file or package.',
    why: 'Either the dependency is missing, misspelled, or the project uses ad-hoc resolution the compiler does not model.',
    impact: 'Silent breakage in another environment, or a future refactor that assumes the import works.',
    howToFix: 'Install the package, correct the specifier, or declare the alias in tsconfig paths.',
    severity: 'warning',
  },
  forbidden_import: {
    kind: 'forbidden_import',
    title: 'Remove the forbidden import',
    summary: 'An explicit configuration rule prohibits this edge.',
    why: 'The architecture says so, in a machine-checked declaration, for a reason captured in the rule.',
    impact: 'The protected boundary erodes; the reason the rule exists will resurface as a concrete bug.',
    howToFix: 'Route the dependency through the allowed surface described in the rule reason.',
    severity: 'error',
  },
  package_boundary_violation: {
    kind: 'package_boundary_violation',
    title: 'Use the package public API',
    summary: 'One package imports another through a path its public API does not expose.',
    why: 'Internal files are not part of the package contract and can change without notice.',
    impact: 'Consumers break when internals move; the whole point of a package boundary is to make that safe.',
    howToFix: 'Import only paths listed in the target package publicApi, or export the needed symbol there.',
    severity: 'error',
  },
  abstraction_leakage: {
    kind: 'abstraction_leakage',
    title: 'Stop reaching into layer internals',
    summary: 'A cross-layer import bypasses the target layer public API.',
    why: 'Layers declare an interface precisely so their internals stay replaceable.',
    impact: 'The layer cannot evolve internally without breaking its callers, contrary to the contract.',
    howToFix: 'Import from the layer public entry instead of its implementation path.',
    severity: 'warning',
  },
  dependency_inversion: {
    kind: 'dependency_inversion',
    title: 'Depend on the interface, not the implementation',
    summary: 'Code reaches a concrete implementation whose declared interface it should depend on.',
    why: 'The architecture declares an interface/implementation pair so callers remain decoupled from the concrete choice.',
    impact: 'Swapping the implementation now requires editing every call site, hardwiring the architecture to one vendor.',
    howToFix: 'Import the interface module and receive the implementation by injection.',
    severity: 'error',
  },
  god_module: {
    kind: 'god_module',
    title: 'Split the god module',
    summary: 'A module coordinates an extreme number of dependencies relative to the codebase.',
    why: 'A fan-out far beyond the average is where change risk concentrates: the module re-writes every time its world changes.',
    impact: 'Merge conflict churn and high cognitive load; every edit risks one of its many dependencies.',
    howToFix: 'Split it into focused sub-modules and let callers compose them.',
    severity: 'warning',
  },
  excessive_coupling: {
    kind: 'excessive_coupling',
    title: 'Decouple the hidden hub',
    summary: 'Many modules across several layers depend on one module.',
    why: 'Because so many dependents fan in, any change to the hub requires coordinated releases across layers.',
    impact: 'The hub becomes a change bottleneck and a single point of re-testing.',
    howToFix: 'Introduce shared abstractions behind the hub and slim its dependents against them.',
    severity: 'warning',
  },
  orphan_module: {
    kind: 'orphan_module',
    title: 'Connect or remove the orphan',
    summary: 'A module with no imports and no dependents participates in nothing.',
    why: 'Either it is dead code, or it is reachable only by convention (mocks, fixtures, entry points).',
    impact: 'It is not exercised by the graph, so tests cannot cover its real integration.',
    howToFix: 'Import it from a real consumer, wire it as an entry point, or delete it.',
    severity: 'info',
  },
  deep_dependency_chain: {
    kind: 'deep_dependency_chain',
    title: 'Shorten the dependency chain',
    summary: 'Transitive dependency depth exceeds the configured comfort limit.',
    why: 'Deep chains mean a small change at the base must be traced through many hops to predict its effect.',
    impact: 'Long propagation delays and surprises where an early ripple surfaces late.',
    howToFix: 'Add a facade between the extremes, or move the shared base upward to flatten the chain.',
    severity: 'info',
  },
}

/** Every documented rule kind in a stable order. */
export function ruleWiki(): RuleInfo[] {
  const order: ViolationType[] = [
    'circular_dependency',
    'import_direction',
    'dependency_inversion',
    'package_boundary_violation',
    'abstraction_leakage',
    'forbidden_import',
    'unresolved_import',
    'god_module',
    'excessive_coupling',
    'orphan_module',
    'deep_dependency_chain',
  ]
  return order.map((k) => RULES[k])
}

/** Look up the explanation for one rule kind. */
export function explainRule(kind: ViolationType): RuleInfo {
  return RULES[kind]
}

export interface ViolationNarrative {
  /** One-line actionable headline. */
  headline: string
  /** Why, in this specific instance, the rule engaged. */
  why: string
  /** The consequence this instance carries. */
  impact: string
}

/**
 * Turn one detected violation into a concrete narrative grounded in the rule
 * wiki plus the edge evidence (source/target/specifier/line).
 */
export function explainViolation(v: Violation): ViolationNarrative {
  const rule = RULES[v.type]
  const where = v.line !== undefined ? ` (line ${v.line})` : ''
  const via = v.specifier ? ` via "${v.specifier}"` : ''
  const route = v.target ? ` from ${v.source} to ${v.target}` : ` on ${v.source}`
  const edge = `${via}${route}${where}`.trim()
  return {
    headline: `${rule.title}.`,
    why: `${rule.summary} ${v.description}${v.why ? ` ${v.why}` : ''}`,
    impact: edge.length > 0 ? `Detected ${edge}. ${rule.impact}` : rule.impact,
  }
}
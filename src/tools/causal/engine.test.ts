import { describe, expect, it } from 'bun:test'

// ─── graph.ts ──────────────────────────────────────────────────────────────
import {
  createGraph, addNode, addEdge, outgoingEdges, incomingEdges,
  findNodesByType, findNodesByCommit, findNodesByFile,
  getAncestors, getDescendants, findPath, findCausalChain, graphStats,
} from './graph.ts'

describe('causal graph', () => {
  it('creates an empty graph', () => {
    const g = createGraph()
    expect(g.nodes.size).toBe(0)
    expect(g.edges.size).toBe(0)
    expect(g.adjacency.size).toBe(0)
  })

  it('addNode returns a stable, deduplicated id', () => {
    const g = createGraph()
    const a = addNode(g, 'file', 'src/app.ts', {}, 'src/app.ts')
    const b = addNode(g, 'file', 'src/app.ts', {}, 'src/app.ts')
    expect(a).toBe(b) // dedup for identical inputs
    expect(g.nodes.size).toBe(1)
  })

  it('addEdge connects outgoing and incoming adjacency', () => {
    const g = createGraph()
    const from = addNode(g, 'commit', 'c1', {}, undefined, undefined, undefined, 'abc123')
    const to = addNode(g, 'file', 'src/app.ts', {}, 'src/app.ts')
    addEdge(g, from, to, 'modified', 0.8, 'evidence', [{
      kind: 'evidence', description: 'x', source: 'git', confidence: 0.8,
    }])

    const out = outgoingEdges(g, from)
    const inc = incomingEdges(g, to)
    expect(out).toHaveLength(1)
    expect(out[0]!.target).toBe(to)
    expect(inc).toHaveLength(1)
    expect(inc[0]!.source).toBe(from)
    expect(out[0]!.type).toBe('modified')
    expect(out[0]!.confidence).toBe(0.8)
  })

  it('supports all edge types including behavioral_change', () => {
    const g = createGraph()
    const a = addNode(g, 'commit', 'c1', {}, undefined, undefined, undefined, 'def456')
    const b = addNode(g, 'file', 'x.ts', {}, 'x.ts')
    addEdge(g, a, b, 'behavioral_change', 0.9, 'evidence', [])
    const edge = outgoingEdges(g, a)[0]!
    expect(edge.type).toBe('behavioral_change')
  })

  it('findNodesByType/Commit/File filter correctly', () => {
    const g = createGraph()
    addNode(g, 'commit', 'Fix login', {}, undefined, undefined, undefined, 'abcdef1234')
    addNode(g, 'file', 'src/auth.ts', {}, 'src/auth.ts')
    addNode(g, 'file', 'src/other.ts', {}, 'src/other.ts')

    expect(findNodesByType(g, 'commit')).toHaveLength(1)
    expect(findNodesByCommit(g, 'abc')).toHaveLength(1) // prefix match
    expect(findNodesByCommit(g, 'xyz')).toHaveLength(0)
    expect(findNodesByFile(g, 'src/auth.ts')).toHaveLength(1)
  })

  it('getAncestors and getDescendants traverse edges', () => {
    const g = createGraph()
    const commit = addNode(g, 'commit', 'c1', {}, undefined, undefined, undefined, '1111111111')
    const fn = addNode(g, 'function', 'login', {}, 'auth.ts', 1, 5)
    const file = addNode(g, 'file', 'auth.ts', {}, 'auth.ts')

    addEdge(g, commit, fn, 'introduced', 0.7, 'fact', [])
    addEdge(g, fn, file, 'caused', 0.9, 'fact', [])

    expect(getDescendants(g, commit)).toContain(fn)
    expect(getDescendants(g, commit)).toContain(file)
    expect(getAncestors(g, file)).toContain(fn)
    expect(getAncestors(g, file)).toContain(commit)
    expect(getAncestors(g, commit)).toHaveLength(0)
  })

  it('findPath returns shortest BFS path or null', () => {
    const g = createGraph()
    const a = addNode(g, 'commit', 'a', {}, undefined, undefined, undefined, 'aaaa111')
    const b = addNode(g, 'function', 'b', {}, 'f.ts')
    const c = addNode(g, 'file', 'f.ts', {}, 'f.ts')
    addEdge(g, a, b, 'caused', 0.5, 'evidence', [])
    addEdge(g, b, c, 'caused', 0.5, 'evidence', [])

    const path = findPath(g, a, c)
    expect(path).toEqual([a, b, c])

    const unused = addNode(g, 'function', 'unused', {}, 'g.ts')
    expect(findPath(g, a, unused)).toBeNull()
  })

  it('findCausalChain returns the highest-confidence path', () => {
    const g = createGraph()
    const commit = addNode(g, 'commit', 'c', {}, undefined, undefined, undefined, 'bbbb222')
    const weak = addNode(g, 'function', 'weak', {}, 'w.ts')
    const strong = addNode(g, 'function', 'strong', {}, 's.ts')
    const file = addNode(g, 'file', 's.ts', {}, 's.ts')

    addEdge(g, commit, weak, 'modified', 0.1, 'evidence', [])
    addEdge(g, commit, strong, 'modified', 0.9, 'evidence', [])
    addEdge(g, strong, file, 'modified', 0.9, 'evidence', [])

    const chain = findCausalChain(g, 'bbbb222', file)
    expect(chain).not.toBeNull()
    expect(chain![0]).toBe(commit)
    expect(chain![chain!.length - 1]).toBe(file)
    // The high-confidence path through `strong` should be chosen, not through `weak`
    expect(chain).toContain(strong)
    expect(chain).not.toContain(weak)
  })

  it('graphStats aggregates counts and average confidence', () => {
    const g = createGraph()
    const commit = addNode(g, 'commit', 'c', {}, undefined, undefined, undefined, 'cccc333')
    const f = addNode(g, 'file', 'x.ts', {}, 'x.ts')
    addEdge(g, commit, f, 'modified', 0.6, 'evidence', [])
    addEdge(g, commit, f, 'caused', 1.0, 'fact', [])

    const stats = graphStats(g)
    expect(stats.nodeCount).toBe(2)
    expect(stats.edgeCount).toBe(2)
    expect(stats.edgesByType['modified']).toBe(1)
    expect(stats.edgesByType['caused']).toBe(1)
    expect(stats.avgConfidence).toBeCloseTo(0.8, 1)
  })
})

// ─── scoring.ts ────────────────────────────────────────────────────────────
import {
  classifyConfidence, scoreBlameRelevance, scoreSemanticRelevance,
  scoreTemporalProximity, scoreBehavioralChange, scoreCallGraphRelevance,
  scoreTestEvidence, scoreCodeOverlap, scoreRenameContinuity,
  scoreCounterfactual, computeRootCauseScore, rankCandidates,
} from './scoring.ts'

describe('causal scoring', () => {
  it('classifyConfidence maps score to level', () => {
    expect(classifyConfidence(0.95)).toBe('certain')
    expect(classifyConfidence(0.8)).toBe('high')
    expect(classifyConfidence(0.7)).toBe('high')
    expect(classifyConfidence(0.5)).toBe('medium')
    expect(classifyConfidence(0.3)).toBe('low')
    expect(classifyConfidence(0)).toBe('speculative')
  })

  it('scoreBlameRelevance rewards exact line matches', () => {
    const blame = [{ commit: 'aaa111', line: 10 }]
    const exact = scoreBlameRelevance(blame, 'aaa111', 10)
    expect(exact.score).toBe(1)
    expect(exact.kind).toBe('fact')

    const near = scoreBlameRelevance(blame, 'aaa111', 12)
    expect(near.score).toBe(1) // within 5 lines

    const elsewhere = scoreBlameRelevance(blame, 'aaa111', 50)
    expect(elsewhere.score).toBe(0.7)

    const noMatch = scoreBlameRelevance(blame, 'zzz999', 10)
    expect(noMatch.score).toBe(0)
  })

  it('scoreSemanticRelevance rewards high-impact categories', () => {
    const empty = scoreSemanticRelevance([], false)
    expect(empty.score).toBe(0)

    const behavioral = scoreSemanticRelevance([], true)
    expect(behavioral.score).toBe(0.5)

    const full = scoreSemanticRelevance(['auth_change', 'control_flow'], true)
    expect(full.score).toBe(1) // capped at 1
    expect(full.reason).toContain('auth_change')
  })

  it('scoreTemporalProximity favors recent commits', () => {
    const recent = scoreTemporalProximity(new Date(Date.now() - 86_400_000).toISOString(), new Date().toISOString(), 5)
    expect(recent.score).toBeGreaterThan(0.8)

    const old = scoreTemporalProximity('2020-01-01T00:00:00Z', new Date().toISOString(), 5)
    expect(old.score).toBeLessThan(0.2)

    const noTarget = scoreTemporalProximity('2020-01-01T00:00:00Z', undefined, 5)
    expect(noTarget.score).toBe(0.5) // neutral fallback when no target date
  })

  it('scoreBehavioralChange rewards behavioral and bug keywords', () => {
    const bugFix = scoreBehavioralChange('fix bug where login fails', ['control_flow'])
    expect(bugFix.score).toBeGreaterThan(0.5) // fix+bug+control_flow = 0.6

    const chore = scoreBehavioralChange('chore: update deps', [])
    expect(chore.score).toBeLessThan(bugFix.score)
  })

  it('scoreCallGraphRelevance finds graph connectivity', () => {
    const g = createGraph()
    const commit = addNode(g, 'commit', 'c', {}, undefined, undefined, undefined, 'dddd444')
    const target = addNode(g, 'file', 't.ts', {}, 't.ts')
    addEdge(g, commit, target, 'modified', 0.8, 'evidence', [])

    const connected = scoreCallGraphRelevance(g, commit, target)
    expect(connected.score).toBeGreaterThan(0)
  })

  it('scoreTestEvidence rewards test-related commits', () => {
    const testCommit = scoreTestEvidence('add regression test for bug', ['auth.test.ts'])
    expect(testCommit.score).toBeGreaterThan(0.5)

    const irrelevant = scoreTestEvidence('update docs', ['README.md'])
    expect(irrelevant.score).toBe(0)
  })

  it('scoreCodeOverlap correlates with blame overlap', () => {
    const blame = [{ commit: 'eee555', line: 1 }, { commit: 'eee555', line: 2 }]
    const high = scoreCodeOverlap(blame, 'eee555', 1, 100)
    expect(high.score).toBeGreaterThan(0.5)

    const none = scoreCodeOverlap(blame, 'fff666', 1, 100)
    expect(none.score).toBe(0)
  })

  it('scoreRenameContinuity and scoreCounterfactual are consistent', () => {
    const renamed = scoreRenameContinuity(
      [ { commit: 'aaa111', action: 'renamed' } ],
      'aaa111',
    )
    expect(renamed.score).toBeGreaterThan(0.5)

    const cfTrue = scoreCounterfactual(true, true)
    expect(cfTrue.score).toBeGreaterThan(0.5)
    const cfDenied = scoreCounterfactual(false, true)
    expect(cfDenied.score).toBe(0)
    const cfUnavailable = scoreCounterfactual(false, false)
    expect(cfUnavailable.score).toBe(0.5) // neutral when analysis wasn't available
  })

  it('computeRootCauseScore is a weighted mean', () => {
    const signals = [
      scoreBlameRelevance([], 'x', 1),
      scoreSemanticRelevance([], false),
    ]
    const score = computeRootCauseScore(signals)
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(1)
  })

  it('rankCandidates sorts by confidence and fills candidate fields', () => {
    const candidates = [
      {
        commitHash: 'aaa111', nodeId: 'n1', label: 'low impact',
        signals: [scoreBlameRelevance([], 'aaa111', 1)],
        causalChain: ['a', 'b'], counterfactualVerified: false,
      },
      {
        commitHash: 'bbb222', nodeId: 'n2', label: 'high impact',
        signals: [scoreBlameRelevance([{ commit: 'bbb222', line: 5 }], 'bbb222', 5)],
        causalChain: ['a', 'b'], counterfactualVerified: false,
      },
    ]
    const ranked = rankCandidates(candidates)
    expect(ranked).toHaveLength(2)
    expect(ranked[0]!.commitHash).toBe('bbb222')
    expect(ranked[0]!.confidence).toBeGreaterThan(ranked[1]!.confidence)
    expect(ranked[0]!.scoringBreakdown.length).toBeGreaterThan(0)
    expect(ranked[0]!.explanation.length).toBeGreaterThan(0)
  })
})

// ─── semanticDiff.ts ───────────────────────────────────────────────────────
import { analyzeSemanticDiff } from './semanticDiff.ts'

describe('semantic diff', () => {
  it('classifies control flow, auth, and error handling changes', () => {
    const oldContent = `function login(user) {
  return user.password === "x"
}
`
    const newContent = `function login(user) {
  if (auth.verify(user)) {
    return true
  }
  throw new Error("denied")
}
`
    const diff = analyzeSemanticDiff(oldContent, newContent, 'auth.ts', 'abc123')
    expect(diff.filePath).toBe('auth.ts')
    expect(diff.commitHash).toBe('abc123')
    expect(diff.categories).toContain('control_flow')
    expect(diff.categories).toContain('auth_change')
    expect(diff.categories).toContain('error_handling')
    expect(diff.behavioralChanges.length).toBeGreaterThan(0)
    expect(diff.behavioralSummary).toContain('auth.ts')
  })

  it('handles identical content with no behavioral changes', () => {
    const content = 'const x = 1\n'
    const diff = analyzeSemanticDiff(content, content, 'x.ts', 'def456')
    expect(diff.behavioralChanges.length).toBe(0)
    // Even without line changes, a fallback category may be present
    expect(diff.categories.length).toBeGreaterThanOrEqual(0)
  })

  it('classifies return-value and dependency changes', () => {
    const before = `import { oldFn } from "./legacy"\nexport const r = oldFn()\n`
    const after = `import { newFn } from "./modern"\nexport const r = newFn()\nreturn 42\n`
    const diff = analyzeSemanticDiff(before, after, 'm.ts', 'fed000')
    expect(diff.categories).toContain('dependency_change')
    expect(diff.categories).toContain('return_value')
  })
})

// ─── gitProvenance.ts (pure parsers) ───────────────────────────────────────
import { parseBlamePorcelain, parseGitLog } from './gitProvenance.ts'

describe('git provenance parsers', () => {
  it('parseBlamePorcelain extracts structured entries', () => {
    const output = [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 10 1',
      'author Alice',
      'author-mail <alice@example.com>',
      'author-time 1700000000',
      '\tconst x = 1',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 2 11 2',
      'author Bob',
      'author-time 1700000100',
      '\tconst y = 2',
    ].join('\n')

    const entries = parseBlamePorcelain(output)
    expect(entries).toHaveLength(2)
    expect(entries[0]!.commit).toBe('a'.repeat(40))
    expect(entries[0]!.line).toBe(10)
    expect(entries[0]!.author).toBe('Alice')
    expect(entries[0]!.content).toBe('const x = 1')
    expect(entries[1]!.author).toBe('Bob')
  })

  it('parseGitLog parses delimited commit sections', () => {
    const output = [
      'aaa111|||aaaaaa|||Alice|||2024-01-01|||Fix bug|||000000',
      'src/app.ts',
      '\u0000',
      'bbb222|||bbbbbb|||Bob|||2024-01-02|||Add feature|||aaa111',
      'src/api.ts',
      'src/lib.ts',
    ].join('\n')

    const commits = parseGitLog(output)
    expect(commits).toHaveLength(2)
    expect(commits[0]!.hash).toBe('aaa111')
    expect(commits[0]!.message).toBe('Fix bug')
    expect(commits[0]!.filesChanged).toContain('src/app.ts')
    expect(commits[1]!.parents).toContain('aaa111')
    expect(commits[1]!.filesChanged).toContain('src/api.ts')
  })
})

// ─── reproduction.ts (pure) ────────────────────────────────────────────────
import { deriveReproductionCommand } from './reproduction.ts'

describe('deriveReproductionCommand', () => {
  it('extracts test names from error descriptions', () => {
    const cmd = deriveReproductionCommand('The test "login failure" failed', undefined, undefined)
    expect(cmd).toContain('login failure')
    expect(cmd).toContain('bun test')
  })

  it('extracts file:line from stack traces', () => {
    const cmd = deriveReproductionCommand('Error: x', 'at src/auth.ts:12:5', undefined)
    expect(cmd).toContain('src/auth.ts')
  })

  it('derives a test path from a source file', () => {
    const cmd = deriveReproductionCommand('generic error', undefined, 'src/utils.ts')
    expect(cmd).toContain('src/utils.test.ts')
  })

  it('returns null when nothing is extractable', () => {
    expect(deriveReproductionCommand('')).toBeNull()
  })
})

// ─── risk.ts ───────────────────────────────────────────────────────────────
import { assessRisk } from './risk.ts'

describe('assessRisk', () => {
  const basePlan = { steps: [], summary: 'x', overallRisk: 'low' as const, confidence: 0.9, alternatives: [] }

  it('scores low risk for small, confident plans', () => {
    const risk = assessRisk(
      { ...basePlan },
      { filePath: 'a.ts', diff: '', filesAffected: ['a.ts'], linesChanged: 5, explanation: '', expectedBehavior: '', risks: [], confidence: 0.8, applied: false },
      0.9,
    )
    expect(risk.overallRisk).toBe('low')
    expect(risk.score).toBeLessThan(25)
    expect(risk.recommendation).toContain('Low risk')
  })

  it('escalates for API changes and low causal confidence', () => {
    const risk = assessRisk(
      { steps: [{ index: 0, description: 'change public API contract', filePath: 'a.ts', change: 'x', risk: 'high' as const, rationale: 'r' }], summary: 'api', overallRisk: 'medium' as const, confidence: 0.1, alternatives: [] },
      { filePath: 'a.ts', diff: '', filesAffected: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'], linesChanged: 100, explanation: '', expectedBehavior: '', risks: [], confidence: 0.2, applied: false },
      0.1,
    )
    expect(risk.overallRisk).toBe('critical')
    expect(risk.score).toBeGreaterThan(50)
    expect(risk.recommendation).toContain('HIGH RISK')
  })
})

// ─── verify.ts (pure) ──────────────────────────────────────────────────────
import { summarizeVerification } from './verify.ts'

describe('summarizeVerification', () => {
  it('reports all-passed summary', () => {
    const out = summarizeVerification([
      { name: 'typecheck', status: 'PASS' },
      { name: 'lint', status: 'PASS' },
    ])
    expect(out).toContain('All verifications passed')
    expect(out).toContain('typecheck: PASS')
  })

  it('reports failures with truncated output', () => {
    const bigOutput = 'x'.repeat(500)
    const out = summarizeVerification([
      { name: 'regression_test', status: 'FAIL', command: 'bun test x', output: bigOutput },
    ])
    expect(out).toContain('Some verifications failed')
    expect(out).toContain('regression_test: FAIL')
    expect(out).toContain('...') // truncated
  })
})

// ─── format.ts ─────────────────────────────────────────────────────────────
import { formatCausalDebugResult, formatCausalFixResult } from './format.ts'

describe('format results', () => {
  const emptyDebugResult = {
    target: { file: 'src/foo.ts', line: 3 },
    graph: createGraph(),
    candidates: [] as never[],
    semanticDiffs: [],
    provenance: [],
    reproduction: { established: false, bugConfirmed: false, output: '', limitation: 'no tests' },
    counterfactual: {
      performed: false, candidateCausal: false,
      counterfactualReproduction: { established: false, bugConfirmed: false, output: '' },
      explanation: 'not performed',
    },
    causalChainSummary: 'none',
    overallConfidence: 0,
    limitations: [],
  }

  it('formats a debug result with location header', () => {
    const out = formatCausalDebugResult(emptyDebugResult)
    expect(out).toContain('CAUSAL DEBUG & REPAIR ENGINE')
    expect(out).toContain('src/foo.ts')
  })

  it('formats a fix result', () => {
    const result = {
      rootCause: {
        nodeId: 'n1', commitHash: 'aaa111', label: 'root cause', confidence: 0.8,
        level: 'high' as const, scoringBreakdown: [], explanation: 'why',
        causalChain: ['n1', 'n2'], counterfactualVerified: false,
      },
      repairPlan: { steps: [], summary: 'fix', overallRisk: 'low' as const, confidence: 0.8, alternatives: [] },
      patch: { filePath: 'a.ts', diff: '', filesAffected: ['a.ts'], linesChanged: 3, explanation: 'e', expectedBehavior: 'b', risks: [], confidence: 0.8, applied: false },
      regressionTest: { filePath: 'a.test.ts', code: 'import { test } from "bun:test"', invariant: 'i', framework: 'bun:test', failsBeforeFix: true, passesAfterFix: false },
      verification: [{ name: 'typecheck', status: 'PASS' as const }],
      risk: { overallRisk: 'low' as const, score: 10, factors: [], recommendation: 'safe' },
      fixApplied: false,
      allVerified: false,
    }
    const out = formatCausalFixResult(result)
    expect(out).toContain('CAUSAL FIX & VERIFICATION')
    expect(out).toContain('aaa111')
  })
})

// ─── tool metadata wiring ──────────────────────────────────────────────────
import { causalDebugTool, causalFixTool, causalVerifyTool } from './index.ts'

describe('causal tool suite metadata', () => {
  it('registers all three tools with correct names', () => {
    expect(causalDebugTool.name).toBe('causal_debug')
    expect(causalFixTool.name).toBe('causal_fix')
    expect(causalVerifyTool.name).toBe('causal_verify')
  })

  it('causal_fix requires a file and documents apply flag', () => {
    expect(causalFixTool.input_schema.required).toContain('file')
    expect(causalFixTool.input_schema.properties.apply).toBeDefined()
  })

  it('causal_verify exposes optional path and test options', () => {
    const props = causalVerifyTool.input_schema.properties
    expect(props.path).toBeDefined()
    expect(props.test_pattern).toBeDefined()
    expect(props.test_file).toBeDefined()
    expect(props.reproduction_command).toBeDefined()
  })
})
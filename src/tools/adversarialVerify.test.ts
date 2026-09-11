import { describe, expect, it } from 'bun:test'
import { parseDiff, classifyEdgeCase, classifyExploitVector, adversarialAnalyze, formatReport } from './adversarialVerify.ts'

const DIFF = `diff --git a/src/auth.ts b/src/auth.ts
index 123..456 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,4 +1,6 @@
 const userInput = req.body.username
+const id = parseInt(req.body.id)
+const html = "<div>" + userInput + "</div>"
+document.getElementById("app").innerHTML = html
+await fetch("/api/order", { method: "POST", body: JSON.stringify(id) })`;

describe('parseDiff', () => {
  it('attributes added lines to their file', () => {
    const blocks = parseDiff(DIFF)
    expect(blocks.length).toBe(1)
    expect(blocks[0]!.path).toBe('src/auth.ts')
    expect(blocks[0]!.addedLines).toContain('const id = parseInt(req.body.id)')
    expect(blocks[0]!.addedLines).not.toContain('+++ b/src/auth.ts')
  })

  it('parses multi-file diffs', () => {
    const blocks = parseDiff(DIFF + '\ndiff --git a/src/other.ts b/src/other.ts\n--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1 +1 @@\n+exec("rm -rf /")\n')
    expect(blocks.length).toBe(2)
    expect(blocks[1]!.path).toBe('src/other.ts')
  })
})

describe('classifyEdgeCase', () => {
  it('flags injection for innerHTML', () => {
    const ec = classifyEdgeCase('document.body.innerHTML = evil', 'src/x.ts')!
    expect(ec.type).toBe('injection')
    expect(ec.severity).toBe('critical')
  })

  it('flags shell exec for injection', () => {
    const ec = classifyEdgeCase('exec(cmd, { shell: true })', 'src/x.ts')!
    expect(ec.type).toBe('injection')
    expect(ec.severity).toBe('critical')
  })

  it('flags numeric ops as overflow', () => {
    const ec = classifyEdgeCase('const total = Number(a) + b', 'src/x.ts')!
    expect(ec.type).toBe('overflow')
  })

  it('returns null for benign code', () => {
    expect(classifyEdgeCase('export const x = 1', 'src/x.ts')).toBeNull()
  })
})

describe('classifyExploitVector', () => {
  it('flags unsanitized request data', () => {
    const ev = classifyExploitVector('const q = req.query.term', 'src/routes.ts')!
    expect(ev.type).toBe('input-validation')
    expect(ev.mitigation).toContain('Validate')
  })

  it('ignores sanitized request data', () => {
    expect(classifyExploitVector('const q = sanitize(req.query.term)', 'src/routes.ts')).toBeNull()
  })

  it('flags permissive CORS', () => {
    const ev = classifyExploitVector('res.setHeader("Access-Control-Allow-Origin", "*")', 'src/server.ts')!
    expect(ev.type).toBe('cors')
  })
})

describe('adversarialAnalyze', () => {
  it('scores risk and dedupes identical findings', () => {
    const report = adversarialAnalyze(DIFF)
    expect(report.riskScore).toBeGreaterThan(0)
    expect(report.edgeCases.length).toBeGreaterThan(0)
    expect(report.diffLines).toBeGreaterThan(0)
    expect(report.summary).toContain('Risk score')
  })

  it('respects minSeverity filter', () => {
    const all = adversarialAnalyze(DIFF, { minSeverity: 'low' })
    const critical = adversarialAnalyze(DIFF, { minSeverity: 'critical' })
    expect(critical.edgeCases.every((e) => e.severity === 'critical')).toBe(true)
    expect(critical.edgeCases.length).toBeLessThanOrEqual(all.edgeCases.length)
  })

  it('returns empty report for clean diff', () => {
    const report = adversarialAnalyze('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n+export const x = 1\n')
    expect(report.edgeCases).toEqual([])
    expect(report.exploitVectors).toEqual([])
    expect(report.riskScore).toBe(0)
  })

  it('is deterministic', () => {
    expect(adversarialAnalyze(DIFF)).toEqual(adversarialAnalyze(DIFF))
  })
})

describe('formatReport', () => {
  it('warns on high risk', () => {
    const text = formatReport({ target: 'x', diffLines: 5, edgeCases: [], exploitVectors: [], riskScore: 90, summary: 's' })
    expect(text).toContain('HIGH RISK')
  })

  it('signals clean diffs', () => {
    const text = formatReport({ target: 'x', diffLines: 0, edgeCases: [], exploitVectors: [], riskScore: 0, summary: 's' })
    expect(text).toContain('No adversarial issues')
  })
})
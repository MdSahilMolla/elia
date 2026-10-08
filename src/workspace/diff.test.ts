import { describe, expect, it } from 'bun:test'

import {
  diffCounts,
  parseUnifiedDiff,
  renderUnifiedDiff,
  shouldWithholdDiffBody,
  WITHHELD_NOTICE,
} from './diff.ts'

type Marker = ' ' | '+' | '-'

/** Builds a unified diff body from per-line markers. */
function body(entries: Marker[]): string {
  const head = '--- a/src/app.ts\n+++ b/src/app.ts\n'
  const content = entries.map((m) => `${m}${m === ' ' ? 'line' : 'changed'}`).join('\n')
  const oldCount = entries.filter((m) => m !== '+').length
  const newCount = entries.filter((m) => m !== '-').length
  return `${head}@@ -1,${oldCount} +1,${newCount} @@\n${content}\n`
}

describe('parseUnifiedDiff', () => {
  it('reads hunk headers with and without explicit counts', () => {
    const withCount = parseUnifiedDiff('a.ts', body([' ', '+', '-']))
    expect(withCount.hunks).toHaveLength(1)
    expect(withCount.hunks[0]?.oldLines).toBe(2)
    expect(withCount.hunks[0]?.newLines).toBe(2)

    const bare = parseUnifiedDiff('a.ts', '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n')
    expect(bare.hunks[0]?.oldLines).toBe(1)
    expect(bare.hunks[0]?.newLines).toBe(1)
  })

  it('tracks old and new line numbers independently', () => {
    const parsed = parseUnifiedDiff('a.ts', '--- a/a.ts\n+++ b/a.ts\n@@ -10,3 +20,3 @@\n ctx\n-gone\n+here\n ctx2\n')
    const lines = parsed.hunks[0]?.lines ?? []
    expect(lines[0]).toMatchObject({ kind: 'context', oldLine: 10, newLine: 20 })
    expect(lines[1]).toMatchObject({ kind: 'remove', oldLine: 11 })
    expect(lines[2]).toMatchObject({ kind: 'add', newLine: 21 })
    expect(lines[3]).toMatchObject({ kind: 'context', oldLine: 12, newLine: 22 })
  })

  it('takes the path from the header, stripping a/ and b/', () => {
    expect(parseUnifiedDiff('fallback.ts', '--- a/src/deep/name.ts\n+++ b/src/deep/name.ts\n@@ -1 +1 @@\n-a\n+b\n').path)
      .toBe('src/deep/name.ts')
  })

  it('marks a creation and a deletion from /dev/null', () => {
    const created = parseUnifiedDiff('n.ts', '--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n')
    expect(created.isNewFile).toBe(true)
    expect(created.isDeleted).toBe(false)

    const deleted = parseUnifiedDiff('d.ts', '--- a/d.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n')
    expect(deleted.isDeleted).toBe(true)
    expect(deleted.isNewFile).toBe(false)
  })

  it('reports binary content rather than pretending there is no change', () => {
    const parsed = parseUnifiedDiff('logo.png', 'Binary files a/logo.png and b/logo.png differ\n')
    expect(parsed.binary).toBe(true)
    expect(parsed.hunks).toHaveLength(0)
  })

  it('notes a missing trailing newline on the last line', () => {
    const parsed = parseUnifiedDiff('a.txt', '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n')
    const lines = parsed.hunks[0]?.lines ?? []
    expect(lines[0]?.noNewline).toBe(true)
    expect(lines[1]?.noNewline).toBe(true)
  })

  it('does not treat the trailing newline as a context line', () => {
    const parsed = parseUnifiedDiff('a.ts', body([' ', '+']))
    expect(diffCounts(parsed)).toEqual({ added: 1, removed: 0 })
  })

  it('keeps multiple hunks apart', () => {
    const parsed = parseUnifiedDiff(
      'a.ts',
      '--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n@@ -50,1 +50,1 @@\n-c\n+d\n',
    )
    expect(parsed.hunks).toHaveLength(2)
    expect(parsed.hunks[1]?.oldStart).toBe(50)
  })

  it('counts additions and removals exactly', () => {
    expect(diffCounts(parseUnifiedDiff('a.ts', body([' ', '+', '+', '-'])))).toEqual({ added: 2, removed: 1 })
  })

  it('does not flag a whole-file deletion as a rewrite', () => {
    const entries: Marker[] = Array.from({ length: 300 }, () => '-' as const)
    expect(parseUnifiedDiff('gone.ts', body(entries)).degenerate).toBe(false)
  })

  it('flags a wholesale replacement, which is what the engine falls back to', () => {
    const entries: Marker[] = [
      ...Array.from({ length: 200 }, () => '-' as const),
      ...Array.from({ length: 200 }, () => '+' as const),
    ]
    const parsed = parseUnifiedDiff('rewritten.ts', body(entries))
    expect(parsed.degenerate).toBe(true)
    expect(diffCounts(parsed)).toEqual({ added: 200, removed: 200 })
  })

  it('does not flag an ordinary edit that happens to be large', () => {
    const entries: Marker[] = [
      ...Array.from({ length: 120 }, () => '-' as const),
      ' ',
      ...Array.from({ length: 120 }, () => '+' as const),
    ]
    expect(parseUnifiedDiff('bigEdit.ts', body(entries)).degenerate).toBe(false)
  })
})

describe('renderUnifiedDiff', () => {
  it('summarises the change in the first line', () => {
    // The path comes from the diff header, not the caller's guess, so the two
    // sides of a feed agree on which file the counts belong to.
    const out = renderUnifiedDiff(parseUnifiedDiff('a.ts', body([' ', '+', '-'])), { color: false })
    expect(out.split('\n')[0]).toBe('src/app.ts +1 -1')
  })

  it('elides unchanged runs instead of printing them', () => {
    const entries: Marker[] = [...Array.from({ length: 30 }, () => ' ' as const), '+', ...Array.from({ length: 30 }, () => ' ' as const)]
    const out = renderUnifiedDiff(parseUnifiedDiff('a.ts', body(entries)), { color: false, context: 1 })
    expect(out).toContain('unchanged lines elided')
    // 3 lines of context either side of the single change, not 60.
    const rendered = out.split('\n').filter((l) => l.startsWith('+') || l.startsWith('-') || l.startsWith(' ')).length
    expect(rendered).toBeLessThan(10)
  })

  it('shows changes only when context is zero', () => {
    const out = renderUnifiedDiff(parseUnifiedDiff('a.ts', body([' ', '+', ' '])), { color: false, context: 0 })
    // The single change is shown in full and the untouched lines either side
    // collapse to elision markers, so nothing claims to be a context line.
    expect(out.split('\n')).toEqual([
      'src/app.ts +1 -0',
      '  @@ -1,2 +1,3 @@',
      '  … 1 unchanged lines elided',
      '+2 changed',
      '  … 3 unchanged lines elided',
    ])
  })

  it('replaces a rewrite with a one-line notice and keeps exact counts', () => {
    const entries: Marker[] = [
      ...Array.from({ length: 200 }, () => '-' as const),
      ...Array.from({ length: 200 }, () => '+' as const),
    ]
    const out = renderUnifiedDiff(parseUnifiedDiff('rewritten.ts', body(entries)), { color: false })
    expect(out).toContain('rewritten wholesale')
    expect(out).toContain('+200 -200')
    expect(out.split('\n')).toHaveLength(2)
  })

  it('says so for binary content instead of showing nothing', () => {
    const out = renderUnifiedDiff(parseUnifiedDiff('logo.png', 'Binary files differ\n'), { color: false })
    expect(out).toContain('binary content changed')
  })

  it('does not emit color when color is off', () => {
    const out = renderUnifiedDiff(parseUnifiedDiff('a.ts', body(['+'])), { color: false })
    expect(out).not.toMatch(/\[/)
  })
})

describe('shouldWithholdDiffBody', () => {
  it('withholds for paths that store secrets', () => {
    for (const p of ['.env', 'src/.env.local', '.ssh/config', 'id_rsa', 'deploy.pem', 'secrets.json', 'token']) {
      expect(shouldWithholdDiffBody(p)).toBe(true)
    }
  })

  it('withholds Elia trust files, which are host-side policy', () => {
    expect(shouldWithholdDiffBody('.elia/policy.json')).toBe(true)
    expect(shouldWithholdDiffBody('.elia/allow.json')).toBe(true)
    expect(shouldWithholdDiffBody('.elia/preauth.secret')).toBe(true)
  })

  it('allows ordinary project source through', () => {
    for (const p of ['src/app.ts', 'README.md', 'package.json', 'src/token.ts', 'src/tokens.css', '.env.example']) {
      expect(shouldWithholdDiffBody(p)).toBe(false)
    }
  })

  it('offers a notice a reader can act on', () => {
    expect(WITHHELD_NOTICE).toBe('changed (contents withheld)')
  })
})
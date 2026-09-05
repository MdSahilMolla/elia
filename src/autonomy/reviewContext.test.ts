import { expect, test } from 'bun:test'
import { REVIEW_DIFF_LIMIT, buildReviewDiffSection, parseNumstat, renderChangedFiles } from './reviewContext.ts'

const NUMSTAT = ['12\t3\tsrc/a.ts', '0\t40\tsrc/b.ts', '-\t-\tlogo/icon.png'].join('\n')

test('parses numstat, keeping binary files in the inventory', () => {
  // Binary changes report "-" counts but are still changes a reviewer must see.
  expect(parseNumstat(NUMSTAT)).toEqual([
    { path: 'src/a.ts', added: 12, removed: 3 },
    { path: 'src/b.ts', added: 0, removed: 40 },
    { path: 'logo/icon.png', added: 0, removed: 0 },
  ])
})

test('a rename resolves to the path a reviewer can actually open', () => {
  expect(parseNumstat('4\t2\tsrc/old.ts => src/new.ts')).toEqual([{ path: 'src/new.ts', added: 4, removed: 2 }])
  expect(parseNumstat('4\t2\tsrc/{old => new}/file.ts')).toEqual([{ path: 'src/new/file.ts', added: 4, removed: 2 }])
})

test('ignores blank and malformed lines instead of inventing files', () => {
  expect(parseNumstat('\n\nnot-a-numstat-line\n')).toEqual([])
})

test('renders one line per file, and says so plainly when there are none', () => {
  expect(renderChangedFiles(parseNumstat(NUMSTAT))).toBe(
    ['- src/a.ts (+12 −3)', '- src/b.ts (+0 −40)', '- logo/icon.png (+0 −0)'].join('\n'),
  )
  expect(renderChangedFiles([])).toBe('(no files changed against HEAD)')
})

test('a small diff is passed through whole, with the inventory attached', () => {
  const section = buildReviewDiffSection({ diff: 'diff --git a/src/a.ts b/src/a.ts\n+one line\n', numstat: NUMSTAT })
  expect(section.truncated).toBe(false)
  expect(section.text).toContain('+one line')
  expect(section.text).toContain('## Files changed (3)')
  expect(section.text).not.toContain('TRUNCATED')
})

test('a clamped diff names every file it could not show, and forbids approving around it', () => {
  // This is the failure the section exists to prevent: clampOutput removes the
  // middle, so whole files vanish, and a reviewer who does not know they existed
  // approves a change it never saw.
  const huge = `diff --git a/src/a.ts b/src/a.ts\n${'+ a line of change\n'.repeat(2000)}`
  const section = buildReviewDiffSection({ diff: huge, numstat: NUMSTAT })

  expect(section.truncated).toBe(true)
  expect(section.text).toContain('TRUNCATED')
  // The inventory survives the clamp because it is built from numstat.
  for (const path of ['src/a.ts', 'src/b.ts', 'logo/icon.png']) expect(section.text).toContain(path)
  expect(section.text).toContain('is UNREVIEWED')
  expect(section.text).toContain('rather than approving around it')
})

test('the truncation notice appears only when the diff was actually cut', () => {
  const justUnder = 'x'.repeat(REVIEW_DIFF_LIMIT)
  expect(buildReviewDiffSection({ diff: justUnder, numstat: NUMSTAT }).truncated).toBe(false)
  expect(buildReviewDiffSection({ diff: `${justUnder}yy`, numstat: NUMSTAT }).truncated).toBe(true)
})

test('an empty diff is reported as such rather than as an empty section', () => {
  const section = buildReviewDiffSection({ diff: '   \n', numstat: '' })
  expect(section.files).toEqual([])
  expect(section.text).toContain('no diff against HEAD')
  expect(section.text).toContain('(no files changed against HEAD)')
})

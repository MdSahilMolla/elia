import { describe, expect, it } from 'bun:test'

import {
  buildFileChangedPayload,
  describeFileChange,
  fileChangeFromPayload,
  renderFileChangeBody,
  type IncomingFileChange,
} from './fileChange.ts'

const edit: IncomingFileChange = {
  path: 'src/app.ts',
  op: 'write',
  originNode: 'node-b',
  oldSha: 'aaa',
  newSha: 'bbb',
  added: 2,
  removed: 1,
  size: 120,
  diff: '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,4 @@\n ctx\n-old\n+new\n+more\n ctx2\n',
}

describe('buildFileChangedPayload', () => {
  it('keeps the change metadata', () => {
    const meta = buildFileChangedPayload(edit)
    expect(meta).toEqual({
      path: 'src/app.ts',
      op: 'write',
      originNode: 'node-b',
      oldSha: 'aaa',
      newSha: 'bbb',
      added: 2,
      removed: 1,
      size: 120,
      diffWithheld: false,
    })
  })

  it('cannot carry a diff body, because no returned field can hold one', () => {
    // The safety property, asserted structurally rather than by inspecting one
    // value: the persisted shape has exactly these keys and no string field
    // large enough to be a diff.
    const meta = buildFileChangedPayload(edit)
    expect(Object.keys(meta).sort()).toEqual(
      ['added', 'diffWithheld', 'newSha', 'oldSha', 'op', 'originNode', 'path', 'removed', 'size'].sort(),
    )
    expect(JSON.stringify(meta)).not.toContain('@@')
  })

  it('drops the body even when the sidecar supplied one', () => {
    expect('diff' in buildFileChangedPayload(edit)).toBe(false)
    expect('binary' in buildFileChangedPayload(edit)).toBe(false)
  })

  it('marks a sensitive path withheld whatever the sidecar sent', () => {
    const leaked = buildFileChangedPayload({ ...edit, path: '.env', diff: 'SECRET=1' })
    expect(leaked.diffWithheld).toBe(true)
    expect(JSON.stringify(leaked)).not.toContain('SECRET')
  })

  it('marks Elia trust files withheld, which isSensitivePath alone does not do', () => {
    for (const path of ['.elia/policy.json', '.elia/allow.json', '.elia/preauth.secret']) {
      expect(buildFileChangedPayload({ ...edit, path }).diffWithheld).toBe(true)
    }
  })

  it('replaces non-numeric counts rather than persisting NaN', () => {
    const meta = buildFileChangedPayload({ ...edit, added: Number.NaN, removed: Number.NaN, size: Number.NaN })
    expect(meta).toMatchObject({ added: 0, removed: 0, size: 0 })
    expect(JSON.stringify(meta)).not.toContain('null')
  })
})

describe('fileChangeFromPayload', () => {
  it('round-trips a persisted payload', () => {
    const meta = buildFileChangedPayload(edit)
    expect(fileChangeFromPayload({ ...meta })).toEqual(meta)
  })

  it('tolerates an older payload that only had a path', () => {
    expect(fileChangeFromPayload({ path: 'src/legacy.ts' })).toMatchObject({
      path: 'src/legacy.ts',
      op: 'write',
      originNode: 'unknown',
      added: 0,
      diffWithheld: false,
    })
  })

  it('returns undefined when there is no path at all', () => {
    expect(fileChangeFromPayload({ op: 'write' })).toBeUndefined()
  })
})

describe('describeFileChange', () => {
  it('reports counts and the node that made the change', () => {
    expect(describeFileChange(buildFileChangedPayload(edit))).toBe('write  src/app.ts +2 −1  node-b')
  })

  it('reports a deletion as removals only', () => {
    const meta = buildFileChangedPayload({ ...edit, op: 'delete', added: 0, removed: 42 })
    expect(describeFileChange(meta)).toContain('−42')
    expect(describeFileChange(meta)).not.toContain('+0')
  })

  it('says why a sensitive path has no body', () => {
    const meta = buildFileChangedPayload({ ...edit, path: '.env' })
    expect(describeFileChange(meta)).toContain('changed (contents withheld)')
  })
})

describe('renderFileChangeBody', () => {
  it('renders the diff for an ordinary path', () => {
    const out = renderFileChangeBody(edit)
    expect(out).toContain('src/app.ts +2 -1')
    expect(out).toContain('@@')
  })

  it('withholds at the last moment, even if a caller passed the body through', () => {
    // Defence in depth: buildFileChangedPayload already withheld it, and this
    // re-checks at display so a second call path cannot leak it.
    expect(renderFileChangeBody({ ...edit, path: '.env', diff: 'SECRET=1' })).toBe('changed (contents withheld)')
    expect(renderFileChangeBody({ ...edit, path: '.elia/preauth.secret', diff: 'key' })).toBe('changed (contents withheld)')
  })

  it('says so for binary content instead of showing an empty diff', () => {
    expect(renderFileChangeBody({ ...edit, diff: '', binary: true })).toBe('binary content changed')
  })

  it('says so when counts arrived with no body', () => {
    expect(renderFileChangeBody({ ...edit, diff: '' })).toBe('no textual change')
  })
})
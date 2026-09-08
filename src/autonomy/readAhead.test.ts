import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReadAhead } from './readAhead.ts'

function fixture(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'elia-readahead-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  for (const name of ['a', 'b', 'c', 'd']) {
    writeFileSync(join(dir, 'src', `${name}.ts`), `export const ${name} = ${JSON.stringify(name.repeat(50))}\n`)
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const read = (dir: string) => async (path: string) => {
  const fs = await import('node:fs/promises')
  return fs.readFile(join(dir, path), 'utf8')
}

test('expands the rest of a grep worklist when the model opens one hit', async () => {
  const { dir, cleanup } = fixture()
  try {
    const ra = createReadAhead(dir)
    ra.observe([
      {
        name: 'grep',
        input: { pattern: 'export' },
        result: ['src/a.ts:1:export const a', 'src/b.ts:1:export const b', 'src/c.ts:1:export const c', 'src/d.ts:1:export const d'].join('\n'),
      },
    ])

    const expansion = await ra.expand([{ name: 'read_file', input: { path: 'src/a.ts' } }], read(dir))
    expect(expansion).toBeDefined()
    // a.ts was the model's own read; the other three come forward.
    expect(new Set(expansion!.paths)).toEqual(new Set(['src/b.ts', 'src/c.ts', 'src/d.ts']))
    expect(expansion!.text).toContain('===== src/b.ts =====')
    expect(expansion!.text).toContain('export const d')
  } finally {
    cleanup()
  }
})

test('does not fire for a batch that also writes', async () => {
  const { dir, cleanup } = fixture()
  try {
    const ra = createReadAhead(dir)
    ra.observe([{ name: 'list_files', input: { pattern: 'src/**' }, result: 'src/a.ts\nsrc/b.ts\nsrc/c.ts' }])
    const expansion = await ra.expand(
      [
        { name: 'read_file', input: { path: 'src/a.ts' } },
        { name: 'edit_file', input: { path: 'src/a.ts' } },
      ],
      read(dir),
    )
    expect(expansion).toBeUndefined()
  } finally {
    cleanup()
  }
})

test('never re-shows a file the model already read', async () => {
  const { dir, cleanup } = fixture()
  try {
    const ra = createReadAhead(dir)
    ra.observe([{ name: 'list_files', input: { pattern: 'src/**' }, result: 'src/a.ts\nsrc/b.ts\nsrc/c.ts\nsrc/d.ts' }])
    ra.observe([{ name: 'read_file', input: { path: 'src/b.ts' }, result: 'export const b' }])

    const expansion = await ra.expand([{ name: 'read_file', input: { path: 'src/a.ts' } }], read(dir))
    expect(expansion!.paths).not.toContain('src/b.ts')
    expect(new Set(expansion!.paths)).toEqual(new Set(['src/c.ts', 'src/d.ts']))
  } finally {
    cleanup()
  }
})

test('a file the model has since edited is not pulled forward', async () => {
  const { dir, cleanup } = fixture()
  try {
    const ra = createReadAhead(dir)
    ra.observe([{ name: 'grep', input: { pattern: 'x' }, result: 'src/a.ts:1:x\nsrc/b.ts:1:x\nsrc/c.ts:1:x\nsrc/d.ts:1:x' }])
    ra.observe([{ name: 'edit_file', input: { path: 'src/c.ts' }, result: 'ok' }])

    const expansion = await ra.expand([{ name: 'read_file', input: { path: 'src/a.ts' } }], read(dir))
    expect(expansion!.paths).not.toContain('src/c.ts')
  } finally {
    cleanup()
  }
})

test('stays quiet when fewer than two other worklist files remain', async () => {
  const { dir, cleanup } = fixture()
  try {
    const ra = createReadAhead(dir)
    ra.observe([{ name: 'grep', input: { pattern: 'x' }, result: 'src/a.ts:1:x\nsrc/b.ts:1:x' }])
    const expansion = await ra.expand([{ name: 'read_file', input: { path: 'src/a.ts' } }], read(dir))
    expect(expansion).toBeUndefined()
  } finally {
    cleanup()
  }
})

test('is bounded per loop', async () => {
  const { dir, cleanup } = fixture()
  try {
    const ra = createReadAhead(dir)
    let fired = 0
    for (let i = 0; i < 20; i++) {
      ra.observe([{ name: 'grep', input: { pattern: 'x' }, result: 'src/a.ts:1:x\nsrc/b.ts:1:x\nsrc/c.ts:1:x\nsrc/d.ts:1:x' }])
      // Force the worklist to look fresh each round by re-observing the search.
      const expansion = await ra.expand([{ name: 'read_file', input: { path: `src/a.ts` } }], read(dir))
      if (expansion) fired += 1
    }
    // MAX_EXPANSIONS_PER_LOOP is 8.
    expect(fired).toBeLessThanOrEqual(8)
  } finally {
    cleanup()
  }
})

test('skips unreadable paths without throwing', async () => {
  const { dir, cleanup } = fixture()
  try {
    writeFileSync(join(dir, 'src', 'locked.ts'), 'export const locked = 1\n')
    const ra = createReadAhead(dir)
    ra.observe([{ name: 'grep', input: { pattern: 'x' }, result: 'src/a.ts:1:x\nsrc/b.ts:1:x\nsrc/locked.ts:1:x\nsrc/c.ts:1:x\nsrc/d.ts:1:x' }])
    const expansion = await ra.expand([{ name: 'read_file', input: { path: 'src/a.ts' } }], async (p) => {
      if (p.includes('locked')) throw new Error('EACCES')
      return read(dir)(p)
    })
    expect(expansion!.paths).not.toContain('src/locked.ts')
    expect(expansion!.paths.length).toBeGreaterThanOrEqual(2)
  } finally {
    cleanup()
  }
})

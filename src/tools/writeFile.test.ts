import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAgentIdentity } from '../autonomy/context.ts'
import { resetFileAccess } from './fileAccess.ts'
import { readFileTool } from './readFile.ts'
import { MAX_WRITE_BYTES, writeFileTool } from './writeFile.ts'

let dir: string

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'elia-write-')))
  resetFileAccess()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(input: Record<string, unknown>, signal?: AbortSignal) {
  return withAgentIdentity({ name: 'test', role: 'lead', cwd: dir, signal }, () => writeFileTool.execute(input))
}

function markRead(path: string) {
  return withAgentIdentity({ name: 'test', role: 'lead', cwd: dir }, () => readFileTool.execute({ path }))
}

test('creating a brand-new file works with no prior read', async () => {
  const path = join(dir, 'new.txt')
  await write({ path, content: 'hello\n' })
  expect(readFileSync(path, 'utf8')).toBe('hello\n')
})

test('content over the size cap is refused before anything touches disk', async () => {
  const path = join(dir, 'huge.txt')
  await expect(write({ path, content: 'x'.repeat(MAX_WRITE_BYTES + 1) })).rejects.toThrow('byte limit')
  expect(existsSync(path)).toBe(false)
  // The cap counts bytes, not UTF-16 code units: multi-byte text is measured as written.
  await expect(write({ path, content: 'é'.repeat(MAX_WRITE_BYTES / 2 + 1) })).rejects.toThrow('byte limit')
})

test('a file whose name really starts with a space stays addressable', async () => {
  writeFileSync(join(dir, ' spaced.txt'), 'old\n')
  await markRead(' spaced.txt')
  await write({ path: ' spaced.txt', content: 'new\n' })
  expect(readFileSync(join(dir, ' spaced.txt'), 'utf8')).toBe('new\n')
  // ...while stray whitespace around an ordinary path is still forgiven.
  await write({ path: '  plain.txt\n', content: 'p\n' })
  expect(readFileSync(join(dir, 'plain.txt'), 'utf8')).toBe('p\n')
})

// --- Lost-update / concurrent-modification protection (mirrors edit_file's guard) ---
//
// write_file has no old_string to go stale against, so a real "two sub-agents
// raced" test can't reliably force the exact interleaving that trips the
// guard — timing between real async fs calls isn't something a test should
// depend on. Instead this deterministically simulates the race at the one
// point it matters: the tool calls `Bun.file(path)` exactly twice — once for
// its initial read, once for the re-read guard right before writing — so a
// write lands (from a stand-in "concurrent writer") in between those two
// calls, exactly like a parallel sub-agent's write would.

test('a write is rejected when the file changes between this call\'s own read and its write', async () => {
  const path = join(dir, 'race.txt')
  writeFileSync(path, 'original\n')
  await markRead(path)

  const realBunFile = Bun.file.bind(Bun)
  let callsForPath = 0
  const originalFile = Bun.file
  const patched = (p: string, options?: BlobPropertyBag) => {
    const handle = realBunFile(p, options)
    if (p === path) {
      callsForPath += 1
      if (callsForPath === 2) {
        // This is write_file's re-read guard. Land a concurrent write right
        // before it reads, so the guard sees content that differs from what
        // this call's own initial read captured.
        const realText = handle.text.bind(handle)
        handle.text = async () => {
          writeFileSync(path, 'a concurrent writer got here first\n')
          return realText()
        }
      }
    }
    return handle
  }
  // @ts-expect-error - test-only monkeypatch of a global (narrower signature than Bun.file's full overload set), restored in `finally`
  Bun.file = patched

  try {
    await expect(write({ path, content: 'my update\n' })).rejects.toThrow(/changed on disk/)
  } finally {
    Bun.file = originalFile
  }
  // The concurrent writer's content survives — this call's own update never landed.
  expect(readFileSync(path, 'utf8')).toBe('a concurrent writer got here first\n')
})

test('an unmodified file (read, then written back unchanged in between) writes through normally', async () => {
  const path = join(dir, 'stable.txt')
  writeFileSync(path, 'stable content\n')
  await markRead(path)
  await write({ path, content: 'updated content\n' })
  expect(readFileSync(path, 'utf8')).toBe('updated content\n')
})

// --- Cancellation ---

test('an already-aborted run cancels the write before writing', async () => {
  const path = join(dir, 'c.txt')
  const controller = new AbortController()
  controller.abort()
  await expect(write({ path, content: 'changed' }, controller.signal)).rejects.toThrow(/cancelled|aborted/i)
  expect(() => readFileSync(path, 'utf8')).toThrow()
})

// --- Sensitive paths ---

test('refuses to overwrite a non-empty protected file', async () => {
  const path = join(dir, '.env')
  writeFileSync(path, 'SECRET=1\n')
  await expect(write({ path, content: 'SECRET=2\n' })).rejects.toThrow(/protected path/)
  expect(readFileSync(path, 'utf8')).toBe('SECRET=1\n')
})

// A file too long for one response is written in parts.

test('a file written in parts: partial skips the syntax check, append adds to the end, the last part checks the whole file', async () => {
  const path = join(dir, 'big.ts')
  expect(await write({ path, content: 'export function f() {\n', partial: true })).toContain('partial')
  expect(await write({ path, content: '  return 1\n', append: true, partial: true })).toContain('Appended to')
  await write({ path, content: '}\n', append: true })
  expect(readFileSync(path, 'utf8')).toBe('export function f() {\n  return 1\n}\n')
})

test('append adds to an unread file without the overwrite guard, and creates a missing one', async () => {
  const path = join(dir, 'log.txt')
  writeFileSync(path, 'one\n')
  await write({ path, content: 'two\n', append: true })
  expect(readFileSync(path, 'utf8')).toBe('one\ntwo\n')
  const fresh = join(dir, 'fresh.txt')
  expect(await write({ path: fresh, content: 'x', append: true })).toContain('Created')
})

test('append and partial must be booleans', async () => {
  await expect(write({ path: join(dir, 'a.txt'), content: 'x', append: 'yes' })).rejects.toThrow('append must be')
  await expect(write({ path: join(dir, 'a.txt'), content: 'x', partial: 1 })).rejects.toThrow('partial must be')
})

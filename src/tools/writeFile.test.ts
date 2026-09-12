import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAgentIdentity } from '../autonomy/context.ts'
import { resetFileAccess } from './fileAccess.ts'
import { readFileTool } from './readFile.ts'
import { writeFileTool } from './writeFile.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-write-'))
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

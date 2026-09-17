import { expect, test } from 'bun:test'
import { Glob } from 'bun'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// A scripted edit once wrote a raw backspace (0x08) where a regex needed the
// two characters `\b`. The file still parsed, and /402/ quietly stopped
// matching a 402 in the provider fallback and the evolve fitness gate for
// weeks. Other control characters do turn up on purpose (an ESC in an ANSI
// test, a NUL in a binary fixture); a backspace never has.
const BACKSPACE = String.fromCharCode(8)

test('no source file carries a raw backspace', () => {
  const root = join(import.meta.dir)
  const offenders: string[] = []
  for (const path of new Glob('**/*.{ts,tsx}').scanSync({ cwd: root })) {
    const text = readFileSync(join(root, path), 'utf8')
    const at = text.indexOf(BACKSPACE)
    if (at >= 0) offenders.push(`${path}:${text.slice(0, at).split('\n').length}`)
  }
  expect(offenders).toEqual([])
})

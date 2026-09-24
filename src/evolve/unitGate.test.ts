import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-unit-gate-test'

const { failingTestFiles } = await import('./engine.ts')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-unit-gate-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('the failing files are read from what the gate saw when generation 7 was rejected', () => {
  const output = [
    'src/battmann/store.test.ts:',
    '[battmann] audit reconciliation found row(s) with no corresponding audit_log entry',
    '',
    'src/tools/presentation.test.ts:',
    '(fail) presentation rejects output paths outside the current repository [151452.86ms]',
    '  ^ this test timed out after 5000ms.',
    ' 3474 pass',
    ' 1 fail',
  ].join('\n')
  // A file that only logged is not a failing file.
  expect(failingTestFiles(output)).toEqual(['src/tools/presentation.test.ts'])
})

test('it reads real bun test output, and never hands back a path outside the tree', async () => {
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'ok.test.ts'), "import { test, expect } from 'bun:test'\ntest('fine', () => expect(1).toBe(1))\n")
  writeFileSync(join(dir, 'src', 'bad.test.ts'), "import { test, expect } from 'bun:test'\ntest('broken', () => expect(1).toBe(2))\n")
  const proc = Bun.spawn(['bun', 'test'], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  expect(failingTestFiles(`${out}\n${err}`)).toEqual(['src/bad.test.ts'])
  expect(failingTestFiles('/etc/x.test.ts:\n(fail) a\n../up.test.ts:\n(fail) b\n')).toEqual([])
}, 60_000)

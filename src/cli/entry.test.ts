import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

/**
 * The flags that must work before anything else does.
 *
 * `--help`, `-h` and `--version` are the only entry points that have to succeed
 * with no provider configured and no session on disk, and they are the ones a
 * refactor breaks without noticing: splitting `printHelp` out of index.ts moved
 * the guards that *call* it into the new module, where `--help` silently fell
 * through to the REPL and `--version` read `new URL('../package.json')` relative
 * to a directory one level deeper — a file that does not exist. Typecheck was
 * clean through all of it.
 *
 * So this spawns the real binary. Nothing short of that would have caught it.
 */
const BIN = fileURLToPath(new URL('../../bin/elia.ts', import.meta.url))

async function run(...args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bun', BIN, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1', ELIA_API_KEY: 'entry-test-placeholder' },
  })
  const out = await new Response(proc.stdout).text()
  const code = await proc.exited
  return { code, out }
}

test('--help prints usage and exits cleanly, without starting a session', async () => {
  const { code, out } = await run('--help')
  expect(code).toBe(0)
  expect(out).toContain('Usage:')
  expect(out).toContain('elia')
  // The REPL draws a box; help must never reach it.
  expect(out).not.toContain('┌─ elia')
}, 30_000)

test('-h is the same door as --help', async () => {
  const { code, out } = await run('-h')
  expect(code).toBe(0)
  expect(out).toContain('Usage:')
}, 30_000)

test('--version prints the package version and nothing else', async () => {
  const pkg = await Bun.file(fileURLToPath(new URL('../../package.json', import.meta.url))).json()
  const { code, out } = await run('--version')
  expect(code).toBe(0)
  expect(out.trim()).toBe(pkg.version)
}, 30_000)

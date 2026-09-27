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

/**
 * Every subcommand must reach a handler.
 *
 * `SUBCOMMANDS` is what the argument parser recognises; the switch in `main` is
 * what actually runs something. Nothing ties the two together, so a name can be
 * added to one and not the other — and the failure is silent, because an
 * unmatched `subcommand` falls to `default` and opens the REPL. That is exactly
 * how `--help` broke when it was split out: the flag was still recognised and
 * quietly did the wrong thing.
 *
 * Spawning twenty-two processes to check this would be slow and most of them do
 * real work, so this reads the dispatcher instead. Crude, and it catches the
 * whole class.
 */
test('every recognised subcommand has a case in the dispatcher', async () => {
  const { SUBCOMMANDS } = await import('./argv.ts')
  const source = await Bun.file(fileURLToPath(new URL('../index.ts', import.meta.url))).text()
  const dispatcher = source.slice(source.indexOf('async function main'))
  const missing = SUBCOMMANDS.filter((name) => !dispatcher.includes(`case '${name}':`))
  expect(missing).toEqual([])
})

// `elia workspace --help` — which the global help tells you to run — used to
// print the global help: `--help` was answered before the command was read.
test('<command> --help is that command\'s help, not the whole manual', async () => {
  const auto = await run('auto', '--help')
  expect(auto.code).toBe(0)
  expect(auto.out).toContain('Usage: elia auto')
  expect(auto.out).toContain('--unattended')
  expect(auto.out).not.toContain('Battmann intelligence')

  const workspace = await run('workspace', '--help')
  expect(workspace.code).toBe(0)
  expect(workspace.out).toContain('elia workspace serve')
  expect(workspace.out).not.toContain('Autonomous work:')

  const battmann = await run('battmann', '--help')
  expect(battmann.code).toBe(0)
  expect(battmann.out).toContain('Usage: elia battmann <command>')
}, 60_000)

test('-v after a command is not a request for the version', async () => {
  const pkg = await Bun.file(fileURLToPath(new URL('../../package.json', import.meta.url))).json()
  const { out } = await run('bench', '-v', '--help')
  expect(out.trim()).not.toBe(pkg.version)
  expect(out).toContain('Usage: elia bench')
}, 30_000)

test('every recognised subcommand is documented in --help', async () => {
  const { SUBCOMMANDS } = await import('./argv.ts')
  const { helpFor } = await import('./help.ts')
  const undocumented = SUBCOMMANDS.filter((name) => helpFor(name) === undefined)
  expect(undocumented).toEqual([])
})

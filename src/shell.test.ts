import { afterEach, expect, test } from 'bun:test'
import { isLongRunningServerCommand, runProcess, runShell, shellCommandAlternative } from './shell.ts'
import { resetContainerSandboxWarningForTests } from './sandbox/container.ts'

afterEach(() => {
  delete process.env.ELIA_SANDBOX
  delete process.env.ELIA_SANDBOX_IMAGE
  resetContainerSandboxWarningForTests()
})

test.if(process.platform === 'win32')('a cmd.exe builtin like mkdir runs even when PATH is broken', async () => {
  // The failure this guards: `Bun.spawn(['cmd', ...])` -> ENOENT when System32
  // is missing from PATH, which took out every shell command. runShell now
  // resolves cmd via %ComSpec%, so a stripped PATH still works.
  const original = process.env.PATH
  try {
    process.env.PATH = 'C:\\nonexistent'
    const dir = `elia-shell-test-${Date.now()}`
    const result = await runShell(`mkdir ${dir} && rmdir ${dir}`, 10_000, process.env.TEMP)
    expect(result.exitCode).toBe(0)
  } finally {
    process.env.PATH = original
  }
})

test('ELIA_SANDBOX=container falls back to host execution when the sandbox is unconfigured (docker unavailable and/or no image set) — runShell still completes', async () => {
  process.env.ELIA_SANDBOX = 'container'
  delete process.env.ELIA_SANDBOX_IMAGE // never guesses an image, so this alone forces a fallback
  const result = await runShell('echo elia-shell-ok', 10_000)
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('elia-shell-ok')
})

test('echo through the shell returns its output', async () => {
  const result = await runShell('echo elia-shell-ok', 10_000)
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('elia-shell-ok')
})

test('terminates timed-out shell work and returns timeout evidence', async () => {
  const result = await runShell(process.platform === 'win32' ? 'ping 127.0.0.1 -n 3' : 'sleep 0.2', 30)
  expect(result.timedOut).toBe(true)
  // Windows taskkill /T closes the complete process tree but can take slightly
  // over two seconds on a loaded runner. Keep the bound strict and platform-realistic.
  expect(result.elapsedMs).toBeLessThan(process.platform === 'win32' ? 3_000 : 2_000)
})

test('direct process arguments are not interpreted as shell syntax', async () => {
  const literal = 'elia literal & whoami'
  const result = await runProcess({
    executable: process.execPath,
    args: ['-e', 'console.log(process.argv.at(-1))', '--', literal],
    timeoutMs: 10_000,
  })
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain(literal)
})

test('cancels shell work cooperatively', async () => {
  const controller = new AbortController()
  const pending = runShell(process.platform === 'win32' ? 'ping 127.0.0.1 -n 3 > nul' : 'sleep 0.2', 2_000, undefined, controller.signal)
  await Bun.sleep(20)
  controller.abort()
  const result = await pending
  expect(result.stderr).toContain('cancelled')
})

// 30k lines of an 11-byte payload is ~360KB on Windows ("xxxxxxxxxx\r\n") and
// ~330KB elsewhere ("xxxxxxxxxx\n") — unambiguously past MAX_SHELL_OUTPUT_LENGTH
// (200,000), so the "omitted" marker is guaranteed. The previous "yes x | head
// -n 100000" produced exactly 200,000 bytes on Linux, right on the boundary
// where `totalLength > limit` is false and no marker is appended.
//
// The explicit test timeout must stay well above the shell timeout passed to
// runShell: when they were both 5_000 the harness raced the command's own
// deadline and this test failed roughly half the time on Windows.
test('bounds large shell output', async () => {
  const command = process.platform === 'win32'
    ? 'for /L %i in (1,1,30000) do @echo xxxxxxxxxx'
    : 'yes xxxxxxxxxx | head -n 30000'
  const result = await runShell(command, 10_000)
  expect(result.stdout.length).toBeLessThanOrEqual(200_100)
  expect(result.stdout).toContain('characters omitted')
}, 30_000)

// Run 2026-09-13-l0av-rnq0 spent eight actions on `ls`, `pwd`, `rm`,
// `Get-Location`, `Get-ChildItem` and `Get-Content`, each rejected with
// "<name> is not available in PATH — fix the missing environment or ask the
// user to take over". The environment was fine; the commands were from another
// shell. Reported that way, `classifyStuck` reads it as a broken machine.
test('a POSIX command on Windows is explained, not reported as a broken environment', () => {
  for (const name of ['ls', 'pwd', 'cat', 'rm', 'which']) {
    const message = shellCommandAlternative(name, 'win32')
    expect(message).toBeDefined()
    expect(message).toContain('not a broken environment')
  }
})

test('a PowerShell cmdlet on Windows is explained', () => {
  expect(shellCommandAlternative('Get-ChildItem', 'win32')).toContain('PowerShell cmdlet')
  expect(shellCommandAlternative('Get-Location', 'win32')).toContain('PowerShell cmdlet')
})

// A genuinely missing tool must keep the original message — "install it" is
// the right answer there, and claiming otherwise would hide a real problem.
test('a genuinely missing tool gets no substitute advice', () => {
  for (const name of ['cargo', 'docker', 'terraform', 'some-tool']) {
    expect(shellCommandAlternative(name, 'win32')).toBeUndefined()
  }
})

// An ordinary hyphenated binary is not a cmdlet.
test('a hyphenated binary is not mistaken for a cmdlet', () => {
  expect(shellCommandAlternative('tree-sitter', 'win32')).toBeUndefined()
  expect(shellCommandAlternative('docker-compose', 'win32')).toBeUndefined()
})

test('POSIX platforms are untouched', () => {
  for (const name of ['ls', 'pwd', 'Get-ChildItem']) {
    expect(shellCommandAlternative(name, 'linux')).toBeUndefined()
  }
})

test('a dev server is recognised but a build or test is not', () => {
  for (const command of ['bun run dev', 'npm start', 'vite', 'next dev', 'python -m http.server', 'serve']) {
    expect(isLongRunningServerCommand(command)).toBe(true)
  }
  for (const command of ['bun run build', 'npm test', 'tsc --noEmit', 'bun install', 'cargo build', 'docker compose up -d']) {
    expect(isLongRunningServerCommand(command)).toBe(false)
  }
})

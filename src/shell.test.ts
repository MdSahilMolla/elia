import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { escapeShellArg, isLongRunningServerCommand, mayStartServer, runProcess, runShell, shellCommandAlternative } from './shell.ts'
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

// Session mu0a7she-x8eipw: every command with a double quote reached cmd.exe
// with each `"` turned into `\"`. `echo "Testing file path"` printed the
// backslashes, `dir "D:\…\"` failed with "The filename, directory name, or
// volume label syntax is incorrect", and `powershell -Command "…"` echoed its
// own script instead of running it.
test('double quotes reach the shell untouched', async () => {
  const result = await runShell('echo "two words"', 10_000)
  expect(result.exitCode).toBe(0)
  expect(result.stdout.trim()).toBe(process.platform === 'win32' ? '"two words"' : 'two words')
})

test('a quoted path with spaces and a trailing backslash can be read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'elia shell quoting '))
  try {
    await writeFile(join(dir, 'page.html'), '<h1>ok</h1>')
    const listing = process.platform === 'win32' ? `dir "${dir}\\"` : `ls "${dir}/"`
    const listed = await runShell(listing, 10_000)
    expect(listed.exitCode).toBe(0)
    expect(listed.stdout).toContain('page.html')
    const read = await runShell(`${process.platform === 'win32' ? 'type' : 'cat'} "${join(dir, 'page.html')}"`, 10_000)
    expect(read.exitCode).toBe(0)
    expect(read.stdout).toContain('<h1>ok</h1>')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test.if(process.platform === 'win32')('powershell -Command "…" runs the script instead of echoing it', async () => {
  const result = await runShell(`powershell -NoProfile -Command "Write-Output ('ok' + 'ay')"`, 30_000)
  expect(result.exitCode).toBe(0)
  expect(result.stdout.trim()).toBe('okay')
}, 40_000)

test.if(process.platform === 'win32')('a nested cmd /c "…" is recognised as a command', async () => {
  const result = await runShell('cmd /c "echo nested"', 10_000)
  expect(result.exitCode).toBe(0)
  expect(result.stdout.trim()).toBe('nested')
})

test('ELIA_SANDBOX=container falls back to host execution when the sandbox is unconfigured (docker unavailable and/or no image set) — runShell still completes', async () => {
  process.env.ELIA_SANDBOX = 'container'
  delete process.env.ELIA_SANDBOX_IMAGE // never guesses an image, so this alone forces a fallback
  const result = await runShell('echo elia-shell-ok', 10_000)
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('elia-shell-ok')
})

test('A2-08: an env-scoped command still honors the container sandbox path, falling back only when docker cannot run it', async () => {
  // Before the fix, `containerSandboxRequested() && !env` silently skipped the
  // sandbox for every env-scoped command (workspace-scoped PATH overrides,
  // node_modules .bin prepends) and ran it on the bare host instead. With no
  // image configured the container path must be attempted and only docker's
  // own unavailability (ContainerUnavailable) may fall back — which still
  // completes, exactly like the no-env case above.
  process.env.ELIA_SANDBOX = 'container'
  delete process.env.ELIA_SANDBOX_IMAGE
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  const result = await runShell('echo env-scoped-sandbox-ok', 10_000, undefined, undefined, env)
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('env-scoped-sandbox-ok')
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

// #1268: a shell-arg escaper must make `"; touch pwned` / `$(…)` payloads one
// literal argument, never a new command segment.
test('escapeShellArg keeps an injection payload literal', () => {
  expect(escapeShellArg('simple', 'linux')).toBe("'simple'")
  expect(escapeShellArg("it's", 'linux')).toBe("'it'\\''s'")
  // cmd.exe: every metacharacter, quotes included, is caret-escaped, so an
  // embedded quote can never end a quoted region and let `&` start a command.
  expect(escapeShellArg('simple', 'win32')).toBe('^"simple^"')
  expect(escapeShellArg('a" & calc & "b', 'win32')).toBe('^"a\\^"^ ^&^ calc^ ^&^ \\^"b^"')
  expect(escapeShellArg('%PATH%', 'win32')).toBe('^"^%PATH^%^"')
  expect(escapeShellArg('dir\\', 'win32')).toBe('^"dir\\\\^"')
})

test.if(process.platform === 'win32')('an escaping payload passed to cmd.exe cannot break out', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'elia-shell-escape-win-'))
  try {
    for (const payload of ['a" & echo pwned> pwned.txt & "b', '%PATH%', 'x|y<z>w', '^caret!bang', 'C:\\dir with space\\', 'q\\"q']) {
      const result = await runShell(`"${process.execPath}" -e "process.stdout.write(process.argv.at(-1))" ${escapeShellArg(payload)}`, 20_000, dir)
      expect(result.exitCode, payload).toBe(0)
      expect(result.stdout, payload).toBe(payload)
    }
    expect(await Bun.file(join(dir, 'pwned.txt')).exists()).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test.if(process.platform !== 'win32')('an escaping payload passed to a shell cannot break out', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'elia-shell-escape-'))
  try {
    const payload = 'a"; touch pwned; echo "$(id)'
    const result = await runShell(`printf '%s' ${escapeShellArg(payload)}`, 10_000, dir)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(payload)
    expect(await Bun.file(join(dir, 'pwned')).exists()).toBe(false)

    const dollar = '$(mkdir dollar-pwned)'
    const quoted = await runShell(`printf '%s' ${escapeShellArg(dollar)}`, 10_000, dir)
    expect(quoted.stdout).toBe(dollar)
    expect(await Bun.file(join(dir, 'dollar-pwned')).exists()).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
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

test('the servers Python apps are started with are recognised, however they are launched', () => {
  for (const command of [
    'streamlit run app.py --server.headless true',
    'python -m streamlit run app.py',
    'python manage.py runserver',
    'python3 src/manage.py runserver 0.0.0.0:8000',
    'gradio app.py',
    'panel serve app.py',
    'fastapi dev main.py',
    'uv run uvicorn main:app',
    'python -m flask run',
    'PORT=3000 npm run dev',
    './node_modules/.bin/vite --port 3000',
    'npm install && npm run dev',
    'docker compose up --build',
  ]) {
    expect(isLongRunningServerCommand(command)).toBe(true)
  }
})

// The list used to match a server's name anywhere in the line, so installing
// one read as starting it, and run_command refused `pip install uvicorn`.
test('installing or building with a server package is not starting a server', () => {
  for (const command of [
    'pip install uvicorn',
    'pip install gunicorn flask',
    'uv add uvicorn',
    'npm install serve',
    'python -m pip install streamlit gradio',
    'vite build',
    'npx vite build',
    'docker compose up --build -d',
    'serverless deploy',
  ]) {
    expect(isLongRunningServerCommand(command)).toBe(false)
  }
})

test('an app entrypoint may start a server, and is not a dev server by name alone', () => {
  for (const command of ['python app.py', 'python app.py --port 5000', 'node server.js', 'bun run src/server.ts', 'python3 backend/main.py']) {
    expect(mayStartServer(command)).toBe(true)
    expect(isLongRunningServerCommand(command)).toBe(false)
  }
  for (const command of ['python -m pytest', 'python scripts/seed.py', 'node build.js']) {
    expect(mayStartServer(command)).toBe(false)
  }
})

test('a go test binary that died without naming a test gets a hint; a normal failure does not', async () => {
  const { failureHint, formatShellResult } = await import('./shell.ts')
  // The exact output a Go CLI run spent every repair attempt on.
  const silent = 'exit status 1\nFAIL\twordfreq\t0.733s\nFAIL\n'
  expect(failureHint(silent)).toContain('os.Exit')
  expect(failureHint(silent)).toContain('go test -v')
  const verbose = '=== RUN   TestCountWords\n--- PASS: TestCountWords (0.00s)\n=== RUN   TestMainArgumentParsing/no_args\nexit status 1\nFAIL\twordfreq\t0.609s\n'
  expect(failureHint(verbose)).toContain('TestMainArgumentParsing/no_args')
  expect(failureHint('--- FAIL: TestX (0.00s)\n    x_test.go:9: got 1\nFAIL\nexit status 1\nFAIL\tpkg\t0.1s\n')).toBeUndefined()
  expect(formatShellResult({ command: 'go test ./...', exitCode: 1, stdout: silent, stderr: '', elapsedMs: 1, timedOut: false })).toContain('hint: the Go test binary exited')
  expect(formatShellResult({ command: 'go test ./...', exitCode: 0, stdout: 'ok\twordfreq\t0.2s\n', stderr: '', elapsedMs: 1, timedOut: false })).not.toContain('hint:')
})

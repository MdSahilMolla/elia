import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAgentIdentity } from '../autonomy/context.ts'
import { editFileTool } from './editFile.ts'
import { grepTool } from './grep.ts'
import { listFilesTool } from './listFiles.ts'
import { readFileTool } from './readFile.ts'
import { defaultTimeoutForCommand, runCommandTool } from './runCommand.ts'
import { writeFileTool } from './writeFile.ts'
import { dataScienceTool } from './dataScience.ts'
import { readSpreadsheetTool } from './readSpreadsheet.ts'
import { spreadsheetTool } from './spreadsheet.ts'

const toolsByName = {
  edit_file: editFileTool,
  grep: grepTool,
  list_files: listFilesTool,
  read_file: readFileTool,
  run_command: runCommandTool,
  write_file: writeFileTool,
}

let testDir: string

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), 'elia-test-'))
})

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
})

function executeTool(name: keyof typeof toolsByName, input: Record<string, unknown>) {
  return withAgentIdentity({ name: 'test', role: 'lead', cwd: testDir }, () => toolsByName[name]!.execute(input))
}

test('write_file creates a file', async () => {
  const result = await executeTool('write_file', {
    path: join(testDir, 'hello.txt'),
    content: 'hello from elia',
  })
  expect(result).toContain('hello.txt')
  expect(await Bun.file(join(testDir, 'hello.txt')).text()).toBe('hello from elia')
})

test('write_file rejects a missing path with a clear error instead of a raw Node exception', async () => {
  await expect(executeTool('write_file', { content: 'x' })).rejects.toThrow('non-empty "path"')
})

test('write_file rejects a missing content argument', async () => {
  await expect(executeTool('write_file', { path: join(testDir, 'no-content.txt') })).rejects.toThrow('"content"')
})

test('read_file returns content with line numbers', async () => {
  const result = await executeTool('read_file', { path: join(testDir, 'hello.txt') })
  expect(result).toBe('1\thello from elia')
})

test('read_file throws on missing file', async () => {
  await expect(
    executeTool('read_file', { path: join(testDir, 'does-not-exist.txt') }),
  ).rejects.toThrow('File not found')
})

test('edit_file replaces a unique substring', async () => {
  await executeTool('edit_file', {
    path: join(testDir, 'hello.txt'),
    old_string: 'hello',
    new_string: 'hi',
  })
  expect(await Bun.file(join(testDir, 'hello.txt')).text()).toBe('hi from elia')
})

test('edit_file throws when old_string is not found', async () => {
  await expect(
    executeTool('edit_file', {
      path: join(testDir, 'hello.txt'),
      old_string: 'nonexistent',
      new_string: 'x',
    }),
  ).rejects.toThrow('not found')
})

test('edit_file rejects a missing old_string with a clear error', async () => {
  await expect(
    executeTool('edit_file', { path: join(testDir, 'hello.txt'), new_string: 'x' }),
  ).rejects.toThrow('non-empty "old_string"')
})

test('edit_file rejects a missing new_string with a clear error', async () => {
  await expect(
    executeTool('edit_file', { path: join(testDir, 'hello.txt'), old_string: 'hi' }),
  ).rejects.toThrow('"new_string"')
})

test('edit_file throws when old_string is not unique', async () => {
  const dupPath = join(testDir, 'dup.txt')
  await executeTool('write_file', { path: dupPath, content: 'foo foo' })
  await expect(
    executeTool('edit_file', { path: dupPath, old_string: 'foo', new_string: 'bar' }),
  ).rejects.toThrow('matches 2 locations')
})

test('edit_file replace_all changes every occurrence', async () => {
  const path = join(testDir, 'rename.ts')
  await executeTool('write_file', { path, content: 'const oldName = 1\nreturn oldName + oldName\n' })
  const result = await executeTool('edit_file', { path, old_string: 'oldName', new_string: 'newName', replace_all: true })
  expect(result).toContain('Edited')
  expect(readFileSync(path, 'utf8')).toBe('const newName = 1\nreturn newName + newName\n')
})

test('write_file and edit_file append no LSP suffix for a file type with no configured LSP server', async () => {
  const path = join(testDir, 'notes.txt')
  const written = await executeTool('write_file', { path, content: 'first' })
  expect(written).toContain(`Created ${path}`)
  expect(written).not.toContain('LSP diagnostics')
  const edited = await executeTool('edit_file', { path, old_string: 'first', new_string: 'second' })
  expect(edited).toContain(`Edited ${path}`)
  expect(edited).toContain('-first')
  expect(edited).toContain('+second')
  expect(edited).not.toContain('LSP diagnostics')
})

test('edit_file rejects an edit that would be a no-op', async () => {
  const path = join(testDir, 'noop.txt')
  await executeTool('write_file', { path, content: 'same text' })
  await expect(
    executeTool('edit_file', { path, old_string: 'same text', new_string: 'same text' }),
  ).rejects.toThrow('identical')
})

test('edit_file matches old_string against \\r\\n content even though the model writes plain \\n', async () => {
  const path = join(testDir, 'crlf.txt')
  await Bun.write(path, 'line one\r\nline two\r\nline three')
  const result = await executeTool('edit_file', { path, old_string: 'line one\nline two', new_string: 'line ONE\nline TWO' })
  expect(result).toContain(`Edited ${path}`)
  expect(await Bun.file(path).text()).toBe('line ONE\r\nline TWO\r\nline three')
})

test('edit_file rejects a write when the file changed on disk since it was read', async () => {
  const path = join(testDir, 'race.txt')
  await executeTool('write_file', { path, content: 'original content' })

  // edit_file reads the file's content, computes the edit, then re-reads right
  // before writing to catch a concurrent change in that window. Spy on the first
  // read so it injects a concurrent write before resolving; the recheck then
  // sees the mismatch and refuses.
  const fsp = await import('node:fs/promises')
  const realReadFile = fsp.readFile
  const spy = spyOn(fsp, 'readFile')
  let calls = 0
  spy.mockImplementation((async (...args: Parameters<typeof realReadFile>) => {
    calls += 1
    const value = await (realReadFile as (...a: unknown[]) => Promise<unknown>)(...args)
    if (calls === 1) await Bun.write(path, 'changed by someone else')
    return value
  }) as typeof realReadFile)

  try {
    await expect(
      executeTool('edit_file', { path, old_string: 'original content', new_string: 'my edit' }),
    ).rejects.toThrow('changed on disk')
  } finally {
    spy.mockRestore()
  }
  expect(await Bun.file(path).text()).toBe('changed by someone else')
})

test('write_file refuses to overwrite a non-empty file the agent has not read', async () => {
  const path = join(testDir, 'hand-written.html')
  writeFileSync(path, '<html>\n  <body>precious</body>\n</html>\n')
  await expect(executeTool('write_file', { path, content: 'clobbered' })).rejects.toThrow('has not been read this session')
  // After a read it goes through.
  await executeTool('read_file', { path })
  const result = await executeTool('write_file', { path, content: 'deliberate' })
  expect(result).toContain('Overwrote')
  expect(readFileSync(path, 'utf8')).toBe('deliberate')
})

test('write_file appends no LSP suffix for a recognized-but-uninstalled language server (fails soft)', async () => {
  // gopls is not installed in this environment (see src/lsp/registry.test.ts) —
  // exercises the real "server unavailable" path, not a mock.
  const path = join(testDir, 'main.go')
  const result = await executeTool('write_file', { path, content: 'package main' })
  expect(result).toContain(`Created ${path}`)
  expect(result).not.toContain('LSP diagnostics')
  expect(result).not.toContain('gopls')
})

test('list_files finds files matching a glob', async () => {
  const result = await executeTool('list_files', { pattern: '*.txt', cwd: testDir })
  expect(result).toContain('hello.txt')
})

test('list_files skips node_modules', async () => {
  mkdirSync(join(testDir, 'node_modules'), { recursive: true })
  writeFileSync(join(testDir, 'node_modules', 'ignored.txt'), 'x')
  const result = await executeTool('list_files', { pattern: '**/*.txt', cwd: testDir })
  expect(result).not.toContain('ignored.txt')
})

test('grep finds a matching line', async () => {
  const result = await executeTool('grep', { pattern: 'hi from', path: testDir })
  expect(result).toContain('hi from elia')
})

test('grep returns no matches message when nothing found', async () => {
  const result = await executeTool('grep', { pattern: 'zzz-not-present-zzz', path: testDir })
  expect(result).toBe('No matches found.')
})

test('run_command captures stdout and exit code', async () => {
  const result = await executeTool('run_command', { command: 'echo test123' })
  expect(result).toContain('exit code: 0')
  expect(result).toContain('test123')
})

test('run_command rejects malformed and oversized command inputs', async () => {
  await expect(executeTool('run_command', {})).rejects.toThrow('non-empty string')
  await expect(executeTool('run_command', { command: 42 })).rejects.toThrow('non-empty string')
  await expect(executeTool('run_command', { command: 'x'.repeat(100_001) })).rejects.toThrow('exceeds 100000 characters')
})

test('content tools deny protected files before bytes reach the model', async () => {
  const envPath = join(testDir, '.env')
  writeFileSync(envPath, 'ELIA_TEST_SECRET=do-not-return')

  await expect(executeTool('read_file', { path: envPath })).rejects.toThrow('protected sensitive path')
  await expect(executeTool('run_command', { command: `cat ${envPath}` })).rejects.toThrow('protected sensitive path')
  await expect(executeTool('grep', { pattern: 'ELIA_TEST_SECRET', path: testDir })).resolves.not.toContain('ELIA_TEST_SECRET')
  await expect(executeTool('list_files', { pattern: '**/*', cwd: testDir })).resolves.not.toContain('.env')

  await expect(withAgentIdentity({ name: 'test', role: 'lead', cwd: testDir }, () => dataScienceTool.execute({ action: 'profile', path: envPath }))).rejects.toThrow('protected sensitive path')
  await expect(withAgentIdentity({ name: 'test', role: 'lead', cwd: testDir }, () => readSpreadsheetTool.execute({ path: envPath }))).rejects.toThrow('protected sensitive path')
  await expect(withAgentIdentity({ name: 'test', role: 'lead', cwd: testDir }, () => spreadsheetTool.execute({ action: 'inspect', path: envPath }))).rejects.toThrow('protected sensitive path')
})

test('file tools reject traversal and symlink escapes without changing outside files', async () => {
  const outsideDir = mkdtempSync(join(tmpdir(), 'elia-test-outside-'))
  const outsideFile = join(outsideDir, 'secret.txt')
  const linkPath = join(testDir, 'outside-link')
  writeFileSync(outsideFile, 'original')
  symlinkSync(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir')

  await expect(executeTool('write_file', { path: '../outside.txt', content: 'changed' })).rejects.toThrow('escapes the active workspace')
  await expect(executeTool('read_file', { path: '../outside.txt' })).rejects.toThrow('escapes the active workspace')
  await expect(executeTool('edit_file', { path: '../outside.txt', old_string: 'original', new_string: 'changed' })).rejects.toThrow('escapes the active workspace')
  await expect(executeTool('write_file', { path: 'outside-link/secret.txt', content: 'changed' })).rejects.toThrow('escapes the active workspace')
  await expect(executeTool('read_file', { path: 'outside-link/secret.txt' })).rejects.toThrow('escapes the active workspace')
  await expect(executeTool('edit_file', { path: 'outside-link/secret.txt', old_string: 'original', new_string: 'changed' })).rejects.toThrow('escapes the active workspace')

  expect(readFileSync(outsideFile, 'utf8')).toBe('original')
  rmSync(outsideDir, { recursive: true, force: true })
})

test('read_file windows into a section with offset and limit', async () => {
  const path = join(testDir, 'multiline.txt')
  writeFileSync(path, Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'))

  const window = await executeTool('read_file', { path, offset: 3, limit: 2 })
  expect(window).toBe('3\tline 3\n4\tline 4\n\n[6 more line(s); pass offset 5 to continue]')

  const rest = await executeTool('read_file', { path, offset: 5 })
  expect(rest).toContain('5\tline 5')
  expect(rest).toContain('10\tline 10')
  expect(rest).not.toContain('more line(s)')
})

test('read_file rejects a non-positive offset or limit', async () => {
  const path = join(testDir, 'hello.txt')
  await expect(executeTool('read_file', { path, offset: 0 })).rejects.toThrow('offset must be a positive integer')
  await expect(executeTool('read_file', { path, limit: -1 })).rejects.toThrow('limit must be a positive integer')
})

test('grep filters by glob and can include surrounding context', async () => {
  writeFileSync(join(testDir, 'grep-target.md'), 'above\nhi from elia\nbelow\n')

  const onlyMd = await executeTool('grep', { pattern: 'hi from', path: testDir, glob: '*.md' })
  expect(onlyMd).toContain('grep-target.md')
  expect(onlyMd).not.toContain('hello.txt')

  const withContext = await executeTool('grep', { pattern: 'hi from', path: testDir, glob: '*.md', context: 1 })
  expect(withContext).toContain('above')
  expect(withContext).toContain('below')
})

test('grep rejects an out-of-range context value', async () => {
  await expect(executeTool('grep', { pattern: 'x', path: testDir, context: -1 })).rejects.toThrow('context must be an integer')
  await expect(executeTool('grep', { pattern: 'x', path: testDir, context: 21 })).rejects.toThrow('context must be an integer')
})

test('run_command honors an explicit timeoutMs and kills a command that overruns it', async () => {
  const command = process.platform === 'win32' ? 'ping -n 5 127.0.0.1 >NUL' : 'sleep 5'
  const result = await executeTool('run_command', { command, timeoutMs: 1_000 })
  expect(result).toContain('timed out after')
})

test('run_command rejects an out-of-range timeoutMs', async () => {
  await expect(executeTool('run_command', { command: 'echo hi', timeoutMs: 500 })).rejects.toThrow('timeoutMs must be an integer')
  await expect(executeTool('run_command', { command: 'echo hi', timeoutMs: 700_000 })).rejects.toThrow('timeoutMs must be an integer')
})

test('run_command gives installs, builds, and test runs a longer default timeout', () => {
  // A 60s cap killed these midway, leaving a half-installed tree that then
  // broke every downstream build, test, and verification step.
  for (const command of ['npm install', 'npm ci', 'pnpm add left-pad', 'bun install', 'pip install -r requirements.txt', 'pip3 install torch', 'npm run build', 'npm run test', 'cargo build --release', 'docker build -t app .']) {
    expect(defaultTimeoutForCommand(command)).toBe(300_000)
  }
  for (const command of ['echo hello', 'git status', 'ls -la']) {
    expect(defaultTimeoutForCommand(command)).toBe(60_000)
  }
})

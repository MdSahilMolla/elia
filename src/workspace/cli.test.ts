import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runWorkspace } from './cli.ts'
import { WorkspaceStore } from './store.ts'

const dirs: string[] = []
let output = ''
const originalWrite = process.stdout.write.bind(process.stdout)

afterEach(() => {
  process.stdout.write = originalWrite
  output = ''
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* windows lock */
    }
  }
})

function capture(): void {
  output = ''
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
    return true
  }) as typeof process.stdout.write
}

test('elia workspace --help lists the commands', async () => {
  capture()
  await runWorkspace(['--help'])
  expect(output).toContain('elia workspace serve')
  expect(output).toContain('elia workspace init')
})

test('elia workspace init bootstraps a workspace and prints a one-time owner token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-ws-cli-'))
  dirs.push(dir)
  const dbPath = join(dir, 'workspace.sqlite')
  capture()
  await runWorkspace(['init', '--name', 'acme', '--db', dbPath, '--owner', 'sam'])
  expect(output).toMatch(/wst_[A-Za-z0-9_-]+/)

  const store = WorkspaceStore.open(dbPath)
  expect(store.workspace()?.name).toBe('acme')
  expect(store.members()[0]?.name).toBe('sam')
  store.close()
})

test('elia workspace init refuses to overwrite an existing workspace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-ws-cli-'))
  dirs.push(dir)
  const dbPath = join(dir, 'workspace.sqlite')
  capture()
  await runWorkspace(['init', '--name', 'acme', '--db', dbPath])
  process.exitCode = 0
  await runWorkspace(['init', '--name', 'other', '--db', dbPath])
  expect(process.exitCode).toBe(1)
  process.exitCode = 0
})

test('a client command without a token fails clearly', async () => {
  const previous = process.env.ELIA_WORKSPACE_TOKEN
  delete process.env.ELIA_WORKSPACE_TOKEN
  capture()
  process.exitCode = 0
  await runWorkspace(['status'])
  expect(process.exitCode).toBe(1)
  process.exitCode = 0
  if (previous !== undefined) process.env.ELIA_WORKSPACE_TOKEN = previous
})

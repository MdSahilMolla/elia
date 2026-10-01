import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveProjectPath, withAgentIdentity } from '../autonomy/context.ts'
import { resetPreviewServerForTests } from '../preview/server.ts'
import { consumeLastPreviewedUrl, previewTool } from './preview.ts'

let dir: string

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'elia-preview-')))
})

afterEach(() => {
  resetPreviewServerForTests()
  rmSync(dir, { recursive: true, force: true })
})

function preview(input: Record<string, unknown>) {
  return withAgentIdentity({ name: 'test', role: 'lead', cwd: dir }, () => previewTool.execute(input))
}

test('preview rejects when neither path nor url is given', async () => {
  await expect(previewTool.execute({})).rejects.toThrow('requires either')
})

test('preview rejects a non-http url', async () => {
  await expect(previewTool.execute({ url: 'file:///etc/passwd' })).rejects.toThrow('http or https')
})

test('preview rejects both path and url', async () => {
  await expect(previewTool.execute({ path: 'a.html', url: 'http://x' })).rejects.toThrow('only one of')
})

test('the description tells the model preview builds framework projects itself', () => {
  expect(previewTool.description).toContain('build')
  expect(previewTool.description.toLowerCase()).toContain('dev server')
})

// Session mu0a7she-x8eipw: preview was handed a path that did not exist, created
// it as an empty directory, served a 404 from it, and answered "Opened … in
// Chrome" — so the model told the user the page was up.
test('a path that does not exist is an error, and nothing is created for it', async () => {
  await expect(preview({ path: 'nepal-trekking/index.html' })).rejects.toThrow('Nothing to preview')
  expect(existsSync(join(dir, 'nepal-trekking'))).toBe(false)
})

test('a folder with no index.html is an error that says so', async () => {
  mkdirSync(join(dir, 'site'))
  writeFileSync(join(dir, 'site', 'about.html'), '<h1>about</h1>')
  await expect(preview({ path: 'site' })).rejects.toThrow('no index.html')
})

test('a page that renders blank is an error, not an "opened" message', async () => {
  mkdirSync(join(dir, 'blank'))
  writeFileSync(join(dir, 'blank', 'index.html'), '')
  await expect(preview({ path: 'blank/index.html' })).rejects.toThrow('would not render')
})

test('a project named by its short name resolves into the scratch workspace', () => {
  const workspace = join(dir, 'workspace')
  mkdirSync(join(workspace, 'nepal-trekking'), { recursive: true })
  writeFileSync(join(workspace, 'nepal-trekking', 'index.html'), '<h1>treks</h1>')
  expect(resolveProjectPath('nepal-trekking/index.html', dir, workspace)).toBe(join(workspace, 'nepal-trekking', 'index.html'))
})

test('a path that is not in the scratch workspace resolves against the active root', () => {
  const workspace = join(dir, 'workspace')
  mkdirSync(workspace)
  mkdirSync(join(dir, 'kerala-navigator'))
  expect(resolveProjectPath('kerala-navigator', dir, workspace)).toBe(join(dir, 'kerala-navigator'))
  // Nothing exists anywhere yet: the active root, as before.
  expect(resolveProjectPath('new-site/index.html', dir, workspace)).toBe(join(dir, 'new-site', 'index.html'))
})

test('an isolated task workspace never reaches up into the shared scratch folder', () => {
  const workspace = join(dir, 'workspace')
  const task = join(workspace, '2026-09-14-run')
  mkdirSync(task, { recursive: true })
  writeFileSync(join(workspace, 'index.html'), '<h1>a different project</h1>')
  expect(resolveProjectPath('index.html', task, workspace)).toBe(join(task, 'index.html'))
})

// --- A `url` is only a preview link if something answers on it and paints -----

test('preview refuses a url with nothing listening instead of reporting it opened', async () => {
  // Port 9 (discard) is reserved and never accepts — the shape of the real bug:
  // the model guessed a dev-server port, preview opened it blind, and the user
  // was handed a localhost link that was never serving anything.
  await expect(preview({ url: 'http://127.0.0.1:9/' })).rejects.toThrow('Nothing is serving')
}, 15_000)

test('preview refuses a url that answers with an error status', async () => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('nope', { status: 404 }) })
  try {
    await expect(preview({ url: `http://127.0.0.1:${server.port}/` })).rejects.toThrow('would not render')
  } finally {
    server.stop(true)
  }
})

// --- The verified URL is handed over, not scraped out of prose ---------------

test('the previewed url is reported through the stash, and draining it clears it', async () => {
  writeFileSync(join(dir, 'page.html'), '<h1>A page with a decoy link https://decoy.example/not-the-preview inside it</h1>')
  // No window: this asserts the handover, not the ability to open Chrome — and
  // a test suite must not leave browser processes behind.
  process.env.ELIA_NO_BROWSER_LAUNCH = '1'
  let url: string | undefined
  try {
    await preview({ path: 'page.html' })
    url = consumeLastPreviewedUrl()
  } finally {
    delete process.env.ELIA_NO_BROWSER_LAUNCH
  }
  // The old regex took the first URL in the human-readable message. What the
  // turn verifies must be the URL preview actually served.
  expect(url).toContain('/page.html')
  expect(url).not.toContain('decoy.example')
  // Drained, so a later turn cannot re-verify a stale page.
  expect(consumeLastPreviewedUrl()).toBeUndefined()
})

test('a refused preview leaves no url behind to verify', async () => {
  consumeLastPreviewedUrl()
  await expect(preview({ path: 'does-not-exist.html' })).rejects.toThrow('Nothing to preview')
  expect(consumeLastPreviewedUrl()).toBeUndefined()
})

test('"." and anything that exists at the active root resolve there, not under the scratch workspace', () => {
  const workspace = join(dir, 'workspace')
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'game.py'), 'a different project')
  writeFileSync(join(dir, 'game.py'), 'the file write_file just wrote')
  expect(resolveProjectPath('.', dir, workspace)).toBe(dir)
  expect(resolveProjectPath('game.py', dir, workspace)).toBe(join(dir, 'game.py'))
})

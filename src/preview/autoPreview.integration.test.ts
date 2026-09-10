import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareAutoPreview } from './prepare.ts'
import { ensurePreviewServer, resetPreviewServerForTests } from './server.ts'
import { checkRendered, waitForHttp } from './readiness.ts'

afterEach(() => resetPreviewServerForTests())

function viteApp(): string {
  const root = mkdtempSync(join(tmpdir(), 'elia-vite-app-'))
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'test-app',
      scripts: { dev: 'vite', build: 'vite build' },
      dependencies: { react: '^18', 'react-dom': '^18' },
      devDependencies: { vite: '^5', '@vitejs/plugin-react': '^4' },
    }),
  )
  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><html><head><title>Test</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
  )
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'main.tsx'), 'document.getElementById("root")!.textContent = "hi"')
  return root
}

test('an unbuilt Vite project is not announced as a ready static preview', async () => {
  const root = viteApp()
  const prep = prepareAutoPreview(join(root, 'index.html'))
  // It must refuse rather than serve a page that renders blank.
  expect(prep.kind).toBe('skip')

  // And even if something served the raw index anyway, the render check catches it.
  const server = ensurePreviewServer(root)
  const url = `${server.baseUrl}/index.html`
  expect((await waitForHttp(url, 3_000)).ok).toBe(true)
  const rendered = await checkRendered(url)
  expect(rendered.ok).toBe(false)
  expect(rendered.reason).toContain('blank')
})

test('once the project is built, the preview serves dist/ and renders real content', async () => {
  const root = viteApp()
  mkdirSync(join(root, 'dist'))
  writeFileSync(
    join(root, 'dist', 'index.html'),
    '<!doctype html><html><body><div id="root">Educational XSS demo</div><script type="module" src="/assets/index-a1b2c3.js"></script></body></html>',
  )
  writeFileSync(join(root, 'dist', 'assets-marker'), 'x')

  const prep = prepareAutoPreview(join(root, 'index.html'))
  expect(prep.kind).toBe('static')
  if (prep.kind !== 'static') return
  expect(prep.serveRoot).toBe(join(root, 'dist'))

  const server = ensurePreviewServer(prep.serveRoot)
  const url = `${server.baseUrl}/${prep.servePath}`
  expect((await waitForHttp(url, 3_000)).ok).toBe(true)
  const rendered = await checkRendered(url)
  expect(rendered.ok).toBe(true)
})

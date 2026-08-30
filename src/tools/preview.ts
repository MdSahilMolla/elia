import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import type { Tool } from './types.ts'
import { ensurePreviewServer } from '../preview/server.ts'
import { launchInBrowser } from '../preview/launchChrome.ts'
import { resolveWorkspacePath } from '../autonomy/context.ts'
import { paths } from '../config.ts'
import { runShell } from '../shell.ts'
import { activeActionGovernor } from '../autonomy/governor.ts'

const BUNDLER = /\b(vite|webpack|parcel|rollup|esbuild|@vitejs|next|@remix-run|astro|@sveltejs)\b/
const BUILD_TIMEOUT_MS = 240_000

export const previewTool: Tool = {
  name: 'preview',
  description:
    'Open something visually in a real Chrome window. Pass `path` for a file under the workspace (served locally with push-based live-reload). If the file belongs to a project that needs a build (Vite, Next, etc.), preview runs its `build` script first and serves the output — so you never have to start a dev server. Pass `url` instead for an already-running server, opened directly.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace, e.g. "airbnb-mvp/index.html"' },
      url: { type: 'string', description: 'An already-running URL to open directly, e.g. "http://localhost:3000"' },
      build: { type: 'boolean', description: 'Force (true) or skip (false) the build step. Default: auto — build when the project has a bundler and a build script.' },
    },
  },
  async execute(input) {
    const path = input.path === undefined ? undefined : typeof input.path === 'string' ? input.path.trim() : undefined
    const url = input.url === undefined ? undefined : typeof input.url === 'string' ? input.url.trim() : undefined
    if (input.path !== undefined && typeof input.path !== 'string') throw new Error('preview "path" must be a string')
    if (input.url !== undefined && typeof input.url !== 'string') throw new Error('preview "url" must be a string')
    if (!path && !url) throw new Error('preview requires either "path" or "url"')
    if (path && url) throw new Error('preview accepts only one of "path" or "url", not both')

    if (url) {
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        throw new Error(`preview URL is invalid: ${url}`)
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('preview URL must use http or https')
      return (await launchInBrowser(url)).message
    }

    // Scope the static server to the target's own directory, not all of
    // workspace/. Serving the whole workspace meant a request that missed
    // (e.g. a bare directory path) fell back to workspace/index.html — a
    // different project's leftover page — which is exactly the "preview shows
    // the wrong thing" bug. Each preview now sees only its own files.
    const resolvedTarget = resolveWorkspacePath(path!)
    const targetIsDir = existsSync(resolvedTarget) && statSync(resolvedTarget).isDirectory()
    let serveRoot = targetIsDir ? resolvedTarget : dirname(resolvedTarget)
    let servePath = targetIsDir ? 'index.html' : basename(resolvedTarget)
    let note = ''

    const project = findProject(resolvedTarget)
    if (project && input.build !== false) {
      const built = pickBuildOutput(project.dir)
      const wants = input.build === true || (project.hasBuildScript && project.usesBundler && !built)
      if (wants) {
        const command = `${project.runner} run build`
        const gate = await activeActionGovernor().check({ name: 'run_command', input: { command } })
        if (!gate.allowed) return `preview wanted to build this project first (${command}) but that was not approved. Approve it, or point preview at a plain HTML file.`
        const result = await runShell(command, BUILD_TIMEOUT_MS, project.dir)
        if (result.exitCode !== 0 || result.timedOut) {
          return `Build failed — nothing to preview yet.\n$ ${command}\n${(result.stderr || result.stdout).slice(-1500)}`
        }
      }
      const out = pickBuildOutput(project.dir)
      if (out) {
        serveRoot = out
        servePath = 'index.html'
        note = ` (served the built output from ${relative(paths.workspace, out) || '.'})`
      }
    }

    const server = ensurePreviewServer(serveRoot)
    const target = `${server.baseUrl}/${servePath.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`
    return `${(await launchInBrowser(target)).message}${note}`
  },
}

interface ProjectInfo {
  dir: string
  runner: 'bun' | 'npm' | 'pnpm' | 'yarn'
  hasBuildScript: boolean
  usesBundler: boolean
}

function findProject(fileOrDir: string): ProjectInfo | undefined {
  let dir = existsSync(fileOrDir) && !fileOrDir.match(/\.[a-z]+$/i) ? fileOrDir : dirname(fileOrDir)
  for (let i = 0; i < 6; i += 1) {
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
        const deps = JSON.stringify({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.scripts })
        return {
          dir,
          runner: existsSync(join(dir, 'bun.lock')) || existsSync(join(dir, 'bun.lockb')) ? 'bun' : existsSync(join(dir, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(dir, 'yarn.lock')) ? 'yarn' : 'npm',
          hasBuildScript: Boolean(pkg.scripts?.build),
          usesBundler: BUNDLER.test(deps),
        }
      } catch {
        return undefined
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

function pickBuildOutput(projectDir: string): string | undefined {
  for (const name of ['dist', 'build', 'out', '.output/public']) {
    const candidate = join(projectDir, name)
    if (existsSync(join(candidate, 'index.html'))) return candidate
  }
  return undefined
}

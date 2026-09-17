import { existsSync, statSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import type { Tool } from './types.ts'
import { ensurePreviewServer } from '../preview/server.ts'
import { launchInBrowser } from '../preview/launchChrome.ts'
import { checkRendered, waitForHttp } from '../preview/readiness.ts'
import { findProject, pickBuildOutput } from '../preview/project.ts'
import { resolveProjectPath } from '../autonomy/context.ts'
import { paths } from '../config.ts'
import { runShell } from '../shell.ts'
import { activeActionGovernor } from '../autonomy/governor.ts'

const BUILD_TIMEOUT_MS = 240_000

/**
 * The URL of the last page preview actually opened, for the turn to verify.
 *
 * The turn used to recover this by running `/\bhttps?:\/\/\S+/` over preview's
 * human-readable result and taking the first match — so the thing elia verified
 * was whatever URL happened to appear first in a sentence written for a person.
 * Rewording that sentence silently changed what got checked, and a message
 * containing two URLs checked the wrong one. Tools return strings, so rather
 * than reshape that interface for one value, this is the same module-local
 * stash `lessons.ts` uses for injected lesson keys, with the same
 * justification: one process, one turn at a time, filled by the producer and
 * drained by the consumer.
 */
let lastPreviewedUrl: string | undefined

/** The URL preview last opened, clearing it so a later turn cannot re-read a stale one. */
export function consumeLastPreviewedUrl(): string | undefined {
  const url = lastPreviewedUrl
  lastPreviewedUrl = undefined
  return url
}
/** A server the user says is already running should answer promptly; this is not a startup wait. */
const URL_READY_TIMEOUT_MS = 5_000

export const previewTool: Tool = {
  name: 'preview',
  description:
    'Open something visually in a real Chrome window. Pass `path` for a file under the workspace (served locally with push-based live-reload). If the file belongs to a project that needs a build (Vite, Next, etc.), preview runs its `build` script first and serves the output — so you never have to start a dev server. Pass `url` instead for a server that is already running. Either way preview loads the page before opening it and fails with the reason if it would not render (missing file, nothing listening on that port, HTTP error, blank or unbuilt page), so a successful result means the page really loads and the URL in that result is a link the user can actually open. Never report a preview URL you did not get back from a successful preview result.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace, e.g. "airbnb-mvp/index.html", or the absolute path write_file reported' },
      url: { type: 'string', description: 'An already-running URL to open directly, e.g. "http://localhost:3000"' },
      build: { type: 'boolean', description: 'Force (true) or skip (false) the build step. Default: auto — build when the project has a bundler and a build script.' },
    },
  },
  async execute(input) {
    lastPreviewedUrl = undefined
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
      // The `path` branch below has checked its page since the "preview called a
      // 404 opened" fix; this branch never did. It opened whatever URL it was
      // handed and returned "Opened … in Chrome" — so a guessed dev-server port
      // that nothing was listening on was announced to the user as a working
      // preview link, and the turn's `previewedUrl` was set from that message.
      // A URL is only a preview link if something answers on it and paints.
      const reachable = await waitForHttp(url, URL_READY_TIMEOUT_MS)
      if (!reachable.ok) {
        throw new Error(`Nothing is serving ${url} — ${reachable.reason ?? 'no response'}. Nothing was opened. Start the server first, or pass \`path\` to have preview serve the files itself.`)
      }
      // Not a static server: this URL belongs to something the user is already
      // running, very possibly a dev server, so the unbuilt-bundler heuristic
      // must not fire on markup that dev server renders correctly.
      const live = await checkRendered(url, undefined, { staticServer: false })
      if (!live.ok) {
        throw new Error(`${url} answered but would not render: ${live.reason}. Nothing was opened — fix the page, then preview again.`)
      }
      lastPreviewedUrl = url
      return (await launchInBrowser(url)).message
    }

    // Scope the static server to the target's own directory, not all of
    // workspace/. Serving the whole workspace meant a request that missed
    // (e.g. a bare directory path) fell back to workspace/index.html — a
    // different project's leftover page — which is exactly the "preview shows
    // the wrong thing" bug. Each preview now sees only its own files.
    const resolvedTarget = resolveProjectPath(path!)
    // Serving a path that does not exist used to create it (the server mkdirs
    // its root), answer every request with 404, and still report "Opened … in
    // Chrome" — the model then told the user the page was up.
    if (!existsSync(resolvedTarget)) {
      throw new Error(`Nothing to preview: ${path} does not exist (looked for ${resolvedTarget}). Nothing was opened. Pass the exact path write_file reported, or create the file first.`)
    }
    const targetIsDir = statSync(resolvedTarget).isDirectory()
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

    const servedFile = join(serveRoot, servePath)
    if (!existsSync(servedFile)) {
      throw new Error(`Nothing to preview: ${servedFile} does not exist${targetIsDir ? ` — ${path} is a folder with no index.html; pass the HTML file to open` : ''}. Nothing was opened.`)
    }

    const server = ensurePreviewServer(serveRoot)
    const target = `${server.baseUrl}/${servePath.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`
    // Load the page before claiming it is up: "Opened … in Chrome" must mean the
    // user is looking at the page, not at a 404 or a blank screen.
    const rendered = await checkRendered(target)
    if (!rendered.ok) {
      throw new Error(`Preview would not render ${servedFile}: ${rendered.reason} (at ${target}). Nothing was opened — fix the page, then preview again.`)
    }
    // Stashed here rather than after the launch: the check above has proven this
    // URL serves a page, which is exactly what the turn wants to verify.
    // Whether a browser window then opened is a separate question, and one a
    // headless environment answers differently.
    lastPreviewedUrl = target
    return `${(await launchInBrowser(target)).message}${note}\nServing ${servedFile}`
  },
}

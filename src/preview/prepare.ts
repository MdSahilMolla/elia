import { existsSync, statSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { findProject, pickBuildOutput, isUnbuiltModuleEntry } from './project.ts'

export type PreparedPreview =
  | { kind: 'static'; serveRoot: string; servePath: string; note?: string }
  | { kind: 'skip'; reason: string }

/**
 * Decides how (and whether) a freshly-written HTML file can be previewed as a
 * static page, without starting a build or a dev server — that stays the
 * governed `preview` tool's job. The point here is to never hand the static
 * server a bundler *source* `index.html`, which renders blank.
 *
 *  - plain self-contained HTML  → serve its directory
 *  - a project with a built dist/ → serve the built output
 *  - an unbuilt Vite/Next/CRA app → skip, with a message that says what to run
 */
export function prepareAutoPreview(target: string): PreparedPreview {
  if (!existsSync(target)) return { kind: 'skip', reason: 'the file disappeared before it could be served' }

  const isDir = statSync(target).isDirectory()
  const project = findProject(target)

  if (project?.usesBundler) {
    const built = pickBuildOutput(project.dir)
    if (built) {
      return { kind: 'static', serveRoot: built, servePath: 'index.html', note: 'serving the built output' }
    }
    if (!isDir && isUnbuiltModuleEntry(target)) {
      const how = project.hasBuildScript
        ? `run \`${project.runner} run build\` in ${dirname(target)} then \`/preview\``
        : `start its dev server, then \`/preview <url>\``
      return {
        kind: 'skip',
        reason: `this is an unbuilt ${bundlerName(project)} app — a static preview would be blank. ${how}.`,
      }
    }
  }

  const serveRoot = isDir ? target : dirname(target)
  const servePath = isDir ? 'index.html' : basename(target)
  return { kind: 'static', serveRoot, servePath }
}

function bundlerName(project: ReturnType<typeof findProject>): string {
  return project?.devScript?.includes('next')
    ? 'Next.js'
    : project?.devScript?.includes('vite')
      ? 'Vite'
      : 'bundled'
}

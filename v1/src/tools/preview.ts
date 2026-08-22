import type { Tool } from './types.ts'
import { ensurePreviewServer } from '../preview/server.ts'
import { launchInBrowser } from '../preview/launchChrome.ts'

export const previewTool: Tool = {
  name: 'preview',
  description:
    'Open something visually in a real Chrome window. Pass `path` for a file under the workspace directory (served locally with push-based live-reload — the window updates automatically as you keep editing the file). Pass `url` instead for an already-running server (e.g. one you started with run_command) — opened directly, without live-reload.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace directory, e.g. "index.html"' },
      url: { type: 'string', description: 'An already-running URL to open directly, e.g. "http://localhost:3000"' },
    },
  },
  async execute(input) {
    const path = input.path as string | undefined
    const url = input.url as string | undefined

    if (!path && !url) throw new Error('preview requires either "path" or "url"')
    if (path && url) throw new Error('preview accepts only one of "path" or "url", not both')

    const target = url ?? buildWorkspaceUrl(path!)
    const result = await launchInBrowser(target)
    return result.message
  },
}

function buildWorkspaceUrl(relativePath: string): string {
  const server = ensurePreviewServer()
  return `${server.baseUrl}/${relativePath.replace(/^\/+/, '')}`
}

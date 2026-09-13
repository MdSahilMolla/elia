/**
 * The live-reload script the preview server injects into every HTML response,
 * and the means to take it back out again.
 *
 * It lives in its own module, free of dependencies, because two places need it
 * and they cannot import each other: `server.ts` adds it, and `readiness.ts`
 * has to subtract it before judging whether a page rendered. `readiness.ts` is
 * deliberately dependency-free (importing `server.ts` would drag in `config.ts`
 * and its provider resolution), and a second hand-copied literal is exactly how
 * the two drift apart.
 *
 * Why subtracting it matters: the readiness check calls a page blank when the
 * response is under 40 bytes. This script alone is ~135, so once it was added
 * *every* page cleared that bar — a zero-byte file served as 135 bytes and
 * passed. For a static site that render check is the only gate there is, so the
 * blank-page failure it exists to catch could never fire.
 */

export const RELOAD_PATH = '/__reload'

export function reloadScriptTag(): string {
  return `<script>(function(){var ws=new WebSocket('ws://'+location.host+'${RELOAD_PATH}');ws.onmessage=function(){location.reload();};})();</script>`
}

export function injectReloadScript(html: string): string {
  const script = reloadScriptTag()
  if (html.includes('</body>')) return html.replace('</body>', `${script}</body>`)
  return `${html}\n${script}`
}

/** Removes what {@link injectReloadScript} added, so callers can measure the page itself. */
export function stripReloadScript(html: string): string {
  const script = reloadScriptTag()
  return html.includes(script) ? html.replace(script, '') : html
}

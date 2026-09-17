import { render } from 'ink'
import { App, type AppProps } from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { resolveThemeName, setTheme, themeName } from './theme.ts'

export type { AppProps, TurnHooks, SlashOutcome, SlashPickerRequest, SlashPromptRequest, SlashRunRequest } from './App.tsx'

/**
 * Rewrite only the rows that changed on each frame. The working line animates
 * several times a second; redrawing the whole live region for that erased and
 * rewrote every row of it each time — flicker, and a steady stream of bytes.
 * `ELIA_INK_INCREMENTAL=off` goes back to full redraws.
 */
export function incrementalRenderingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = (env.ELIA_INK_INCREMENTAL ?? 'on').trim().toLowerCase()
  return !(raw === 'off' || raw === '0' || raw === 'false' || raw === 'no')
}

/** Mounts the live Ink REPL and resolves when the user exits. */
export async function runInkRepl(props: AppProps): Promise<void> {
  // ~/.elia/config.env can carry a saved ELIA_THEME; make sure it is the one in use.
  const wanted = resolveThemeName(process.env)
  if (wanted !== themeName) setTheme(wanted)
  // Top-level catch-all: the per-area boundaries in App keep the frame usable,
  // but if App itself throws before those mount, at least show why instead of a
  // raw React stack.
  const instance = render(
    <ErrorBoundary area="REPL">
      <App {...props} />
    </ErrorBoundary>,
    { exitOnCtrlC: false, incrementalRendering: incrementalRenderingEnabled() },
  )
  await instance.waitUntilExit()
}

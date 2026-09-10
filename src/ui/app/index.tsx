import { render } from 'ink'
import { App, type AppProps } from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'

export type { AppProps, TurnHooks, SlashOutcome, SlashPickerRequest, SlashPromptRequest, SlashRunRequest } from './App.tsx'

/** Mounts the live Ink REPL and resolves when the user exits. */
export async function runInkRepl(props: AppProps): Promise<void> {
  // Top-level catch-all: the per-area boundaries in App keep the frame usable,
  // but if App itself throws before those mount, at least show why instead of a
  // raw React stack.
  const instance = render(
    <ErrorBoundary area="REPL">
      <App {...props} />
    </ErrorBoundary>,
    { exitOnCtrlC: false },
  )
  await instance.waitUntilExit()
}

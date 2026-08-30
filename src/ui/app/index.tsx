import { render } from 'ink'
import { App, type AppProps } from './App.tsx'

export type { AppProps, TurnHooks, SlashOutcome, SlashPickerRequest, SlashPromptRequest, SlashRunRequest } from './App.tsx'

/** Mounts the live Ink REPL and resolves when the user exits. */
export async function runInkRepl(props: AppProps): Promise<void> {
  const instance = render(<App {...props} />, { exitOnCtrlC: false })
  await instance.waitUntilExit()
}

export type UiMode = 'normal' | 'plain' | 'quiet' | 'verbose' | 'json'

function hasArg(...names: string[]): boolean {
  return names.some((name) => process.argv.includes(name))
}

const requestedMode = process.env.ELIA_UI_MODE?.trim().toLowerCase()

export const uiMode: UiMode =
  requestedMode === 'json' || hasArg('--json', '--jsonl')
    ? 'json'
    : requestedMode === 'quiet' || hasArg('--quiet')
      ? 'quiet'
      : requestedMode === 'verbose' || hasArg('--verbose')
        ? 'verbose'
        : requestedMode === 'plain' || hasArg('--plain') || hasArg('--no-color') || Boolean(process.env.NO_COLOR)
          ? 'plain'
          : 'normal'

export const machineReadable = uiMode === 'json'
export const plainOutput = uiMode === 'plain' || uiMode === 'quiet' || machineReadable
export const quietOutput = uiMode === 'quiet'
export const animationsEnabled = uiMode === 'normal' || uiMode === 'verbose'

/** Interactive terminal rendering is opt-in: quiet suppresses status text but keeps the editor usable in a real TTY. */
export function isInteractiveTerminal(stdinIsTTY: boolean, stdoutIsTTY: boolean, mode: UiMode): boolean {
  return stdinIsTTY && stdoutIsTTY && mode !== 'plain' && mode !== 'json'
}

export const interactiveTerminal = isInteractiveTerminal(Boolean(process.stdin.isTTY), Boolean(process.stdout.isTTY), uiMode)

export interface UiEvent {
  type: string
  at: string
  [key: string]: unknown
}

/** Stable JSONL event output for CI, orchestration, and log ingestion. */
export function emitEvent(type: string, data: Record<string, unknown> = {}): void {
  if (!machineReadable) return
  const event: UiEvent = { type, at: new Date().toISOString(), ...data }
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

export function writeDiagnostic(text: string): void {
  process.stderr.write(`${text}\n`)
}

// Semantic palette for the Ink REPL. Ink takes chalk-style color names, so this
// stays close to src/ui/theme.ts's meanings (gold = brand accent, cyan = tool
// names, green = success, red = failure, gray = secondary).
export const palette = {
  accent: 'yellow',
  toolName: 'cyan',
  success: 'green',
  failure: 'red',
  muted: 'gray',
  user: 'cyan',
  text: undefined as string | undefined,
} as const

export const glyphs = {
  user: '❯',
  bullet: '⏺',
  ok: '✓',
  error: '✗',
  cached: '⚡',
  running: '◐',
  branch: '⎿',
} as const

/** Spinner frames shared with src/ui/stream.ts's tool spinner. */
export const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

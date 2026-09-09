// Semantic palette for the Ink REPL. Ink takes chalk-style color names, so this
// stays close to src/ui/theme.ts's meanings (gold = brand accent, cyan = tool
// names, green = success, red = failure, gray = secondary).
// Deliberately near-monochrome, like Devin's CLI. Anything that used to be a
// brand accent (the prompt, the banner, tool names, links) is now "ash" — a
// soft off-white that's easier on the eye than pure #fff against a black
// terminal. Gray stays for secondary text; colour is reserved for the two
// things that actually need to jump out, success and failure.
const ASH = '#c8ccc6'

export const palette = {
  accent: ASH,
  toolName: ASH,
  success: 'green',
  failure: 'red',
  muted: 'gray',
  user: ASH,
  text: undefined as string | undefined,
  /** Background for inline-code pills. A near-black grey — subtle on dark terminals, still legible on light. */
  codeBg: '#2f2f2f',
} as const

export const glyphs = {
  user: '❯',
  bullet: '⏺',
  ok: '✓',
  error: '✗',
  cached: '⚡',
  running: '◐',
  branch: '⎿',
  skill: '✦',
} as const

/** Spinner frames shared with src/ui/stream.ts's tool spinner. */
export const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

import { bold, dim, gold } from './theme.ts'

export interface CharacterFrame {
  lines: readonly string[]
  durationMs: number
}

// The mascot is a tiny kaomoji, not a portrait: two eyes and a mouth, framed by a
// pair of sparks for the lightning theme the rest of the app already uses (the
// gold accent, the ⚡ cache marker in stream.ts). A face this small never needs
// downsampling for terminal width the way a full ASCII portrait would, and it's
// the shape a "minimal, cute" terminal logo actually takes — Claude Code's own
// banner is a few characters, not a set piece.
export const FACE_NEUTRAL = '◕‿◕'
export const FACE_BLINK = '◠‿◠'
export const FACE_LEFT = '◔‿◔'
export const FACE_RIGHT = '◑‿◑'

const WORDMARK = 'e l i a'

function sparkLine(spark: (text: string) => string, face: string): string {
  return `  ${spark('⚡')} ${face} ${spark('⚡')}`
}

/**
 * The one-shot "power on" played at startup: sparks catch, the mascot blinks
 * once, then it settles. Four frames and well under a second — an intro, not
 * a loop, so it never gets in the way of actually using elia.
 */
export function buildIntroFrames(): readonly CharacterFrame[] {
  const wordmark = `   ${bold(WORDMARK)}`
  return [
    { lines: [`  ${dim('.')} ${FACE_NEUTRAL} ${dim('.')}`, wordmark], durationMs: 120 },
    { lines: [sparkLine(gold, FACE_NEUTRAL), wordmark], durationMs: 160 },
    { lines: [sparkLine(gold, FACE_BLINK), wordmark], durationMs: 90 },
    { lines: [sparkLine(gold, FACE_NEUTRAL), wordmark], durationMs: 0 },
  ]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Plays the intro frame by frame in place, and leaves the settled last frame on screen. */
export async function playIntro(): Promise<void> {
  const frames = buildIntroFrames()
  const lineCount = frames[0]!.lines.length

  for (const [index, current] of frames.entries()) {
    if (index > 0) process.stdout.write(`\x1b[${lineCount}A`)
    for (const line of current.lines) process.stdout.write(`\x1b[2K${line}\n`)
    if (current.durationMs > 0) await sleep(current.durationMs)
  }
}

import { FACE_NEUTRAL, FACE_BLINK, FACE_LEFT, FACE_RIGHT } from './character.ts'
import { dim, gold } from './theme.ts'

// Eyes dart around while "thinking", blink once, and repeat — a small loop, not
// a set piece. Each entry gets one FRAME_MS tick.
const FACES = [FACE_NEUTRAL, FACE_LEFT, FACE_NEUTRAL, FACE_RIGHT, FACE_NEUTRAL, FACE_BLINK]
const FRAME_MS = 220

// The verb rotates far slower than the face — swapping it every tick would be
// noise, not personality. Themed to the same lightning motif as the mascot and
// the rest of the app's gold accent, not a random word generator.
const VERBS = ['Sparking', 'Charging', 'Pondering', 'Zapping', 'Percolating', 'Scheming', 'Noodling']
const VERB_INTERVAL_S = 3

export interface Animation {
  stop(): void
}

const NOOP_ANIMATION: Animation = { stop() {} }

/**
 * A single-line "thinking" indicator: a small blinking kaomoji plus a rotating
 * verb and elapsed time. Deliberately one line — the old version was a two-line
 * ASCII snake plus a separate status line, which is more real estate than a
 * "still working" cue needs. This is the shape Claude Code's own status line
 * takes: one glyph, one phrase, one clock.
 */
export function startThinkingAnimation(): Animation {
  if (!process.stdout.isTTY) return NOOP_ANIMATION

  const startedAt = Date.now()
  let frameIndex = 0
  let stopped = false

  function line(): string {
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000)
    const verb = VERBS[Math.floor(elapsedSeconds / VERB_INTERVAL_S) % VERBS.length]
    const face = FACES[frameIndex % FACES.length]
    return `${gold(`(${face})`)} ${dim(`${verb}… (${elapsedSeconds}s)`)}`
  }

  process.stdout.write(`${line()}\n`)

  let timer: ReturnType<typeof setTimeout> | undefined
  function scheduleNext(): void {
    timer = setTimeout(() => {
      if (stopped) return
      frameIndex += 1
      process.stdout.write(`\x1b[1A\x1b[2K${line()}\n`)
      scheduleNext()
    }, FRAME_MS)
  }
  scheduleNext()

  return {
    stop() {
      if (stopped) return
      stopped = true
      if (timer) clearTimeout(timer)
      process.stdout.write('\x1b[1A\x1b[0J')
    },
  }
}

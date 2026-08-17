import { CHARACTER_FRAMES, GOLD, DIM, RESET } from './character.ts'

const FRAME_INTERVAL_MS = 450
const STATUS_LINE_COUNT = 1
const LINE_COUNT = CHARACTER_FRAMES[0]!.length + STATUS_LINE_COUNT

export interface Animation {
  stop(): void
}

const NOOP_ANIMATION: Animation = { stop() {} }

export function startThinkingAnimation(): Animation {
  // Escape codes corrupt output when stdout isn't a real terminal (piped/redirected).
  if (!process.stdout.isTTY) return NOOP_ANIMATION

  const startedAt = Date.now()
  let frameIndex = 0
  let stopped = false

  function statusLine(): string {
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000)
    return `${DIM}    · thinking (${elapsedSeconds}s)${RESET}`
  }

  function render(frame: readonly string[]): void {
    for (const line of frame) {
      process.stdout.write(`\x1b[2K${GOLD}${line}${RESET}\n`)
    }
    process.stdout.write(`\x1b[2K${statusLine()}\n`)
  }

  function moveUp(): void {
    process.stdout.write(`\x1b[${LINE_COUNT}A`)
  }

  render(CHARACTER_FRAMES[0]!)

  const interval = setInterval(() => {
    frameIndex = (frameIndex + 1) % CHARACTER_FRAMES.length
    moveUp()
    render(CHARACTER_FRAMES[frameIndex]!)
  }, FRAME_INTERVAL_MS)

  return {
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(interval)
      moveUp()
      process.stdout.write('\x1b[0J') // clear the frame, cursor lands where it was
    },
  }
}

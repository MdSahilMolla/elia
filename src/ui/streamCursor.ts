// A blinking text cursor shown during pauses *within* an active stream (e.g.
// waiting on the next network chunk) — distinct from the pre-stream "thinking"
// character animation. Only blinks after a short idle gap so fast streaming
// never flickers; any incoming text instantly erases it first.
import { interactiveTerminal } from './runtime.ts'
import { registerShutdownCleanup } from './shutdown.ts'

const CURSOR_CHAR = '_'
const BLINK_INTERVAL_MS = 500
const IDLE_BEFORE_BLINK_MS = 250

export interface StreamCursor {
  beforeText(): void
  afterText(): void
  stop(): void
}

const NOOP_CURSOR: StreamCursor = { beforeText() {}, afterText() {}, stop() {} }

export function createStreamCursor(): StreamCursor {
  // Escape codes corrupt output when stdout isn't a real terminal (piped/redirected).
  if (!interactiveTerminal) return NOOP_CURSOR

  let blinkTimer: ReturnType<typeof setInterval> | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let visible = false

  function show(): void {
    if (visible) return
    visible = true
    process.stdout.write(CURSOR_CHAR)
  }

  function hide(): void {
    if (!visible) return
    visible = false
    process.stdout.write('\b \b')
  }

  function cancelIdleTimer(): void {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  function stopBlink(): void {
    if (blinkTimer) {
      clearInterval(blinkTimer)
      blinkTimer = null
    }
    hide()
  }

  const cleanup = () => {
    cancelIdleTimer()
    stopBlink()
  }
  const unregisterShutdown = registerShutdownCleanup(cleanup)

  return {
    beforeText() {
      cancelIdleTimer()
      stopBlink()
    },
    afterText() {
      cancelIdleTimer()
      idleTimer = setTimeout(() => {
        show()
        blinkTimer = setInterval(() => (visible ? hide() : show()), BLINK_INTERVAL_MS)
      }, IDLE_BEFORE_BLINK_MS)
    },
    stop() {
      cleanup()
      unregisterShutdown()
    },
  }
}

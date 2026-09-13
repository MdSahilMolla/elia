// WS0.8 — the frame's single source of truth for terminal geometry.
//
// Ink gives components a width via `useStdout().stdout.columns`, but it reads
// that once per render and nothing re-renders on a resize: drag the window
// narrower mid-turn and every measured layout below stays sized for the old
// width until the next frame happens to be pushed. Worse, nothing in the tree
// knows the terminal's *height* at all, which is what the live-region cap
// (WS0.7, `liveRegion.ts`) needs.
//
// So: one hook, subscribed to the resize signal, that every geometry-aware
// component reads. On a TTY Node emits `'resize'` on the stream itself; on
// POSIX the same event is driven by SIGWINCH. We listen to the stream event
// (portable, including Windows Terminal) and to SIGWINCH where the platform
// has it, deduplicated through the same setState.
import { useEffect, useState } from 'react'

/** Below this, the HUD drops optional segments rather than wrapping. */
export const NARROW_COLUMNS = 80

// Non-TTY (piped output, CI, `ink-testing-library`) reports no geometry at all.
// 80×24 is the historical safe default and keeps tests deterministic.
const FALLBACK_COLUMNS = 80
const FALLBACK_ROWS = 24

export interface TerminalSize {
  columns: number
  rows: number
  /** `columns < NARROW_COLUMNS` — render the compact variant. */
  narrow: boolean
}

type SizedStream = Pick<NodeJS.WriteStream, 'columns' | 'rows'> &
  Partial<Pick<NodeJS.WriteStream, 'on' | 'off'>>

/** Reads geometry once. Exported for tests and for non-React callers. */
export function readTerminalSize(stream: SizedStream = process.stdout): TerminalSize {
  const columns = Math.max(1, stream.columns || FALLBACK_COLUMNS)
  const rows = Math.max(1, stream.rows || FALLBACK_ROWS)
  return { columns, rows, narrow: columns < NARROW_COLUMNS }
}

const sameSize = (a: TerminalSize, b: TerminalSize): boolean => a.columns === b.columns && a.rows === b.rows

/**
 * Current terminal geometry, re-rendering the caller when the window resizes.
 * Safe on a non-TTY: returns the 80×24 fallback and never subscribes.
 */
export function useTerminalSize(stream: SizedStream = process.stdout): TerminalSize {
  const [size, setSize] = useState<TerminalSize>(() => readTerminalSize(stream))

  useEffect(() => {
    const sync = (): void => {
      const next = readTerminalSize(stream)
      // Bail out on a no-op resize so a burst of SIGWINCH during a window drag
      // doesn't push a frame per event.
      setSize((prev) => (sameSize(prev, next) ? prev : next))
    }
    // A resize that landed between the initial read and this subscription would
    // otherwise be missed until the *next* one.
    sync()

    const cleanups: Array<() => void> = []
    if (typeof stream.on === 'function' && typeof stream.off === 'function') {
      stream.on('resize', sync)
      cleanups.push(() => stream.off?.('resize', sync))
    }
    // Not every platform/runtime has SIGWINCH; registering it is best-effort.
    try {
      process.on('SIGWINCH', sync)
      cleanups.push(() => process.off('SIGWINCH', sync))
    } catch {
      // no SIGWINCH here — the stream event above is the only signal
    }
    return () => {
      for (const cleanup of cleanups) cleanup()
    }
  }, [stream])

  return size
}

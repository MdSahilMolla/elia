import { useEffect, useRef, useState } from 'react'
import { Box, Text } from 'ink'
import { browserMotionFrame, browserMotionLabel } from '../browserMotion.ts'
import { glyphs, palette } from '../theme.ts'

// Slightly slower than the spinner's 120ms. The two run side by side, and at
// the same rate they beat against each other; at 150 the track reads as its own
// movement rather than a second spinner. It is also one more repaint of the
// live region per tick, which the spinner's own comment is right to count.
const FRAME_MS = 150

/**
 * The animated track under a running `browser` call:
 *
 *   ● Navigating to example.com
 *     ⎿ ··─▸·····  loading
 *
 * Mounted only while the call is running, so a finished card costs nothing —
 * the same contract the Spinner keeps.
 */
export function BrowserMotion({ action }: { action: string | undefined }) {
  const [tick, setTick] = useState(0)
  const startedAt = useRef(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), FRAME_MS)
    return () => clearInterval(timer)
  }, [])

  return (
    <Box marginLeft={2}>
      <Text color={palette.muted} wrap="truncate-end">
        {glyphs.branch} {browserMotionFrame(action, tick)}  {browserMotionLabel(action, Date.now() - startedAt.current)}
      </Text>
    </Box>
  )
}

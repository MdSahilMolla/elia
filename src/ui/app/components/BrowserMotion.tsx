import { useRef } from 'react'
import { Box, Text } from 'ink'
import { browserMotionFrame, browserMotionLabel } from '../browserMotion.ts'
import { glyphs, palette } from '../theme.ts'
import { motionReduced, useAnimationClock } from '../animation.tsx'

// Slightly slower than the spinner's 120ms. The two run side by side, and at
// the same rate they beat against each other; at 150 the track reads as its own
// movement rather than a second spinner.
const FRAME_MS = 150

/**
 * The animated track under a running `browser` call:
 *
 *   ● Navigating to example.com
 *     ⎿ ··─▸·····  loading
 *
 * Mounted only while the call is running, so a finished card costs nothing —
 * the same contract the Spinner keeps. It runs on the shared animation clock,
 * so it repaints with everything else instead of on a timer of its own, and it
 * holds still when motion is reduced (ELIA_REDUCED_MOTION).
 */
export function BrowserMotion({ action }: { action: string | undefined }) {
  const now = useAnimationClock()
  const startedAt = useRef(now)
  const elapsed = Math.max(0, now - startedAt.current)
  const tick = motionReduced ? 0 : Math.floor(elapsed / FRAME_MS)

  return (
    <Box marginLeft={2}>
      <Text color={palette.muted} wrap="truncate-end">
        {glyphs.branch} {browserMotionFrame(action, tick)}  {browserMotionLabel(action, elapsed)}
      </Text>
    </Box>
  )
}

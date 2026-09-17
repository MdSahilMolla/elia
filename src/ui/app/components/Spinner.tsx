import { useRef } from 'react'
import { Text } from 'ink'
import { glyphs, palette } from '../theme.ts'
import { useAnimationClock, motionReduced } from '../animation.tsx'
import { mixColor, pulseLevel, sparkFrame } from '../motion.ts'

/**
 * Something in motion, on the shared clock. Ticks only while mounted, so an
 * unmounted row costs nothing, and any number of them repaint together.
 *
 * - `spark` (default): elia's spark, breathing — a subagent at work.
 * - `pulse`: a dot that brightens and dims — a tool call in flight. Calmer
 *   than a second spinner next to the working line.
 */
export function Spinner({ color, variant = 'spark' }: { color?: string; variant?: 'spark' | 'pulse' }) {
  const now = useAnimationClock()
  const startedAt = useRef(now)
  const elapsed = now - startedAt.current
  if (variant === 'pulse') {
    const level = motionReduced ? 1 : pulseLevel(elapsed)
    return <Text color={color ?? mixColor(palette.brandDim, palette.brand, level)}>{glyphs.bullet}</Text>
  }
  return <Text color={color ?? palette.brand}>{motionReduced ? glyphs.brand : sparkFrame(elapsed)}</Text>
}

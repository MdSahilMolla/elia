import { useEffect, useState } from 'react'
import { Text } from 'ink'
import { palette, spinnerFrames } from '../theme.ts'

// Every tick repaints the whole live region, so the rate is a cost, not just a
// look: 120ms reads as smooth and repaints a third less often than 80ms did.
const FRAME_MS = 120

/** A small braille spinner. Ticks only while mounted, so an unmounted card costs nothing. */
export function Spinner({ color = palette.accent }: { color?: string }) {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setFrame((n) => (n + 1) % spinnerFrames.length), FRAME_MS)
    return () => clearInterval(timer)
  }, [])
  return <Text color={color}>{spinnerFrames[frame]}</Text>
}

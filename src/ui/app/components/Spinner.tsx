import { useEffect, useState } from 'react'
import { Text } from 'ink'
import { palette, spinnerFrames } from '../theme.ts'

/** A small braille spinner. Ticks only while mounted, so an unmounted card costs nothing. */
export function Spinner({ color = palette.accent }: { color?: string }) {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setFrame((n) => (n + 1) % spinnerFrames.length), 80)
    return () => clearInterval(timer)
  }, [])
  return <Text color={color}>{spinnerFrames[frame]}</Text>
}

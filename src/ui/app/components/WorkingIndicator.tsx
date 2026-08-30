import { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { Spinner } from './Spinner.tsx'
import { palette } from '../theme.ts'

const VERBS = ['Thinking', 'Working', 'Pondering', 'Digging', 'Wiring things up', 'Reticulating']

/** The "still working" line: spinner · elapsed · a rotating verb (or the live status). */
export function WorkingIndicator({ startedAt, status }: { startedAt: number; status?: string }) {
  const [, force] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [])

  const seconds = Math.floor((Date.now() - startedAt) / 1000)
  const clock = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
  const label = status?.trim() || VERBS[Math.floor(seconds / 4) % VERBS.length]

  return (
    <Box marginTop={1}>
      <Spinner color={palette.accent} />
      <Text color={palette.muted}>
        {' '}
        {label} · {clock} · esc to interrupt
      </Text>
    </Box>
  )
}

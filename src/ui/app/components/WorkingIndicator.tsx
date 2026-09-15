import { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { Spinner } from './Spinner.tsx'
import { palette } from '../theme.ts'

/** `12s`, `3m04s`, `~14m` — precise while it matters, coarse once it doesn't. */
export function formatClock(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 300) return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
  return `~${Math.floor(seconds / 60)}m`
}

/** The one "still working" line: spinner · what is happening · (elapsed · esc to interrupt). */
export function WorkingIndicator({ startedAt, status, steeringPending = 0 }: { startedAt: number; status?: string; steeringPending?: number }) {
  const [, force] = useState(0)
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    // Each repaint re-anchors the terminal to the bottom, which fights the
    // user's scrollback. The clock is reassuring while a turn is young, so tick
    // once a second early — then back off hard. A 10-minute test run does not
    // need a live second-hand.
    const schedule = () => {
      const elapsed = Date.now() - startedAt
      const next = elapsed < 60_000 ? 1_000 : elapsed < 300_000 ? 10_000 : 30_000
      timer = setTimeout(() => {
        if (stopped) return
        force((n) => n + 1)
        schedule()
      }, next)
    }
    schedule()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [startedAt])

  const seconds = Math.floor((Date.now() - startedAt) / 1000)
  const label = (status?.trim() || 'Working').replace(/[.…]+$/, '')

  // The label gives way first: a long status truncates, the clock and the
  // "esc to interrupt" hint never do.
  return (
    <Box marginTop={1}>
      <Box width={2} flexShrink={0}>
        <Spinner />
      </Box>
      <Box flexShrink={1}>
        <Text wrap="truncate-end">{label}…</Text>
      </Box>
      <Box flexShrink={0}>
        <Text color={palette.muted}>
          {' '}({formatClock(seconds)} · esc to interrupt{steeringPending > 0 ? ` · ${steeringPending} steering queued` : ''})
        </Text>
      </Box>
    </Box>
  )
}

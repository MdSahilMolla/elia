import { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { Spinner } from './Spinner.tsx'
import { palette } from '../theme.ts'

const VERBS = ['Thinking', 'Working', 'Pondering', 'Digging', 'Wiring things up', 'Reticulating']

/** The "still working" line: spinner · elapsed · a rotating verb (or the live status). */
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
  const clock =
    seconds < 60
      ? `${seconds}s`
      : seconds < 300
        ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
        : `~${Math.floor(seconds / 60)}m`
  const label = status?.trim() || VERBS[Math.floor(seconds / 4) % VERBS.length]

  return (
    <Box marginTop={1}>
      <Spinner color={palette.accent} />
      <Text color={palette.muted}>
        {' '}
        {label} · {clock} · esc to interrupt
      </Text>
      {steeringPending > 0 && (
        <Text color={palette.accent}> · {steeringPending} steering queued (folds in at the next step)</Text>
      )}
    </Box>
  )
}

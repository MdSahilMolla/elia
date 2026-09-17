import { useRef, type MutableRefObject } from 'react'
import { Box, Text } from 'ink'
import { blendable, glyphs, palette } from '../theme.ts'
import { motionReduced, useAnimationClock } from '../animation.tsx'
import { easeToward, mixColor, shimmerRuns, sparkFrame, stallLevel } from '../motion.ts'
import { formatElapsed, formatTokens } from '../working.ts'
import { useFrameWidth } from '../wrap.ts'

/** What the running turn has produced so far — read on every frame, written without re-rendering the app. */
export interface TurnProgress {
  /** Estimated output tokens streamed this turn. */
  tokens: number
  /** When the last sign of life arrived: a streamed token, a tool starting or finishing. */
  lastAt: number
}

export interface WorkingIndicatorProps {
  startedAt: number
  /** What elia is doing, without the ellipsis (see working.ts `workingLabel`). */
  label: string
  progress?: MutableRefObject<TurnProgress>
  /** The model is streaming reasoning right now. */
  thinking?: boolean
  /** Only a silent *model* is a stall — a long test run is just a long test run. */
  waitingOnModel?: boolean
  steeringPending?: number
  /** A rotating hint, shown under the line. */
  tip?: string
}

/** The label keeps at least this many columns before details start to give way. */
const MIN_LABEL_COLUMNS = 18

/**
 * The parenthesised details that fit beside the label on a line `width` wide.
 * Least important go first — steering, the reasoning flag, the token count,
 * the silence warning — then "esc to interrupt" shortens to "esc". The clock
 * always stays.
 */
export function fitDetails(details: { key: string; text: string }[], labelColumns: number, width: number): string[] {
  const size = (items: { text: string }[]) => (items.length ? Bun.stringWidth(` (${items.map((item) => item.text).join(' · ')})`) : 0)
  const room = (items: { text: string }[]) => 2 + Math.min(labelColumns, MIN_LABEL_COLUMNS) + size(items) <= width
  let kept = details
  for (const key of ['steering', 'thinking', 'tokens', 'stall']) {
    if (!Number.isFinite(width) || room(kept)) break
    kept = kept.filter((item) => item.key !== key)
  }
  if (Number.isFinite(width) && !room(kept)) kept = kept.map((item) => (item.key === 'esc' ? { ...item, text: 'esc' } : item))
  return kept.map((item) => item.text)
}

/** The number on screen rolls up toward the real count instead of jumping. */
function useRollingCount(target: number, now: number): number {
  const shown = useRef(0)
  const lastTick = useRef(now)
  if (target < shown.current) shown.current = target
  if (now !== lastTick.current) {
    shown.current = motionReduced ? target : easeToward(shown.current, target, now - lastTick.current)
    lastTick.current = now
  }
  return shown.current
}

/**
 * The one "still working" line:
 *
 *   ✶ Reading stats.ts… (12s · ↓ 1.2k tokens · esc to interrupt)
 *     ⎿ Tip: ctrl+o expands every tool result
 *
 * The spark breathes in elia's gold and a brighter band sweeps across the
 * label; if the model goes quiet the spark cools toward red, and after a while
 * the line says how long it has been silent.
 */
export function WorkingIndicator({ startedAt, label, progress, thinking = false, waitingOnModel = false, steeringPending = 0, tip }: WorkingIndicatorProps) {
  const now = useAnimationClock()
  const width = useFrameWidth()
  const elapsed = Math.max(0, now - startedAt)
  const tokens = useRollingCount(Math.round(progress?.current.tokens ?? 0), now)
  const lastAt = Math.max(startedAt, progress?.current.lastAt ?? 0)
  const quiet = waitingOnModel ? Math.max(0, now - lastAt) : 0
  const stall = stallLevel(quiet)

  const text = `${label.trim().replace(/[.…]+$/, '') || 'Working'}…`
  const runs = shimmerRuns(text, elapsed, palette.brand, palette.brandShimmer, blendable && !motionReduced)
  const sparkColor = stall > 0 ? mixColor(palette.brand, palette.stall, stall) : palette.brand
  const details = fitDetails(
    [
      { key: 'clock', text: formatElapsed(elapsed / 1000) },
      { key: 'tokens', text: tokens > 0 ? `↓ ${formatTokens(tokens)} tokens` : '' },
      { key: 'thinking', text: thinking && !/^thinking/i.test(text) ? 'thinking' : '' },
      { key: 'stall', text: stall >= 1 ? `no output for ${formatElapsed(quiet / 1000)}` : '' },
      { key: 'steering', text: steeringPending > 0 ? `${steeringPending} steering queued` : '' },
      { key: 'esc', text: 'esc to interrupt' },
    ].filter((item) => item.text),
    Bun.stringWidth(text),
    width,
  )

  // The label gives way first: a long one truncates, the clock and the
  // "esc to interrupt" hint never do.
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Box width={2} flexShrink={0}>
          <Text color={sparkColor} bold>
            {motionReduced ? glyphs.brand : sparkFrame(elapsed)}
          </Text>
        </Box>
        <Box flexShrink={1}>
          <Text wrap="truncate-end">
            {runs.map((run, index) => (
              <Text key={index} color={run.color}>
                {run.text}
              </Text>
            ))}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text color={palette.muted}> ({details.join(' · ')})</Text>
        </Box>
      </Box>
      {tip ? (
        <Box marginLeft={2}>
          <Text color={palette.muted} wrap="truncate-end">
            {glyphs.branch} Tip: {tip}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}

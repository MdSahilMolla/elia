import { useMemo } from 'react'
import { Box, Static, Text } from 'ink'
import type { Item } from '../store.ts'
import { palette } from '../theme.ts'
import { TranscriptItemView } from './TranscriptItem.tsx'

/**
 * Finished turns go through <Static> — Ink prints each once, above the live
 * frame, and never touches it again. The in-progress turn re-renders normally.
 *
 * `live` may already have been trimmed to fit the viewport (WS0.7, see
 * `liveRegion.ts`); `hiddenRows` is how much was trimmed off the top. The
 * trimmed content is not lost — it prints in full to <Static> the moment it
 * settles — so the marker says where it went rather than offering to expand it.
 */
export function Transcript({
  committed,
  live,
  expandedAll,
  hiddenRows = 0,
  width,
}: {
  committed: readonly Item[]
  live: readonly Item[]
  expandedAll: boolean
  hiddenRows?: number
  /**
   * The frame width. <Static> is laid out as an absolutely-positioned box, so it
   * does not inherit its parent's width — without this, scrollback rows ran to
   * the terminal's full width and a row that filled it exactly wrapped one
   * character onto a line of its own on Windows consoles.
   */
  width?: number
}) {
  const staticStyle = useMemo(() => (width ? { width } : undefined), [width])
  // A run of status notes reads as one block: only the first gets a gap above it.
  const leadsNotes = (item: Item, previous: Item | undefined): boolean =>
    item.kind === 'notice' && previous !== undefined && previous.kind !== 'notice'
  return (
    <>
      <Static items={committed as Item[]} style={staticStyle}>
        {(item, index) => (
          <TranscriptItemView key={item.id} item={item} expanded={expandedAll} gapAbove={leadsNotes(item, committed[index - 1])} />
        )}
      </Static>
      <Box flexDirection="column">
        {hiddenRows > 0 && (
          <Text color={palette.muted}>
            {'  '}… {hiddenRows} line{hiddenRows === 1 ? '' : 's'} above, printed in full once finished
          </Text>
        )}
        {live.map((item, i) => (
          <TranscriptItemView
            key={item.id}
            item={item}
            expanded={expandedAll}
            gapAbove={leadsNotes(item, i === 0 ? committed[committed.length - 1] : live[i - 1])}
            live
          />
        ))}
      </Box>
    </>
  )
}

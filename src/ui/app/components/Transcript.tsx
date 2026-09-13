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
}: {
  committed: readonly Item[]
  live: readonly Item[]
  expandedAll: boolean
  hiddenRows?: number
}) {
  return (
    <>
      <Static items={committed as Item[]}>
        {(item) => <TranscriptItemView key={item.id} item={item} expanded={expandedAll} />}
      </Static>
      <Box flexDirection="column">
        {hiddenRows > 0 && (
          <Text color={palette.muted}>
            ↑ {hiddenRows} earlier row{hiddenRows === 1 ? '' : 's'} — printed to scrollback as they finish
          </Text>
        )}
        {live.map((item) => (
          <TranscriptItemView key={item.id} item={item} expanded={expandedAll} />
        ))}
      </Box>
    </>
  )
}

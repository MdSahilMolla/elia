import { Box, Static } from 'ink'
import type { Item } from '../store.ts'
import { TranscriptItemView } from './TranscriptItem.tsx'

/**
 * Finished turns go through <Static> — Ink prints each once, above the live
 * frame, and never touches it again. The in-progress turn re-renders normally.
 */
export function Transcript({
  committed,
  live,
  expandedAll,
}: {
  committed: readonly Item[]
  live: readonly Item[]
  expandedAll: boolean
}) {
  return (
    <>
      <Static items={committed as Item[]}>
        {(item) => <TranscriptItemView key={item.id} item={item} expanded={expandedAll} />}
      </Static>
      <Box flexDirection="column">
        {live.map((item) => (
          <TranscriptItemView key={item.id} item={item} expanded={expandedAll} />
        ))}
      </Box>
    </>
  )
}

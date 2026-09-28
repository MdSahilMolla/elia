import { Box, Text, useInput, type Key } from 'ink'
import { palette } from '../theme.ts'
import { Panel } from './Panel.tsx'
import { DiffPreview } from './DiffPreview.tsx'
import { ARM_MS, isTypingKey, useArming } from '../typingGuard.ts'

export interface ConfirmRequest {
  title: string
  lines: string[]
  /** A diff / content / command preview, rendered with +/- coloring so the change can be judged without scrolling back. */
  preview?: string[]
  /** Resolved with the user's choice. */
  resolve(approved: boolean): void
}

const PREVIEW_LIMIT = 24

/**
 * A y/n question. Mirrors confirm.ts semantics (y/yes → approve, anything else → deny).
 * Like the approval menu, it answers only once the keyboard has gone quiet —
 * a "y" in the middle of a sentence is typing, not a yes (typingGuard.ts).
 */
export function Confirm({ request, onTypeThrough, armMs = ARM_MS }: { request: ConfirmRequest; onTypeThrough?: (input: string, key: Key) => void; armMs?: number }) {
  const arming = useArming(armMs)
  useInput((input, key) => {
    if (key.escape) return request.resolve(false)
    const decision = input === 'y' || input === 'Y' || input === 'n' || input === 'N' || key.return
    if (!arming.press() || !decision) {
      if (isTypingKey(input, key)) onTypeThrough?.(input, key)
      arming.rest()
      return
    }
    if (input === 'y' || input === 'Y') request.resolve(true)
    else request.resolve(false)
  })

  return (
    <Panel title={request.title} tone="warning">
      {request.lines.map((line, i) => (
        <Text key={i} color={palette.muted} wrap="wrap">
          {line}
        </Text>
      ))}
      {request.preview && request.preview.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <DiffPreview lines={request.preview} limit={PREVIEW_LIMIT} />
        </Box>
      )}
      <Box marginTop={1}>
        {/* Enter declines, so the default is shown the conventional way: N. */}
        <Text>
          Continue? <Text bold>y</Text>
          <Text color={palette.muted}>/</Text>
          <Text bold>N</Text>
          <Text color={palette.muted}>  enter or esc declines</Text>
        </Text>
      </Box>
    </Panel>
  )
}

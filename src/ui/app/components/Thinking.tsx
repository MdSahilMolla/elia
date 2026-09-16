import { Box, Text } from 'ink'
import { glyphs, palette } from '../theme.ts'
import { useFrameWidth, wrapPlain } from '../wrap.ts'

/**
 * Reasoning — the model's own, or elia thinking a request through before it
 * plans. Marked with ✻ and set in dim italics so it never reads as the answer
 * itself. A continuation (the next finished lines of the same reasoning, see
 * store.ts) carries no mark and no gap, so it reads as one block.
 */
export function Thinking({ text, continuation = false }: { text: string; streaming?: boolean; continuation?: boolean }) {
  const width = useFrameWidth()
  const lines = text.replace(/\s+$/, '').split('\n')
  return (
    <Box flexDirection="column" marginTop={continuation ? 0 : 1}>
      {lines.map((line, i) => (
        <Box key={i}>
          <Box width={2} flexShrink={0}>
            <Text color={palette.muted}>{i === 0 && !continuation ? glyphs.thinking : ' '}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            <Text color={palette.muted} italic wrap="wrap">
              {wrapPlain(line, width - 2) || ' '}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}

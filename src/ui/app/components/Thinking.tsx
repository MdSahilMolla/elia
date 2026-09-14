import { Box, Text } from 'ink'
import { palette } from '../theme.ts'

/**
 * Reasoning — the model's own, or elia thinking a request through before it
 * plans. Marked with ✻ so it never reads as the answer itself.
 */
export function Thinking({ text }: { text: string; streaming?: boolean }) {
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      {text.split('\n').map((line, i) => (
        <Text key={i} color={palette.muted} italic>
          {i === 0 ? `✻ ${line}` : `  ${line}`}
        </Text>
      ))}
    </Box>
  )
}

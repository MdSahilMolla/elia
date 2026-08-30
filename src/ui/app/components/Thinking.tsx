import { Box, Text } from 'ink'
import { palette } from '../theme.ts'

export function Thinking({ text }: { text: string; streaming?: boolean }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {text.split('\n').map((line, i) => (
        <Text key={i} color={palette.muted} italic>
          {line}
        </Text>
      ))}
    </Box>
  )
}

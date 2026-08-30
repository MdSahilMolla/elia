import { Box, Text, useInput } from 'ink'
import { palette } from '../theme.ts'

export interface ConfirmRequest {
  title: string
  lines: string[]
  /** Resolved with the user's choice. */
  resolve(approved: boolean): void
}

/** A y/n approval card. Mirrors confirm.ts semantics (y/yes → approve, anything else → deny). */
export function Confirm({ request }: { request: ConfirmRequest }) {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') request.resolve(true)
    else if (input === 'n' || input === 'N' || key.escape || key.return) request.resolve(false)
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.accent} paddingX={1} marginTop={1}>
      <Text bold color={palette.accent}>
        {request.title}
      </Text>
      {request.lines.map((line, i) => (
        <Text key={i} color={palette.muted}>
          {line}
        </Text>
      ))}
      <Text>
        Approve? <Text color={palette.success}>y</Text> / <Text color={palette.failure}>n</Text>
      </Text>
    </Box>
  )
}

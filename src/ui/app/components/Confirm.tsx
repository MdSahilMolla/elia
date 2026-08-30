import { Box, Text, useInput } from 'ink'
import { palette } from '../theme.ts'

export interface ConfirmRequest {
  title: string
  lines: string[]
  /** A diff / content / command preview, rendered with +/- coloring so the change can be judged without scrolling back. */
  preview?: string[]
  /** Resolved with the user's choice. */
  resolve(approved: boolean): void
}

const PREVIEW_LIMIT = 24

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
      {request.preview && request.preview.length > 0 && (
        <Box flexDirection="column" marginTop={1} marginBottom={1}>
          {request.preview.slice(0, PREVIEW_LIMIT).map((line, i) => (
            <Text
              key={i}
              color={line.startsWith('+') ? palette.success : line.startsWith('-') ? palette.failure : palette.muted}
            >
              {line}
            </Text>
          ))}
          {request.preview.length > PREVIEW_LIMIT && (
            <Text color={palette.muted}>… +{request.preview.length - PREVIEW_LIMIT} more lines</Text>
          )}
        </Box>
      )}
      <Text>
        Approve? <Text color={palette.success}>y</Text> / <Text color={palette.failure}>n</Text>
      </Text>
    </Box>
  )
}

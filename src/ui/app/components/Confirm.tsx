import { Box, Text, useInput } from 'ink'
import { palette } from '../theme.ts'
import { Panel } from './Panel.tsx'

export interface ConfirmRequest {
  title: string
  lines: string[]
  /** A diff / content / command preview, rendered with +/- coloring so the change can be judged without scrolling back. */
  preview?: string[]
  /** Resolved with the user's choice. */
  resolve(approved: boolean): void
}

const PREVIEW_LIMIT = 24

/** A y/n question. Mirrors confirm.ts semantics (y/yes → approve, anything else → deny). */
export function Confirm({ request }: { request: ConfirmRequest }) {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') request.resolve(true)
    else if (input === 'n' || input === 'N' || key.escape || key.return) request.resolve(false)
  })

  return (
    <Panel title={request.title}>
      {request.lines.map((line, i) => (
        <Text key={i} color={palette.muted} wrap="wrap">
          {line}
        </Text>
      ))}
      {request.preview && request.preview.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {request.preview.slice(0, PREVIEW_LIMIT).map((line, i) => (
            <Text
              key={i}
              wrap="truncate-end"
              color={line.startsWith('+') ? palette.success : line.startsWith('-') ? palette.failure : undefined}
            >
              {line}
            </Text>
          ))}
          {request.preview.length > PREVIEW_LIMIT && (
            <Text color={palette.muted}>… +{request.preview.length - PREVIEW_LIMIT} more lines</Text>
          )}
        </Box>
      )}
      <Box marginTop={1}>
        <Text>
          Continue? <Text bold>y</Text>
          <Text color={palette.muted}>/</Text>
          <Text bold>n</Text>
        </Text>
      </Box>
    </Panel>
  )
}

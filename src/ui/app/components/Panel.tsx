import type { ReactNode } from 'react'
import { Box, Text } from 'ink'
import { palette } from '../theme.ts'

/**
 * The boxless replacement for `<Box borderStyle="round">`. Structure comes from a
 * heading, a one-column indent, and vertical spacing — never a drawn border.
 * Box-drawing frames wrap badly on narrow terminals and, when a stray write
 * lands mid-frame, flatten into `| | |` soup (observed 2026-09-10). See
 * docs/terminal-ui-redesign-plan.md.
 */
export function Panel({
  title,
  tone = 'accent',
  marginTop = 1,
  children,
}: {
  title?: string
  tone?: 'accent' | 'success' | 'failure' | 'muted' | 'warning'
  marginTop?: number
  children: ReactNode
}) {
  const color = palette[tone]
  return (
    <Box flexDirection="column" marginTop={marginTop}>
      {title ? (
        <Text bold color={color}>
          {title}
        </Text>
      ) : null}
      <Box flexDirection="column" marginLeft={2}>
        {children}
      </Box>
    </Box>
  )
}

import type { ReactNode } from 'react'
import { Box, Text } from 'ink'
import { palette } from '../theme.ts'

type Tone = 'accent' | 'brand' | 'success' | 'failure' | 'muted' | 'warning' | 'permission' | 'plan'

/**
 * The boxless replacement for `<Box borderStyle="round">`. Structure comes from
 * a heading underlined by one rule, a two-column indent, and vertical spacing —
 * never a drawn frame. Side borders wrap badly on narrow terminals and, when a
 * stray write lands mid-frame, flatten into `| | |` soup (observed 2026-09-10).
 * See docs/terminal-ui-redesign-plan.md.
 */
export function Panel({
  title,
  tone = 'accent',
  marginTop = 1,
  children,
}: {
  title?: string
  tone?: Tone
  marginTop?: number
  children: ReactNode
}) {
  const color = palette[tone]
  return (
    <Box flexDirection="column" marginTop={marginTop}>
      {title ? (
        <Box borderStyle="single" borderColor={color ?? palette.subtle} borderTop={false} borderBottom borderLeft={false} borderRight={false}>
          <Text bold color={color} wrap="truncate-end">
            {title}
          </Text>
        </Box>
      ) : null}
      <Box flexDirection="column" marginLeft={2}>
        {children}
      </Box>
    </Box>
  )
}

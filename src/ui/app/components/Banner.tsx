import { Box, Text } from 'ink'
import { palette } from '../theme.ts'

// A small pixel "e" monogram next to "elia CLI" + version — deliberately minimal,
// the way Devin's banner is just its glyph and two words. House style for brand
// art here is "a few characters, not a set piece" (see src/ui/character.ts).
const GLYPH = [
  ' ▄███▄',
  '██▄▄▄▀',
  '██▀▀▀▀',
  ' ▀███▀',
] as const

export function Banner(props: { version: string }) {
  return (
    <Box>
      <Box flexDirection="column" marginRight={2}>
        {GLYPH.map((line, i) => (
          <Text key={i} color={palette.accent} bold>
            {line}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" justifyContent="center">
        <Text>
          <Text color={palette.accent} bold>
            elia
          </Text>
          <Text bold> CLI</Text>
        </Text>
        <Text color={palette.muted}>v{props.version}</Text>
      </Box>
    </Box>
  )
}

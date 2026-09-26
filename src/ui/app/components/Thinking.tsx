import { Box, Text } from 'ink'
import { glyphs, palette } from '../theme.ts'
import { useFrameWidth, wrapPlain } from '../wrap.ts'
import { motionReduced, useAnimationClock } from '../animation.tsx'
import { mixColor, pulseLevel } from '../motion.ts'

/** The ✻ breathing between dim and elia's gold while reasoning is still arriving. */
function BreathingMark() {
  const now = useAnimationClock()
  return <Text color={motionReduced ? palette.brand : mixColor(palette.muted, palette.brand, pulseLevel(now))}>{glyphs.thinking}</Text>
}

/**
 * Reasoning — the model's own, or elia thinking a request through before it
 * plans. Marked with ✻ and set in dim italics so it never reads as the answer
 * itself. While it is still streaming the ✻ breathes, so reasoning in flight
 * looks alive instead of like a finished block. A continuation (the next
 * finished lines of the same reasoning, see store.ts) carries no mark and no
 * gap, so it reads as one block.
 */
export function Thinking({ text, streaming = false, continuation = false }: { text: string; streaming?: boolean; continuation?: boolean }) {
  const width = useFrameWidth()
  const lines = text.replace(/\s+$/, '').split('\n')
  return (
    <Box flexDirection="column" marginTop={continuation ? 0 : 1}>
      {lines.map((line, i) => (
        <Box key={i}>
          <Box width={2} flexShrink={0}>
            {i === 0 && !continuation ? (
              streaming ? <BreathingMark /> : <Text color={palette.muted}>{glyphs.thinking}</Text>
            ) : (
              <Text> </Text>
            )}
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

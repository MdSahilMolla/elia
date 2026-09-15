import { Box, Text } from 'ink'
import type { Item } from '../store.ts'
import { palette, glyphs } from '../theme.ts'
import { AssistantMessage } from './AssistantMessage.tsx'
import { Thinking } from './Thinking.tsx'
import { ExploreCard, ToolCard } from './ToolCard.tsx'
import { useFrameWidth, wrapPlain } from '../wrap.ts'

/**
 * A marker column plus text that wraps *inside* its own column, so every
 * continuation row lines up under the first instead of snapping back to the
 * left edge.
 */
function Marked({ mark, color, children, textColor, marginTop = 0 }: {
  mark: string
  color?: string
  textColor?: string
  marginTop?: number
  children: string
}) {
  const width = useFrameWidth()
  return (
    <Box marginTop={marginTop}>
      <Box width={2} flexShrink={0}>
        <Text color={color}>{mark}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text color={textColor} wrap="wrap">
          {wrapPlain(children, width - 2)}
        </Text>
      </Box>
    </Box>
  )
}

/** A dim status note, indented under the markers above it. */
function Note({ text, marginTop }: { text: string; marginTop: number }) {
  const width = useFrameWidth()
  return (
    <Box paddingLeft={2} marginTop={marginTop}>
      <Text color={palette.muted} wrap="wrap">
        {wrapPlain(text, width - 2)}
      </Text>
    </Box>
  )
}

export function TranscriptItemView({ item, expanded, gapAbove = false }: { item: Item; expanded: boolean; gapAbove?: boolean }) {
  switch (item.kind) {
    case 'header':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text bold>elia</Text>
            <Text color={palette.muted}>
              {' '}v{item.version}
              {item.greeting ? ` · ${item.greeting}` : ''}
            </Text>
          </Text>
          {item.location || item.lessons ? (
            <Text color={palette.muted} wrap="truncate-end">
              {item.location ?? ''}
              {item.location && item.lessons ? ' · ' : ''}
              {item.lessons ? `${glyphs.learn} ${item.lessons} lesson${item.lessons === 1 ? '' : 's'} from past runs` : ''}
            </Text>
          ) : null}
        </Box>
      )
    case 'user':
      // What you sent carries the same `❯` as the prompt you typed it at, dimmed —
      // it reads as "you said", and the reply's `●` reads as "elia said".
      return (
        <Marked mark={glyphs.user} color={palette.muted} marginTop={1}>
          {item.text}
        </Marked>
      )
    case 'assistant':
      return (
        <Box marginTop={1}>
          <AssistantMessage text={item.text} streaming={item.streaming} lead={!item.continuation} />
        </Box>
      )
    case 'thinking':
      return <Thinking text={item.text} streaming={item.streaming} continuation={item.continuation} />
    case 'tool':
      return (
        <Box marginTop={1}>
          <ToolCard tool={item} expanded={expanded} />
        </Box>
      )
    case 'group':
      return (
        <Box marginTop={1}>
          <ExploreCard tools={item.tools} expanded={expanded} />
        </Box>
      )
    case 'shell':
      return (
        <Box flexDirection="column" marginTop={1}>
          {item.text.split('\n').map((line, i) => (
            <Text key={i} color={i === 0 ? undefined : palette.muted} wrap="truncate-end">
              {i === 0 ? line : `  ${line}`}
            </Text>
          ))}
        </Box>
      )
    case 'notice': {
      // A learning receipt (✦) is elia committing something durable to memory —
      // full weight, so it doesn't read as just another grey status.
      if (item.text.startsWith(glyphs.learn)) {
        return (
          <Marked mark={glyphs.learn} marginTop={gapAbove ? 1 : 0}>
            {item.text.slice(glyphs.learn.length).trimStart()}
          </Marked>
        )
      }
      return <Note text={item.text} marginTop={gapAbove ? 1 : 0} />
    }
    case 'error':
      return (
        <Marked mark={glyphs.error} color={palette.failure} textColor={palette.failure} marginTop={1}>
          {item.text}
        </Marked>
      )
  }
}

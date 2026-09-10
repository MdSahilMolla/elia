import { Box, Text } from 'ink'
import type { Item } from '../store.ts'
import { palette, glyphs } from '../theme.ts'
import { AssistantMessage } from './AssistantMessage.tsx'
import { Thinking } from './Thinking.tsx'
import { ToolCard } from './ToolCard.tsx'

export function TranscriptItemView({ item, expanded }: { item: Item; expanded: boolean }) {
  switch (item.kind) {
    case 'user':
      // elia's own turn marker: a thin accent rule down the left of what you
      // sent — the terminal equivalent of a quote bar. Distinct from the live
      // input's `❯` prompt, so a committed turn reads differently from the
      // thing you're still typing, and no full-width fill to stay minimal.
      return (
        <Box marginTop={1}>
          <Text color={palette.accent}>▎ </Text>
          <Text>{item.text}</Text>
        </Box>
      )
    case 'assistant':
      return (
        <Box marginTop={1}>
          <AssistantMessage text={item.text} streaming={item.streaming} />
        </Box>
      )
    case 'thinking':
      return <Thinking text={item.text} streaming={item.streaming} />
    case 'tool':
      return (
        <Box marginTop={1}>
          <ToolCard tool={item} expanded={expanded} />
        </Box>
      )
    case 'shell':
      return (
        <Box flexDirection="column" marginTop={1}>
          {item.text.split('\n').map((line, i) => (
            <Text key={i} color={palette.muted}>
              {line}
            </Text>
          ))}
        </Box>
      )
    case 'notice': {
      // A learning receipt (✦) is elia committing something durable to memory —
      // give it accent weight so it doesn't read as just another grey status.
      const isLearning = item.text.startsWith('✦')
      return <Text color={isLearning ? palette.accent : palette.muted}>{item.text}</Text>
    }
    case 'error':
      // A red left rail rather than a bare red line — scannable in scrollback,
      // and no box to wrap. Multi-line errors keep the rail on every row.
      return (
        <Box flexDirection="column" marginTop={1}>
          {item.text.split('\n').map((line, i) => (
            <Box key={i}>
              <Text color={palette.failure}>{glyphs.errorRail} </Text>
              <Text color={palette.failure} wrap="wrap">
                {line || ' '}
              </Text>
            </Box>
          ))}
        </Box>
      )
  }
}

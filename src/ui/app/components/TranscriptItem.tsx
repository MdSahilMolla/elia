import { Box, Text } from 'ink'
import type { Item } from '../store.ts'
import { palette, glyphs } from '../theme.ts'
import { AssistantMessage } from './AssistantMessage.tsx'
import { Thinking } from './Thinking.tsx'
import { ToolCard } from './ToolCard.tsx'

export function TranscriptItemView({ item, expanded }: { item: Item; expanded: boolean }) {
  switch (item.kind) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color={palette.user}>{glyphs.user} </Text>
          <Text color={palette.user}>{item.text}</Text>
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
    case 'notice':
      return (
        <Text color={palette.muted}>{item.text}</Text>
      )
    case 'error':
      return (
        <Text color={palette.failure}>{item.text}</Text>
      )
  }
}

import type { ReactNode } from 'react'
import { Box, Text } from 'ink'
import { palette } from '../theme.ts'

/** Minimal inline markdown → Ink runs: **bold**, `code`. Block-level markdown lands in Phase C. */
function inlineRuns(line: string): ReactNode[] {
  const runs: ReactNode[] = []
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = pattern.exec(line)) !== null) {
    if (match.index > last) runs.push(<Text key={key++}>{line.slice(last, match.index)}</Text>)
    const token = match[0]
    if (token.startsWith('**')) runs.push(<Text key={key++} bold>{token.slice(2, -2)}</Text>)
    else runs.push(<Text key={key++} color={palette.toolName}>{token.slice(1, -1)}</Text>)
    last = match.index + token.length
  }
  if (last < line.length) runs.push(<Text key={key++}>{line.slice(last)}</Text>)
  return runs.length > 0 ? runs : [<Text key={0}>{line}</Text>]
}

export function AssistantMessage({ text, streaming }: { text: string; streaming: boolean }) {
  const lines = text.split('\n')
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading) {
          return (
            <Text key={i} bold color={palette.accent}>
              {i === 0 ? '● ' : ''}
              {heading[2]}
            </Text>
          )
        }
        return (
          <Text key={i}>
            {i === 0 ? <Text color={palette.accent}>● </Text> : null}
            {inlineRuns(line)}
            {streaming && i === lines.length - 1 ? <Text color={palette.muted}>▏</Text> : null}
          </Text>
        )
      })}
    </Box>
  )
}

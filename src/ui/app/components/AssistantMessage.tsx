import { Fragment, type ReactNode } from 'react'
import { Box, Text } from 'ink'
import { parseMarkdownBlocks, type InlineRun, type MarkdownBlock } from '../../markdownBlocks.ts'
import { palette } from '../theme.ts'

function InlineText({ runs }: { runs: InlineRun[] }) {
  return (
    <>
      {runs.map((run, index) => {
        if (run.kind === 'strong') return <Text key={index} bold>{run.text}</Text>
        if (run.kind === 'code') return <Text key={index} color={palette.toolName}>{run.text}</Text>
        if (run.kind === 'link') {
          const visible = run.text === run.url ? run.url : `${run.text} (${run.url})`
          return <Text key={index} color={palette.toolName} underline>{visible}</Text>
        }
        return <Fragment key={index}>{run.text}</Fragment>
      })}
    </>
  )
}

function Cursor() {
  return <Text color={palette.muted}>▏</Text>
}

function BlockShell({ lead, marginTop, children }: { lead: boolean; marginTop: number; children: ReactNode }) {
  return (
    <Box width="100%" marginTop={marginTop}>
      <Text color={palette.accent}>{lead ? '● ' : '  '}</Text>
      <Box flexDirection="column" flexBasis={0} flexGrow={1}>{children}</Box>
    </Box>
  )
}

function TableCell({ runs, header, align, cursor }: { runs: InlineRun[]; header?: boolean; align: 'left' | 'right' | 'center'; cursor?: boolean }) {
  return (
    <Box flexBasis={0} flexGrow={1} marginRight={1} justifyContent={align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start'}>
      <Text bold={header} underline={header} wrap="wrap">
        <InlineText runs={runs} />
        {cursor ? <Cursor /> : null}
      </Text>
    </Box>
  )
}

function BlockBody({ block, cursor }: { block: MarkdownBlock; cursor: boolean }) {
  switch (block.kind) {
    case 'heading':
      return (
        <Text bold color={block.level <= 2 ? palette.accent : undefined} wrap="wrap">
          {block.level === 1 ? '━━ ' : block.level === 2 ? '◆ ' : '▸ '}
          <InlineText runs={block.content} />
          {cursor ? <Cursor /> : null}
        </Text>
      )
    case 'paragraph':
      return (
        <Text wrap="wrap">
          <InlineText runs={block.content} />
          {cursor ? <Cursor /> : null}
        </Text>
      )
    case 'list':
      return (
        <Box flexDirection="column">
          {block.items.map((item, index) => {
            const marker = item.checked === true ? '✓' : item.checked === false ? '□' : /^\d/.test(item.marker) ? item.marker : '•'
            return (
              <Box key={index} paddingLeft={item.depth * 2}>
                <Text color={item.checked === true ? palette.success : item.checked === false ? palette.muted : palette.accent}>{marker} </Text>
                <Text wrap="wrap">
                  <InlineText runs={item.content} />
                  {cursor && index === block.items.length - 1 ? <Cursor /> : null}
                </Text>
              </Box>
            )
          })}
        </Box>
      )
    case 'quote':
      return (
        <Box flexDirection="column">
          {block.lines.map((line, index) => (
            <Box key={index}>
              <Text color={palette.muted}>│ </Text>
              <Text italic color={palette.muted} wrap="wrap">
                <InlineText runs={line} />
                {cursor && index === block.lines.length - 1 ? <Cursor /> : null}
              </Text>
            </Box>
          ))}
        </Box>
      )
    case 'code':
      return (
        <Box flexDirection="column" width="100%" borderStyle="round" borderColor={palette.muted} paddingX={1}>
          {block.language ? <Text bold color={palette.toolName}>{block.language}{!block.complete ? ' …' : ''}</Text> : null}
          {(block.lines.length > 0 ? block.lines : ['']).map((line, index) => (
            <Text key={index} wrap="wrap">
              {line}
              {cursor && index === Math.max(0, block.lines.length - 1) ? <Cursor /> : null}
            </Text>
          ))}
        </Box>
      )
    case 'rule':
      return <Text color={palette.muted}>────────────────{cursor ? <Cursor /> : null}</Text>
    case 'table': {
      const rows = [block.header, ...block.rows]
      return (
        <Box flexDirection="column" width="100%">
          {rows.map((row, rowIndex) => (
            <Box key={rowIndex} width="100%">
              {block.header.map((_, columnIndex) => (
                <TableCell
                  key={columnIndex}
                  runs={row[columnIndex] ?? [{ kind: 'text', text: '' }]}
                  header={rowIndex === 0}
                  align={block.align[columnIndex] ?? 'left'}
                  cursor={cursor && rowIndex === rows.length - 1 && columnIndex === block.header.length - 1}
                />
              ))}
            </Box>
          ))}
        </Box>
      )
    }
  }
}

export function AssistantMessage({ text, streaming }: { text: string; streaming: boolean }) {
  const blocks = parseMarkdownBlocks(text)

  if (blocks.length === 0) {
    return streaming ? <Text color={palette.accent}>● <Cursor /></Text> : null
  }

  return (
    <Box flexDirection="column" width="100%">
      {blocks.map((block, index) => (
        <BlockShell key={index} lead={index === 0} marginTop={index === 0 ? 0 : 1}>
          <BlockBody block={block} cursor={streaming && index === blocks.length - 1} />
        </BlockShell>
      ))}
    </Box>
  )
}

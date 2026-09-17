import { Fragment, type ReactNode } from 'react'
import { Box, Text } from 'ink'
import { parseMarkdownBlocks, type InlineRun, type MarkdownBlock } from '../../markdownBlocks.ts'
import { glyphs, palette } from '../theme.ts'
import { highlightLine, normalizeLanguage } from '../highlight.ts'
import { useFrameWidth, wrapRuns } from '../wrap.ts'

/** One code line, syntax-highlighted into coloured Text runs. */
function CodeLine({ line, language, trailingCursor }: { line: string; language?: string; trailingCursor?: boolean }) {
  const segs = highlightLine(line, language)
  return (
    <Text wrap="wrap">
      {segs.map((seg, i) => (
        <Text key={i} color={seg.color} bold={seg.bold}>
          {seg.text}
        </Text>
      ))}
      {trailingCursor ? <Cursor /> : null}
    </Text>
  )
}

function InlineText({ runs }: { runs: InlineRun[] }) {
  return (
    <>
      {runs.map((run, index) => {
        if (run.kind === 'strong') return <Text key={index} bold>{run.text}</Text>
        if (run.kind === 'em') return <Text key={index} italic>{run.text}</Text>
        // Code gets the one "look here" hue — no background pill, which turned
        // into a black slab on light terminal themes.
        if (run.kind === 'code') return <Text key={index} color={palette.code}>{run.text}</Text>
        if (run.kind === 'link') {
          const visible = run.text === run.url ? run.url : `${run.text} (${run.url})`
          return <Text key={index} color={palette.code} underline>{visible}</Text>
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
      <Box width={2} flexShrink={0}>
        <Text>{lead ? glyphs.bullet : ' '}</Text>
      </Box>
      <Box flexDirection="column" flexBasis={0} flexGrow={1}>{children}</Box>
    </Box>
  )
}

function TableCell({ runs, header, align, cursor }: { runs: InlineRun[]; header?: boolean; align: 'left' | 'right' | 'center'; cursor?: boolean }) {
  return (
    <Box flexBasis={0} flexGrow={1} marginRight={1} justifyContent={align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start'}>
      <Text bold={header} wrap="wrap">
        <InlineText runs={runs} />
        {cursor ? <Cursor /> : null}
      </Text>
    </Box>
  )
}

function BlockBody({ block, cursor, width }: { block: MarkdownBlock; cursor: boolean; width: number }) {
  // A streaming block ends in a one-column cursor — leave room for it.
  const room = (columns: number) => columns - (cursor ? 1 : 0)
  switch (block.kind) {
    case 'heading':
      // Hierarchy from weight, not a rainbow: h1/h2 bold, h3+ bold and quieter.
      return (
        <Text bold color={block.level >= 3 ? palette.muted : undefined} wrap="wrap">
          <InlineText runs={wrapRuns(block.content, room(width))} />
          {cursor ? <Cursor /> : null}
        </Text>
      )
    case 'paragraph':
      return (
        <Text wrap="wrap">
          <InlineText runs={wrapRuns(block.content, room(width))} />
          {cursor ? <Cursor /> : null}
        </Text>
      )
    case 'list':
      return (
        <Box flexDirection="column">
          {block.items.map((item, index) => {
            const marker = item.checked === true ? '✓' : item.checked === false ? '□' : /^\d/.test(item.marker) ? item.marker : '•'
            const last = cursor && index === block.items.length - 1
            const itemWidth = width - item.depth * 2 - (Bun.stringWidth(marker) + 1) - (last ? 1 : 0)
            return (
              <Box key={index} paddingLeft={item.depth * 2}>
                <Box flexShrink={0}>
                  <Text color={item.checked === true ? palette.success : palette.muted}>{marker} </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text wrap="wrap">
                    <InlineText runs={wrapRuns(item.content, itemWidth)} />
                    {last ? <Cursor /> : null}
                  </Text>
                </Box>
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
                <InlineText runs={wrapRuns(line, width - 2 - (cursor && index === block.lines.length - 1 ? 1 : 0))} />
                {cursor && index === block.lines.length - 1 ? <Cursor /> : null}
              </Text>
            </Box>
          ))}
        </Box>
      )
    case 'code': {
      // Boxless: a dim left rail per line + a language label, instead of a
      // drawn border that wraps badly and can flatten into `| |` soup.
      // Lines are syntax-highlighted (see ../highlight.ts).
      const lang = normalizeLanguage(block.language)
      return (
        <Box flexDirection="column" width="100%">
          {block.language ? (
            <Text color={palette.muted}>
              {block.language}
              {!block.complete ? ' …' : ''}
            </Text>
          ) : null}
          {(block.lines.length > 0 ? block.lines : ['']).map((line, index) => (
            <Box key={index}>
              <Text color={palette.subtle}>│ </Text>
              <CodeLine
                line={line}
                language={lang}
                trailingCursor={cursor && index === Math.max(0, block.lines.length - 1)}
              />
            </Box>
          ))}
        </Box>
      )
    }
    case 'rule':
      return <Text color={palette.subtle}>────────────────{cursor ? <Cursor /> : null}</Text>
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

/**
 * An assistant reply (or one finished paragraph-run of it). `lead` draws the
 * `●` that opens a reply; a continuation — the next paragraphs of the same
 * reply, committed separately while it streams — lines up under it instead.
 */
export function AssistantMessage({ text, streaming, lead = true }: { text: string; streaming: boolean; lead?: boolean }) {
  const blocks = parseMarkdownBlocks(text)
  // Every block sits behind the two-column `●` lead.
  const width = useFrameWidth() - 2

  if (blocks.length === 0) {
    return streaming ? (
      <BlockShell lead={lead} marginTop={0}>
        <Cursor />
      </BlockShell>
    ) : null
  }

  return (
    <Box flexDirection="column" width="100%">
      {blocks.map((block, index) => (
        <BlockShell key={index} lead={lead && index === 0} marginTop={index === 0 ? 0 : 1}>
          <BlockBody block={block} cursor={streaming && index === blocks.length - 1} width={width} />
        </BlockShell>
      ))}
    </Box>
  )
}

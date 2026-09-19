import { Box, Text } from 'ink'
import { palette } from '../theme.ts'
import { pairChanges, paintRow, type DiffRow } from '../diffRows.ts'
import { highlightLine, normalizeLanguage } from '../highlight.ts'
import { useFrameWidth } from '../wrap.ts'

interface PreviewRow extends DiffRow {
  /** The line as approvalPreview.ts wrote it, for rows that are not a change. */
  raw: string
}

function toRow(line: string): PreviewRow {
  const text = line.replace(/\t/g, '  ')
  if (text.startsWith('+ ') || text === '+') return { kind: 'add', text: text.slice(2), raw: text }
  if (text.startsWith('- ') || text === '-') return { kind: 'del', text: text.slice(2), raw: text }
  return { kind: 'ctx', text, raw: text }
}

/**
 * The change an approval is about, drawn the way the transcript draws a diff:
 * removed and added lines on their bands, the words that differ marked, code
 * coloured when the file's language is known. Other lines — the path, the
 * command — stay plain.
 */
export function DiffPreview({ lines, limit }: { lines: readonly string[]; limit: number }) {
  // The panel body starts two columns in.
  const width = useFrameWidth() - 2
  const rows = pairChanges(lines.map(toRow)) as PreviewRow[]
  const pathLine = rows.find((row) => row.kind === 'ctx' && /\.[a-z0-9]+\b/i.test(row.raw))
  const language = normalizeLanguage(/\.([a-z0-9]+)\b/i.exec(pathLine?.raw ?? '')?.[1])
  const shown = rows.slice(0, limit)
  return (
    <Box flexDirection="column">
      {shown.map((row, index) => {
        if (row.kind !== 'add' && row.kind !== 'del') {
          return (
            <Text key={index} wrap="truncate-end" color={row.raw.startsWith('@@') ? palette.muted : undefined}>
              {row.raw}
            </Text>
          )
        }
        const added = row.kind === 'add'
        const band = added ? palette.diffAddBg : palette.diffDelBg
        const sign = added ? '+' : '-'
        const signColor = added ? palette.success : palette.failure
        if (!band) {
          return (
            <Text key={index} wrap="truncate-end" color={signColor}>
              {row.raw}
            </Text>
          )
        }
        const body = row.text || ' '
        const pad = Number.isFinite(width) ? Math.max(0, width - 2 - Bun.stringWidth(body)) : 0
        return (
          <Text key={index} wrap="truncate-end" backgroundColor={band}>
            <Text color={signColor}>{sign}</Text>{' '}
            {paintRow(highlightLine(body, language), row.changes).map((paint, j) => (
              <Text key={j} color={paint.color} bold={paint.bold} backgroundColor={paint.changed ? (added ? palette.diffAddWordBg : palette.diffDelWordBg) : undefined}>
                {paint.text}
              </Text>
            ))}
            {pad > 0 ? ' '.repeat(pad) : null}
          </Text>
        )
      })}
      {rows.length > shown.length ? <Text color={palette.muted}>… +{rows.length - shown.length} more lines</Text> : null}
    </Box>
  )
}

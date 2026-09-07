import { Box, Text } from 'ink'
import { Spinner } from './Spinner.tsx'
import { glyphs, palette } from '../theme.ts'
import type { ToolItem } from '../store.ts'
import { summarizeTool } from '../toolSummary.ts'
import { summarizeResult } from '../../stream.ts'
import { foldText } from '../../render.ts'
import { redactText } from '../../redact.ts'
import { visualizationTerminalPreview } from '../../../tools/visualize.ts'
import { listLoadedSkills } from '../../../skills/loader.ts'

/** Tools whose result is worth a one-line `⎿` summary under the header, always — the way Devin shows "⎿ 50 lines". */
const SUMMARY_LINE_TOOLS = new Set(['read_file', 'grep', 'list_files', 'web_search', 'web_fetch', 'todo_write'])

interface DiffRow {
  kind: 'hunk' | 'add' | 'del' | 'ctx' | 'meta'
  num?: number
  text: string
}

/** Parses the `` ```diff `` block of an edit/write result into rows with a line-number gutter. */
function parseDiff(result: string): DiffRow[] {
  const start = result.indexOf('```diff')
  if (start === -1) return []
  const afterFence = result.indexOf('\n', start)
  const end = result.indexOf('```', afterFence + 1)
  const body = result.slice(afterFence + 1, end === -1 ? undefined : end).split('\n')

  const rows: DiffRow[] = []
  let oldLn = 0
  let newLn = 0
  for (const line of body) {
    if (line.length === 0) continue
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      oldLn = Number(hunk[1])
      newLn = Number(hunk[2])
      rows.push({ kind: 'hunk', text: line })
      continue
    }
    const marker = line[0]
    const text = line.slice(1)
    if (marker === '+') rows.push({ kind: 'add', num: newLn++, text })
    else if (marker === '-') rows.push({ kind: 'del', num: oldLn++, text })
    else if (marker === '\\') rows.push({ kind: 'meta', text: text.trim() })
    else {
      rows.push({ kind: 'ctx', num: newLn, text })
      oldLn += 1
      newLn += 1
    }
  }
  return rows
}

const gutter = (n: number | undefined): string => (n === undefined ? '' : String(n)).padStart(4, ' ')

function DiffBody({ rows, limit }: { rows: DiffRow[]; limit: number }) {
  const shown = rows.slice(0, limit)
  return (
    <Box flexDirection="column" marginLeft={4}>
      {shown.map((row, i) => {
        if (row.kind === 'hunk' || row.kind === 'meta') return <Text key={i} color={palette.muted}>{row.kind === 'hunk' ? row.text : `     ${row.text}`}</Text>
        const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '
        const color = row.kind === 'add' ? palette.success : row.kind === 'del' ? palette.failure : palette.muted
        return (
          <Text key={i} color={color} wrap="truncate-end">
            <Text color={palette.muted}>{gutter(row.num)} </Text>
            {sign} {row.text || ' '}
          </Text>
        )
      })}
      {rows.length > shown.length && (
        <Text color={palette.muted}>… +{rows.length - shown.length} lines — Ctrl+O</Text>
      )}
    </Box>
  )
}

/**
 * One tool call, Claude-Code style: a single line —
 *   ⏺ Edited App.tsx  +16 −2
 * collapsed by default. Errors always expand; Ctrl+O (via `expanded`) expands
 * everything.
 */
/** "$ cmd" echo + the last few output lines — shown for every run_command, not only on expand. */
function ShellBody({ tool, expanded }: { tool: ToolItem; expanded: boolean }) {
  const command = typeof tool.input.command === 'string' ? tool.input.command : ''
  const body = (tool.result ?? '')
    .split('\n')
    .filter((line) => line !== 'stdout:' && line !== 'stderr:' && !/^(exit code:|timed out)/i.test(line))
  const limit = expanded ? 400 : 8
  const shown = body.slice(-limit)
  const hidden = body.length - shown.length
  const lineColor = tool.status === 'error' ? palette.failure : palette.muted
  return (
    <Box flexDirection="column" marginLeft={4}>
      <Text color={palette.muted}>$ {command}</Text>
      {hidden > 0 && <Text color={palette.muted}>… +{hidden} earlier lines{expanded ? '' : ' — Ctrl+O'}</Text>}
      {shown.map((line, i) => (
        <Text key={i} color={lineColor} wrap="truncate-end">
          {line || ' '}
        </Text>
      ))}
    </Box>
  )
}

export function ToolCard({ tool, expanded }: { tool: ToolItem; expanded: boolean }) {
  const s = summarizeTool(tool)
  const running = tool.status === 'running'
  const isError = tool.status === 'error'
  const isShell = tool.name === 'run_command'
  const isSkill = listLoadedSkills().some((skill) => skill.name === tool.name)
  const badExit = isShell && (s.stat === 'timed out' || (s.stat.startsWith('exit ') && s.stat !== 'exit 0'))
  const showBody =
    (tool.name === 'visualize' || (isShell && tool.result) || expanded || isError) && !running && tool.result
  const summaryLine =
    !running && !isError && !expanded && tool.result && SUMMARY_LINE_TOOLS.has(tool.name)
      ? summarizeResult(tool.name, tool.result)
      : ''

  const markColor = isError || badExit ? palette.failure : running ? palette.toolName : palette.success
  const mark = running
    ? null
    : isError || badExit
      ? glyphs.error
      : tool.status === 'cached'
        ? glyphs.cached
        : glyphs.ok

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={isSkill ? palette.accent : markColor}>{isSkill ? glyphs.skill : glyphs.bullet} </Text>
        {isSkill && <Text color={palette.accent} bold>Skill </Text>}
        <Text color={isError ? palette.failure : undefined} bold={isSkill}>{isSkill ? tool.name : s.verb}</Text>
        {s.target && !isSkill ? (
          <Text bold={tool.name === 'edit_file' || tool.name === 'write_file'}> {s.target}</Text>
        ) : null}
        {s.stat ? <Text color={badExit ? palette.failure : palette.muted}>  {s.stat}</Text> : null}
        {running && (
          <Text>
            {'  '}
            <Spinner />
          </Text>
        )}
        {!running && mark && <Text color={markColor}> {mark}</Text>}
        {!running && s.expandable && !expanded && !isError && <Text color={palette.muted}> ›</Text>}
        {tool.durationMs !== undefined && tool.durationMs >= 500 && !running && (
          <Text color={palette.muted}> ({(tool.durationMs / 1000).toFixed(1)}s)</Text>
        )}
      </Box>

      {summaryLine && !showBody && (
        <Box marginLeft={2}>
          <Text color={palette.muted}>{glyphs.branch} {summaryLine}</Text>
        </Box>
      )}
      {showBody && tool.result && (isShell ? <ShellBody tool={tool} expanded={expanded} /> : renderBody(tool, s, expanded))}
    </Box>
  )
}

function renderBody(tool: ToolItem, s: ReturnType<typeof summarizeTool>, expanded: boolean) {
  if (tool.name === 'visualize' && tool.status !== 'error') {
    return (
      <Box marginLeft={4} flexDirection="column">
        <Text>{visualizationTerminalPreview(tool.result ?? '')}</Text>
      </Box>
    )
  }
  if ((tool.name === 'edit_file' || tool.name === 'write_file') && tool.status !== 'error') {
    const rows = parseDiff(tool.result ?? '')
    if (rows.length > 0) return <DiffBody rows={rows} limit={expanded ? 600 : 24} />
  }
  if (tool.status === 'error') {
    return (
      <Box marginLeft={4}>
        <Text color={palette.failure}>{redactText(tool.result ?? '', 800)}</Text>
      </Box>
    )
  }
  const folded = expanded ? { text: tool.result ?? '' } : foldText(tool.result ?? '', { headLines: 16 })
  return (
    <Box marginLeft={4}>
      <Text color={palette.muted}>{expanded ? folded.text : summarizeResult(tool.name, tool.result ?? '')}</Text>
    </Box>
  )
}

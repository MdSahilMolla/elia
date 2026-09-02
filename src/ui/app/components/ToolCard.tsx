import { Box, Text } from 'ink'
import { Spinner } from './Spinner.tsx'
import { glyphs, palette } from '../theme.ts'
import type { ToolItem } from '../store.ts'
import { summarizeTool } from '../toolSummary.ts'
import { summarizeResult } from '../../stream.ts'
import { foldText } from '../../render.ts'
import { redactText } from '../../redact.ts'
import { visualizationTerminalPreview } from '../../../tools/visualize.ts'

/** Splits a `… ```diff … ``` …` result into a plain preamble and the diff body lines. */
function splitDiff(result: string): { diff: string[] } {
  const start = result.indexOf('```diff')
  if (start === -1) return { diff: [] }
  const afterFence = result.indexOf('\n', start)
  const end = result.indexOf('```', afterFence + 1)
  const body = result.slice(afterFence + 1, end === -1 ? undefined : end)
  return { diff: body.split('\n').filter((line) => line.length > 0) }
}

function DiffBody({ lines, limit }: { lines: string[]; limit: number }) {
  const shown = lines.slice(0, limit)
  return (
    <Box flexDirection="column" marginLeft={4}>
      {shown.map((line, i) => (
        <Text
          key={i}
          color={line.startsWith('+') ? palette.success : line.startsWith('-') ? palette.failure : palette.muted}
        >
          {line}
        </Text>
      ))}
      {lines.length > shown.length && (
        <Text color={palette.muted}>… +{lines.length - shown.length} lines — Ctrl+O</Text>
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
export function ToolCard({ tool, expanded }: { tool: ToolItem; expanded: boolean }) {
  const s = summarizeTool(tool)
  const running = tool.status === 'running'
  const isError = tool.status === 'error'
  const showBody = (tool.name === 'visualize' || expanded || isError) && !running && tool.result

  const markColor = isError ? palette.failure : running ? palette.toolName : palette.success
  const mark = running ? null : isError ? glyphs.error : tool.status === 'cached' ? glyphs.cached : glyphs.ok

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={markColor}>{glyphs.bullet} </Text>
        <Text color={isError ? palette.failure : undefined}>{s.verb}</Text>
        {s.target ? (
          <Text bold={tool.name === 'edit_file' || tool.name === 'write_file'}> {s.target}</Text>
        ) : null}
        {s.stat ? <Text color={palette.muted}>  {s.stat}</Text> : null}
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

      {showBody && tool.result && renderBody(tool, s, expanded)}
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
    const { diff } = splitDiff(tool.result ?? '')
    if (diff.length > 0) return <DiffBody lines={diff} limit={expanded ? 400 : 24} />
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

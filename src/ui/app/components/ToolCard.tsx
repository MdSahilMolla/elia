import { Box, Text } from 'ink'
import { Spinner } from './Spinner.tsx'
import { glyphs, palette } from '../theme.ts'
import type { ToolItem } from '../store.ts'
import { activeVerb, exploreSummary, summarizeTool } from '../toolSummary.ts'
import { summarizeResult } from '../../stream.ts'
import { foldText } from '../../render.ts'
import { redactText } from '../../redact.ts'
import { visualizationTerminalPreview } from '../../../tools/visualize.ts'
import { listLoadedSkills } from '../../../skills/loader.ts'
import { highlightLine, normalizeLanguage } from '../highlight.ts'

// One tool call reads as a single line, Claude-Code style:
//
//   ● Edited src/app.ts  +1 −1
//     ⎿ …a short body when there is one worth seeing…
//
// The dot carries the state — a spinner while running, green when it worked,
// red when it failed — so there is no trailing ✓, no cache mark and no
// "expand me" chevron competing with the text. Ctrl+O expands every body.

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
  // The first hunk header only restates the line numbers the gutter already
  // shows; later ones become a quiet "⋮" gap marker.
  return rows.filter((row, i) => !(row.kind === 'hunk' && rows.slice(0, i).every((r) => r.kind === 'hunk')))
}

const gutter = (n: number | undefined): string => (n === undefined ? '' : String(n)).padStart(4, ' ')

/** Extension → highlight language for a diff/edit target. */
function languageForTarget(target?: string): string | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(target ?? '')?.[1]
  return normalizeLanguage(ext)
}

const COLLAPSED_DIFF_ROWS = 12
const COLLAPSED_SHELL_ROWS = 5

function MoreRows({ hidden, expanded }: { hidden: number; expanded: boolean }) {
  if (hidden <= 0) return null
  return <Text color={palette.muted}>… +{hidden} lines{expanded ? '' : ' (ctrl+o to expand)'}</Text>
}

function DiffBody({ rows, limit, language, expanded }: { rows: DiffRow[]; limit: number; language?: string; expanded: boolean }) {
  const shown = rows.slice(0, limit)
  return (
    <Box flexDirection="column" marginLeft={2}>
      {shown.map((row, i) => {
        if (row.kind === 'hunk') return <Text key={i} color={palette.muted}>{'   ⋮'}</Text>
        if (row.kind === 'meta') return <Text key={i} color={palette.muted}>{`     ${row.text}`}</Text>
        const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '
        // Added / removed lines keep their green / red so the change reads at a
        // glance; context lines get syntax highlighting instead of flat grey.
        const lineColor = row.kind === 'add' ? palette.success : row.kind === 'del' ? palette.failure : undefined
        return (
          <Text key={i} color={lineColor} wrap="truncate-end">
            <Text color={palette.muted}>{gutter(row.num)} </Text>
            {sign}{' '}
            {row.kind === 'ctx'
              ? highlightLine(row.text || ' ', language).map((seg, j) => (
                  <Text key={j} color={seg.color} bold={seg.bold}>
                    {seg.text}
                  </Text>
                ))
              : row.text || ' '}
          </Text>
        )
      })}
      <MoreRows hidden={rows.length - shown.length} expanded={expanded} />
    </Box>
  )
}

/** The tail of a command's output — the part that usually says how it went. */
function ShellBody({ tool, expanded }: { tool: ToolItem; expanded: boolean }) {
  const body = (tool.result ?? '')
    .split('\n')
    .filter((line) => line !== 'stdout:' && line !== 'stderr:' && !/^(exit code:|timed out)/i.test(line))
  while (body.length > 0 && !body[body.length - 1]!.trim()) body.pop()
  while (body.length > 0 && !body[0]!.trim()) body.shift()
  if (body.length === 0) return null
  const limit = expanded ? 400 : COLLAPSED_SHELL_ROWS
  const shown = body.slice(-limit)
  const hidden = body.length - shown.length
  const failed = tool.status === 'error'
  return (
    <Box flexDirection="column" marginLeft={2}>
      {hidden > 0 && <Text color={palette.muted}>  … +{hidden} earlier lines{expanded ? '' : ' (ctrl+o to expand)'}</Text>}
      {shown.map((line, i) => (
        <Text key={i} color={failed ? palette.failure : palette.muted} wrap="truncate-end">
          {i === 0 && hidden === 0 ? `${glyphs.branch} ` : '  '}
          {line || ' '}
        </Text>
      ))}
    </Box>
  )
}

/** A single dim `⎿ summary` row under a header. */
function SummaryRow({ text, color }: { text: string; color?: string }) {
  return (
    <Box marginLeft={2}>
      <Text color={color ?? palette.muted} wrap="truncate-end">
        {glyphs.branch} {text}
      </Text>
    </Box>
  )
}

/** The dot that leads every tool row — the state lives here. */
function Dot({ running, failed, color }: { running: boolean; failed: boolean; color?: string }) {
  if (running) return <Spinner />
  return <Text color={color ?? (failed ? palette.failure : palette.success)}>{glyphs.bullet}</Text>
}

function seconds(ms: number | undefined): string {
  if (ms === undefined || ms < 3_000) return ''
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`
}

/** First meaningful line of a result — the one-line gist for tools with no custom summary. */
function gist(result: string): string {
  const line = result.split('\n').map((l) => l.trim()).find((l) => l && !/^```/.test(l)) ?? ''
  return redactText(line, 160)
}

export function ToolCard({ tool, expanded }: { tool: ToolItem; expanded: boolean }) {
  const s = summarizeTool(tool)
  const running = tool.status === 'running'
  const isError = tool.status === 'error'
  const isShell = tool.name === 'run_command'
  const isEdit = (tool.name === 'edit_file' || tool.name === 'write_file') && !isError
  const isSkill = listLoadedSkills().some((skill) => skill.name === tool.name)
  const badExit = isShell && (s.stat === 'timed out' || (s.stat.startsWith('exit ') && s.stat !== 'exit 0'))
  // A successful plan update has nothing to say here — the live plan panel
  // shows it, and its receipt closes the turn.
  if (tool.name === 'todo_write' && tool.status !== 'error' && !expanded) return null
  const failed = isError || badExit
  const stat = isShell ? (badExit ? s.stat : '') : s.stat
  const time = running ? '' : seconds(tool.durationMs)

  return (
    <Box flexDirection="column">
      <Box>
        <Box width={2} flexShrink={0}>
          {isSkill && !running ? <Text>{glyphs.skill}</Text> : <Dot running={running} failed={failed} />}
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">
            {isSkill ? <Text bold>Skill {tool.name}</Text> : <Text bold>{running ? activeVerb(s.verb) : s.verb}</Text>}
            {s.target && !isSkill ? <Text> {s.target}</Text> : null}
            {stat ? <Text color={failed ? palette.failure : palette.muted}>  {stat}</Text> : null}
            {time ? <Text color={palette.muted}>  {time}</Text> : null}
          </Text>
        </Box>
      </Box>
      {!running && <ToolBody tool={tool} expanded={expanded} isShell={isShell} isEdit={isEdit} target={s.target} />}
    </Box>
  )
}

function ToolBody({ tool, expanded, isShell, isEdit, target }: { tool: ToolItem; expanded: boolean; isShell: boolean; isEdit: boolean; target: string }) {
  const result = tool.result ?? ''
  if (!result.trim()) return null
  if (tool.status === 'error') {
    const lines = redactText(result, expanded ? 4_000 : 400)
    return <SummaryRow text={lines} color={palette.failure} />
  }
  if (isShell) return <ShellBody tool={tool} expanded={expanded} />
  if (tool.name === 'visualize') {
    return (
      <Box marginLeft={4} flexDirection="column">
        <Text>{visualizationTerminalPreview(result)}</Text>
      </Box>
    )
  }
  if (isEdit) {
    const rows = parseDiff(result)
    if (rows.length > 0) return <DiffBody rows={rows} limit={expanded ? 600 : COLLAPSED_DIFF_ROWS} language={languageForTarget(target)} expanded={expanded} />
    return null
  }
  if (expanded) {
    return (
      <Box marginLeft={4}>
        <Text color={palette.muted}>{foldText(result, { headLines: 400 }).text}</Text>
      </Box>
    )
  }
  return <SummaryRow text={summarizeResult(tool.name, result) || gist(result)} />
}

/**
 * A run of read-only lookups as one row:
 *
 *   ● Read 3 files, searched 1 pattern
 *     ⎿ app.ts, package.json, README.md +1
 *
 * A lone lookup keeps the ordinary single-call shape. Failures inside the
 * group are always listed; Ctrl+O lists every call.
 */
export function ExploreCard({ tools, expanded }: { tools: readonly ToolItem[]; expanded: boolean }) {
  if (tools.length === 1) return <ToolCard tool={tools[0]!} expanded={expanded} />
  const running = tools.some((tool) => tool.status === 'running')
  const failures = tools.filter((tool) => tool.status === 'error')
  const targets = [...new Set(tools.map((tool) => summarizeTool(tool).target).filter(Boolean))]
  const shownTargets = targets.slice(0, 4).join(', ')
  const moreTargets = targets.length > 4 ? ` +${targets.length - 4}` : ''
  return (
    <Box flexDirection="column">
      <Box>
        <Box width={2} flexShrink={0}>
          <Dot running={running} failed={false} color={failures.length === tools.length ? palette.failure : undefined} />
        </Box>
        <Text bold wrap="truncate-end">
          {exploreSummary(tools)}
        </Text>
      </Box>
      {expanded ? (
        tools.map((tool) => {
          const s = summarizeTool(tool)
          const detail = tool.status === 'running' ? '…' : tool.status === 'error' ? redactText(tool.result ?? '', 160) : summarizeResult(tool.name, tool.result ?? '')
          return <SummaryRow key={tool.id} text={`${s.verb} ${s.target}${detail ? ` — ${detail}` : ''}`} color={tool.status === 'error' ? palette.failure : undefined} />
        })
      ) : (
        <>
          {shownTargets && <SummaryRow text={`${shownTargets}${moreTargets}`} />}
          {failures.map((tool) => {
            const s = summarizeTool(tool)
            return <SummaryRow key={tool.id} text={`${s.verb} ${s.target} — ${redactText(tool.result ?? 'failed', 140)}`} color={palette.failure} />
          })}
        </>
      )}
    </Box>
  )
}

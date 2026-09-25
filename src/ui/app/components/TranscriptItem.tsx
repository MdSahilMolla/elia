import { Box, Text } from 'ink'
import type { Item } from '../store.ts'
import { blendable, palette, glyphs } from '../theme.ts'
import { motionReduced, useAnimationClock } from '../animation.tsx'
import { FLARE_MS, flareFrame, flareRuns, mixColor } from '../motion.ts'
import { AssistantMessage } from './AssistantMessage.tsx'
import { Thinking } from './Thinking.tsx'
import { ExploreCard, ShellBody, ToolCard } from './ToolCard.tsx'
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

/** Status marks a notice can open with, and the colour each one means. */
const NOTE_MARKS: Record<string, keyof typeof palette> = {
  '✓': 'success',
  '✗': 'failure',
  '◐': 'warning',
  '!': 'warning',
}

/** A dim status note, indented under the markers above it. A leading ✓ / ✗ / ◐ keeps its meaning in colour. */
function Note({ text, marginTop }: { text: string; marginTop: number }) {
  const width = useFrameWidth()
  const wrapped = wrapPlain(text, width - 2)
  const mark = /^([✓✗◐!])\s/.exec(wrapped)?.[1]
  return (
    <Box paddingLeft={2} marginTop={marginTop}>
      <Text color={palette.muted} wrap="wrap">
        {mark ? <Text color={palette[NOTE_MARKS[mark]!]}>{mark}</Text> : null}
        {mark ? wrapped.slice(mark.length) : wrapped}
      </Text>
    </Box>
  )
}

/**
 * What you sent, on a quiet band that runs the width of the frame — the one
 * thing worth finding again when scrolling back through a long session.
 * Without a band colour (the ANSI theme, NO_COLOR) it is a dim `❯` and the text.
 */
function UserMessage({ text }: { text: string }) {
  const width = useFrameWidth()
  const band = palette.userBg
  if (!band || !Number.isFinite(width)) {
    return (
      <Marked mark={glyphs.user} color={palette.muted} marginTop={1}>
        {text}
      </Marked>
    )
  }
  const bodyWidth = width - 2
  const lines = wrapPlain(text, bodyWidth).split('\n')
  return (
    <Box flexDirection="column" marginTop={1}>
      {lines.map((line, index) => (
        <Text key={index} backgroundColor={band}>
          <Text color={palette.muted}>{index === 0 ? glyphs.user : ' '} </Text>
          {line}
          {' '.repeat(Math.max(0, bodyWidth - Bun.stringWidth(line)))}
        </Text>
      ))}
    </Box>
  )
}

/**
 * A `!command` result without shell.ts's framing: the command, its output, and
 * the exit status only when it is worth reading (non-zero, or a timeout).
 */
export function shellView(text: string): { command: string; output: string[]; exit: string } {
  const [command = '', ...rest] = text.split('\n')
  let exit = ''
  const output: string[] = []
  for (const line of rest) {
    const code = /^exit code:\s*(-?\d+)\s*$/.exec(line)
    if (code) {
      if (code[1] !== '0') exit = `exit ${code[1]}`
      continue
    }
    if (line.startsWith('timed out after ')) {
      exit = line
      continue
    }
    if (line === 'stdout:' || line === 'stderr:') continue
    output.push(line)
  }
  while (output.length > 0 && !output[output.length - 1]!.trim()) output.pop()
  return { command, output, exit }
}

/**
 * A lesson landing: the ✦ catches — the working spark's frames, played once —
 * while a single bright band crosses the lesson, then both settle into the
 * ordinary learning line. Only ever mounted in the live region, and only
 * while the flare has time left to run.
 */
function LearnedFlare({ text, at, marginTop }: { text: string; at: number; marginTop: number }) {
  const now = useAnimationClock()
  const width = useFrameWidth()
  const since = now - at
  const glyph = flareFrame(since) ?? glyphs.learn
  const settle = Math.min(1, Math.max(0, since / FLARE_MS))
  const runs = flareRuns(wrapPlain(text, width - 2), since, palette.brand, palette.brandShimmer, blendable)
  return (
    <Box marginTop={marginTop}>
      <Box width={2} flexShrink={0}>
        <Text color={mixColor(palette.brandShimmer, palette.brand, settle)} bold>
          {glyph}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="wrap">
          {runs.map((run, index) => (
            <Text key={index} color={run.color}>
              {run.text}
            </Text>
          ))}
        </Text>
      </Box>
    </Box>
  )
}

export function TranscriptItemView({ item, expanded, gapAbove = false, live = false }: { item: Item; expanded: boolean; gapAbove?: boolean; live?: boolean }) {
  switch (item.kind) {
    case 'header': {
      const context = [item.model, item.location].filter(Boolean).join(' · ')
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text bold color={palette.brand}>
              {glyphs.brand} elia
            </Text>
            <Text color={palette.muted}>
              {' '}v{item.version}
              {item.greeting ? ` · ${item.greeting}` : ''}
            </Text>
          </Text>
          {context ? (
            <Text color={palette.muted} wrap="truncate-end">
              {'  '}
              {context}
            </Text>
          ) : null}
          {item.lessons ? (
            <Text color={palette.muted} wrap="truncate-end">
              {'  '}
              {item.lessons} lesson{item.lessons === 1 ? '' : 's'} carried from past runs
              {item.lessonsHelp ? (
                <Text>
                  {' · '}
                  <Text color={palette.brand}>{glyphs.learn}</Text> {item.lessonsHelp} proven to help
                </Text>
              ) : null}
              {item.lessonsHurt ? <Text color={palette.warning}> · {item.lessonsHurt} proven to hurt</Text> : null}
              {' · /lessons'}
            </Text>
          ) : null}
        </Box>
      )
    }
    case 'user':
      return <UserMessage text={item.text} />
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
          <ToolCard tool={item} expanded={expanded} live={live} />
        </Box>
      )
    case 'group':
      return (
        <Box marginTop={1}>
          <ExploreCard tools={item.tools} expanded={expanded} />
        </Box>
      )
    case 'shell': {
      const { command, output, exit } = shellView(item.text)
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text wrap="truncate-end">
            <Text color={palette.bash}>{command.slice(0, 1)}</Text>
            {command.slice(1)}
          </Text>
          {/* The same body a tool card's command gets — indented under the
              command, `⎿`-led — shown in full, since you asked to see it. */}
          <ShellBody lines={output} failed={false} expanded />
          {exit ? (
            <Box marginLeft={2}>
              <Text color={palette.failure} wrap="truncate-end">
                {output.length === 0 ? `${glyphs.branch} ` : '  '}
                {exit}
              </Text>
            </Box>
          ) : null}
        </Box>
      )
    }
    case 'notice': {
      // A learning receipt (✦) is elia committing something durable to memory —
      // full weight, so it doesn't read as just another grey status.
      if (item.text.startsWith(glyphs.learn)) {
        const rest = item.text.slice(glyphs.learn.length).trimStart()
        if (live && item.at !== undefined && !motionReduced && Date.now() - item.at < FLARE_MS) {
          return <LearnedFlare text={rest} at={item.at} marginTop={gapAbove ? 1 : 0} />
        }
        return (
          <Marked mark={glyphs.learn} color={palette.brand} marginTop={gapAbove ? 1 : 0}>
            {item.text.slice(glyphs.learn.length).trimStart()}
          </Marked>
        )
      }
      return <Note text={item.text} marginTop={gapAbove ? 1 : 0} />
    }
    case 'receipt':
      // The spark, settled: the turn is over. A turn you stopped, or one that
      // failed, does not get the spark — it gets the mark that says how it ended.
      return (
        <Marked
          mark={item.ending === 'stopped' ? glyphs.warn : item.ending === 'failed' ? glyphs.error : glyphs.receipt}
          color={item.ending === 'stopped' ? palette.warning : item.ending === 'failed' ? palette.failure : palette.brand}
          textColor={palette.muted}
          marginTop={1}
        >
          {item.text}
        </Marked>
      )
    case 'error':
      return (
        <Marked mark={glyphs.error} color={palette.failure} textColor={palette.failure} marginTop={1}>
          {item.text}
        </Marked>
      )
  }
}

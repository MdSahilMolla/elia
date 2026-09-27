import { Box, Text } from 'ink'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { motionReduced } from '../animation.tsx'
import { palette } from '../theme.ts'

/**
 * One message the person sent while elia worked, as the thinking panel shows
 * it: the note, elia's reasoning about it (streamed), what they want, where
 * the work really stands, the answer, and how the plan changed.
 */
export interface PanelNote {
  id: number
  question: string
  thinking: string
  /** Built from what actually ran — never from the model. */
  rightNow: string
  wants?: string
  answer?: string
  changes?: Array<{ kind: 'change' | 'add' | 'remove'; text: string }>
  /** The note went to the running work (with or without a plan change). */
  passed?: boolean
  /** Sentences taken out of the answer because nothing that ran backs them up. */
  dropped?: number
  state: 'thinking' | 'updated' | 'answered' | 'failed'
  error?: string
}

/** How long the panel takes to slide open or shut. */
export const PANEL_SLIDE_MS = 420
const FRAME_MS = 33

/** 0 = shut, 1 = open, eased between the two whenever `open` flips. */
function useSlide(open: boolean): number {
  // Starts shut, so a panel that mounts open slides in.
  const [progress, setProgress] = useState(0)
  const current = useRef(0)
  useEffect(() => {
    const target = open ? 1 : 0
    if (motionReduced) {
      current.current = target
      setProgress(target)
      return
    }
    const from = current.current
    const started = Date.now()
    const timer = setInterval(() => {
      const t = Math.min(1, (Date.now() - started) / PANEL_SLIDE_MS)
      const eased = 1 - (1 - t) ** 3
      const value = t >= 1 ? target : from + (target - from) * eased
      current.current = value
      setProgress(value)
      if (t >= 1) clearInterval(timer)
    }, FRAME_MS)
    return () => clearInterval(timer)
  }, [open])
  return progress
}

const MARK: Record<'change' | 'add' | 'remove', string> = { change: '~', add: '+', remove: '−' }

function noteLines(note: PanelNote): ReactNode[] {
  const lines: ReactNode[] = [
    <Text key={`q${note.id}`} wrap="wrap">
      <Text color={palette.muted}>❯ </Text>
      {note.question}
    </Text>,
  ]
  const thinking = note.thinking.length > 420 ? `…${note.thinking.slice(-420)}` : note.thinking
  if (thinking || note.state === 'thinking') {
    lines.push(
      <Text key={`t${note.id}`} italic color={palette.muted} wrap="wrap">
        ✻ {thinking || 'reading your note…'}
      </Text>,
    )
  }
  if (note.wants) {
    lines.push(
      <Text key={`w${note.id}`} wrap="wrap">
        <Text bold>You want: </Text>
        <Text color={palette.muted}>{note.wants}</Text>
      </Text>,
    )
  }
  lines.push(
    <Text key={`r${note.id}`} wrap="wrap">
      <Text bold>Right now: </Text>
      <Text color={palette.muted}>{note.rightNow}</Text>
    </Text>,
  )
  if (note.answer) {
    lines.push(
      <Text key={`a${note.id}`} wrap="wrap">
        <Text color={palette.brand}>● </Text>
        {note.answer}
      </Text>,
    )
  }
  if (note.dropped) {
    lines.push(
      <Text key={`d${note.id}`} color={palette.muted} dimColor wrap="wrap">
        {`✂ ${note.dropped === 1 ? 'a claim' : `${note.dropped} claims`} removed — nothing that ran backs ${note.dropped === 1 ? 'it' : 'them'} up`}
      </Text>,
    )
  }
  if (note.changes && note.changes.length > 0) {
    lines.push(<Text key={`p${note.id}`} bold>Plan change</Text>)
    note.changes.forEach((change, index) =>
      lines.push(
        <Text key={`p${note.id}-${index}`} wrap="wrap">
          <Text color={change.kind === 'add' ? palette.success : change.kind === 'remove' ? palette.failure : palette.warning}>{MARK[change.kind]} </Text>
          <Text color={palette.muted}>{change.text}</Text>
        </Text>,
      ),
    )
  }
  lines.push(
    <Text key={`s${note.id}`} wrap="wrap" color={note.state === 'failed' ? palette.failure : palette.muted}>
      {note.state === 'thinking'
        ? '… thinking'
        : note.state === 'updated'
          ? '✓ Plan updated — the work picks it up at its next step.'
          : note.state === 'answered'
            ? note.passed ? '↳ No plan change — your note reaches the work at its next step.' : 'No plan change.'
            : `✗ ${note.error ?? 'could not think it through'} — your note went to the work as written.`}
    </Text>,
  )
  return lines
}

/**
 * The thinking panel: where elia works out what a mid-work message means and
 * how the plan should change, beside the plan it changes.
 *
 * Wide terminals get a column that slides in from the right: its width eases
 * open while the content, laid out at the final width and clipped, stays put —
 * nothing reflows frame to frame. Narrow terminals get the same content above
 * the input, revealed line by line. Reduced motion skips the slide.
 */
export function ThinkingPanel({
  open,
  notes,
  width,
  layout,
  pinned,
  onClosed,
}: {
  open: boolean
  notes: readonly PanelNote[]
  width: number
  layout: 'side' | 'stacked'
  pinned: boolean
  onClosed?: () => void
}) {
  const progress = useSlide(open)
  const closedRef = useRef(false)
  useEffect(() => {
    if (!open && progress === 0) {
      if (!closedRef.current) {
        closedRef.current = true
        onClosed?.()
      }
    } else closedRef.current = false
  }, [open, progress, onClosed])
  if (!open && progress === 0) return null

  const lines: ReactNode[] = [
    <Text key="head" color={palette.plan}>◇ Thinking about your note</Text>,
    ...notes.slice(-2).flatMap((note, index) => (index > 0 ? [<Text key={`gap${note.id}`}> </Text>, ...noteLines(note)] : noteLines(note))),
    <Text key="hint" color={palette.muted} dimColor>
      {pinned ? 'ctrl+w hides this' : 'ctrl+w keeps this open'}
    </Text>,
  ]

  if (layout === 'stacked') {
    const shown = Math.max(1, Math.round(progress * lines.length))
    return (
      <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor={palette.plan} borderRight={false} borderTop={false} borderBottom={false} paddingLeft={1}>
        {lines.slice(0, shown)}
      </Box>
    )
  }

  const visible = Math.max(1, Math.round(progress * width))
  return (
    <Box width={visible} flexShrink={0} overflowX="hidden" marginTop={1}>
      <Box width={width} flexShrink={0} flexDirection="column" borderStyle="single" borderColor={palette.plan} borderRight={false} borderTop={false} borderBottom={false} paddingLeft={1}>
        {lines}
      </Box>
    </Box>
  )
}

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
  state: 'thinking' | 'updated' | 'answered' | 'failed'
  error?: string
  /** The note went to the running work (with or without a plan change). */
  passed?: boolean
  /** Sentences taken out of the answer because nothing that ran backs them up. */
  dropped?: number
}

/** How long the panel takes to slide open or shut. */
export const PANEL_SLIDE_MS = 460
/** After the panel starts opening, when its first row appears. */
export const FIRST_ROW_MS = 180
/** Rows that arrive together appear one after another, this far apart… */
export const ROW_STAGGER_MS = 250
/** …each fading in (dim, then full) over this long. */
export const ROW_FADE_MS = 300
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
      // cubic-bezier(0.2, 0.8, 0.2, 1) is close to a quartic ease-out.
      const eased = 1 - (1 - t) ** 4
      const value = t >= 1 ? target : from + (target - from) * eased
      current.current = value
      setProgress(value)
      if (t >= 1) clearInterval(timer)
    }, FRAME_MS)
    return () => clearInterval(timer)
  }, [open])
  return progress
}

type RowPhase = 'hidden' | 'fading' | 'shown'

/**
 * Rows appear in order: a row that arrives with others waits its turn,
 * `ROW_STAGGER_MS` after the one above, and fades in. A row keeps the moment
 * it first appeared, so text that grows in place (the streamed thinking)
 * never appears twice.
 */
function useRowReveal(keys: readonly string[]): (key: string) => RowPhase {
  const openedAt = useRef(Date.now())
  const revealAt = useRef(new Map<string, number>())
  const [, setFrame] = useState(0)
  const now = Date.now()
  let previous = openedAt.current + FIRST_ROW_MS - ROW_STAGGER_MS
  for (const key of keys) {
    let at = revealAt.current.get(key)
    if (at === undefined) {
      at = motionReduced ? now : Math.max(now, previous + ROW_STAGGER_MS)
      revealAt.current.set(key, at)
    }
    previous = Math.max(previous, at)
  }
  const moving = !motionReduced && keys.some((key) => now < (revealAt.current.get(key) ?? 0) + ROW_FADE_MS)
  useEffect(() => {
    if (!moving) return
    const timer = setInterval(() => setFrame((n) => n + 1), FRAME_MS)
    return () => clearInterval(timer)
  }, [moving])
  return (key) => {
    const at = revealAt.current.get(key) ?? 0
    if (now < at) return 'hidden'
    return now < at + ROW_FADE_MS / 2 ? 'fading' : 'shown'
  }
}

const MARK: Record<'change' | 'add' | 'remove', string> = { change: '~', add: '+', remove: '−' }

type Row = { key: string; node: ReactNode }

function noteRows(note: PanelNote): Row[] {
  const rows: Row[] = [
    { key: `${note.id}:q`, node: <Text wrap="wrap">❯ {note.question}</Text> },
  ]
  const thinking = note.thinking.length > 420 ? `…${note.thinking.slice(-420)}` : note.thinking
  if (thinking || note.state === 'thinking') {
    rows.push({
      key: `${note.id}:t`,
      node: (
        <Text italic color={palette.muted} wrap="wrap">
          ✻ {thinking || 'reading your note…'}
        </Text>
      ),
    })
  }
  // The rest lands together when the reply does, and appears in this order.
  if (note.state === 'thinking') return rows
  if (note.wants) {
    rows.push({
      key: `${note.id}:w`,
      node: (
        <Text wrap="wrap">
          You want: <Text color={palette.muted}>{note.wants}</Text>
        </Text>
      ),
    })
  }
  rows.push({
    key: `${note.id}:r`,
    node: (
      <Text wrap="wrap">
        Right now: <Text color={palette.muted}>{note.rightNow}</Text>
      </Text>
    ),
  })
  if (note.answer) {
    rows.push({
      key: `${note.id}:a`,
      node: (
        <Text wrap="wrap">
          <Text color={palette.brand}>● </Text>
          {note.answer}
        </Text>
      ),
    })
  }
  if (note.dropped) {
    rows.push({
      key: `${note.id}:d`,
      node: (
        <Text color={palette.muted} dimColor wrap="wrap">
          {`✂ ${note.dropped === 1 ? 'a claim' : `${note.dropped} claims`} removed — nothing that ran backs ${note.dropped === 1 ? 'it' : 'them'} up`}
        </Text>
      ),
    })
  }
  if (note.changes && note.changes.length > 0) {
    rows.push({
      key: `${note.id}:p`,
      // One Text, not a Box: a fading row is wrapped in <Text dimColor>, and Ink
      // cannot put a Box inside a Text.
      node: (
        <Text wrap="wrap">
          Plan change
          {note.changes.map((change, index) => (
            <Text key={index}>
              {'\n'}
              <Text color={change.kind === 'add' ? palette.success : change.kind === 'remove' ? palette.failure : palette.warning}>{MARK[change.kind]} </Text>
              <Text color={palette.muted}>{change.text}</Text>
            </Text>
          ))}
        </Text>
      ),
    })
  }
  rows.push({
    key: `${note.id}:s`,
    node:
      note.state === 'updated' ? (
        <Text wrap="wrap">
          <Text color={palette.success}>✓ </Text>
          <Text color={palette.muted}>Plan updated — the work picks it up at its next step.</Text>
        </Text>
      ) : note.state === 'answered' ? (
        <Text color={palette.muted} dimColor wrap="wrap">
          {note.passed ? 'No plan change — your note reaches the work at its next step.' : 'No plan change.'}
        </Text>
      ) : (
        <Text wrap="wrap">
          <Text color={palette.failure}>✗ </Text>
          <Text color={palette.muted}>{`${note.error ?? 'could not think it through'} — your note went to the work as written.`}</Text>
        </Text>
      ),
  })
  return rows
}

/**
 * The thinking panel: where elia works out what a mid-work message means and
 * how the plan should change, beside the plan it changes.
 *
 * Wide terminals get a column that slides in from the right: its width eases
 * open while the content, laid out at the final width and clipped, stays put —
 * nothing reflows frame to frame. Narrow terminals get the same content above
 * the input. Either way the rows appear one after another, each fading in, and
 * reduced motion shows them at once.
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

  const rows: Row[] = [
    { key: 'head', node: <Text color={palette.note}>◇ Thinking about your note</Text> },
    ...notes.slice(-2).flatMap((note, index) => (index > 0 ? [{ key: `${note.id}:gap`, node: <Text> </Text> }, ...noteRows(note)] : noteRows(note))),
    {
      key: pinned ? 'hint:pinned' : 'hint',
      node: (
        <Text color={palette.muted} dimColor>
          {pinned ? 'ctrl+w hides this' : 'ctrl+w keeps this open'}
        </Text>
      ),
    },
  ]
  const phaseOf = useRowReveal(rows.map((row) => row.key))
  if (!open && progress === 0) return null

  const visible = rows
    .map((row) => ({ row, phase: phaseOf(row.key) }))
    .filter(({ phase }) => phase !== 'hidden')
    .map(({ row, phase }) => (phase === 'fading' ? <Text key={row.key} dimColor>{row.node}</Text> : <Box key={row.key}>{row.node}</Box>))

  if (layout === 'stacked') {
    // Opening, the rows reveal themselves; closing, the panel folds up from the bottom.
    const shown = open ? visible.length : Math.max(1, Math.round(progress * visible.length))
    return (
      <Box
        flexDirection="column"
        marginTop={1}
        borderStyle="single"
        borderColor={palette.note}
        borderRight={false}
        borderTop={false}
        borderBottom={false}
        paddingLeft={1}
        backgroundColor={palette.noteBg}
      >
        {visible.slice(0, shown)}
      </Box>
    )
  }

  const edge = Math.max(1, Math.round(progress * width))
  return (
    <Box width={edge} flexShrink={0} overflowX="hidden" marginTop={1}>
      <Box
        width={width}
        flexShrink={0}
        flexDirection="column"
        borderStyle="single"
        borderColor={palette.note}
        borderRight={false}
        borderTop={false}
        borderBottom={false}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={palette.noteBg}
      >
        {visible}
      </Box>
    </Box>
  )
}

import { useRef, useSyncExternalStore } from 'react'
import { Box, Text } from 'ink'
import { blendable, glyphs, palette } from './theme.ts'
import { motionReduced, useAnimationClock } from './animation.tsx'
import { shimmerRuns, sparkFrame } from './motion.ts'
import { Panel } from './components/Panel.tsx'
import { AssistantMessage } from './components/AssistantMessage.tsx'
import { FrameWidth, useFrameWidth } from './wrap.ts'
import { quickchatStore, type QuickchatOverlayStore, type QuickchatOverlaySnapshot } from './quickchatOverlayStore.ts'

/** Reads one quickchat store's snapshot so the panel re-renders on every change. */
export function useQuickchatOverlay(store: QuickchatOverlayStore): QuickchatOverlaySnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

/** Rows of answer the panel shows before it folds the rest. */
export const QUICKCHAT_ANSWER_ROWS = 10

/** Rows the panel costs beyond its answer: margin, title, rule, question, footer. */
const PANEL_CHROME_ROWS = 5

/** A failed quickchat reports itself as text; the panel shows it as an error, not an answer. */
function isFailure(answer: string): boolean {
  return /^quickchat(?: failed)?:/.test(answer.trimStart())
}

/**
 * The answer as the panel shows it: whole source lines up to `maxRows` rows at
 * `columns` wide, and how many lines were folded away. Folding by source line
 * keeps markdown intact; a fence left open by the cut is closed so the rest of
 * the panel does not render as code.
 */
export function foldQuickchatAnswer(answer: string, columns: number, maxRows = QUICKCHAT_ANSWER_ROWS): { text: string; hiddenLines: number } {
  const lines = answer.trim().split('\n')
  const width = Number.isFinite(columns) ? Math.max(10, columns) : Number.POSITIVE_INFINITY
  const cost = (line: string) => (Number.isFinite(width) ? Math.max(1, Math.ceil(Bun.stringWidth(line) / width)) : 1)
  let rows = 0
  let kept = 0
  for (const line of lines) {
    if (rows + cost(line) > maxRows) break
    rows += cost(line)
    kept += 1
  }
  if (kept === lines.length) return { text: lines.join('\n'), hiddenLines: 0 }
  // One line longer than the whole budget: show as much of it as fits.
  if (kept === 0) {
    const room = Number.isFinite(width) ? width * maxRows - 1 : 2_000
    return { text: `${Array.from(lines[0]!).slice(0, room).join('')}…`, hiddenLines: lines.length - 1 }
  }
  let text = lines.slice(0, kept).join('\n')
  if ((text.match(/^\s*```/gm) ?? []).length % 2 === 1) text += '\n```'
  return { text, hiddenLines: lines.length - kept }
}

/** Rows the open panel takes on a frame `columns` wide — the live region reserves them. */
export function quickchatPanelRows(snapshot: QuickchatOverlaySnapshot, columns: number): number {
  if (snapshot.status !== 'open') return 0
  if (snapshot.answer === '') return PANEL_CHROME_ROWS + 1
  const fold = foldQuickchatAnswer(snapshot.answer, columns - 4)
  const width = Number.isFinite(columns) ? Math.max(10, columns - 4) : Number.POSITIVE_INFINITY
  const rows = fold.text.split('\n').reduce((sum, line) => sum + (Number.isFinite(width) ? Math.max(1, Math.ceil(Bun.stringWidth(line) / width)) : 1), 0)
  return PANEL_CHROME_ROWS + rows
}

/** The full question and answer, for the transcript when Esc closes a folded panel. */
export function quickchatTranscriptText(snapshot: QuickchatOverlaySnapshot): string {
  const where = snapshot.contextLabel ? ` · ${snapshot.contextLabel}` : ''
  return `quickchat${where} — ${snapshot.question}\n${snapshot.answer.trim()}`
}

/** Whether the open panel is hiding part of its answer at this width. */
export function quickchatFolded(snapshot: QuickchatOverlaySnapshot, columns: number): boolean {
  return snapshot.status === 'open' && snapshot.answer !== '' && !isFailure(snapshot.answer) && foldQuickchatAnswer(snapshot.answer, columns - 4).hiddenLines > 0
}

/** The spark and a shimmering "Thinking…" while the answer is on its way — the working line's motion, smaller. */
function Pending() {
  const now = useAnimationClock()
  const startedAt = useRef(now)
  const elapsed = Math.max(0, now - startedAt.current)
  const runs = shimmerRuns('Thinking…', elapsed, palette.brand, palette.brandShimmer, blendable && !motionReduced)
  return (
    <Box>
      <Box width={2} flexShrink={0}>
        <Text color={palette.brand} bold>
          {motionReduced ? glyphs.brand : sparkFrame(elapsed)}
        </Text>
      </Box>
      <Text>
        {runs.map((run, index) => (
          <Text key={index} color={run.color}>
            {run.text}
          </Text>
        ))}
      </Text>
    </Box>
  )
}

export interface QuickchatOverlayProps {
  /** Defaults to the module singleton the running REPL shares with the escape handler. */
  store?: QuickchatOverlayStore
}

/**
 * The on-screen panel for a `/quickchat` in progress, in the frame's own
 * vocabulary: a `Panel` heading instead of a drawn box (side borders smear on
 * narrow and Windows terminals), the question as a muted `❯` row, and the
 * answer rendered like any assistant reply. While it is on its way the spark
 * breathes beside a shimmering "Thinking…". A long answer folds to
 * QUICKCHAT_ANSWER_ROWS rows — the App prints it whole to the transcript when
 * Esc closes the panel — so the panel can never push the frame off screen.
 * Non-blocking by construction: the underlying overlay (`quickchat/overlay.ts`)
 * only ever writes to its own buffer.
 */
export function QuickchatOverlay({ store = quickchatStore }: QuickchatOverlayProps) {
  const snapshot = useQuickchatOverlay(store)
  const width = useFrameWidth()
  if (snapshot.status !== 'open') return null

  // Everything inside the panel sits behind its two-column indent.
  const inner = Number.isFinite(width) ? width - 2 : width
  const title = snapshot.contextLabel ? `quickchat · ${snapshot.contextLabel}` : 'quickchat'
  const failed = isFailure(snapshot.answer)
  const fold = foldQuickchatAnswer(snapshot.answer, inner - 2)
  const footer = snapshot.answer === ''
    ? 'esc to close · your session keeps running'
    : fold.hiddenLines > 0 && !failed
      ? `… ${fold.hiddenLines} more line${fold.hiddenLines === 1 ? '' : 's'} · esc closes and prints the whole answer`
      : 'esc to close'

  return (
    <Panel title={title} tone="brand">
      <Text color={palette.muted} wrap="truncate-end">
        {glyphs.user} {snapshot.question}
      </Text>
      <FrameWidth.Provider value={inner}>
        {snapshot.answer === '' ? (
          <Pending />
        ) : failed ? (
          <Box>
            <Box width={2} flexShrink={0}>
              <Text color={palette.failure}>{glyphs.error}</Text>
            </Box>
            <Text color={palette.failure} wrap="wrap">
              {snapshot.answer.trim().replace(/^quickchat(?: failed)?:\s*/, '')}
            </Text>
          </Box>
        ) : (
          <AssistantMessage text={fold.text} streaming={false} />
        )}
      </FrameWidth.Provider>
      <Text color={palette.subtle} wrap="truncate-end">
        {footer}
      </Text>
    </Panel>
  )
}

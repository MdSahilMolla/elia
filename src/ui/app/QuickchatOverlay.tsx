import { useSyncExternalStore } from 'react'
import { Box, Text } from 'ink'
import { box, terminalWidth, wrapText } from '../layout.ts'
import { dim } from '../theme.ts'
import { quickchatStore, type QuickchatOverlayStore, type QuickchatOverlaySnapshot } from './quickchatOverlayStore.ts'

/** Reads one quickchat store's snapshot so the panel re-renders on every change. */
export function useQuickchatOverlay(store: QuickchatOverlayStore): QuickchatOverlaySnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

export interface QuickchatOverlayProps {
  /** Defaults to the module singleton the running REPL shares with the escape handler. */
  store?: QuickchatOverlayStore
  maxWidth?: number
}

/**
 * The on-screen panel for a `/quickchat` in progress. Renders nothing while
 * closed, and while open shows the question, the streamed answer framed in
 * `layout.box`, and a "esc to close" footer. Non-blocking by construction: the
 * underlying overlay (see `quickchat/overlay.ts`) only ever writes to its own
 * buffer — the streaming turn underneath is never punched.
 */
export function QuickchatOverlay({ store = quickchatStore, maxWidth = 96 }: QuickchatOverlayProps) {
  const snapshot = useQuickchatOverlay(store)
  if (snapshot.status !== 'open') return null

  const innerWidth = Math.max(20, terminalWidth(maxWidth) - 6)
  const lines: string[] = []
  lines.push(dim(`quickchat — ${snapshot.question}`))
  const body = snapshot.contextLabel.length > 0 ? `[${snapshot.contextLabel}] ${snapshot.answer}` : snapshot.answer
  lines.push(...wrapText(body, innerWidth))
  lines.push('')
  lines.push(dim('esc to close — streaming, not blocking'))
  return (
    <Box marginBottom={1}>
      <Text>{box(lines, { title: 'quickchat', maxWidth })}</Text>
    </Box>
  )
}
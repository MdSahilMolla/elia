import { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { getSessionBus } from '../../session/bus.ts'
import type { SessionBus, SessionHandle, SessionId } from '../../session/types.ts'
import { renderSessionBar, statusGlyph, type SessionBarItem } from '../sessionBar.ts'
import { isIdle, shouldAutoFocus } from './sessionActions.ts'

/** How often the bar re-checks the bus — status transitions like running →
 * `waiting-input` emit no `bus.on` event, so a poll catches what events miss. */
export const SESSION_BAR_POLL_MS = 1_000

export interface SessionBarData {
  /** The live session handles, in bus order. */
  handles: SessionHandle[]
  /** Session id → status glyph (● ○ ⚠ ✓ ✗), for inspection without Ink rendering. */
  glyph: Record<string, string>
  /** The rendered bar line ('' when there are no sessions). */
  barText: string
  /**
   * Derive-time snapshot of `id:status:name`. Kept separate from `handles`:
   * the bus hands out handle objects by reference, so a signature recomputed
   * from the stored state would never see a `setStatus` mutation land.
   */
  sig: string
}

const EMPTY: SessionBarData = { handles: [], glyph: {}, barText: '', sig: '' }

function derive(bus: SessionBus): SessionBarData {
  const handles = bus.list()
  if (handles.length === 0) return EMPTY
  const items: SessionBarItem[] = []
  const glyph: Record<string, string> = {}
  let sig = ''
  for (const handle of handles) {
    items.push({ name: handle.name, status: handle.status, lastTask: handle.lastTask })
    glyph[handle.id] = statusGlyph(handle.status)
    sig += `${handle.id}:${handle.status}:${handle.name}|`
  }
  return { handles, glyph, barText: renderSessionBar(items), sig }
}

export interface UseSessionBarDataOptions {
  bus?: SessionBus
  /** Re-poll cadence — also how fast a no-event status transition shows up. */
  pollMs?: number
}

/**
 * Subscribes to one session bus and re-renders whenever its roster or a
 * session's status changes. Both an immediate `bus.on` listener and a poll are
 * wired: the bus only emits on structural events (started/completed/…), while
 * `setStatus` to running/idle/waiting-input stays silent, so the poll is what
 * makes those visible.
 */
export function useSessionBarData({ bus = getSessionBus(), pollMs = SESSION_BAR_POLL_MS }: UseSessionBarDataOptions = {}): SessionBarData {
  const [data, setData] = useState<SessionBarData>(() => derive(bus))
  useEffect(() => {
    const sync = (): void => {
      const next = derive(bus)
      setData((prev) => (prev.sig === next.sig ? prev : next))
    }
    sync()
    const off = bus.on(sync)
    const timer = setInterval(sync, pollMs)
    return () => {
      off()
      clearInterval(timer)
    }
  }, [bus, pollMs])
  return data
}

export interface SessionBarProps {
  bus?: SessionBus
  /** Render nothing (but stay subscribed) when false. */
  visible?: boolean
  pollMs?: number
  /** WAITING_INPUT auto-focus — switch the bus to a waiting session when idle. */
  autoFocus?: boolean
  /** Is the user's own session mid-turn? Auto-focus waits for idle. */
  activeRunning?: boolean
  /** A modal owns the screen — hold auto-focus. */
  suppressed?: boolean
  /** Fired once per switching to a waiting-input session. */
  onAutoFocus?: (notice: string) => void
}

/**
 * The live session status bar: `renderSessionBar` output pinned to the top of
 * the frame, kept current from the session bus. Renders nothing while there
 * are no sessions or `visible` is off. Auto-focus lives here too — when a
 * session goes `waiting-input` and the current session is idle, the bus is
 * switched to it once and `onAutoFocus` is apprised.
 */
export function SessionBar({
  bus = getSessionBus(),
  visible = true,
  pollMs = SESSION_BAR_POLL_MS,
  autoFocus = true,
  activeRunning = false,
  suppressed = false,
  onAutoFocus,
}: SessionBarProps) {
  const data = useSessionBarData({ bus, pollMs })
  const [notified, setNotified] = useState<SessionId | undefined>(undefined)

  useEffect(() => {
    if (!autoFocus || suppressed) return
    const waitingIndex = shouldAutoFocus(data.handles.map((handle) => handle.status))
    if (waitingIndex === undefined) {
      setNotified(undefined)
      return
    }
    const waiting = data.handles[waitingIndex]
    if (!waiting) return
    if (!isIdle({ running: activeRunning })) return
    if (bus.activeSession === waiting.id) {
      setNotified(waiting.id)
      return
    }
    if (notified === waiting.id) return
    bus.setActiveSession(waiting.id)
    setNotified(waiting.id)
    onAutoFocus?.(`Waiting for input — focused session ${waiting.name}`)
  }, [autoFocus, suppressed, data.handles, activeRunning, bus, notified, onAutoFocus])

  if (!visible || !data.barText) return null
  return (
    <Box marginBottom={1}>
      <Text aria-label="session status bar">{data.barText}</Text>
    </Box>
  )
}
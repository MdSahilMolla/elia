import { box, terminalWidth } from './layout.ts'
import type { KeyEvent } from './picker.ts'
import { interactiveTerminal, plainOutput } from './runtime.ts'
import { gracefulShutdown, registerShutdownCleanup } from './shutdown.ts'
import { listKnownSessions } from '../sessionRegistry.ts'
import { describeSession, listSessionSummaries, relativeTime, sessionDetail, type SessionSummary } from '../sessionCatalog.ts'
import { moveTaskSelection } from './taskDashboard.ts'
import { bold, cyan, dim, gold, green, red, reverse } from './theme.ts'

const PAGE_SIZE = 10
const POLL_MS = 1000

/**
 * `/sessions` — every conversation in this project, whether or not a process
 * still has it open, newest first. Enter resumes the selected one.
 *
 * The list of conversations is read once when the panel opens; the live column
 * (which of them another elia is holding, and what it is doing) is polled from
 * the heartbeat files, since a sibling process's writes are not visible any
 * other way from here. Only the poll repeats — re-parsing every conversation
 * once a second to learn nothing new is not worth it.
 *
 * Resolves with the session id to resume, or undefined if the panel was just
 * closed.
 */
export async function openSessionsDashboard(selfId: string | undefined, statusDir?: string): Promise<string | undefined> {
  const initial = await listSessionSummaries({ statusDir })
  if (!interactiveTerminal) {
    writePlainSessionsList(initial, selfId)
    return undefined
  }

  const stdin = process.stdin
  const stdout = process.stdout
  const wasRaw = stdin.isRaw
  const wasPaused = stdin.isPaused()
  let current = initial
  let selected = 0
  let viewportStart = 0
  let rendered = 0
  let closed = false
  let chosen: string | undefined
  let resolveClosed: (() => void) | undefined

  function adjustViewport(): void {
    if (selected < viewportStart) viewportStart = selected
    if (selected >= viewportStart + PAGE_SIZE) viewportStart = selected - PAGE_SIZE + 1
    viewportStart = Math.max(0, Math.min(viewportStart, Math.max(0, current.length - PAGE_SIZE)))
  }

  function render(): void {
    if (closed) return
    adjustViewport()
    if (rendered > 0) stdout.write(`\x1b[${rendered}A`)
    const selectedSession = current[selected]
    const visible = current.slice(viewportStart, viewportStart + PAGE_SIZE)
    const width = Math.max(40, terminalWidth(96))
    const listLines = visible.length > 0
      ? visible.map((session, offset) => {
          const index = viewportStart + offset
          const marker = index === selected ? gold('›') : ' '
          const label = index === selected ? reverse(renderSessionLine(session, selfId, width - 4)) : renderSessionLine(session, selfId, width - 4)
          return `${marker} ${label}`
        })
      : ['  No saved conversations in this project yet.']
    const detailLines = selectedSession ? sessionDetailLines(selectedSession, selfId) : ['Select a session to see its details.']
    const range = current.length > 0 ? `showing ${viewportStart + 1}–${Math.min(current.length, viewportStart + visible.length)} of ${current.length}` : 'no sessions'
    const lines = [
      `${bold('elia sessions')} ${dim('(↑/↓ move · pgup/pgdn page · enter resume · q/esc close)')}`,
      ...listLines,
      dim(range),
      '',
      ...detailLines,
    ]
    for (const line of lines) stdout.write(`\x1b[2K${line}\n`)
    rendered = lines.length
  }

  /** Re-reads only the heartbeats and folds their live status back onto the list. */
  function refresh(): void {
    if (closed) return
    const beats = new Map(listKnownSessions(statusDir).map((beat) => [beat.sessionId, beat]))
    current = current.map((session) => {
      const beat = beats.get(session.id)
      if (!beat) return session
      const live = !beat.endedAt && (beat.liveStatus === 'running' || beat.liveStatus === 'idle')
      return { ...session, status: beat.liveStatus, lastAction: beat.lastAction, pid: beat.pid, heldByLiveProcess: live && session.heldByLiveProcess }
    })
    if (selected >= current.length) selected = Math.max(0, current.length - 1)
    render()
  }

  function cleanup(): void {
    if (closed) return
    closed = true
    clearInterval(timer)
    stdin.off('keypress', onKeypress)
    if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false)
    if (wasPaused) stdin.pause()
    if (rendered > 0) stdout.write(`\x1b[${rendered}A\x1b[0J`)
    resolveClosed?.()
  }

  const unregisterShutdown = registerShutdownCleanup(cleanup)

  function close(): void {
    cleanup()
    unregisterShutdown()
  }

  function onKeypress(_str: string | undefined, key: KeyEvent): void {
    if (key.ctrl && key.name === 'c') {
      close()
      gracefulShutdown(130)
    }
    if (key.name === 'escape' || key.name === 'q') {
      close()
      return
    }
    if (current.length === 0) return
    if (key.name === 'return') {
      const session = current[selected]
      // A session with nothing saved yet has no conversation to hand back.
      if (session?.hasConversation) chosen = session.id
      close()
      return
    }
    const next = moveTaskSelection(selected, current.length, key)
    if (next !== selected) selected = next
    render()
  }

  stdin.setRawMode(true)
  stdin.resume()
  stdin.on('keypress', onKeypress)
  const timer = setInterval(refresh, POLL_MS)
  render()

  await new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  return chosen
}

function renderSessionLine(session: SessionSummary, selfId: string | undefined, maxWidth: number): string {
  const self = session.id === selfId ? cyan(' (this session)') : ''
  const line = `${statusGlyph(session)} ${truncate(session.id, 18).padEnd(18)} ${cyan(relativeTime(session.updatedAt).padEnd(9))} ${truncate(session.model ?? '—', 18).padEnd(18)} ${describeSession(session, 34)}${self}`
  return truncate(line, Math.max(20, maxWidth))
}

function sessionDetailLines(session: SessionSummary, selfId: string | undefined): string[] {
  return [
    `${bold('Session')}  ${session.id}${session.id === selfId ? dim(' (this session)') : ''}`,
    `${bold('State')}    ${statusGlyph(session)} ${session.heldByLiveProcess ? `open in pid ${session.pid}` : session.status}`,
    `${bold('Started')}  ${describeSession(session, 70)}`,
    `${bold('Model')}    ${session.providerName ? `${session.providerName} · ` : ''}${session.model ?? 'unknown'}`,
    `${bold('Doing')}    ${truncate(session.lastAction || '—', 70)}`,
    `${bold('Turns')}    ${session.turns} (${session.messages} messages)`,
    `${bold('Updated')}  ${relativeTime(session.updatedAt)}`,
    session.id === selfId
      ? dim('This is the conversation you are in.')
      : session.hasConversation
        ? `${bold('Resume')}   enter — or elia --resume ${session.id}`
        : dim('Nothing saved in this session yet, so there is nothing to resume.'),
  ]
}

function writePlainSessionsList(sessions: SessionSummary[], selfId: string | undefined): void {
  if (sessions.length === 0) {
    process.stdout.write('No saved conversations in this project yet.\n')
    return
  }
  const lines = sessions.map(
    (session) =>
      `[${session.heldByLiveProcess ? 'open' : session.status}] ${session.id}${session.id === selfId ? ' (this session)' : ''} — ${sessionDetail(session)} — ${describeSession(session, 48)}`,
  )
  process.stdout.write(`${box(lines, { title: 'elia sessions' })}\n`)
}

function statusGlyph(session: SessionSummary): string {
  const status = session.heldByLiveProcess ? (session.status === 'running' ? 'running' : 'idle') : session.status
  if (plainOutput) return `[${status}]`
  if (status === 'running') return gold('•')
  if (status === 'idle') return green('·')
  if (status === 'saved' || status === 'ended') return dim('✓')
  return red('✗')
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat
}

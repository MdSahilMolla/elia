import { box, terminalWidth } from './layout.ts'
import type { KeyEvent } from './picker.ts'
import { interactiveTerminal, plainOutput } from './runtime.ts'
import { gracefulShutdown, registerShutdownCleanup } from './shutdown.ts'
import { listKnownSessions, type KnownSession, type SessionLiveStatus } from '../sessionRegistry.ts'
import { moveTaskSelection } from './taskDashboard.ts'
import { bold, cyan, dim, gold, green, red, reverse } from './theme.ts'

const PAGE_SIZE = 10
const POLL_MS = 1000

/**
 * `/sessions` — every other elia process running in this project, discovered
 * from their heartbeat files (sessionRegistry.ts), not from anything this
 * process itself is doing. Polled rather than event-driven, since sibling
 * processes' writes aren't visible any other way from here.
 */
export function openSessionsDashboard(selfId: string | undefined, dir?: string): Promise<void> {
  const initial = listKnownSessions(dir)
  if (!interactiveTerminal) {
    writePlainSessionsList(initial, selfId)
    return Promise.resolve()
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
      : ['  No other elia sessions found in this project yet.']
    const detailLines = selectedSession ? sessionDetailLines(selectedSession, selfId) : ['Select a session to see its details.']
    const range = current.length > 0 ? `showing ${viewportStart + 1}–${Math.min(current.length, viewportStart + visible.length)} of ${current.length}` : 'no sessions'
    const lines = [
      `${bold('elia sessions')} ${dim('(↑/↓ move · pgup/pgdn page · q/esc close)')}`,
      ...listLines,
      dim(range),
      '',
      ...detailLines,
    ]
    for (const line of lines) stdout.write(`\x1b[2K${line}\n`)
    rendered = lines.length
  }

  function refresh(): void {
    if (closed) return
    current = listKnownSessions(dir)
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
    const next = moveTaskSelection(selected, current.length, key)
    if (next !== selected) selected = next
    render()
  }

  stdin.setRawMode(true)
  stdin.resume()
  stdin.on('keypress', onKeypress)
  const timer = setInterval(refresh, POLL_MS)
  render()

  return new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
}

function renderSessionLine(session: KnownSession, selfId: string | undefined, maxWidth: number): string {
  const self = session.sessionId === selfId ? cyan(' (this session)') : ''
  const line = `${statusGlyph(session.liveStatus)} ${truncate(session.sessionId, 18).padEnd(18)} ${cyan(session.mode.padEnd(9))} ${truncate(session.model, 18).padEnd(18)} ${truncate(session.lastAction || session.liveStatus, 24)}${self}`
  return truncate(line, Math.max(20, maxWidth))
}

function sessionDetailLines(session: KnownSession, selfId: string | undefined): string[] {
  return [
    `${bold('Session')}  ${session.sessionId}${session.sessionId === selfId ? dim(' (this session)') : ''}`,
    `${bold('State')}    ${statusGlyph(session.liveStatus)} ${session.liveStatus}`,
    `${bold('Mode')}     ${session.mode}`,
    `${bold('Model')}    ${session.providerLabel} · ${session.model}`,
    `${bold('Doing')}    ${truncate(session.lastAction || '—', 70)}`,
    `${bold('Tasks')}    ${session.taskSummary || '—'}`,
    `${bold('Messages')} ${session.messageCount}`,
    `${bold('Started')}  ${relativeTime(session.startedAt)}`,
    `${bold('Updated')}  ${relativeTime(session.updatedAt)}`,
    `${bold('Resume')}   elia --resume ${session.sessionId}`,
  ]
}

function writePlainSessionsList(sessions: KnownSession[], selfId: string | undefined): void {
  if (sessions.length === 0) {
    process.stdout.write('No other elia sessions found in this project yet.\n')
    return
  }
  const lines = sessions.map((session) => `[${session.liveStatus}] ${session.sessionId}${session.sessionId === selfId ? ' (this session)' : ''} — ${session.mode} · ${session.model} — ${session.lastAction || session.liveStatus}`)
  process.stdout.write(`${box(lines, { title: 'elia sessions' })}\n`)
}

function statusGlyph(status: SessionLiveStatus): string {
  if (plainOutput) return `[${status}]`
  if (status === 'running') return gold('•')
  if (status === 'idle') return green('·')
  if (status === 'ended') return dim('✓')
  return red('✗')
}

function relativeTime(ms: number): string {
  const deltaS = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (deltaS < 5) return 'just now'
  if (deltaS < 60) return `${deltaS}s ago`
  const deltaM = Math.round(deltaS / 60)
  if (deltaM < 60) return `${deltaM}m ago`
  const deltaH = Math.round(deltaM / 60)
  if (deltaH < 24) return `${deltaH}h ago`
  return `${Math.round(deltaH / 24)}d ago`
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat
}

import { bold, cyan, dim, gold, green, red, reverse } from './theme.ts'
import { box, frame } from './layout.ts'
import type { KeyEvent } from './picker.ts'
import { taskSessions, type TaskSession, type TaskSessionStore } from '../taskSessions.ts'

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export interface ActionWindow {
  stop(): void
}

/**
 * A persistent in-place action window used while a user request is executing.
 * It subscribes to the same task store that the `/task` dashboard reads, so the
 * dashboard never invents progress: every displayed action came from real work.
 */
export function createLiveActionWindow(store: TaskSessionStore = taskSessions): ActionWindow {
  if (!process.stdout.isTTY) return { stop() {} }

  const panel = frame(92, { title: 'Action window', borderColor: gold })
  let rendered = 0
  let tick = 0
  let stopped = false

  function render(sessions: TaskSession[] = store.list()): void {
    if (stopped) return
    if (rendered > 0) process.stdout.write(`\x1b[${rendered}A`)
    const active = sessions.filter((session) => session.status === 'pending' || session.status === 'running' || session.status === 'paused').slice(0, 5)
    const recent = sessions.filter((session) => session.status === 'done' || session.status === 'failed').slice(0, 2)
    const visible = active.length > 0 ? active : recent
    const lines = visible.length > 0
      ? visible.map((session) => renderSessionLine(session, tick))
      : ['No active task. Type /task to browse task sessions.']
    const body = [panel.top, ...lines.map((line) => panel.line(line)), panel.bottom]
    for (const line of body) process.stdout.write(`\x1b[2K${line}\n`)
    rendered = body.length
  }

  const unsubscribe = store.subscribe((sessions) => render(sessions))
  const timer = setInterval(() => {
    tick += 1
    render()
  }, 180)

  return {
    stop() {
      if (stopped) return
      clearInterval(timer)
      unsubscribe()
      // Leave the last action window visible as a completion record.
      render()
      stopped = true
    },
  }
}

/** Opens a modal task browser. Arrow keys navigate tasks; Enter opens the selected task; Escape closes it. */
export function openTaskDashboard(store: TaskSessionStore = taskSessions, requestedId?: string): Promise<void> {
  const sessions = store.list()
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    writePlainTaskList(sessions, requestedId)
    return Promise.resolve()
  }

  const stdin = process.stdin
  const stdout = process.stdout
  const wasRaw = stdin.isRaw
  const wasPaused = stdin.isPaused()
  let selected = Math.max(0, requestedId ? Math.max(0, sessions.findIndex((session) => session.id === requestedId)) : 0)
  let rendered = 0
  let current = sessions
  let closed = false

  function render(): void {
    if (closed) return
    if (rendered > 0) stdout.write(`\x1b[${rendered}A`)
    const selectedSession = current[selected]
    const listLines = current.length > 0
      ? current.slice(0, 10).map((session, index) => {
          const marker = index === selected ? gold('›') : ' '
          const label = index === selected ? reverse(`${kindLabel(session.kind)} · ${session.title}`) : `${kindLabel(session.kind)} · ${session.title}`
          return `${marker} ${statusGlyph(session.status)} ${label} ${dim(shortStatus(session))}`
        })
      : ['  No task sessions yet.']
    const detailLines = selectedSession
      ? [
          `${bold('Task')}  ${selectedSession.title}`,
          `${bold('Type')}  ${kindLabel(selectedSession.kind)}`,
          `${bold('State')} ${statusGlyph(selectedSession.status)} ${selectedSession.status}`,
          `${bold('Action')} ${selectedSession.action || '—'}`,
          `${bold('Detail')} ${selectedSession.detail || '—'}`,
          `${bold('Steps')}  ${selectedSession.stepsCompleted}${selectedSession.stepsTotal ? ` / ${selectedSession.stepsTotal}` : ''}`,
          `${bold('ID')}     ${selectedSession.id}`,
        ]
      : ['Select a task to see its action details.']
    const lines = [
      `${bold('Task sessions')} ${dim('(↑/↓ or ←/→ navigate · enter inspect · esc close)')}`,
      ...listLines,
      '',
      ...detailLines,
    ]
    for (const line of lines) stdout.write(`\x1b[2K${line}\n`)
    rendered = lines.length
  }

  let resolveClosed: (() => void) | undefined

  function close(): void {
    if (closed) return
    closed = true
    unsubscribe()
    stdin.off('keypress', onKeypress)
    if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false)
    if (wasPaused) stdin.pause()
    stdout.write(`\x1b[${rendered}A\x1b[0J`)
    resolveClosed?.()
  }

  function onKeypress(_str: string | undefined, key: KeyEvent): void {
    if (key.ctrl && key.name === 'c') {
      close()
      process.exit(0)
    }
    if (key.name === 'escape' || key.name === 'q') {
      close()
      return
    }
    if (current.length === 0) return
    selected = moveTaskSelection(selected, current.length, key)
    if (key.name === 'return') {
      const session = current[selected]
      if (session) {
        // Re-rendering the selected record is enough for now; the detail pane is
        // already visible and remains stable while the user decides what to do.
        selected = current.findIndex((item) => item.id === session.id)
      }
    }
    render()
  }

  stdin.setRawMode(true)
  stdin.resume()
  stdin.on('keypress', onKeypress)
  const unsubscribe = store.subscribe((next) => {
    current = next
    if (selected >= current.length) selected = Math.max(0, current.length - 1)
    render()
  })
  render()

  return new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
}

export function moveTaskSelection(selected: number, count: number, key: KeyEvent): number {
  if (count <= 0) return 0
  if (key.name === 'up' || key.name === 'left') return (selected - 1 + count) % count
  if (key.name === 'down' || key.name === 'right') return (selected + 1) % count
  return Math.min(Math.max(selected, 0), count - 1)
}

export function renderTaskList(sessions: TaskSession[]): string {
  if (sessions.length === 0) return 'No task sessions yet. Start a coding or browser task, then use /task to inspect it.'
  return box(
    sessions.slice(0, 20).map((session) => `${statusGlyph(session.status)} ${kindLabel(session.kind).padEnd(7)} ${session.title} — ${shortStatus(session)}`),
    { title: 'Task sessions' },
  )
}

function writePlainTaskList(sessions: TaskSession[], requestedId?: string): void {
  const selected = requestedId ? sessions.find((session) => session.id === requestedId) : undefined
  process.stdout.write(`${renderTaskList(selected ? [selected] : sessions)}\n`)
}

function renderSessionLine(session: TaskSession, tick: number): string {
  const marker = session.status === 'running' ? SPINNER[tick % SPINNER.length]! : statusGlyph(session.status)
  const progress = session.stepsTotal ? ` ${session.stepsCompleted}/${session.stepsTotal}` : ''
  return `${marker} ${cyan(kindLabel(session.kind).padEnd(7))} ${truncate(session.title, 30).padEnd(30)} ${truncate(session.action || session.status, 22).padEnd(22)}${dim(progress)}`
}

function statusGlyph(status: TaskSession['status']): string {
  if (status === 'done') return green('✓')
  if (status === 'failed') return red('✗')
  if (status === 'paused') return gold('Ⅱ')
  if (status === 'running') return gold('•')
  return dim('·')
}

function kindLabel(kind: TaskSession['kind']): string {
  if (kind === 'browser') return 'browser'
  if (kind === 'code') return 'code'
  return 'pending'
}

function shortStatus(session: TaskSession): string {
  return truncate(session.action || session.detail || session.status, 42)
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

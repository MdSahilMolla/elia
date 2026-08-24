import { box, frame, terminalWidth } from './layout.ts'
import type { KeyEvent } from './picker.ts'
import { interactiveTerminal, plainOutput, machineReadable } from './runtime.ts'
import { gracefulShutdown, registerShutdownCleanup } from './shutdown.ts'
import { taskSessions, type TaskSession, type TaskSessionStore, type TaskControlAction } from '../taskSessions.ts'
import { bold, cyan, dim, gold, green, red, reverse } from './theme.ts'

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const PAGE_SIZE = 10

export interface ActionWindow {
  stop(): void
}

export function createLiveActionWindow(store: TaskSessionStore = taskSessions): ActionWindow {
  if (!interactiveTerminal) return { stop() {} }

  const panelWidth = Math.max(40, Math.min(92, terminalWidth(96) - 4))
  const panel = frame(panelWidth, { title: 'Action window', borderColor: gold })
  let rendered = 0
  let tick = 0
  let stopped = false

  function render(sessions: TaskSession[] = store.list()): void {
    if (stopped) return
    if (rendered > 0) process.stdout.write(`\x1b[${rendered}A`)
    const active = sessions.filter((session) => ['pending', 'running', 'paused'].includes(session.status)).slice(0, 5)
    const recent = sessions.filter((session) => session.status === 'done' || session.status === 'failed').slice(0, 2)
    const visible = active.length > 0 ? active : recent
    const lines = visible.length > 0 ? visible.map((session) => renderSessionLine(session, tick, panel.innerWidth - 2)) : ['No active task. Type /task to inspect sessions.']
    const body = [panel.top, ...lines.map((line) => panel.line(line)), panel.bottom]
    for (const line of body) process.stdout.write(`\x1b[2K${line}\n`)
    rendered = body.length
  }

  const unsubscribe = store.subscribe((sessions) => render(sessions))
  const timer = setInterval(() => {
    tick += 1
    render()
  }, 180)
  const unregisterShutdown = registerShutdownCleanup(() => {
    clearInterval(timer)
    unsubscribe()
    if (rendered > 0) process.stdout.write(`\x1b[${rendered}A\x1b[0J`)
  })

  return {
    stop() {
      if (stopped) return
      clearInterval(timer)
      unsubscribe()
      unregisterShutdown()
      render()
      stopped = true
    },
  }
}

/** Opens a bounded task browser. c=stop/cancel, p=pause, Enter=inspect, Escape=close. */
export function openTaskDashboard(store: TaskSessionStore = taskSessions, requestedId?: string): Promise<void> {
  const sessions = store.list()
  if (!interactiveTerminal) {
    writePlainTaskList(sessions, requestedId)
    return Promise.resolve()
  }

  const stdin = process.stdin
  const stdout = process.stdout
  const wasRaw = stdin.isRaw
  const wasPaused = stdin.isPaused()
  let selected = requestedId ? Math.max(0, sessions.findIndex((session) => session.id === requestedId)) : 0
  selected = Math.min(Math.max(selected, 0), Math.max(0, sessions.length - 1))
  let viewportStart = 0
  let rendered = 0
  let current = sessions
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
    const listLines = visible.length > 0
      ? visible.map((session, offset) => {
          const index = viewportStart + offset
          const marker = index === selected ? gold('›') : ' '
          const label = index === selected ? reverse(`${kindLabel(session.kind)} · ${truncate(session.title, 46)}`) : `${kindLabel(session.kind)} · ${truncate(session.title, 46)}`
          return `${marker} ${statusGlyph(session.status)} ${label} ${dim(shortStatus(session))}`
        })
      : ['  No task sessions yet.']
    const detailLines = selectedSession
      ? [
          `${bold('Task')}     ${truncate(selectedSession.title, 70)}`,
          `${bold('Type')}     ${kindLabel(selectedSession.kind)}`,
          `${bold('State')}    ${statusGlyph(selectedSession.status)} ${selectedSession.status}`,
          `${bold('Action')}   ${truncate(selectedSession.action || '—', 70)}`,
          `${bold('Detail')}   ${truncate(selectedSession.detail || '—', 70)}`,
          `${bold('Steps')}    ${selectedSession.stepsCompleted}${selectedSession.stepsTotal ? ` / ${selectedSession.stepsTotal}` : ''}`,
          `${bold('Role')}     ${selectedSession.role ?? 'top-level'}${selectedSession.depth === undefined ? '' : ` · depth ${selectedSession.depth}`}`,
          `${bold('Parent')}   ${selectedSession.parentId ?? 'top-level'}`,
          `${bold('ID')}       ${selectedSession.id}`,
          `${bold('Controls')} ${availableControls(selectedSession)}`,
        ]
      : ['Select a task to see its action details.']
    const range = current.length > 0 ? `showing ${viewportStart + 1}–${Math.min(current.length, viewportStart + visible.length)} of ${current.length}` : 'no tasks'
    const lines = [
      `${bold('Task sessions')} ${dim('(↑/↓ move · pgup/pgdn page · c stop · p pause · q/esc close)')}`,
      ...listLines,
      dim(range),
      '',
      ...detailLines,
    ]
    for (const line of lines) stdout.write(`\x1b[2K${line}\n`)
    rendered = lines.length
  }

  function cleanup(): void {
    if (closed) return
    closed = true
    unsubscribe?.()
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

  function invoke(action: TaskControlAction): void {
    const session = current[selected]
    if (!session) return
    if (!store.control(session.id, action)) {
      // Keep the operator informed without corrupting the modal; the detail pane will
      // explain that no live controller is attached after the next render.
      store.update(session.id, { detail: `No live handler for ${action}; use the owning process to control this task.` })
    }
    render()
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
    if (key.name === 'c') return invoke('cancel')
    if (key.name === 'p') return invoke('pause')
    if (current.length === 0) return
    const next = moveTaskSelection(selected, current.length, key)
    if (next !== selected) selected = next
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
  if (key.name === 'pageup') return Math.max(0, selected - PAGE_SIZE)
  if (key.name === 'pagedown') return Math.min(count - 1, selected + PAGE_SIZE)
  if (key.name === 'home') return 0
  if (key.name === 'end') return count - 1
  return Math.min(Math.max(selected, 0), count - 1)
}

export function renderTaskList(sessions: TaskSession[]): string {
  if (sessions.length === 0) return 'No task sessions yet. Start a coding or browser task, then use /task to inspect it.'
  if (plainOutput) {
    return ['Task sessions', ...sessions.slice(0, 20).map((session) => `[${session.status}] ${kindLabel(session.kind)} ${session.title} — ${shortStatus(session)}`)].join('\n')
  }
  return box(sessions.slice(0, 20).map((session) => `${statusGlyph(session.status)} ${kindLabel(session.kind).padEnd(7)} ${session.title} — ${shortStatus(session)}`), { title: 'Task sessions' })
}

function writePlainTaskList(sessions: TaskSession[], requestedId?: string): void {
  const selected = requestedId ? sessions.find((session) => session.id === requestedId) : undefined
  process.stdout.write(`${renderTaskList(selected ? [selected] : sessions)}\n`)
}

function renderSessionLine(session: TaskSession, tick: number, maxWidth: number): string {
  const marker = session.status === 'running' ? SPINNER[tick % SPINNER.length]! : statusGlyph(session.status)
  const progress = session.stepsTotal ? ` ${session.stepsCompleted}/${session.stepsTotal}` : ''
  const owner = session.role ? `${session.role}${session.depth ? `@${session.depth}` : ''}` : 'lead'
  const line = `${marker} ${cyan(kindLabel(session.kind).padEnd(7))} ${truncate(owner, 14).padEnd(14)} ${truncate(session.title, 26).padEnd(26)} ${truncate(session.action || session.status, 20).padEnd(20)}${dim(progress)}`
  return truncate(line, Math.max(20, maxWidth))
}

function statusGlyph(status: TaskSession['status']): string {
  if (plainOutput) return `[${status}]`
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

function availableControls(session: TaskSession): string {
  const controls: string[] = []
  if (session.status === 'running' || session.status === 'pending') controls.push('c stop/cancel', 'p pause')
  if (session.status === 'paused') controls.push('stopped; use elia resume <run-id> after review')
  if (session.status === 'failed') controls.push('failed; submit a new turn to retry')

  return controls.length > 0 ? controls.join(' · ') : 'none'
}

function shortStatus(session: TaskSession): string {
  const owner = session.role ? `${session.role}${session.depth ? ` · d${session.depth}` : ''}` : ''
  const status = session.action || session.detail || session.status
  return truncate(owner ? `${owner} · ${status}` : status, 42)
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function renderTaskSummary(store: TaskSessionStore = taskSessions): string {
  const sessions = store.list()
  if (sessions.length === 0) return ''
  const active = sessions.filter((s) => ['pending', 'running', 'paused', 'waiting-input', 'waiting-approval'].includes(s.status)).length
  const done = sessions.filter((s) => s.status === 'done').length
  const failed = sessions.filter((s) => s.status === 'failed').length

  const parts: string[] = []
  if (active > 0) parts.push(`${active} active`)
  if (done > 0) parts.push(`${done} done`)
  if (failed > 0) parts.push(`${failed} failed`)
  if (parts.length === 0) return ''
  return `tasks: ${parts.join(' · ')}`
}

export function updateTerminalTaskTitle(store: TaskSessionStore = taskSessions, baseTitle = 'elia'): void {
  if (!interactiveTerminal || plainOutput || machineReadable) return
  const sessions = store.list()
  const active = sessions.filter((s) => ['pending', 'running', 'paused', 'waiting-input', 'waiting-approval'].includes(s.status)).length
  const done = sessions.filter((s) => s.status === 'done').length
  const failed = sessions.filter((s) => s.status === 'failed').length

  let label = baseTitle
  if (sessions.length > 0) {
    const parts: string[] = []
    if (active > 0) parts.push(`${active} running`)
    if (done > 0) parts.push(`${done} done`)
    if (failed > 0) parts.push(`${failed} failed`)
    if (parts.length > 0) label = `${baseTitle} [${parts.join(' · ')}]`
  }
  process.stdout.write(`\x1b]0;${label}\x07`)
}

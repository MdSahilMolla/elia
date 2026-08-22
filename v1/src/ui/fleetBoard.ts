import { dim, gold, green, red, cyan } from './theme.ts'
import { frame } from './layout.ts'

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const TICK_MS = 120

const ROLE_WIDTH = 8
const TITLE_WIDTH = 46
const TIME_WIDTH = 7
const DETAIL_WIDTH = 41 // includes its own leading space when present
// Kept in sync with the columns `line()` below actually writes, so the frame
// never has to guess — a live board can't re-measure its width every tick
// without the border jittering as detail text grows and shrinks.
const INNER_WIDTH = 1 + 1 + ROLE_WIDTH + 1 + TITLE_WIDTH + 1 + TIME_WIDTH + DETAIL_WIDTH

export type WorkerStatus = 'queued' | 'running' | 'done' | 'failed'

interface WorkerRow {
  name: string
  role: string
  title: string
  status: WorkerStatus
  detail: string
  startedAt?: number
  finishedAt?: number
}

export interface FleetBoard {
  update(name: string, status: WorkerStatus, detail?: string): void
  /** Renders one last time and leaves the finished board on screen. */
  stop(): void
}

export interface FleetWorkerSpec {
  name: string
  role: string
  title: string
}

/**
 * A live, in-place status board for a running fleet.
 *
 * Parallel sub-agents are otherwise invisible: output would interleave into
 * nonsense, so the usual answer is to silence them entirely and leave the user
 * staring at nothing for a minute. The board is the compromise — one stable line
 * per worker, updated where it sits, so the parallelism is legible while it
 * happens.
 */
export function createFleetBoard(workers: FleetWorkerSpec[]): FleetBoard {
  const rows: WorkerRow[] = workers.map((worker) => ({ ...worker, status: 'queued', detail: '' }))

  if (!process.stdout.isTTY) return createPlainBoard(rows)

  const panel = frame(INNER_WIDTH, {
    title: `Fleet — ${rows.length} worker${rows.length === 1 ? '' : 's'}`,
    borderColor: gold,
  })

  let frameIndex = 0
  let rendered = 0
  let stopped = false

  function line(row: WorkerRow): string {
    const elapsed = row.startedAt ? ((row.finishedAt ?? Date.now()) - row.startedAt) / 1000 : 0
    const time = row.startedAt ? dim(`${elapsed.toFixed(1)}s`) : ''

    const marker =
      row.status === 'running'
        ? gold(SPINNER[frameIndex % SPINNER.length]!)
        : row.status === 'done'
          ? green('✓')
          : row.status === 'failed'
            ? red('✗')
            : dim('·')

    const detail = row.detail ? ` ${dim(truncate(row.detail, 40))}` : ''
    return panel.line(`${marker} ${cyan(row.role.padEnd(ROLE_WIDTH))} ${truncate(row.title, TITLE_WIDTH).padEnd(TITLE_WIDTH)} ${time}${detail}`)
  }

  function render(): void {
    if (stopped) return
    if (rendered > 0) process.stdout.write(`\x1b[${rendered}A`)
    process.stdout.write(`\x1b[2K${panel.top}\n`)
    for (const row of rows) process.stdout.write(`\x1b[2K${line(row)}\n`)
    process.stdout.write(`\x1b[2K${panel.bottom}\n`)
    rendered = rows.length + 2
  }

  render()
  const timer = setInterval(() => {
    frameIndex += 1
    render()
  }, TICK_MS)

  return {
    update(name, status, detail) {
      const row = rows.find((candidate) => candidate.name === name)
      if (!row) return
      row.status = status
      if (detail !== undefined) row.detail = detail
      if (status === 'running' && !row.startedAt) row.startedAt = Date.now()
      if (status === 'done' || status === 'failed') row.finishedAt = Date.now()
      render()
    },
    stop() {
      if (stopped) return
      clearInterval(timer)
      render()
      stopped = true
    },
  }
}

/** Piped output can't be rewritten in place, so each transition becomes one plain line. */
function createPlainBoard(rows: WorkerRow[]): FleetBoard {
  return {
    update(name, status, detail) {
      const row = rows.find((candidate) => candidate.name === name)
      if (!row) return
      row.status = status
      if (status === 'queued') return
      process.stdout.write(`  [${status}] ${row.role} ${row.title}${detail ? ` — ${detail}` : ''}\n`)
    },
    stop() {},
  }
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const DIM = '\x1b[2m'
const GOLD = '\x1b[33m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const CYAN = '\x1b[36m'
const RESET = '\x1b[0m'

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const TICK_MS = 120

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

  let frame = 0
  let rendered = 0
  let stopped = false

  function line(row: WorkerRow): string {
    const elapsed = row.startedAt ? ((row.finishedAt ?? Date.now()) - row.startedAt) / 1000 : 0
    const time = row.startedAt ? `${DIM}${elapsed.toFixed(1)}s${RESET}` : ''

    const marker =
      row.status === 'running'
        ? `${GOLD}${SPINNER[frame % SPINNER.length]}${RESET}`
        : row.status === 'done'
          ? `${GREEN}✓${RESET}`
          : row.status === 'failed'
            ? `${RED}✗${RESET}`
            : `${DIM}·${RESET}`

    const detail = row.detail ? ` ${DIM}${truncate(row.detail, 40)}${RESET}` : ''
    return `  ${marker} ${CYAN}${row.role.padEnd(8)}${RESET} ${truncate(row.title, 46).padEnd(46)} ${time}${detail}`
  }

  function render(): void {
    if (stopped) return
    if (rendered > 0) process.stdout.write(`\x1b[${rendered}A`)
    for (const row of rows) process.stdout.write(`\x1b[2K${line(row)}\n`)
    rendered = rows.length
  }

  render()
  const timer = setInterval(() => {
    frame += 1
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

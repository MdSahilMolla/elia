import * as readline from 'node:readline'
import { reverse, dim, gold, bold } from './theme.ts'
import { interactiveTerminal } from './runtime.ts'
import { gracefulShutdown, registerShutdownCleanup } from './shutdown.ts'

export interface PickerOption {
  label: string
  detail?: string
  value: string
}

export type PickerResult =
  | { type: 'select'; value: string }
  | { type: 'cancel' }
  | { type: 'unavailable' }

export interface KeyEvent {
  name?: string
  ctrl?: boolean
}

export type PickerKeyResult =
  | { type: 'move'; selected: number }
  | { type: 'select'; index: number }
  | { type: 'cancel' }
  | { type: 'quit' }
  | { type: 'none' }

const PAGE_SIZE = 10

/** Pure picker reducer; all terminal I/O stays in pick() below. */
export function applyPickerKey(selected: number, optionCount: number, key: KeyEvent): PickerKeyResult {
  if (key.ctrl && key.name === 'c') return { type: 'quit' }
  if (optionCount <= 0) return key.name === 'escape' ? { type: 'cancel' } : { type: 'none' }
  switch (key.name) {
    case 'up':
    case 'left':
      return { type: 'move', selected: (selected - 1 + optionCount) % optionCount }
    case 'down':
    case 'right':
      return { type: 'move', selected: (selected + 1) % optionCount }
    case 'pageup':
      return { type: 'move', selected: Math.max(0, selected - PAGE_SIZE) }
    case 'pagedown':
      return { type: 'move', selected: Math.min(optionCount - 1, selected + PAGE_SIZE) }
    case 'home':
      return { type: 'move', selected: 0 }
    case 'end':
      return { type: 'move', selected: optionCount - 1 }
    case 'return':
      return { type: 'select', index: Math.min(Math.max(selected, 0), optionCount - 1) }
    case 'escape':
      return { type: 'cancel' }
    default:
      return { type: 'none' }
  }
}

export type SearchKeyResult = PickerKeyResult | { type: 'query'; query: string }

const SEARCH_NAV_KEYS = new Set(['up', 'down', 'left', 'right', 'pageup', 'pagedown', 'home', 'end', 'return', 'tab'])

/**
 * Same navigation as applyPickerKey, plus typed characters editing a live
 * search query. Escape clears the query before it cancels the picker — the
 * fuzzy-finder convention (fzf, VS Code's quick-open) this borrows from,
 * since a search that's easy to start but sticky to leave is worse than none.
 */
export function applySearchKey(selected: number, filteredCount: number, query: string, str: string | undefined, key: KeyEvent): SearchKeyResult {
  if (key.ctrl && key.name === 'c') return { type: 'quit' }
  if (key.name === 'escape') return query ? { type: 'query', query: '' } : { type: 'cancel' }
  if (key.name === 'backspace') return query ? { type: 'query', query: query.slice(0, -1) } : { type: 'none' }
  if (str && str.length === 1 && !key.ctrl && !SEARCH_NAV_KEYS.has(key.name ?? '') && str.charCodeAt(0) >= 32) {
    return { type: 'query', query: query + str }
  }
  return applyPickerKey(selected, filteredCount, key)
}

export interface PickOptions {
  /** Lets typed characters filter the list live instead of only moving the cursor — worthwhile once a list can outgrow one page (artifacts, a large model catalog). */
  searchable?: boolean
}

/** A bounded interactive list picker for models, skills, reasoning settings, and artifacts. */
export function pick(title: string, options: PickerOption[], initialIndex = 0, pickOptions: PickOptions = {}): Promise<PickerResult> {
  if (!interactiveTerminal || options.length === 0) return Promise.resolve({ type: 'unavailable' })
  const searchable = pickOptions.searchable ?? false

  const stdin = process.stdin
  const stdout = process.stdout
  readline.emitKeypressEvents(stdin)
  const wasRaw = stdin.isRaw
  const wasPaused = stdin.isPaused()
  stdin.setRawMode(true)
  stdin.resume()

  let query = ''
  let filtered = options
  let selected = Math.min(Math.max(initialIndex, 0), options.length - 1)
  let viewportStart = 0
  let rendered = 0
  let finished = false

  function applyFilter(): void {
    const needle = query.trim().toLowerCase()
    filtered = !searchable || !needle
      ? options
      : options.filter((option) => option.label.toLowerCase().includes(needle) || (option.detail ?? '').toLowerCase().includes(needle))
    selected = Math.min(Math.max(selected, 0), Math.max(0, filtered.length - 1))
    viewportStart = 0
  }

  function adjustViewport(): void {
    if (selected < viewportStart) viewportStart = selected
    if (selected >= viewportStart + PAGE_SIZE) viewportStart = selected - PAGE_SIZE + 1
    viewportStart = Math.max(0, Math.min(viewportStart, Math.max(0, filtered.length - PAGE_SIZE)))
  }

  function render(): void {
    if (finished) return
    adjustViewport()
    if (rendered > 0) stdout.write(`\x1b[${rendered}A`)
    const visible = filtered.slice(viewportStart, viewportStart + PAGE_SIZE)
    const hint = searchable ? 'type to search · ↑/↓ move · enter select · esc clear/cancel' : '↑/↓ move · pgup/pgdn page · home/end · enter select · esc cancel'
    const lines = [
      `${bold(title)} ${dim(`(${hint})`)}`,
      ...(searchable ? [`  ${gold('search›')} ${query}${dim('▏')}`] : []),
      ...(visible.length > 0
        ? visible.map((option, offset) => {
            const i = viewportStart + offset
            const highlighted = i === selected
            const marker = highlighted ? gold('›') : ' '
            const label = highlighted ? reverse(option.label) : option.label
            const detail = option.detail ? ` ${dim(option.detail)}` : ''
            return `  ${marker} ${label}${detail}`
          })
        : [`  ${dim(searchable ? 'no matches' : 'nothing to show')}`]),
      dim(
        filtered.length > 0
          ? `showing ${viewportStart + 1}–${Math.min(filtered.length, viewportStart + visible.length)} of ${filtered.length}${searchable && filtered.length !== options.length ? ` (${options.length} total)` : ''}`
          : `0 of ${options.length}`,
      ),
    ]
    for (const line of lines) stdout.write(`\x1b[2K${line}\n`)
    rendered = lines.length
  }

  function cleanup(): void {
    if (finished) return
    finished = true
    stdin.off('keypress', onKeypress)
    if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false)
    if (wasPaused) stdin.pause()
  }

  const unregisterShutdown = registerShutdownCleanup(cleanup)

  function finish(result: PickerResult): void {
    cleanup()
    unregisterShutdown()
    stdout.write(`\x1b[${rendered}A\x1b[0J`)
    resolveResult?.(result)
  }

  let resolveResult: ((result: PickerResult) => void) | undefined
  function onKeypress(str: string | undefined, key: KeyEvent): void {
    const result = searchable ? applySearchKey(selected, filtered.length, query, str, key) : applyPickerKey(selected, filtered.length, key)
    switch (result.type) {
      case 'quit':
        cleanup()
        unregisterShutdown()
        stdout.write('\n')
        gracefulShutdown(130)
        break
      case 'move':
        selected = result.selected
        render()
        break
      case 'select':
        finish({ type: 'select', value: filtered[result.index]!.value })
        break
      case 'cancel':
        finish({ type: 'cancel' })
        break
      case 'query':
        query = result.query
        applyFilter()
        render()
        break
      case 'none':
        break
    }
  }

  applyFilter()
  render()
  stdin.on('keypress', onKeypress)
  return new Promise((resolve) => {
    resolveResult = resolve
  })
}

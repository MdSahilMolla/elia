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

/** A bounded interactive list picker for models, skills, and reasoning settings. */
export function pick(title: string, options: PickerOption[], initialIndex = 0): Promise<PickerResult> {
  if (!interactiveTerminal || options.length === 0) return Promise.resolve({ type: 'unavailable' })

  const stdin = process.stdin
  const stdout = process.stdout
  readline.emitKeypressEvents(stdin)
  const wasRaw = stdin.isRaw
  stdin.setRawMode(true)
  stdin.resume()

  let selected = Math.min(Math.max(initialIndex, 0), options.length - 1)
  let viewportStart = 0
  let rendered = 0
  let finished = false

  function adjustViewport(): void {
    if (selected < viewportStart) viewportStart = selected
    if (selected >= viewportStart + PAGE_SIZE) viewportStart = selected - PAGE_SIZE + 1
    viewportStart = Math.max(0, Math.min(viewportStart, Math.max(0, options.length - PAGE_SIZE)))
  }

  function render(): void {
    if (finished) return
    adjustViewport()
    if (rendered > 0) stdout.write(`\x1b[${rendered}A`)
    const visible = options.slice(viewportStart, viewportStart + PAGE_SIZE)
    const lines = [
      `${bold(title)} ${dim('(↑/↓ move · pgup/pgdn page · home/end · enter select · esc cancel)')}`,
      ...visible.map((option, offset) => {
        const i = viewportStart + offset
        const highlighted = i === selected
        const marker = highlighted ? gold('›') : ' '
        const label = highlighted ? reverse(option.label) : option.label
        const detail = option.detail ? ` ${dim(option.detail)}` : ''
        return `  ${marker} ${label}${detail}`
      }),
      dim(`showing ${viewportStart + 1}–${Math.min(options.length, viewportStart + visible.length)} of ${options.length}`),
    ]
    for (const line of lines) stdout.write(`\x1b[2K${line}\n`)
    rendered = lines.length
  }

  function cleanup(): void {
    if (finished) return
    finished = true
    stdin.off('keypress', onKeypress)
    if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false)
    stdin.pause()
  }

  const unregisterShutdown = registerShutdownCleanup(cleanup)

  function finish(result: PickerResult): void {
    cleanup()
    unregisterShutdown()
    stdout.write(`\x1b[${rendered}A\x1b[0J`)
    resolveResult?.(result)
  }

  let resolveResult: ((result: PickerResult) => void) | undefined
  function onKeypress(_str: string | undefined, key: KeyEvent): void {
    const result = applyPickerKey(selected, options.length, key)
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
        finish({ type: 'select', value: options[result.index]!.value })
        break
      case 'cancel':
        finish({ type: 'cancel' })
        break
      case 'none':
        break
    }
  }

  render()
  stdin.on('keypress', onKeypress)
  return new Promise((resolve) => {
    resolveResult = resolve
  })
}

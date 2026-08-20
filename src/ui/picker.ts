import * as readline from 'node:readline'
import { reverse, dim, gold, bold } from './theme.ts'

export interface PickerOption {
  label: string
  detail?: string
  value: string
}

export type PickerResult =
  | { type: 'select'; value: string }
  | { type: 'cancel' }
  /** Not a real TTY, so there was nothing to render at all — distinct from the user actually pressing escape, so a caller can fall back to printing a plain listing instead of just going silent. */
  | { type: 'unavailable' }

/** The subset of Node's keypress event this module reacts to — kept minimal and structural so tests don't need a real TTY (mirrors slashPrompt.ts's KeyEvent). */
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

/**
 * Pure reducer over one keypress given the current selection and option count —
 * up/down *and* left/right both move the highlight (deliberately: this is a
 * single vertical list, not a grid, but different people's muscle memory reaches
 * for either pair). Free of any terminal I/O so it can be unit tested without a
 * real TTY; `pick` below is the thin raw-mode renderer that drives it.
 */
export function applyPickerKey(selected: number, optionCount: number, key: KeyEvent): PickerKeyResult {
  if (key.ctrl && key.name === 'c') return { type: 'quit' }
  switch (key.name) {
    case 'up':
    case 'left':
      return { type: 'move', selected: (selected - 1 + optionCount) % optionCount }
    case 'down':
    case 'right':
      return { type: 'move', selected: (selected + 1) % optionCount }
    case 'return':
      return { type: 'select', index: selected }
    case 'escape':
      return { type: 'cancel' }
    default:
      return { type: 'none' }
  }
}

/**
 * A small interactive list picker — up/down or left/right move the highlight,
 * enter selects, escape cancels, Ctrl+C quits elia entirely (matching the slash
 * prompt's own convention, since raw mode intercepts Ctrl+C as a keypress rather
 * than letting the terminal deliver SIGINT).
 *
 * Runs as its own short-lived modal between `prompt.question()` calls rather than
 * being woven into the line editor: `/model` and `/thinking` need to browse a
 * fixed list of options, not edit a line of text. It reuses the same raw-mode
 * stdin the main prompt already put the terminal into and restores exactly what
 * it found, so control hands back to `createSlashPrompt` none the wiser.
 */
export function pick(title: string, options: PickerOption[], initialIndex = 0): Promise<PickerResult> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || options.length === 0) {
    return Promise.resolve({ type: 'unavailable' })
  }

  const stdin = process.stdin
  const stdout = process.stdout
  readline.emitKeypressEvents(stdin)
  const wasRaw = stdin.isRaw
  stdin.setRawMode(true)
  stdin.resume()

  let selected = Math.min(Math.max(initialIndex, 0), options.length - 1)
  let rendered = 0

  function render(): void {
    if (rendered > 0) stdout.write(`\x1b[${rendered}A`)
    const lines = [
      `${bold(title)} ${dim('(↑/↓ move · enter select · esc cancel)')}`,
      ...options.map((option, i) => {
        const highlighted = i === selected
        const marker = highlighted ? gold('›') : ' '
        const label = highlighted ? reverse(option.label) : option.label
        const detail = option.detail ? ` ${dim(option.detail)}` : ''
        return `  ${marker} ${label}${detail}`
      }),
    ]
    for (const line of lines) stdout.write(`\x1b[2K${line}\n`)
    rendered = lines.length
  }

  render()

  return new Promise((resolve) => {
    function cleanup(): void {
      stdin.off('keypress', onKeypress)
      if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false)
    }

    function finish(result: PickerResult): void {
      cleanup()
      stdout.write(`\x1b[${rendered}A\x1b[0J`)
      resolve(result)
    }

    function onKeypress(_str: string | undefined, key: KeyEvent): void {
      const result = applyPickerKey(selected, options.length, key)
      switch (result.type) {
        case 'quit':
          cleanup()
          stdout.write('\n')
          process.exit(0)
          break // unreachable, keeps TS happy about exhaustiveness
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

    stdin.on('keypress', onKeypress)
  })
}

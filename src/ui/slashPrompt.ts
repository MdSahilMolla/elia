import * as readline from 'node:readline'
import { dim, reverse, stripAnsi } from './theme.ts'

/** One entry in the slash-command or @-mention completion menu. */
export interface SlashCommand {
  name: string
  description: string
}

export interface PromptState {
  buffer: string
  cursor: number
  selectedIndex: number
  history: string[]
  historyIndex: number
  /** What was being typed before the user started walking history with up/down, restored on down-past-the-end. */
  draft: string
}

export function initialState(): PromptState {
  return { buffer: '', cursor: 0, selectedIndex: 0, history: [], historyIndex: 0, draft: '' }
}

/** Entries whose name starts with the current buffer — completion activates for slash commands and @-mentions. */
export function filteredCommands(buffer: string, commands: SlashCommand[]): SlashCommand[] {
  if (!buffer.startsWith('/') && !buffer.startsWith('@')) return []
  const prefix = buffer.toLowerCase()
  return commands.filter((c) => c.name.toLowerCase().startsWith(prefix))
}

/** The subset of Node's keypress event this module reacts to — kept minimal and structural so tests don't need a real TTY. */
export interface KeyEvent {
  name?: string
  ctrl?: boolean
  meta?: boolean
}

export type KeyResult =
  | { type: 'update'; state: PromptState }
  | { type: 'submit'; state: PromptState; line: string }
  | { type: 'eof' }
  | { type: 'interrupt' }

/**
 * Pure reducer over one keypress: given the current line-editor state and the key
 * that was pressed, returns the next state (or a terminal outcome). Kept free of any
 * terminal I/O so the interaction logic — menu navigation, history walking, editing —
 * can be unit tested without a real TTY; `createSlashPrompt` below is the thin
 * raw-mode renderer that drives it.
 */
export function applyKey(state: PromptState, str: string | undefined, key: KeyEvent, commands: SlashCommand[]): KeyResult {
  if (key.ctrl && key.name === 'c') return { type: 'interrupt' }
  if (key.ctrl && key.name === 'd' && state.buffer === '') return { type: 'eof' }

  const menu = filteredCommands(state.buffer, commands)

  switch (key.name) {
    case 'return': {
      const line = menu.length > 0 ? menu[Math.min(state.selectedIndex, menu.length - 1)]!.name : state.buffer
      const history = line.trim() && state.history[state.history.length - 1] !== line ? [...state.history, line] : state.history
      return {
        type: 'submit',
        line,
        state: { buffer: '', cursor: 0, selectedIndex: 0, history, historyIndex: history.length, draft: '' },
      }
    }
    case 'tab': {
      if (menu.length === 0) return { type: 'update', state }
      const buffer = `${menu[Math.min(state.selectedIndex, menu.length - 1)]!.name} `
      return { type: 'update', state: { ...state, buffer, cursor: buffer.length, selectedIndex: 0 } }
    }
    case 'up': {
      if (menu.length > 0) return { type: 'update', state: { ...state, selectedIndex: (state.selectedIndex - 1 + menu.length) % menu.length } }
      if (state.historyIndex === 0) return { type: 'update', state }
      const draft = state.historyIndex === state.history.length ? state.buffer : state.draft
      const historyIndex = state.historyIndex - 1
      const buffer = state.history[historyIndex]!
      return { type: 'update', state: { ...state, buffer, cursor: buffer.length, historyIndex, draft } }
    }
    case 'down': {
      if (menu.length > 0) return { type: 'update', state: { ...state, selectedIndex: (state.selectedIndex + 1) % menu.length } }
      if (state.historyIndex >= state.history.length) return { type: 'update', state }
      const historyIndex = state.historyIndex + 1
      const buffer = historyIndex === state.history.length ? state.draft : state.history[historyIndex]!
      return { type: 'update', state: { ...state, buffer, cursor: buffer.length, historyIndex } }
    }
    case 'left':
      return { type: 'update', state: { ...state, cursor: Math.max(0, state.cursor - 1) } }
    case 'right':
      return { type: 'update', state: { ...state, cursor: Math.min(state.buffer.length, state.cursor + 1) } }
    case 'home':
      return { type: 'update', state: { ...state, cursor: 0 } }
    case 'end':
      return { type: 'update', state: { ...state, cursor: state.buffer.length } }
    case 'backspace': {
      if (state.cursor === 0) return { type: 'update', state }
      const buffer = state.buffer.slice(0, state.cursor - 1) + state.buffer.slice(state.cursor)
      return { type: 'update', state: { ...state, buffer, cursor: state.cursor - 1, selectedIndex: 0 } }
    }
    case 'delete': {
      const buffer = state.buffer.slice(0, state.cursor) + state.buffer.slice(state.cursor + 1)
      return { type: 'update', state: { ...state, buffer, selectedIndex: 0 } }
    }
    default: {
      if (str && !key.ctrl && !key.meta && [...str].every((ch) => ch >= ' ' || ch === '\t')) {
        const buffer = state.buffer.slice(0, state.cursor) + str + state.buffer.slice(state.cursor)
        return { type: 'update', state: { ...state, buffer, cursor: state.cursor + str.length, selectedIndex: 0 } }
      }
      return { type: 'update', state }
    }
  }
}

export interface SlashPromptHandle {
  /** Resolves with the submitted line, or null on EOF (Ctrl+D / closed stdin) — same contract as the old `rl.question` + EOF-catch pairing it replaces. */
  question(promptLabel: string): Promise<string | null>
  close(): void
}

/**
 * A line editor for the interactive REPL with a live completion menu: typing "/"
 * lists matching commands, up/down move the highlight (or walk line history once the
 * buffer isn't a slash or @-mention), left/right/home/end move the cursor, tab accepts the
 * highlighted suggestion, enter submits it. Falls back to plain `readline.question`
 * when stdin isn't a TTY (piped input, non-interactive runs) since raw-mode rendering
 * only makes sense against a real terminal.
 */
export function createSlashPrompt(commands: SlashCommand[]): SlashPromptHandle {
  if (!process.stdin.isTTY) return createFallbackPrompt()

  const stdin = process.stdin
  const stdout = process.stdout
  readline.emitKeypressEvents(stdin)
  stdin.setRawMode(true)
  stdin.resume()

  let state = initialState()
  let promptLabel = '> '
  let resolveLine: ((line: string | null) => void) | undefined
  let active = false

  function render(): void {
    // Cursor always sits on the prompt row between keystrokes, so clearing
    // from here to end-of-screen wipes the old buffer text and any stale menu.
    stdout.write(`\r\x1b[0J${promptLabel}${state.buffer}`)

    const menu = filteredCommands(state.buffer, commands)
    if (menu.length > 0) {
      const selected = Math.min(state.selectedIndex, menu.length - 1)
      for (const [i, cmd] of menu.entries()) {
        const highlighted = i === selected
        const name = highlighted ? reverse(cmd.name) : cmd.name
        stdout.write(`\n${name}  ${dim(cmd.description)}`)
      }
      stdout.write(`\x1b[${menu.length}A`) // back up to the prompt row
    }

    stdout.write('\r')
    // promptLabel may carry ANSI color codes (see index.ts) — strip them before
    // measuring, or the cursor lands past where the visible text actually ends.
    const col = stripAnsi(promptLabel).length + state.cursor
    if (col > 0) stdout.write(`\x1b[${col}C`)
  }

  function finish(line: string | null): void {
    active = false
    stdout.write(`\r\x1b[0J${promptLabel}${line ?? state.buffer}\n`)
    const resolve = resolveLine
    resolveLine = undefined
    resolve?.(line)
  }

  function onKeypress(str: string | undefined, key: KeyEvent): void {
    if (!active) return
    const result = applyKey(state, str, key, commands)

    if (result.type === 'interrupt') {
      stdout.write(`\r\x1b[0J${promptLabel}${state.buffer}\n`)
      process.exit(0)
    }
    if (result.type === 'eof') {
      finish(null)
      return
    }
    if (result.type === 'submit') {
      state = result.state
      finish(result.line)
      return
    }
    state = result.state
    render()
  }

  stdin.on('keypress', onKeypress)

  return {
    question(label: string) {
      promptLabel = label
      state = { ...state, buffer: '', cursor: 0, selectedIndex: 0 }
      active = true
      render()
      return new Promise((resolve) => {
        resolveLine = resolve
      })
    },
    close() {
      active = false
      stdin.off('keypress', onKeypress)
      if (stdin.isTTY) stdin.setRawMode(false)
      stdin.pause()
    },
  }
}

function createFallbackPrompt(): SlashPromptHandle {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  let resolveLine: ((line: string | null) => void) | undefined
  // One persistent listener rather than one per question() call, so it never accumulates.
  rl.on('close', () => {
    resolveLine?.(null)
    resolveLine = undefined
  })
  return {
    question(label: string) {
      return new Promise((resolve) => {
        resolveLine = resolve
        rl.question(label, (answer) => {
          resolveLine = undefined
          resolve(answer)
        })
      })
    },
    close() {
      rl.close()
    },
  }
}

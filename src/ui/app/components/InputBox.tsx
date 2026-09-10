import { useState } from 'react'
import { Box, Text, useInput, type Key } from 'ink'
import { palette, glyphs } from '../theme.ts'
import {
  applyKey,
  filteredCommands,
  initialState,
  type PromptState,
  type SlashCommand,
  type KeyEvent,
} from '../../slashPrompt.ts'

/** Ink's key object → the small structural KeyEvent slashPrompt's pure reducer expects. */
function toKeyEvent(input: string, key: Key): { str: string | undefined; event: KeyEvent } {
  const name = key.return
    ? 'return'
    : key.backspace
      ? 'backspace'
      : key.delete
        ? 'backspace'
        : key.leftArrow
          ? 'left'
          : key.rightArrow
            ? 'right'
            : key.upArrow
              ? 'up'
              : key.downArrow
                ? 'down'
                : key.tab
                  ? 'tab'
                  : key.escape
                    ? 'escape'
                    : key.ctrl && input === 'a'
                      ? 'home'
                      : key.ctrl && input === 'e'
                        ? 'end'
                        : undefined
  return { str: name ? undefined : input, event: { name, ctrl: key.ctrl, meta: key.meta } }
}

export interface InputBoxProps {
  commands: SlashCommand[]
  disabled: boolean
  placeholder: string
  onSubmit(line: string): void
  onInterrupt(): void
  onEof(): void
  /** Tab on an empty line (no completion menu) — used to toggle plan/build mode. */
  onTabEmpty(): void
  /** `?` on an empty line — opens the keybinding help. */
  onHelp?(): void
}

/**
 * Renders the input buffer with a block caret sitting at `cursor` rather than
 * always pinned to the end of the line. The character under the cursor is drawn
 * inverse; when the cursor is past the last character (or the line is empty) an
 * inverse space stands in for it. See issue #11 — the caret used to be a fixed
 * trailing glyph, so its position never tracked left/right/home/end moves.
 */
function BufferView(props: { buffer: string; cursor: number; placeholder: string; showCursor: boolean }) {
  const { buffer, cursor, placeholder, showCursor } = props

  if (buffer.length === 0) {
    return (
      <Text>
        {showCursor && <Text inverse> </Text>}
        <Text color={palette.muted}>{placeholder}</Text>
      </Text>
    )
  }

  if (!showCursor) return <Text>{buffer}</Text>

  const clamped = Math.max(0, Math.min(cursor, buffer.length))
  return (
    <Text>
      {buffer.slice(0, clamped)}
      <Text inverse>{buffer.slice(clamped, clamped + 1) || ' '}</Text>
      {buffer.slice(clamped + 1)}
    </Text>
  )
}

export function InputBox(props: InputBoxProps) {
  const [state, setState] = useState<PromptState>(initialState)

  useInput((input, key) => {
    if (props.disabled) return
    if (key.ctrl && input === 'c') {
      props.onInterrupt()
      return
    }
    if (key.tab && !key.shift && state.buffer.length === 0 && filteredCommands(state.buffer, props.commands).length === 0) {
      props.onTabEmpty()
      return
    }
    if (input === '?' && !key.ctrl && !key.meta && state.buffer.length === 0) {
      props.onHelp?.()
      return
    }
    const { str, event } = toKeyEvent(input, key)
    const result = applyKey(state, str, event, props.commands)
    if (result.type === 'eof') {
      props.onEof()
      return
    }
    if (result.type === 'interrupt') {
      props.onInterrupt()
      return
    }
    if (result.type === 'submit') {
      setState(result.state)
      if (result.line.trim()) props.onSubmit(result.line)
      return
    }
    setState(result.state)
  })

  const menu = filteredCommands(state.buffer, props.commands)
  const selected = Math.min(state.selectedIndex, Math.max(0, menu.length - 1))

  // The menu can be longer than we want to draw. Scroll a fixed window so the
  // highlighted row is always visible instead of clipping everything past row 8.
  const MAX_VISIBLE = 10
  const start =
    menu.length <= MAX_VISIBLE
      ? 0
      : Math.min(Math.max(0, selected - Math.floor(MAX_VISIBLE / 2)), menu.length - MAX_VISIBLE)
  const visible = menu.slice(start, start + MAX_VISIBLE)
  const hiddenAbove = start
  const hiddenBelow = menu.length - (start + visible.length)

  return (
    <Box flexDirection="column">
      {/* One dim rule above the prompt — the single structural line in the whole
          UI. Was a top+bottom border box; a lone rule reads lighter and can't
          mis-wrap. */}
      <Box
        borderStyle="single"
        borderColor={props.disabled ? palette.muted : palette.accent}
        borderTop
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
      >
        <Text color={palette.accent}>{glyphs.user} </Text>
        <BufferView buffer={state.buffer} cursor={state.cursor} placeholder={props.placeholder} showCursor={!props.disabled} />
      </Box>
      {menu.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {hiddenAbove > 0 && <Text color={palette.muted}>↑ {hiddenAbove} more</Text>}
          {visible.map((cmd) => (
            <Text key={cmd.name} inverse={menu[selected]?.name === cmd.name}>
              {cmd.name} <Text color={palette.muted}>{cmd.description}</Text>
            </Text>
          ))}
          {hiddenBelow > 0 && <Text color={palette.muted}>↓ {hiddenBelow} more</Text>}
        </Box>
      )}
    </Box>
  )
}

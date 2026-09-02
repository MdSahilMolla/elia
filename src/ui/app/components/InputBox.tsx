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
      <Box borderStyle="round" borderColor={props.disabled ? palette.muted : palette.accent} paddingX={1}>
        <Text color={palette.accent}>{glyphs.user} </Text>
        <Text>{state.buffer || <Text color={palette.muted}>{props.placeholder}</Text>}</Text>
        {!props.disabled && <Text color={palette.muted}>▏</Text>}
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

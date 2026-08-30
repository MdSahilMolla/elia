import { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { palette } from '../theme.ts'
import { applySearchKey, type PickerOption } from '../../picker.ts'

export interface PickerRequest {
  title: string
  options: PickerOption[]
  searchable?: boolean
  initialIndex?: number
  resolve(value: string | null): void
}

const PAGE = 10

/** Ink port of picker.ts's list picker, reusing its pure `applySearchKey` reducer. */
export function Picker({ request }: { request: PickerRequest }) {
  const [selected, setSelected] = useState(request.initialIndex ?? 0)
  const [query, setQuery] = useState('')

  const filtered = query.trim()
    ? request.options.filter(
        (o) =>
          o.label.toLowerCase().includes(query.toLowerCase()) ||
          (o.detail ?? '').toLowerCase().includes(query.toLowerCase()),
      )
    : request.options

  useInput((input, key) => {
    const event = {
      name: key.upArrow
        ? 'up'
        : key.downArrow
          ? 'down'
          : key.leftArrow
            ? 'left'
            : key.rightArrow
              ? 'right'
              : key.pageUp
                ? 'pageup'
                : key.pageDown
                  ? 'pagedown'
                  : key.return
                    ? 'return'
                    : key.escape
                      ? 'escape'
                      : key.backspace || key.delete
                        ? 'backspace'
                        : undefined,
      ctrl: key.ctrl,
    }
    const result = applySearchKey(selected, filtered.length, query, input, event)
    switch (result.type) {
      case 'move':
        setSelected(result.selected)
        break
      case 'query':
        setQuery(result.query)
        setSelected(0)
        break
      case 'select':
        request.resolve(filtered[result.index]?.value ?? null)
        break
      case 'cancel':
      case 'quit':
        request.resolve(null)
        break
    }
  })

  const start = Math.max(0, Math.min(selected - Math.floor(PAGE / 2), Math.max(0, filtered.length - PAGE)))
  const visible = filtered.slice(start, start + PAGE)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.accent} paddingX={1} marginTop={1}>
      <Text bold>
        {request.title} <Text color={palette.muted}>(↑↓ · type to filter · enter · esc)</Text>
      </Text>
      {request.searchable && (
        <Text color={palette.muted}>
          search: {query}
          <Text color={palette.muted}>▏</Text>
        </Text>
      )}
      {visible.map((option) => {
        const isSel = filtered[selected] === option
        return (
          <Text key={option.value} inverse={isSel}>
            {isSel ? '❯ ' : '  '}
            {option.label}
            {option.detail ? <Text color={palette.muted}> {option.detail}</Text> : null}
          </Text>
        )
      })}
      {filtered.length === 0 && <Text color={palette.muted}>no matches</Text>}
    </Box>
  )
}

import { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { glyphs, palette } from '../theme.ts'
import { Panel } from './Panel.tsx'
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

  // No `query.trim()` special case: an empty query naturally matches every
  // option via `.includes('')`, and a whitespace-only query now filters for
  // real instead of silently showing everything while the search line
  // displays the (apparently ignored) spaces.
  const filtered = request.options.filter(
    (o) =>
      o.label.toLowerCase().includes(query.toLowerCase()) ||
      (o.detail ?? '').toLowerCase().includes(query.toLowerCase()),
  )

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

  // Details line up in one column, as far as a sensible label width allows.
  const labelWidth = Math.min(32, Math.max(0, ...visible.map((option) => Bun.stringWidth(option.label))))
  const hiddenAbove = start
  const hiddenBelow = Math.max(0, filtered.length - (start + visible.length))

  return (
    <Panel title={request.title} tone="brand">
      {(request.searchable || query) && (
        <Text>
          <Text color={palette.muted}>⌕ </Text>
          {query || <Text color={palette.muted}>type to filter</Text>}
          <Text inverse> </Text>
        </Text>
      )}
      {hiddenAbove > 0 && <Text color={palette.muted}>  ↑ {hiddenAbove} more</Text>}
      {visible.map((option) => {
        const isSel = filtered[selected] === option
        return (
          <Text key={option.value} wrap="truncate-end">
            <Text bold={isSel} color={isSel ? palette.selection : palette.muted}>
              {isSel ? `${glyphs.user} ` : '  '}
              {option.label}
            </Text>
            {option.detail ? (
              <Text color={palette.muted}>
                {' '.repeat(Math.max(0, labelWidth - Bun.stringWidth(option.label)))}  {option.detail}
              </Text>
            ) : null}
          </Text>
        )
      })}
      {hiddenBelow > 0 && <Text color={palette.muted}>  ↓ {hiddenBelow} more</Text>}
      {filtered.length === 0 && <Text color={palette.muted}>  no matches</Text>}
      <Box marginTop={1}>
        <Text color={palette.muted}>↑↓ to move · enter to select · esc to cancel</Text>
      </Box>
    </Panel>
  )
}

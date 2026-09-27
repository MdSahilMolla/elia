import { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { palette } from '../theme.ts'
import { Panel } from './Panel.tsx'

export interface TextPromptRequest {
  label: string
  placeholder?: string
  resolve(value: string | null): void
}

/**
 * A one-line text input modal — e.g. "search npm for:". Enter submits, Esc
 * cancels, and it says so. The caret is the same inverse block the main input
 * uses, so the two never look like different kinds of field.
 */
export function TextPrompt({ request }: { request: TextPromptRequest }) {
  const [value, setValue] = useState('')
  useInput((input, key) => {
    if (key.escape) return request.resolve(null)
    if (key.return) return request.resolve(value.trim())
    if (key.backspace || key.delete) return setValue((v) => v.slice(0, -1))
    if (input && !key.ctrl && !key.meta) setValue((v) => v + input)
  })
  return (
    <Panel>
      <Text wrap="wrap">
        <Text bold color={palette.selection}>{request.label} </Text>
        {value}
        <Text inverse> </Text>
        {value ? null : <Text color={palette.muted}>{request.placeholder ?? ''}</Text>}
      </Text>
      <Box marginTop={1}>
        <Text color={palette.muted}>enter to confirm · esc to cancel</Text>
      </Box>
    </Panel>
  )
}

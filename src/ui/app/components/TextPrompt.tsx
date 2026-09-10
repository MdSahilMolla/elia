import { useState } from 'react'
import { Text, useInput } from 'ink'
import { palette } from '../theme.ts'
import { Panel } from './Panel.tsx'

export interface TextPromptRequest {
  label: string
  placeholder?: string
  resolve(value: string | null): void
}

/** A one-line text input modal — e.g. "search npm for:". Enter submits, Esc cancels. */
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
      <Text>
        <Text color={palette.accent}>{request.label} </Text>
        {value || <Text color={palette.muted}>{request.placeholder ?? ''}</Text>}
        <Text color={palette.muted}>▏</Text>
      </Text>
    </Panel>
  )
}

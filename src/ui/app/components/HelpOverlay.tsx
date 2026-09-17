import { Box, Text, useInput } from 'ink'
import { palette } from '../theme.ts'
import { Panel } from './Panel.tsx'

const KEYS: [string, string][] = [
  ['enter', 'send · run the highlighted / command'],
  ['/', 'commands — /model, /cost, /clear, /help …'],
  ['@', 'mention a file'],
  ['!', 'run a shell command; its output joins the next turn'],
  ['shift+tab', 'cycle manual → auto-accept → plan mode'],
  ['tab', 'on an empty line, toggle plan mode'],
  ['type while working', 'steer the running turn at its next step'],
  ['esc', 'stop the turn · clear the queue'],
  ['ctrl+o', 'expand / collapse tool output'],
  ['ctrl+r', 'search your prompt history'],
  ['ctrl+c', 'stop · press twice to quit'],
]

/** A keybinding cheat sheet. Any key dismisses it. */
export function HelpOverlay({ onClose }: { onClose(): void }) {
  useInput(() => onClose())
  const width = Math.max(...KEYS.map(([k]) => k.length))
  return (
    <Panel title="Shortcuts" tone="brand">
      {KEYS.map(([key, desc]) => (
        <Text key={key}>
          <Text bold>{key.padEnd(width)}</Text>
          <Text color={palette.muted}>  {desc}</Text>
        </Text>
      ))}
      <Box marginTop={1}>
        <Text color={palette.muted}>any key to close</Text>
      </Box>
    </Panel>
  )
}

import { Text, useInput } from 'ink'
import { palette } from '../theme.ts'
import { Panel } from './Panel.tsx'

const KEYS: [string, string][] = [
  ['Enter', 'send · run the highlighted / command'],
  ['Tab', 'accept a / completion · on an empty line, toggle plan mode'],
  ['Shift+Tab', 'cycle manual → auto → plan'],
  ['type while working', 'steer the running turn — folded in at the next step'],
  ['Esc', 'clear the queue / pending steering · stop the current turn'],
  ['Ctrl+C', 'stop the turn · press twice to quit'],
  ['Ctrl+O', 'expand / collapse every tool result'],
  ['!<cmd>', 'run a shell command, carry its output into the next turn'],
  ['/', 'slash commands (/help, /model, /cost, /export, …)'],
  ['?', 'this help — on an empty line'],
]

/** A keybinding cheat sheet. Any key dismisses it. */
export function HelpOverlay({ onClose }: { onClose(): void }) {
  useInput(() => onClose())
  const width = Math.max(...KEYS.map(([k]) => k.length))
  return (
    <Panel title="Keys">
      {KEYS.map(([key, desc]) => (
        <Text key={key}>
          <Text color={palette.toolName}>{key.padEnd(width)}</Text>
          <Text color={palette.muted}>  {desc}</Text>
        </Text>
      ))}
      <Text color={palette.muted}>press any key to close</Text>
    </Panel>
  )
}

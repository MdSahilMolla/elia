import { Box, Text, useInput } from 'ink'
import { palette } from '../theme.ts'
import { Panel } from './Panel.tsx'

const KEYS: [string, string][] = [
  ['enter', 'send · run the highlighted / command'],
  ['/', 'commands — /help lists them all'],
  ['@', 'mention a file'],
  ['!', 'run a shell command; its output joins the next turn'],
  ['↑ / ↓', 'earlier prompts'],
  ['ctrl+r', 'search your prompt history'],
  ['ctrl+a / ctrl+e', 'start / end of the line'],
  ['shift+tab', 'cycle manual → auto-accept → plan mode'],
  ['tab', 'on an empty line, toggle plan mode'],
  ['type while working', 'steer the running turn at its next step'],
  ['esc', 'stop the turn · clear the queue · close quickchat'],
  ['ctrl+o', 'expand / collapse tool output and subagents'],
  ['ctrl+n', 'new parallel session (asks for a name)'],
  ['ctrl+tab', 'switch which session /quickchat and delegation target'],
  ['ctrl+c', 'stop · press twice to quit'],
]

/**
 * A keybinding cheat sheet. Any key dismisses it. Descriptions sit in their
 * own column, so on a narrow terminal they wrap under themselves instead of
 * back to the left edge under the keys.
 */
export function HelpOverlay({ onClose }: { onClose(): void }) {
  useInput(() => onClose())
  const width = Math.max(...KEYS.map(([k]) => k.length))
  return (
    <Panel title="Shortcuts" tone="brand">
      {KEYS.map(([key, desc]) => (
        <Box key={key}>
          <Box width={width + 2} flexShrink={0}>
            <Text bold>{key}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            <Text color={palette.muted} wrap="wrap">
              {desc}
            </Text>
          </Box>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text color={palette.muted}>any key to close</Text>
      </Box>
    </Panel>
  )
}

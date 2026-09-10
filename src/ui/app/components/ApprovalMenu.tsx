import { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { palette } from '../theme.ts'
import { Panel } from './Panel.tsx'
import type { ApprovalResult } from '../../../autonomy/governor.ts'

export interface ApprovalRequest {
  title: string
  lines: string[]
  /** A diff / command / content preview, +/- coloured. */
  preview?: string[]
  /** What an "always allow" covers, e.g. "`git` commands" or "`edit_file`". */
  ruleLabel: string
  /** run_command only — enables the "Edit command" option. */
  command?: string
  resolve(result: ApprovalResult): void
}

interface Choice {
  key: string
  label: string
  run(): void
}

const PREVIEW_LIMIT = 24

/**
 * The action-approval menu. A numbered list rather than a bare y/n: the same
 * decision a person actually makes at this boundary — once, always (three
 * scopes), edit, or no with a reason. Digit keys pick directly; ↑/↓ + Enter
 * also work; Esc is "no".
 */
export function ApprovalMenu({ request }: { request: ApprovalRequest }) {
  const [editing, setEditing] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [cursor, setCursor] = useState(0)

  const choices: Choice[] = []
  choices.push({ key: '1', label: 'Yes  (once)', run: () => request.resolve({ approved: true }) })
  choices.push({
    key: '2',
    label: `Yes, allow ${request.ruleLabel} for this session`,
    run: () => request.resolve({ approved: true, remember: 'session' }),
  })
  choices.push({
    key: '3',
    label: `Yes, always allow ${request.ruleLabel} in this project`,
    run: () => request.resolve({ approved: true, remember: 'project' }),
  })
  choices.push({
    key: '4',
    label: `Yes, always allow ${request.ruleLabel} on this machine`,
    run: () => request.resolve({ approved: true, remember: 'global' }),
  })
  if (request.command !== undefined) {
    choices.push({ key: '5', label: 'Edit command first', run: () => setEditing(request.command ?? '') })
  }
  choices.push({ key: 'n', label: 'No', run: () => request.resolve({ approved: false }) })
  choices.push({ key: 'd', label: 'No — tell elia what to do instead', run: () => setFeedback('') })

  useInput((input, key) => {
    if (editing !== null) {
      if (key.return) {
        // The governor does not mutate tool input, so an edit is a redirect:
        // decline the original call and tell the model the command to run.
        request.resolve({ approved: false, feedback: `Do not run that command. Run exactly this instead: ${editing}` })
        return
      }
      if (key.escape) {
        setEditing(null)
        return
      }
      if (key.backspace || key.delete) {
        setEditing((v) => (v ?? '').slice(0, -1))
        return
      }
      if (input && !key.ctrl && !key.meta) setEditing((v) => (v ?? '') + input)
      return
    }
    if (feedback !== null) {
      if (key.return) {
        request.resolve({ approved: false, feedback: feedback.trim() || 'no reason given' })
        return
      }
      if (key.escape) {
        setFeedback(null)
        return
      }
      if (key.backspace || key.delete) {
        setFeedback((v) => (v ?? '').slice(0, -1))
        return
      }
      if (input && !key.ctrl && !key.meta) setFeedback((v) => (v ?? '') + input)
      return
    }
    if (key.escape) {
      request.resolve({ approved: false })
      return
    }
    if (key.upArrow) {
      setCursor((c) => (c - 1 + choices.length) % choices.length)
      return
    }
    if (key.downArrow) {
      setCursor((c) => (c + 1) % choices.length)
      return
    }
    if (key.return) {
      choices[cursor]?.run()
      return
    }
    const hit = choices.find((c) => c.key === input.toLowerCase())
    if (hit) hit.run()
  })

  return (
    <Panel title={request.title}>
      {request.lines.map((line, i) => (
        <Text key={i} color={palette.muted}>
          {line}
        </Text>
      ))}
      {request.preview && request.preview.length > 0 && (
        <Box flexDirection="column" marginTop={1} marginBottom={1}>
          {request.preview.slice(0, PREVIEW_LIMIT).map((line, i) => (
            <Text
              key={i}
              color={line.startsWith('+') ? palette.success : line.startsWith('-') ? palette.failure : palette.muted}
            >
              {line}
            </Text>
          ))}
          {request.preview.length > PREVIEW_LIMIT && (
            <Text color={palette.muted}>… +{request.preview.length - PREVIEW_LIMIT} more lines</Text>
          )}
        </Box>
      )}

      {editing !== null ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={palette.muted}>Edit the command, then Enter to run it · Esc to go back</Text>
          <Text>
            <Text color={palette.accent}>$ </Text>
            {editing}
            <Text color={palette.muted}>▏</Text>
          </Text>
        </Box>
      ) : feedback !== null ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={palette.muted}>What should elia do instead? Enter to send · Esc to go back</Text>
          <Text>
            <Text color={palette.accent}>› </Text>
            {feedback}
            <Text color={palette.muted}>▏</Text>
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {choices.map((choice, i) => (
            <Text key={choice.key} inverse={i === cursor} color={choice.key === 'n' || choice.key === 'd' ? palette.muted : undefined}>
              {i === cursor ? '❯ ' : '  '}
              <Text color={palette.accent}>{choice.key}</Text> {choice.label}
            </Text>
          ))}
        </Box>
      )}
    </Panel>
  )
}

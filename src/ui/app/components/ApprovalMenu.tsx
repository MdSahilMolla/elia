import { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { glyphs, palette } from '../theme.ts'
import { Panel } from './Panel.tsx'
import { DiffPreview } from './DiffPreview.tsx'
import type { ApprovalResult } from '../../../autonomy/governor.ts'

export interface ApprovalRequest {
  title: string
  lines: string[]
  /** A diff / command / content preview, +/- coloured. */
  preview?: string[]
  /** What an "always allow" covers, e.g. "`git` commands" or "`edit_file`". */
  ruleLabel: string
  /** run_command only — enables "e" to edit the command before it runs. */
  command?: string
  /** `plan`: approving a whole run plan — yes / change it / no, and nothing to "always allow". */
  variant?: 'action' | 'plan'
  resolve(result: ApprovalResult): void
}

interface Choice {
  key: string
  label: string
  run(): void
}

const PREVIEW_LIMIT = 24

/**
 * The approval menu — the decision a person actually makes at this boundary,
 * in as few choices as it takes: yes, yes-and-stop-asking (this session or
 * this project), or no-and-here's-what-to-do-instead. Digits pick directly,
 * ↑/↓ + Enter work too, Esc is "no", and `e` edits a command before it runs.
 */
export function ApprovalMenu({ request }: { request: ApprovalRequest }) {
  const [editing, setEditing] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [cursor, setCursor] = useState(0)
  const plan = request.variant === 'plan'

  const choices: Choice[] = plan
    ? [
        { key: '1', label: 'Yes, run it', run: () => request.resolve({ approved: true }) },
        { key: '2', label: 'No, change something first — tell elia what', run: () => setFeedback('') },
      ]
    : [
        { key: '1', label: 'Yes', run: () => request.resolve({ approved: true }) },
        {
          key: '2',
          label: `Yes, and don't ask again for ${request.ruleLabel} this session`,
          run: () => request.resolve({ approved: true, remember: 'session' }),
        },
        {
          key: '3',
          label: `Yes, and always allow ${request.ruleLabel} in this project`,
          run: () => request.resolve({ approved: true, remember: 'project' }),
        },
        { key: '4', label: 'No, and tell elia what to do instead', run: () => setFeedback('') },
      ]

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
    if (key.escape || input.toLowerCase() === 'n') {
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
    if (input.toLowerCase() === 'e' && request.command !== undefined && !plan) {
      setEditing(request.command)
      return
    }
    const hit = choices.find((c) => c.key === input)
    if (hit) hit.run()
  })

  return (
    <Panel title={request.title} tone={plan ? 'plan' : 'permission'}>
      {request.preview && request.preview.length > 0 && <DiffPreview lines={request.preview} limit={PREVIEW_LIMIT} />}
      {request.lines.filter(Boolean).map((line, i) => (
        <Text key={i} color={palette.muted} wrap="wrap">
          {line}
        </Text>
      ))}

      {editing !== null ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color={palette.muted}>$ </Text>
            {editing}
            <Text inverse> </Text>
          </Text>
          <Text color={palette.muted}>enter to run this instead · esc to go back</Text>
        </Box>
      ) : feedback !== null ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text bold color={palette.selection}>{glyphs.user} </Text>
            {feedback || <Text color={palette.muted}>what should elia do instead?</Text>}
            <Text inverse> </Text>
          </Text>
          <Text color={palette.muted}>enter to send · esc to go back</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {choices.map((choice, i) => (
            <Text key={choice.key} bold={i === cursor} color={i === cursor ? palette.selection : palette.muted} wrap="truncate-end">
              {i === cursor ? `${glyphs.user} ` : '  '}
              {choice.key}. {choice.label}
            </Text>
          ))}
          <Box marginTop={1}>
            <Text color={palette.muted}>
              {'  '}esc to decline{request.command !== undefined && !plan ? ' · e to edit the command' : ''}
            </Text>
          </Box>
        </Box>
      )}
    </Panel>
  )
}

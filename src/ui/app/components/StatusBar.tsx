import { Box, Text } from 'ink'
import { palette } from '../theme.ts'
import { formatCostUsd, formatTokenCount } from '../../../usage.ts'

export type ReplMode = 'manual' | 'auto' | 'plan'

const MODE_LABEL: Record<ReplMode, string> = {
  manual: 'manual',
  auto: 'auto-accept',
  plan: 'plan',
}

function meter(pct: number): string {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * 10)
  return '▓'.repeat(filled) + '░'.repeat(10 - filled)
}

/** Keep the repo label from wrapping the HUD on a long branch name. */
function shortRepo(repo: string, max = 28): string {
  if (repo.length <= max) return repo
  return `…${repo.slice(-(max - 1))}`
}

export interface StatusBarProps {
  model: string
  mode: ReplMode
  contextTokens: number
  /**
   * Tokens of history allowed before compaction, for the model in use. Passed in
   * rather than read from a constant here: the budget is model-derived now (see
   * contextWindow.ts), and a meter filling against the wrong denominator would
   * read 100% on a model with most of its window still free.
   */
  contextLimit: number
  sessionInput: number
  sessionOutput: number
  costUsd: number | undefined
  /** Provider id — 'codex' switches the cost readout to "ChatGPT plan" since subscription turns aren't metered in dollars. */
  providerName?: string
  busy: boolean
  queued: number
  /** Operator messages waiting to be folded into the running turn. */
  steering?: number
  /** "elia ⎇ production" — cwd + branch. */
  repo?: string
}

/**
 * A conditional row above the stats line — renders only when a compaction pass
 * is close enough that the operator should know. Silent otherwise, so the HUD
 * stays a single line in the common case.
 */
function AlertLine({ pct }: { pct: number }) {
  if (pct < 80) return null
  return (
    <Text color={palette.warning} wrap="truncate-end">
      ⚠ context {pct}% full — a compaction pass is near
    </Text>
  )
}

export function StatusBar(props: StatusBarProps) {
  const pct = Math.min(100, Math.round((props.contextTokens / props.contextLimit) * 100))
  // The context meter earns attention as it fills — a compaction pass is coming.
  const meterColor = pct >= 85 ? palette.failure : pct >= 60 ? palette.accent : palette.success
  const cost = props.providerName === 'codex' ? 'ChatGPT plan' : formatCostUsd(props.costUsd)
  return (
    <Box flexDirection="column" marginTop={1}>
      <AlertLine pct={pct} />
      <Box justifyContent="space-between">
        {/* model · mode lead the line and truncate-end, so a long repo label can
            never wrap the line and split the `<model> · <mode>` fragment. */}
        <Text color={palette.muted} wrap="truncate-end">
          <Text color={palette.accent}>{props.busy ? '● ' : '  '}</Text>
          {props.model} · {MODE_LABEL[props.mode]}
          {props.steering ? <Text color={palette.accent}> · {props.steering} steering</Text> : null}
          {props.queued > 0 ? ` · ${props.queued} queued` : ''}
          {props.repo ? <Text color={palette.toolName}> · {shortRepo(props.repo)}</Text> : null}
        </Text>
        <Text color={palette.muted} wrap="truncate-end">
          <Text color={meterColor}>{meter(pct)}</Text> {pct}% ctx · {formatTokenCount(props.sessionInput)} in ·{' '}
          {formatTokenCount(props.sessionOutput)} out · {cost}
        </Text>
      </Box>
    </Box>
  )
}

import { Box, Text } from 'ink'
import { palette } from '../theme.ts'
import { COMPACTION_TOKEN_THRESHOLD } from '../../../compaction.ts'
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

export interface StatusBarProps {
  model: string
  mode: ReplMode
  contextTokens: number
  sessionInput: number
  sessionOutput: number
  costUsd: number | undefined
  busy: boolean
  queued: number
  /** Operator messages waiting to be folded into the running turn. */
  steering?: number
}

export function StatusBar(props: StatusBarProps) {
  const pct = Math.min(100, Math.round((props.contextTokens / COMPACTION_TOKEN_THRESHOLD) * 100))
  // The context meter earns attention as it fills — a compaction pass is coming.
  const meterColor = pct >= 85 ? palette.failure : pct >= 60 ? palette.accent : palette.success
  return (
    <Box>
      <Text color={palette.muted}>
        <Text color={palette.accent}>{props.busy ? '● ' : '  '}</Text>
        {props.model} · {MODE_LABEL[props.mode]} · <Text color={meterColor}>{meter(pct)}</Text> {pct}% ctx ·{' '}
        {formatTokenCount(props.sessionInput)} in · {formatTokenCount(props.sessionOutput)} out · {formatCostUsd(props.costUsd)}
        {props.steering ? <Text color={palette.accent}> · {props.steering} steering</Text> : ''}
        {props.queued > 0 ? ` · ${props.queued} queued` : ''}
      </Text>
    </Box>
  )
}

import { Box, Text } from 'ink'
import { glyphs, palette } from '../theme.ts'

/** `auto` is how elia always works; `plan` researches and proposes before changing anything. */
export type ReplMode = 'auto' | 'plan'

/**
 * The mode as the status row shows it. The default (manual: risky actions ask
 * first) says nothing — only a mode you switched into earns a label, the way a
 * lit indicator only means something when most of them are off.
 */
// Working autonomously says nothing; the row only names plan mode.
const MODE_LABEL: Record<ReplMode, string> = {
  auto: '',
  plan: `${glyphs.plan} plan mode on`,
}

/** Keep the repo label from crowding the row on a long branch name. */
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
  /** Kept for callers; token detail lives in /cost, not the status row. */
  sessionInput?: number
  sessionOutput?: number
  /** What the session has spent so far — shown once it is more than nothing. */
  costUsd?: number | undefined
  /** The session's spending limit, when there is one: "$0.012 of $1.00". */
  limitUsd?: number | undefined
  providerName?: string
  /**
   * `auto` when the session falls back across every ready provider. Shown next
   * to the model because they answer different questions: the model is what is
   * talking now, `auto` is that it may quietly move to another provider.
   */
  routing?: 'auto' | 'selected'
  busy: boolean
  queued: number
  /** Operator messages waiting to be folded into the running turn. */
  steering?: number
  /** "elia ⎇ production" — cwd + branch. */
  repo?: string
  /** Under 80 columns: drop the repo label, keep model · context. */
  narrow?: boolean
  /**
   * Set only for a session on elia's own source: whether it may change that
   * source. Only "on" is shown — like the mode, the default earns no label.
   */
  selfEdit?: boolean
}

/** Spend at a glance: tenths of a cent under a dollar, cents above. */
export function formatSpend(usd: number): string {
  if (usd < 0.001) return '<$0.001'
  return usd < 1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`
}

/** Context use only earns space once it is worth watching. */
export function contextPercent(tokens: number, limit: number): number {
  return limit > 0 ? Math.min(100, Math.round((tokens / limit) * 100)) : 0
}

/**
 * One quiet row under the input: the mode (only when it is not the default)
 * or the shortcut hint on the left; model, repo and — once it is filling up —
 * context on the right. Tokens and cost moved to /cost.
 */
export function StatusBar(props: StatusBarProps) {
  const pct = contextPercent(props.contextTokens, props.contextLimit)
  const modeLabel = MODE_LABEL[props.mode]
  const modeColor = props.mode === 'plan' ? palette.plan : palette.muted
  const ctxColor = pct >= 92 ? palette.failure : pct >= 80 ? palette.warning : palette.muted
  const spent = props.costUsd ?? 0
  const spendShare = props.limitUsd ? spent / props.limitUsd : 0
  const spendColor = spendShare >= 1 ? palette.failure : spendShare >= 0.8 ? palette.warning : palette.muted
  const extras = [
    props.queued > 0 ? `${props.queued} queued` : '',
    props.steering ? `${props.steering} steering` : '',
  ].filter(Boolean)

  return (
    <Box justifyContent="space-between" width="100%" paddingLeft={2}>
      <Box flexShrink={1}>
        <Text wrap="truncate-end">
          {modeLabel ? (
            <Text color={modeColor}>
              {modeLabel}
              <Text color={palette.muted}> (shift+tab to cycle)</Text>
            </Text>
          ) : (
            <Text color={palette.muted}>? for shortcuts</Text>
          )}
          {props.selfEdit ? <Text color={palette.warning}> · self-edit on</Text> : null}
          {extras.length > 0 ? <Text color={palette.muted}> · {extras.join(' · ')}</Text> : null}
        </Text>
      </Box>
      <Box flexShrink={1} marginLeft={2}>
        <Text color={palette.muted} wrap="truncate-start">
          {spent > 0 ? (
            <Text color={spendColor}>
              {formatSpend(spent)}
              {props.limitUsd ? ` of ${formatSpend(props.limitUsd)}` : ''}
              {' · '}
            </Text>
          ) : null}
          {props.model}
          {/* Model fallback, not a mode: "auto" here read as yet another autonomy switch. */}
          {props.routing === 'auto' ? ' + fallback' : ''}
          {props.repo && !props.narrow ? ` · ${shortRepo(props.repo)}` : ''}
          {pct >= 50 ? <Text color={ctxColor}> · {pct}% context{pct >= 80 ? ' — compaction soon' : ''}</Text> : null}
        </Text>
      </Box>
    </Box>
  )
}

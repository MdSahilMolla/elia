import { BATTMANN_SYSTEM_PROMPT, config, CYBER_SYSTEM_PROMPT, DEV_SYSTEM_PROMPT, FITNESS_SYSTEM_PROMPT, SPORTS_SYSTEM_PROMPT } from './config.ts'
import { runAgentLoop, type ConversationMessage, type RunAgentLoopResult, type ToolEvent } from './agentLoop.ts'
import type { Provider, ProviderActivity } from './providers/types.ts'
import { allWorkerTools, businessTools, cyberTools, getSynthesizedTools } from './tools/registry.ts'
import { taskTool } from './tools/task.ts'
import { previewTool } from './tools/preview.ts'
import { codexTool } from './tools/codex.ts'
import { writeProviderActivity, writeText, writeThinking, writeUsageLine } from './ui/stream.ts'
import { recordUsage, recordTopLevelTurn, formatUsageLine } from './usage.ts'
import { createToolResultCache } from './speculation/cache.ts'
import { createPrefetcher } from './speculation/prefetch.ts'
import { observeToolCall } from './skills/detector.ts'
import { setActiveMode, type AgentMode } from './autonomy/mode.ts'
import { getActiveLedgerSession, noteToolUse } from './ledger.ts'
import { loadBrainItems } from './brain/store.ts'
import { renderCards } from './brain/cards.ts'
import { noteBrainToolUse } from './brain/relevance.ts'
import { appendActionAudit } from './autonomy/audit.ts'
import { createActionGovernor, withActionGovernor, type ActionApproval, type GovernanceMode } from './autonomy/governor.ts'
import { loadDevelopmentToolHooks, withToolHooks } from './autonomy/devHooks.ts'
import { expandSkillSelection } from './skills/bundles.ts'
import { activeTodoList, type TodoList, withTodoList } from './autonomy/todoList.ts'
import { renderLessons } from './autonomy/lessons.ts'
import { renderRationale } from './autonomy/rationale.ts'
import { regretNudge, weakDomainCaution } from './autonomy/outcomes.ts'
import { renderSkillHint } from './skills/relevance.ts'

/** The most recent user message text — the query project memory is ranked against. */
function lastUserTextFor(messages: ConversationMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!
    if (message.role !== 'user') continue
    const text = message.content.filter((b) => b.type === 'text').map((b) => (b.type === 'text' ? b.text : '')).join(' ')
    if (text.trim()) return text
  }
  return ''
}

/** Bare paths mentioned in a prompt, e.g. "fix src/foo/bar.ts" — used to surface rationale anchored to those files. */
function filePathsIn(text: string): string[] {
  return [...text.matchAll(/[\w./-]+\.[a-z]{1,5}\b/gi)].map((m) => m[0]).slice(0, 8)
}

/** The second brain's per-file knowledge cards for the paths a turn is about. Never throws — a brain read must not break a turn. */
async function renderBrainCards(activePaths: string[]): Promise<string> {
  try {
    const items = await loadBrainItems({ currentSessionId: getActiveLedgerSession()?.id })
    return renderCards(items, activePaths)
  } catch {
    return ''
  }
}

export type { ConversationMessage }
export type { AgentMode }

// preview opens a real Chrome window — like task, that's a top-level-only
// capability; a silent sub-agent popping open browser windows would be surprising.
// The engagement/scan tools are top-level-only too, and further gated to cyber
// mode — a dev turn has no business scaffolding a security engagement.
function topLevelTools(mode: AgentMode, selectedSkillNames?: string[]) {
  const expandedSelection = expandSkillSelection(selectedSkillNames)
  const selected = new Set(expandedSelection ?? [])
  const synthesized = new Set(getSynthesizedTools().map((tool) => tool.name))
  const workerTools = allWorkerTools().filter((tool) => expandedSelection === undefined || !synthesized.has(tool.name) || selected.has(tool.name))
  // Battmann gets the research and reporting set: an intelligence brief
  // grounded only in the local filesystem would be fabrication by construction.
  return [
    ...workerTools,
    taskTool,
    previewTool,
    ...(mode === 'cyber' ? cyberTools : []),
    ...(mode === 'battmann' ? businessTools : []),
    // A silent sub-agent handing work off to a whole separate external agent
    // would be even more surprising than task/preview — dev mode only.
    ...(mode === 'dev' ? [codexTool] : []),
  ]
}

export interface RunTurnOptions {
  mode?: AgentMode
  onTool?: (event: ToolEvent) => void
  /** Fired when a tool call is dispatched, before it runs — for a live UI's pending card. */
  onToolStart?: (call: { id: string; name: string; input: Record<string, unknown> }) => void
  /** Plan mode: read-only tools only, and the model is told to propose a plan rather than act. */
  planMode?: boolean
  approveAction?: ActionApproval
  governanceMode?: GovernanceMode
  /** Names of synthesized skills explicitly selected for this turn; omitted means all loaded skills remain available. */
  skillNames?: string[]
  /** Cooperative cancellation for task-console shutdown and operator control. */
  signal?: AbortSignal
  /** Optional bridge callback for streamed assistant text. */
  onText?: (delta: string) => void
  /** Optional bridge callback for streamed reasoning. */
  onThinking?: (delta: string) => void
  /** Optional callback for plans, commands, edits, diffs, and provider status. */
  onActivity?: (activity: ProviderActivity) => void
  /** Conversation-scoped provider, used by multi-chat clients to keep agent threads isolated. */
  provider?: Provider
  providerName?: string
  model?: string
  /** Conversation-scoped working plan for simultaneous chat turns. */
  todoList?: TodoList
  /** Suppress terminal rendering and usage output for machine clients. */
  silent?: boolean
  /** Skip recordUsage/recordTopLevelTurn/the usage-line print — for a caller (e.g. the orchestrator delegating a lone 'tech' route) that aggregates and records stats itself exactly once. */
  skipStats?: boolean
}

export async function runTurn(
  messages: ConversationMessage[],
  options: RunTurnOptions = {},
): Promise<RunAgentLoopResult> {
  const todoList = options.todoList ?? activeTodoList()
  return withTodoList(todoList, () => runScopedTurn(messages, options))
}

async function runScopedTurn(
  messages: ConversationMessage[],
  options: RunTurnOptions,
): Promise<RunAgentLoopResult> {
  const startedAt = Date.now()
  const mode = options.mode ?? 'dev'
  // Ambient for the whole turn, including sub-agents dispatched via the task
  // tool arbitrarily deep in a tool call — see autonomy/mode.ts.
  setActiveMode(mode)
  const PLAN_MODE_TOOLS = new Set(['read_file', 'list_files', 'grep', 'web_search', 'web_fetch', 'todo_write'])
  const allTools = topLevelTools(mode, options.skillNames)
  const tools = options.planMode ? allTools.filter((tool) => PLAN_MODE_TOOLS.has(tool.name)) : allTools
  const baseSystemPrompt = mode === 'cyber'
    ? CYBER_SYSTEM_PROMPT
    : mode === 'sports'
      ? SPORTS_SYSTEM_PROMPT
      : mode === 'fitness'
        ? FITNESS_SYSTEM_PROMPT
        : mode === 'battmann'
          ? BATTMANN_SYSTEM_PROMPT
          : DEV_SYSTEM_PROMPT
  // Project memory: what earlier sessions learned, and why this codebase is
  // shaped the way it is, ranked against what this turn is about. This is the
  // compounding edge — the longer elia works a repo, the more it carries in.
  const turnQuery = lastUserTextFor(messages)
  const turnPaths = filePathsIn(turnQuery)
  // Knowledge cards: what every past session accumulated about the specific
  // files this turn is about to touch. Derived on read from the second brain;
  // empty (and free) until the brain has something anchored to those paths.
  const brainCards = mode === 'dev' && turnPaths.length > 0 ? await renderBrainCards(turnPaths) : ''
  const projectMemory = mode === 'dev'
    ? `${renderLessons()}${renderRationale(turnQuery, turnPaths)}${brainCards}${renderSkillHint(turnQuery)}${weakDomainCaution(turnQuery, turnPaths)}${regretNudge()}`
    : ''

  // The system prompt is split so prompt caching survives across user turns:
  // `systemPrompt` is stable for the whole session (base prompt + baked-in
  // memory + the static plan-mode instructions), while the query-ranked project
  // memory — which changes with every user message — rides in a separate
  // `systemDynamicPrompt` block that never invalidates the cached stable prefix.
  const systemPrompt = options.planMode
    ? `${baseSystemPrompt}\n\n# PLAN MODE\nYou are planning, not doing. Use only the read-only tools to investigate. Do NOT write files, run commands, or make any change. When you have enough understanding, stop and present a concrete plan: a short numbered list of the exact steps you would take (files to touch, what changes, how you would verify). Keep it tight. The user will approve, edit, or reject it before anything runs.`
    : baseSystemPrompt
  const systemDynamicPrompt = projectMemory.trim() ? projectMemory : undefined

  // One cache per turn rather than per session: the turn boundary is the point at
  // which the user may have edited files behind elia's back.
  const cache = createToolResultCache()
  const prefetcher = createPrefetcher({ tools, cache })

  const governor = createActionGovernor({
    mode: options.governanceMode ?? (options.approveAction ? 'supervised' : 'unattended'),
    approve: options.approveAction,
  })

  const hooks = mode === 'dev' ? loadDevelopmentToolHooks() : []
  const result = await withToolHooks(hooks, () => withActionGovernor(governor, () => runAgentLoop({
    messages,
    systemPrompt,
    systemDynamicPrompt,
    tools,
    provider: options.provider,
    providerName: options.providerName,
    model: options.model,
    onText: options.onText ?? writeText,
    onThinking: options.onThinking ?? writeThinking,
    onActivity: !options.silent || options.onActivity
      ? (activity) => {
          if (!options.silent) writeProviderActivity(activity)
          options.onActivity?.(activity)
        }
      : undefined,
    useAnimation: !options.silent,
    verbose: !options.silent,
    cache,
    prefetcher,
    signal: options.signal,
    onToolStart: options.onToolStart,
    onTool: (event) => {
      // Every call is a data point for deciding which tool elia should write itself next.
      appendActionAudit(event)
      observeToolCall(event.name, event.input)
      // And a data point for whether a recently recalled episode or brain hit actually mattered.
      noteToolUse(event.input)
      noteBrainToolUse(event.input)
      options.onTool?.(event)
    },
  })))
  const elapsedMs = Date.now() - startedAt

  if (!options.skipStats) {
    recordUsage(result.usage)
    recordTopLevelTurn(elapsedMs)
  }

  const hits = result.cacheStats?.hits ?? 0
  const prefetchNote = hits > 0 ? ` · ${hits} read${hits === 1 ? '' : 's'} prefetched` : ''
  if (!options.silent && !options.skipStats) writeUsageLine(`${config.providerLabel} · ${formatUsageLine(result.usage, elapsedMs, config.model)}${prefetchNote}`)

  return result
}

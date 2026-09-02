import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import { setInkSink } from '../stream.ts'
import type { SlashCommand } from '../slashPrompt.ts'
import { createTranscriptStore } from './store.ts'
import { useTranscript } from './useSyncStore.ts'
import { Transcript } from './components/Transcript.tsx'
import { StatusBar, type ReplMode } from './components/StatusBar.tsx'
import { InputBox } from './components/InputBox.tsx'
import { Confirm, type ConfirmRequest } from './components/Confirm.tsx'
import { Picker, type PickerRequest } from './components/Picker.tsx'
import { TextPrompt, type TextPromptRequest } from './components/TextPrompt.tsx'
import { WorkingIndicator } from './components/WorkingIndicator.tsx'
import { WorkspacePanel } from './components/WorkspacePanel.tsx'
import { HelpOverlay } from './components/HelpOverlay.tsx'
import { activeTodoList, type TodoItem } from '../../autonomy/todoList.ts'
import { taskSessions, type TaskSession } from '../../taskSessions.ts'
import type { PickerOption } from '../picker.ts'
import type { ToolItem } from './store.ts'
import { rollupLine, rollupTools } from './toolSummary.ts'
import { palette } from './theme.ts'
import { estimateTokens } from '../../compaction.ts'
import { sessionUsageSnapshot, estimateCostUsd } from '../../usage.ts'
import type { ChatMessage } from '../../providers/types.ts'

export interface TurnHooks {
  onText(delta: string): void
  onThinking(delta: string): void
  onActivity(activity: import('../../providers/types.ts').ProviderActivity): void
  onTool(event: import('../../agentLoop.ts').ToolEvent): void
  onToolStart(call: { id: string; name: string; input: Record<string, unknown> }): void
  approve(title: string, lines: string[], preview?: string[]): Promise<boolean>
  signal: AbortSignal
  planMode: boolean
  /** Drained by the agent loop at each step boundary — operator guidance typed mid-run. */
  drainSteering(): string[]
}

export interface SlashPickerRequest {
  title: string
  options: PickerOption[]
  searchable?: boolean
  initialIndex?: number
  /** Chosen value (or null on cancel). Return a line to show, or another outcome to chain a second picker. */
  onSelect(value: string | null): Promise<SlashOutcome | string | void> | SlashOutcome | string | void
}

export interface SlashPromptRequest {
  label: string
  placeholder?: string
  onSubmit(value: string): Promise<SlashOutcome | string | void> | SlashOutcome | string | void
}

export interface SlashRunRequest {
  command: string
  description: string
}

export interface SlashOutcome {
  handled: boolean
  text?: string
  picker?: SlashPickerRequest
  /** Ask the user to type a value (e.g. a marketplace search query). */
  prompt?: SlashPromptRequest
  /** Run a shell command after an explicit confirmation (install / uninstall). */
  runCommand?: SlashRunRequest
}

export interface AppEnv {
  model: string
  providerLabel: string
  providerName: string
}

export interface AppProps {
  sessionId?: string
  /** Live provider/model — read every render so a `/model` switch shows immediately. */
  getEnv(): AppEnv
  commands: SlashCommand[]
  initialReplMode: 'manual' | 'auto'
  messages: ChatMessage[]
  submitTurn(text: string, hooks: TurnHooks): Promise<void>
  runShellLine(command: string): Promise<string>
  classifyRisk(command: string): Promise<{ risky: boolean; reason?: string }>
  handleSlash(command: string): Promise<SlashOutcome>
  greeting: string
}

export function providerPlanItems(detail?: string): TodoItem[] {
  if (!detail) return []
  return detail.split(/\r?\n/).flatMap((line) => {
    const match = /^\[(done|active|pending)\]\s+(.+)$/.exec(line.trim())
    if (!match) return []
    const status = match[1] === 'done' ? 'completed' : match[1] === 'active' ? 'in_progress' : 'pending'
    return [{ content: match[2]!, status } as TodoItem]
  })
}

export function App(props: AppProps) {
  const { exit } = useApp()
  const store = useRef(createTranscriptStore()).current
  const snap = useTranscript(store)

  const [mode, setMode] = useState<ReplMode>(props.initialReplMode)
  const modeRef = useRef<ReplMode>(props.initialReplMode)
  useEffect(() => {
    modeRef.current = mode
  }, [mode])
  const [planReady, setPlanReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [picker, setPicker] = useState<PickerRequest | null>(null)
  const [textPrompt, setTextPrompt] = useState<TextPromptRequest | null>(null)
  const [expandedAll, setExpandedAll] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [steeringCount, setSteeringCount] = useState(0)
  const [queue, setQueue] = useState<string[]>([])
  const [status, setStatus] = useState('')
  const [turnStartedAt, setTurnStartedAt] = useState(0)
  const [plan, setPlan] = useState<TodoItem[]>([])
  const [providerPlan, setProviderPlan] = useState<TodoItem[]>([])
  const [agents, setAgents] = useState<TaskSession[]>(() => taskSessions.list())
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const queueRef = useRef<string[]>([])
  const steeringRef = useRef<string[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const lastUserText = useRef('')

  const MAX_QUEUE = 5
  const pushQueue = (text: string) => {
    const q = queueRef.current
    // Don't stack the same message — a frustrated double-send shouldn't run twice.
    if (q[q.length - 1] === text || lastUserText.current === text) {
      store.notice('(already queued — waiting for the current turn)')
      return
    }
    if (q.length >= MAX_QUEUE) {
      store.notice(`Queue is full (${MAX_QUEUE}). Press Esc to clear it, or wait.`)
      return
    }
    queueRef.current = [...q, text]
    setQueue(queueRef.current)
    store.notice(`⏎ queued (${queueRef.current.length})`)
  }
  const shiftQueue = (): string | undefined => {
    const [next, ...rest] = queueRef.current
    queueRef.current = rest
    setQueue(rest)
    return next
  }

  const usage = sessionUsageSnapshot()
  const env = props.getEnv()

  // Deep handlers (slash commands, provider fallback) still call writeNotice/
  // writeError. Route that text into the transcript instead of stdout while the
  // Ink frame owns the screen.
  useEffect(() => {
    setInkSink((kind, text) => {
      if (kind === 'error') store.error(text)
      else store.notice(text)
    })
    return () => setInkSink(undefined)
  }, [store])

  // Live subagent fleet — every `task`-tool sub-agent registers a task session.
  useEffect(() => taskSessions.subscribe(setAgents), [])

  const ctrlCAt = useRef(0)
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (busy) {
        abortRef.current?.abort()
        return
      }
      const now = Date.now()
      if (now - ctrlCAt.current < 1_000) exit()
      else {
        ctrlCAt.current = now
        store.notice('Press Ctrl+C again to exit.')
      }
      return
    }
    if (key.ctrl && input === 'o') setExpandedAll((v) => !v)
    if (key.escape) {
      if (queueRef.current.length > 0) {
        queueRef.current = []
        setQueue([])
        store.notice('Queue cleared.')
      }
      if (steeringRef.current.length > 0) {
        steeringRef.current = []
        setSteeringCount(0)
        store.notice('Pending steering cleared.')
      }
      if (busy) abortRef.current?.abort()
    }
    if (key.shift && key.tab) setMode((m) => (m === 'manual' ? 'auto' : m === 'auto' ? 'plan' : 'manual'))
  })

  const executePlan = useRef<(() => void) | null>(null)
  useInput((input, key) => {
    if (!planReady || busy) return
    if (key.return) {
      setPlanReady(false)
      setMode('manual')
      executePlan.current?.()
    } else if (key.escape || input === 'k') {
      setPlanReady(false)
    }
  })

  const runOne = useCallback(
    async (text: string) => {
      setBusy(true)
      setStatus('')
      setTurnStartedAt(Date.now())
      store.appendUser(text)
      lastUserText.current = text
      const controller = new AbortController()
      abortRef.current = controller
      const hooks: TurnHooks = {
        onText: (d) => {
          setStatus('')
          store.assistantDelta(d)
        },
        onThinking: (d) => {
          setStatus('Thinking')
          store.thinkingDelta(d)
        },
        onActivity: (a) => {
          setStatus(a.title)
          if (a.kind === 'plan') {
            const parsed = providerPlanItems(a.detail)
            if (parsed.length > 0) setProviderPlan(parsed)
          }
          store.activity(a)
        },
        onTool: (e) => {
          if (e.name === 'todo_write' && !e.isError) {
            setPlan(activeTodoList().read())
            setProviderPlan([])
          }
          if (e.name === 'preview' && !e.isError) {
            const url = /https?:\/\/[^\s)]+/.exec(e.result)?.[0]
            if (url) setPreviewUrl(url)
          }
          store.toolEnd(e)
        },
        onToolStart: (c) => {
          setStatus(`Running ${c.name}`)
          store.toolStart(c)
        },
        approve: (title, lines, preview) =>
          new Promise<boolean>((resolve) => setConfirm({ title, lines, preview, resolve: (ok) => { setConfirm(null); resolve(ok) } })),
        signal: controller.signal,
        planMode: modeRef.current === 'plan',
        drainSteering: () => {
          const pending = steeringRef.current
          steeringRef.current = []
          setSteeringCount(0)
          if (pending.length > 0) setStatus('Steering applied')
          return pending
        },
      }
      try {
        await props.submitTurn(text, hooks)
      } catch (error) {
        store.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        abortRef.current = null
        const tools = store.getSnapshot().live.filter((i): i is ToolItem => i.kind === 'tool')
        if (tools.length > 2) {
          const line = rollupLine(rollupTools(tools))
          if (line) store.notice(`⏺ ${line}`)
        }
        store.commit()
        setBusy(false)
        setStatus('')
        // A plan-mode turn just proposed — offer to run it.
        if (modeRef.current === 'plan') setPlanReady(true)
      }
    },
    [props, store],
  )
  executePlan.current = () => void runOne('Go ahead — execute the plan you just proposed. Make every change and verify it.')

  const onSubmit = useCallback(
    async (line: string) => {
      const trimmed = line.trim()
      if (!trimmed) return
      if (trimmed === 'exit' || trimmed === 'quit') {
        exit()
        return
      }
      if (busy) {
        // Slash commands and shell escapes can't be applied to a turn already in
        // flight — those still wait. Plain text becomes live steering: it's
        // spliced into the running turn at the next step boundary.
        if (trimmed.startsWith('/') || trimmed.startsWith('@') || trimmed.startsWith('!')) {
          pushQueue(trimmed)
          return
        }
        steeringRef.current = [...steeringRef.current, trimmed]
        setSteeringCount(steeringRef.current.length)
        store.notice(`↳ steering — elia will take this at the next step (${steeringRef.current.length})`)
        return
      }

      if (trimmed.startsWith('!')) {
        const command = trimmed.slice(1).trim()
        if (command) {
          const output = await props.runShellLine(command)
          store.shell(command, output)
          store.commit()
        }
        return
      }

      if (trimmed.startsWith('/') || trimmed.startsWith('@')) {
        let outcome: SlashOutcome | string | void = await props.handleSlash(trimmed)
        // An outcome step may chain another: a picker → another picker
        // (/model → provider → model), a category picker → a search prompt →
        // a results picker → a confirmed install.
        for (let guard = 0; guard < 10; guard += 1) {
          if (!outcome || typeof outcome === 'string' || !outcome.handled) break

          if (outcome.runCommand) {
            const { command, description }: SlashRunRequest = outcome.runCommand
            const ok = await new Promise<boolean>((resolve) =>
              setConfirm({ title: description, lines: [`Runs: ${command}`], resolve: (v) => { setConfirm(null); resolve(v) } }),
            )
            outcome = ok ? await props.runShellLine(command).then((out) => `${command}\n${out}`) : 'Cancelled.'
            continue
          }

          if (outcome.prompt) {
            const req: SlashPromptRequest = outcome.prompt
            const value = await new Promise<string | null>((resolve) =>
              setTextPrompt({ label: req.label, placeholder: req.placeholder, resolve: (v) => { setTextPrompt(null); resolve(v) } }),
            )
            outcome = value === null || value === '' ? undefined : await req.onSubmit(value)
            continue
          }

          if (outcome.picker) {
            const req: SlashPickerRequest = outcome.picker
            const value = await new Promise<string | null>((resolve) =>
              setPicker({
                title: req.title,
                options: req.options,
                searchable: req.searchable,
                initialIndex: req.initialIndex,
                resolve: (v) => { setPicker(null); resolve(v) },
              }),
            )
            outcome = await req.onSelect(value)
            continue
          }
          break
        }
        const finalText = typeof outcome === 'string' ? outcome : outcome?.text
        if (finalText) store.notice(finalText)
        store.commit()
        return
      }

      const ask = (title: string, lines: string[]) =>
        new Promise<boolean>((resolve) =>
          setConfirm({ title, lines: lines.filter(Boolean), resolve: (v) => { setConfirm(null); resolve(v) } }),
        )

      // Codex is a black-box agent that reads, edits, and runs commands in the
      // workspace on its own. Every hand-off gets a confirmation, regardless of
      // manual/auto — you're approving an autonomous run, not a single command.
      const live = props.getEnv()
      if (live.providerName === 'codex') {
        const ok = await ask('Hand this task to Codex?', [
          `${live.model} runs autonomously in this workspace — it can read, edit, and run commands.`,
          `Task: ${trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed}`,
        ])
        if (!ok) {
          store.notice('Skipped.')
          store.commit()
          return
        }
      } else if (mode === 'manual') {
        const { risky, reason } = await props.classifyRisk(trimmed)
        if (risky) {
          const ok = await ask('This looks risky', [reason ?? '', `About to: ${trimmed}`])
          if (!ok) {
            store.notice('Skipped.')
            store.commit()
            return
          }
        }
      }

      await runOne(trimmed)

      // Drain anything queued while that turn ran.
      for (let next = shiftQueue(); next !== undefined; next = shiftQueue()) {
        await runOne(next)
      }
    },
    [busy, mode, props, store, runOne, exit],
  )

  const contextTokens = useMemo(() => estimateTokens(props.messages), [props.messages, snap.version])
  const visiblePlan = plan.length > 0 ? plan : providerPlan

  return (
    <Box flexDirection="column">
      <Transcript committed={snap.committed} live={snap.live} expandedAll={expandedAll} />

      {snap.committed.length === 0 && snap.live.length === 0 && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={palette.muted} paddingX={1}>
          <Text color={palette.muted}>{props.greeting}</Text>
          <Box marginTop={1} flexDirection="column">
            <Text color={palette.muted}>Try:</Text>
            <Text color={palette.toolName}>  fix the failing test in src/</Text>
            <Text color={palette.toolName}>  add a --json flag to the export command and update the help text</Text>
            <Text color={palette.toolName}>  what does the autonomy governor actually block? walk me through it</Text>
          </Box>
          <Box marginTop={1}>
            <Text color={palette.muted}>? keys · / commands · Tab plan mode · type while it works to steer it</Text>
          </Box>
        </Box>
      )}

      <WorkspacePanel plan={visiblePlan} agents={agents} />
      {previewUrl && (
        <Box marginTop={1}>
          <Text color={palette.toolName}>▸ Preview </Text>
          <Text underline color={palette.accent}>
            {previewUrl}
          </Text>
          <Text color={palette.muted}> · live-reloading as files change</Text>
        </Box>
      )}
      {busy && !confirm && <WorkingIndicator startedAt={turnStartedAt} status={status} />}
      {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}
      {confirm && <Confirm request={confirm} />}
      {picker && <Picker request={picker} />}
      {textPrompt && <TextPrompt request={textPrompt} />}
      {planReady && !busy && (
        <Box borderStyle="round" borderColor={palette.success} paddingX={1} marginTop={1}>
          <Text>
            <Text color={palette.success} bold>
              Plan ready.
            </Text>{' '}
            <Text color={palette.success}>Enter</Text> to execute · <Text color={palette.muted}>Esc / k to keep planning</Text>
          </Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <StatusBar
          model={env.model}
          mode={mode}
          contextTokens={contextTokens}
          sessionInput={usage.usage.inputTokens + usage.usage.cacheReadTokens}
          sessionOutput={usage.usage.outputTokens}
          costUsd={estimateCostUsd(env.model, usage.usage)}
          busy={busy}
          queued={queue.length}
          steering={steeringCount}
        />
        <InputBox
          commands={props.commands}
          onTabEmpty={() => setMode((m) => (m === 'plan' ? 'manual' : 'plan'))}
          onHelp={() => setShowHelp(true)}
          disabled={confirm !== null || picker !== null || textPrompt !== null || planReady || showHelp}
          placeholder={
            busy
              ? 'working — type to steer elia now · / ! wait for the turn to finish · Esc to stop'
              : mode === 'plan'
                ? 'PLAN MODE — describe the task; elia researches & proposes, then you approve.  Tab to exit'
                : 'Ask elia…   Tab = plan mode · / commands · ! shell · Ctrl+C quit'
          }
          onSubmit={onSubmit}
          onInterrupt={() => {
            if (busy) abortRef.current?.abort()
            else exit()
          }}
          onEof={() => exit()}
        />
      </Box>
    </Box>
  )
}

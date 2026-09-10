import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import { setInkSink } from '../stream.ts'
import type { SlashCommand } from '../slashPrompt.ts'
import { createTranscriptStore } from './store.ts'
import { useTranscript } from './useSyncStore.ts'
import { Transcript } from './components/Transcript.tsx'
import { StatusBar, type ReplMode } from './components/StatusBar.tsx'
import { Banner } from './components/Banner.tsx'
import { InputBox } from './components/InputBox.tsx'
import { Confirm, type ConfirmRequest } from './components/Confirm.tsx'
import { ApprovalMenu, type ApprovalRequest } from './components/ApprovalMenu.tsx'
import type { ApprovalResult } from '../../autonomy/governor.ts'
import { Picker, type PickerRequest } from './components/Picker.tsx'
import { TextPrompt, type TextPromptRequest } from './components/TextPrompt.tsx'
import { WorkingIndicator } from './components/WorkingIndicator.tsx'
import { WorkspacePanel } from './components/WorkspacePanel.tsx'
import { HelpOverlay } from './components/HelpOverlay.tsx'
import { activeTodoList, type TodoItem } from '../../autonomy/todoList.ts'
import { loadLessons } from '../../autonomy/lessons.ts'
import { taskSessions, type TaskSession } from '../../taskSessions.ts'
import type { PickerOption } from '../picker.ts'
import type { ToolItem } from './store.ts'
import { rollupLine, rollupTools } from './toolSummary.ts'
import { palette } from './theme.ts'
import { repoLabel } from './gitInfo.ts'
import { estimateTokens } from '../../compaction.ts'
import { looksLikeImageAttachmentLine } from '../../attachments.ts'
import { compactionThresholdFor, contextWindowFor } from '../../contextWindow.ts'
import { sessionUsageSnapshot, estimateCostUsd } from '../../usage.ts'
import { codexContextTokens } from '../../providers/codexSubscription.ts'
import type { ChatMessage } from '../../providers/types.ts'

export interface TurnHooks {
  onText(delta: string): void
  onThinking(delta: string): void
  onActivity(activity: import('../../providers/types.ts').ProviderActivity): void
  onTool(event: import('../../agentLoop.ts').ToolEvent): void
  onToolStart(call: { id: string; name: string; input: Record<string, unknown> }): void
  approve(req: {
    title: string
    lines: string[]
    preview?: string[]
    /** What an "always allow" covers — e.g. "`git` commands". */
    ruleLabel: string
    /** run_command only — enables the "Edit command" option. */
    command?: string
  }): Promise<ApprovalResult>
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
  /** Submit a reusable workflow as the next governed model turn. */
  submitText?: string
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
  /** CLI version, for the startup banner. */
  version: string
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

/** Progress belongs in the single live status line; only durable outcomes enter scrollback. */
export function shouldPersistActivity(activity: import('../../providers/types.ts').ProviderActivity): boolean {
  return activity.status === 'completed' || activity.status === 'failed' || activity.status === 'warning' || activity.kind === 'warning'
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
  const busyRef = useRef(false)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [approval, setApproval] = useState<ApprovalRequest | null>(null)
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
  // When this REPL started — the fleet panel uses it to drop finished subagents
  // that belong to earlier sessions (loaded from .elia/tasks.json on startup).
  const sessionStartedAt = useRef(Date.now()).current
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const queueRef = useRef<string[]>([])
  const steeringRef = useRef<string[]>([])
  const abortRef = useRef<AbortController | null>(null)
  // Set when the user stops a turn with Esc/Ctrl+C — tells the post-turn drain
  // not to auto-send steering that was captured before the stop.
  const abortedRef = useRef(false)
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
      else if (busyRef.current) setStatus(text.split('\n', 1)[0] ?? '')
      else store.notice(text)
    })
    return () => setInkSink(undefined)
  }, [store])

  // Live subagent fleet — every `task`-tool sub-agent registers a task session.
  useEffect(() => taskSessions.subscribe(setAgents), [])

  const ctrlCAt = useRef(0)
  const escAt = useRef(0)
  const stopAt = useRef(0)
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      const now = Date.now()
      if (busy) {
        // First press asks the turn to stop. A second press within a few
        // seconds force-quits — the escape hatch when a running command is
        // ignoring the abort signal and `busy` never clears.
        if (abortedRef.current && now - ctrlCAt.current < 4_000) {
          exit()
          return
        }
        abortedRef.current = true
        abortRef.current?.abort()
        ctrlCAt.current = now
        store.notice('Stopping… if a command is still running, press Ctrl+C again to force-quit.')
        return
      }
      if (now - ctrlCAt.current < 1_000) exit()
      else {
        ctrlCAt.current = now
        store.notice('Press Ctrl+C again to exit.')
      }
      return
    }
    if (key.ctrl && input === 'o') setExpandedAll((v) => !v)
    // While the approval menu owns the screen, let it handle Esc (go back / no).
    if (approval) return
    if (key.escape) {
      // Staged, so one stray Esc never wipes work: a running turn stops first
      // (queued/steering messages are kept); then the queue; and pending
      // steering only drops on a deliberate double-tap.
      if (busy) {
        const now = Date.now()
        // "Turn stopped" was a lie when a shell command ignored the signal.
        // Say what's actually happening, and on a second Esc that still hasn't
        // taken, point at the force-quit.
        const stillStuck = abortedRef.current && now - stopAt.current < 4_000
        abortedRef.current = true
        abortRef.current?.abort()
        stopAt.current = now
        if (stillStuck) {
          store.notice('Still working — a running command may not be interruptible. Press Ctrl+C twice to force-quit.')
        } else if (steeringRef.current.length > 0 || queueRef.current.length > 0) {
          store.notice('Stopping the turn — queued & steering messages kept. Send anything to apply, or Esc again to drop them.')
        } else {
          store.notice('Stopping the turn…')
        }
        return
      }
      if (queueRef.current.length > 0) {
        queueRef.current = []
        setQueue([])
        store.notice('Queue cleared.')
        return
      }
      if (steeringRef.current.length > 0) {
        const now = Date.now()
        if (now - escAt.current < 2_000) {
          steeringRef.current = []
          setSteeringCount(0)
          store.notice('Pending steering dropped.')
        } else {
          escAt.current = now
          store.notice(`Press Esc again to drop ${steeringRef.current.length} pending steering message${steeringRef.current.length === 1 ? '' : 's'}.`)
        }
      }
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
    async (text: string, opts?: { echo?: boolean }) => {
      busyRef.current = true
      setBusy(true)
      setStatus('')
      abortedRef.current = false
      setTurnStartedAt(Date.now())
      // onSubmit echoes the message the instant Enter is pressed so it never
      // waits behind the risk check; the other callers (queue drain, plan
      // execution) still echo here.
      if (opts?.echo !== false) store.appendUser(text)
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
          // The turn runner offers a live preview after scaffolding a site
          // (including Codex-subscription turns, which never call the tool).
          // The dedicated Preview line renders it — don't also log it as activity.
          if (a.title === 'Preview ready' && a.detail && /^https?:\/\//.test(a.detail)) {
            setPreviewUrl(a.detail)
            return
          }
          if (shouldPersistActivity(a)) store.activity(a)
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
        approve: (req) =>
          new Promise<ApprovalResult>((resolve) =>
            setApproval({ ...req, resolve: (r) => { setApproval(null); resolve(r) } }),
          ),
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
        const tools = store.turnItems().filter((i): i is ToolItem => i.kind === 'tool')
        if (tools.length > 2) {
          const line = rollupLine(rollupTools(tools))
          if (line) store.notice(`⏺ ${line}`)
        }
        store.commit()
        busyRef.current = false
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
        // Don't stack the same steering twice — a frustrated re-send while the
        // current step is still running shouldn't get folded in N times.
        if (steeringRef.current.includes(trimmed) || lastUserText.current === trimmed) {
          store.notice('↳ steering already captured — it applies when the current step finishes')
          return
        }
        steeringRef.current = [...steeringRef.current, trimmed]
        setSteeringCount(steeringRef.current.length)
        store.notice(
          `↳ steering captured (${steeringRef.current.length}) — elia folds it in at the next step. `
            + 'A running task or Codex turn finishes first; Esc stops the turn.',
        )
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

      // A bare image path pasted or dragged into the line falls through to a
      // normal turn (where it's read, encoded, and stripped from the text) even
      // though a POSIX path starts with "/". "/attach" stays a real command.
      const isAttachCommand = /^\/(?:attach|image|img)\b/.test(trimmed)
      const routeAsImagePrompt = !isAttachCommand && looksLikeImageAttachmentLine(trimmed)

      if (!routeAsImagePrompt && (trimmed.startsWith('/') || trimmed.startsWith('@'))) {
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
        const submitText = typeof outcome === 'object' && outcome ? outcome.submitText : undefined
        const finalText = typeof outcome === 'string' ? outcome : outcome?.text
        if (finalText) store.notice(finalText)
        store.commit()
        if (submitText) await runOne(submitText)
        return
      }

      const ask = (title: string, lines: string[]) =>
        new Promise<boolean>((resolve) =>
          setConfirm({ title, lines: lines.filter(Boolean), resolve: (v) => { setConfirm(null); resolve(v) } }),
        )

      // Echo the message immediately — before the risk check — so pressing
      // Enter always feels instant, not gated on a fast-tier round-trip.
      store.appendUser(trimmed)
      lastUserText.current = trimmed

      // When the ChatGPT subscription is the selected model, running Codex in
      // the workspace is the whole point of that choice — it is confirmed once
      // per session by the agent loop's own governor prompt, not re-approved on
      // every message, and it skips the risky-prompt classifier (its prompts
      // expose no Elia tools for the classifier to reason about).
      const live = props.getEnv()
      if (live.providerName !== 'codex' && mode === 'manual') {
        setBusy(true)
        setTurnStartedAt(Date.now())
        setStatus('Checking whether this needs confirmation…')
        const { risky, reason } = await props.classifyRisk(trimmed).catch(() => ({ risky: true, reason: 'risk check failed — asking to be safe' }))
        if (risky) {
          setBusy(false)
          setStatus('')
          const ok = await ask('This looks risky', [reason ?? '', `About to: ${trimmed}`])
          if (!ok) {
            store.notice('Skipped.')
            store.commit()
            return
          }
        }
      }

      await runOne(trimmed, { echo: false })

      // Drain anything queued while that turn ran.
      for (let next = shiftQueue(); next !== undefined; next = shiftQueue()) {
        await runOne(next)
      }

      // Steering that landed in the gap after the loop's last fold-in check —
      // it was never applied. Send it as its own turn rather than silently
      // prepending it to whatever the user types next. Not after an Esc/Ctrl+C
      // stop: there the user chose to halt, so an auto follow-up isn't wanted.
      while (steeringRef.current.length > 0 && !abortedRef.current) {
        const pending = steeringRef.current.join('\n')
        steeringRef.current = []
        setSteeringCount(0)
        store.notice('↳ sending steering that arrived as the turn ended')
        await runOne(pending)
      }
    },
    [busy, mode, props, store, runOne, exit],
  )

  const repo = useMemo(() => repoLabel(), [])
  // What earlier runs taught elia about this project — surfaced once, on the
  // home screen, so the operator can see what's being carried in. See
  // docs/terminal-ui-redesign-plan.md WS4.
  const lessonCount = useMemo(() => {
    try {
      return loadLessons().length
    } catch {
      return 0
    }
  }, [])
  // In ChatGPT-subscription mode Elia's own `messages` array stays near-empty
  // (Codex keeps the real transcript in its thread), so meter against Codex's
  // reported prompt size and its model's real window instead.
  const isCodex = env.providerName === 'codex'
  const contextTokens = useMemo(
    () => (isCodex ? codexContextTokens() : estimateTokens(props.messages)),
    [isCodex, props.messages, snap.version, busy],
  )
  const contextLimit = useMemo(
    () => (isCodex ? contextWindowFor(env.model) : compactionThresholdFor(env.model)),
    [isCodex, env.model],
  )
  const visiblePlan = plan.length > 0 ? plan : providerPlan
  // An approval / confirm is a modal state: freeze the live panels behind it so
  // a background repaint can't corrupt the menu and the user sees only what the
  // decision is about. The transcript (append-only) and the menu itself stay.
  const modalOpen = confirm !== null || approval !== null || picker !== null || textPrompt !== null

  return (
    <Box flexDirection="column">
      <Transcript committed={snap.committed} live={snap.live} expandedAll={expandedAll} />

      {snap.committed.length === 0 && snap.live.length === 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Banner version={props.version} />
          <Box marginTop={1}>
            <Text color={palette.muted}>{props.greeting}</Text>
          </Box>
          {lessonCount > 0 && (
            <Text color={palette.accent}>
              ✦ carrying {lessonCount} lesson{lessonCount === 1 ? '' : 's'} from past runs here <Text color={palette.muted}>· /lessons</Text>
            </Text>
          )}
        </Box>
      )}

      {!modalOpen && <WorkspacePanel plan={visiblePlan} agents={agents} since={sessionStartedAt} sessionId={props.sessionId} />}
      {previewUrl && !modalOpen && (
        <Box marginTop={1}>
          <Text color={palette.toolName}>▸ Preview </Text>
          <Text underline color={palette.accent}>
            {previewUrl}
          </Text>
          <Text color={palette.muted}> · live-reloading as files change</Text>
        </Box>
      )}
      {busy && !modalOpen && <WorkingIndicator startedAt={turnStartedAt} status={status} steeringPending={steeringCount} />}
      {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}
      {confirm && <Confirm request={confirm} />}
      {approval && <ApprovalMenu request={approval} />}
      {picker && <Picker request={picker} />}
      {textPrompt && <TextPrompt request={textPrompt} />}
      {planReady && !busy && (
        <Box marginTop={1}>
          <Text>
            <Text color={palette.success} bold>
              ✓ Plan ready.
            </Text>{' '}
            <Text color={palette.success}>Enter</Text> to execute · <Text color={palette.muted}>Esc / k to keep planning</Text>
          </Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <InputBox
          commands={props.commands}
          mode={mode}
          onTabEmpty={() => setMode((m) => (m === 'plan' ? 'manual' : 'plan'))}
          onHelp={() => setShowHelp(true)}
          disabled={confirm !== null || approval !== null || picker !== null || textPrompt !== null || planReady || showHelp}
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
        <StatusBar
          model={env.model}
          mode={mode}
          contextTokens={contextTokens}
          contextLimit={contextLimit}
          sessionInput={usage.usage.inputTokens + usage.usage.cacheReadTokens}
          sessionOutput={usage.usage.outputTokens}
          costUsd={estimateCostUsd(env.model, usage.usage)}
          providerName={env.providerName}
          busy={busy}
          queued={queue.length}
          steering={steeringCount}
          repo={repo}
        />
      </Box>
    </Box>
  )
}

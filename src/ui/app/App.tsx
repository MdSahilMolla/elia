import { homedir } from 'node:os'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { setInkSink } from '../stream.ts'
import type { SlashCommand } from '../slashPrompt.ts'
import { createTranscriptStore, flareHoldMs, toolsOf, type TranscriptStore } from './store.ts'
import { useTranscript } from './useSyncStore.ts'
import { Transcript } from './components/Transcript.tsx'
import { useTerminalSize } from './useTerminalSize.ts'
import { clampLive, liveBudgetRows, liveCapEnabled } from './liveRegion.ts'
import { StatusBar, type ReplMode } from './components/StatusBar.tsx'
import { InputBox } from './components/InputBox.tsx'
import { FrameWidth } from './wrap.ts'
import { Confirm, type ConfirmRequest } from './components/Confirm.tsx'
import { ApprovalMenu, type ApprovalRequest } from './components/ApprovalMenu.tsx'
import type { ApprovalResult } from '../../autonomy/governor.ts'
import { Picker, type PickerRequest } from './components/Picker.tsx'
import { TextPrompt, type TextPromptRequest } from './components/TextPrompt.tsx'
import { WorkingIndicator, type TurnProgress } from './components/WorkingIndicator.tsx'
import { ClockProvider, motionReduced } from './animation.tsx'
import { RECEIPT_AFTER_MS, applyCheckEvent, charTokens, streamedTokens, tipFor, tipsEnabled, turnReceipt, turnVerb, workingLabel, type CheckChip, type CheckState } from './working.ts'
import { WorkspacePanel, runPlanFromWorkers, stepEvidenceKey, type RunStep, type StepProof } from './components/WorkspacePanel.tsx'
import { isInternalNudge } from './phases.ts'
import { HelpOverlay } from './components/HelpOverlay.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { activeTodoList, type TodoItem } from '../../autonomy/todoList.ts'
import { lessonKey, loadLessons } from '../../autonomy/lessons.ts'
import { lessonStanding, lessonTrials } from '../../autonomy/lessonEfficacy.ts'
import { selfEditGuard } from '../../autonomy/selfEdit.ts'
import { taskSessions, type TaskSession } from '../../taskSessions.ts'
import type { PickerOption } from '../picker.ts'
import { rollupLine, rollupTools, toolActivity } from './toolSummary.ts'
import { onThemeChange, palette } from './theme.ts'
import { repoLabel } from './gitInfo.ts'
import { estimateTokens } from '../../compaction.ts'
import { looksLikeImageAttachmentLine } from '../../attachments.ts'
import { compactionThresholdFor, contextWindowFor } from '../../contextWindow.ts'
import { codexContextTokens } from '../../providers/codexSubscription.ts'
import type { ChatMessage } from '../../providers/types.ts'
import { onLiveOutput, sessionUsageSnapshot } from '../../usage.ts'

export interface TurnHooks {
  onText(delta: string): void
  onThinking(delta: string): void
  onActivity(activity: import('../../providers/types.ts').ProviderActivity): void
  onTool(event: import('../../agentLoop.ts').ToolEvent): void
  onToolStart(call: { id: string; name: string; input: Record<string, unknown> }): void
  /** Each verification check as it queues, runs and lands. */
  onCheck?(event: { command: string; state: CheckState }): void
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
  /** An escalated run's approved steps — the plan panel ticks each off as its worker finishes. */
  onRunPlan?(steps: RunStep[]): void
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
  /** `/clear`: wipe the screen and transcript and continue as this new session. */
  clear?: { sessionId: string }
}

export interface AppEnv {
  model: string
  providerLabel: string
  providerName: string
  /**
   * `auto` when the session falls back across every ready provider. The model
   * below is still the one that answers first, so the row says both: "auto"
   * alone would hide which model is talking, and the model alone hid that the
   * session was on auto at all.
   */
  routing?: 'auto' | 'selected'
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
  /** Said once under the header — what a background practice run came to. */
  startupNotice?: string
}

/**
 * A plan activity's checklist: Codex's `[done]/[active]/[pending]` lines, or
 * elia's own up-front plan in the glyphs the plan panel itself draws.
 */
export function providerPlanItems(detail?: string): TodoItem[] {
  if (!detail) return []
  const STATUS: Record<string, TodoItem['status']> = { done: 'completed', active: 'in_progress', pending: 'pending', '✓': 'completed', '◐': 'in_progress', '□': 'pending' }
  return detail.split(/\r?\n/).flatMap((line) => {
    const match = /^(?:\[(done|active|pending)\]|([✓◐□]))\s+(.+)$/.exec(line.trim())
    if (!match) return []
    return [{ content: match[3]!, status: STATUS[match[1] ?? match[2]!]! }]
  })
}

/**
 * What the plan came to, said once in scrollback when the turn ends. The panel
 * is cleared after it: a plan left on screen once its turn is over is exactly
 * the "it never updated" the user sees, even when every step got done.
 */
export function planReceipt(items: TodoItem[]): string {
  const done = items.filter((item) => item.status === 'completed').length
  if (done === items.length) return `✓ Plan complete · ${done}/${items.length} steps`
  const open = items.filter((item) => item.status !== 'completed')
  return [
    `◐ Plan · ${done}/${items.length} done — still open:`,
    ...open.slice(0, 6).map((item) => `  □ ${item.content}`),
    ...(open.length > 6 ? [`  … ${open.length - 6} more`] : []),
  ].join('\n')
}

/**
 * Progress belongs in the single live status line; only durable outcomes enter
 * scrollback. A plan never does: its checklist lives in the live plan panel and
 * a receipt closes the turn — printing it into scrollback as well showed every
 * plan twice, the first copy flattened onto one line.
 */
export function shouldPersistActivity(activity: import('../../providers/types.ts').ProviderActivity): boolean {
  if (activity.kind === 'plan') return false
  return activity.status === 'completed' || activity.status === 'failed' || activity.status === 'warning' || activity.kind === 'warning'
}

export function App(props: AppProps) {
  const { exit } = useApp()
  const { write: writeStdout } = useStdout()
  const repo = useMemo(() => repoLabel(), [])
  // What earlier runs taught elia about this project — surfaced once, in the
  // header, so the operator can see what's being carried in. See
  // docs/terminal-ui-redesign-plan.md WS4.
  // Next to the count, what the randomized trials say about them — the one
  // number that separates a memory from a pile of notes.
  const lessonTally = useMemo(() => {
    try {
      const lessons = loadLessons()
      if (lessons.length === 0) return { count: 0, helps: 0, hurts: 0 }
      const standing = lessonStanding(lessons.map((lesson) => lesson.key ?? lessonKey(lesson.text)), lessonTrials())
      return { count: lessons.length, helps: standing.helps, hurts: standing.hurts }
    } catch {
      return { count: 0, helps: 0, hurts: 0 }
    }
  }, [])
  // Where this session runs — the status row already carries repo ⎇ branch.
  const location = useMemo(() => {
    const cwd = process.cwd()
    const home = homedir()
    return home && cwd.toLowerCase().startsWith(home.toLowerCase()) ? `~${cwd.slice(home.length)}` : cwd
  }, [])
  const printHeader = (target: TranscriptStore) => {
    const { model, providerLabel, routing } = props.getEnv()
    // "mercury (mercury-2.5)" → "mercury"; named only when the model's own name doesn't say it.
    const provider = (providerLabel ?? '').replace(/\s*\(.*\)\s*$/, '').trim()
    const named = provider && !model.toLowerCase().includes(provider.toLowerCase()) ? `${model} · ${provider}` : model
    target.header({
      version: props.version,
      greeting: props.greeting,
      location,
      lessons: lessonTally.count,
      lessonsHelp: lessonTally.helps,
      lessonsHurt: lessonTally.hurts,
      model: routing === 'auto' ? `auto · ${named}` : named,
    })
  }
  // The header is the first scrollback item — printed once through <Static>,
  // so it stays put at the top instead of vanishing (and re-flowing the frame)
  // the moment the first message is sent.
  const storeRef = useRef<TranscriptStore | null>(null)
  if (!storeRef.current) {
    storeRef.current = createTranscriptStore()
    printHeader(storeRef.current)
    if (props.startupNotice) storeRef.current.notice(props.startupNotice)
  }
  const store = storeRef.current
  const snap = useTranscript(store)
  // `/clear` moves the REPL onto a new session id; the fleet panel follows it.
  const [sessionId, setSessionId] = useState(props.sessionId)
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId
  // Bumped by `/clear` to remount <Static>: it tracks how many items it has
  // already printed, so an emptied-then-refilled list would otherwise skip the
  // first new items.
  const [transcriptEpoch, setTranscriptEpoch] = useState(0)

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
  // A completion menu takes the status row's place, as it does in the prompt it copies.
  const [inputMenuOpen, setInputMenuOpen] = useState(false)
  // `/theme` switches the palette in place; redraw the live frame in it.
  const [, setThemeEpoch] = useState(0)
  useEffect(() => onThemeChange(() => setThemeEpoch((n) => n + 1)), [])

  // WS0.7/0.8 — terminal geometry, and the live region trimmed to fit it.
  // Read once per mount: flipping the flag mid-session would change how the
  // frame is measured underneath a repaint that is already in flight.
  const termSize = useTerminalSize()
  const liveCapOn = useRef(liveCapEnabled()).current
  const clampedLive = useMemo(
    () =>
      liveCapOn
        ? clampLive(snap.live, {
            columns: termSize.columns,
            budgetRows: liveBudgetRows(termSize.rows),
            expanded: expandedAll,
          })
        : null,
    [liveCapOn, snap.live, termSize.columns, termSize.rows, expandedAll],
  )
  const [steeringCount, setSteeringCount] = useState(0)
  const [queue, setQueue] = useState<string[]>([])
  // The working line's inputs. `status` is the phase or progress a deeper
  // layer last reported; running tools and the stream mode outrank it.
  const [status, setStatus] = useState('')
  const [runningTools, setRunningTools] = useState<{ id: string; name: string; activity: string }[]>([])
  const [checks, setChecks] = useState<CheckChip[]>([])
  // Plan steps elia ticked on evidence this turn, and what proved each.
  const [planEvidence, setPlanEvidence] = useState<ReadonlyMap<string, StepProof>>(new Map())
  const [streamMode, setStreamMode] = useState<'thinking' | 'writing' | null>(null)
  // Tokens and the last sign of life change on every streamed chunk; the
  // indicator reads them each frame, so they live in a ref, not in state.
  const progress = useRef<TurnProgress>({ tokens: 0, lastAt: 0 })
  // What the turn has produced: `settled` is what finished model calls really
  // reported, `streamed` the estimate for the call still under way. Counting
  // only the text that reaches the screen leaves the line frozen through
  // everything elia writes but does not show — a minute of silent reasoning,
  // a large edit's arguments, a sub-agent's whole run.
  const produced = useRef({ settled: 0, streamed: 0 })
  // The shown count never walks backwards: an estimate that overshot the real
  // usage would otherwise make the line count down when the call settles.
  const countProduced = useCallback(() => {
    progress.current.tokens = Math.max(progress.current.tokens, produced.current.settled + produced.current.streamed)
  }, [])
  // Where the session's output stood when this turn began, so the closing
  // receipt reports the same span the working line counted.
  const outputBefore = useRef(0)
  /** A turn is starting — the line counts this one, not the last one's leftovers. */
  const beginProgress = useCallback((startedAt: number) => {
    produced.current = { settled: 0, streamed: 0 }
    progress.current = { tokens: 0, lastAt: startedAt }
    outputBefore.current = sessionUsageSnapshot().usage.outputTokens
  }, [])
  // When the risk pre-check has already put the working line up for a message,
  // the turn that follows inherits its clock and its count: one Enter press is
  // one line, not a count that climbs, drops to zero and starts over.
  const carriedTurnStart = useRef<number | undefined>(undefined)
  // Every model call under the turn reports what it produced as it lands — the
  // lead's own steps, a sub-agent's, an escalated run's. A finished call is
  // also a sign of life, however quiet it was.
  useEffect(
    () =>
      onLiveOutput((event) => {
        if (event.kind === 'settled') {
          produced.current.settled += event.outputTokens
          produced.current.streamed = 0
        } else {
          produced.current.streamed += charTokens(event.chars)
        }
        progress.current.lastAt = Date.now()
        countProduced()
      }),
    [countProduced],
  )
  const turnsRun = useRef(0)
  const [turnStartedAt, setTurnStartedAt] = useState(0)
  const [plan, setPlan] = useState<TodoItem[]>([])
  const [providerPlan, setProviderPlan] = useState<TodoItem[]>([])
  // An escalated run's approved steps; their status comes from the workers.
  // The ref is what the turn-end receipt reads: a passive effect syncing it
  // could still be pending when the turn's `finally` runs, which dropped the
  // receipt under load.
  const [runSteps, setRunSteps] = useState<RunStep[]>([])
  const runStepsRef = useRef<RunStep[]>([])
  // The plan as the running turn last showed it — read when the turn ends, after
  // its state updates may not have rendered yet.
  const turnPlan = useRef<TodoItem[]>([])
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
  // Claimed synchronously the instant a turn begins, before the first `await`
  // (the risk-check round-trip). `busy` is React state and lags a render behind
  // Ink's throttled reconciler, so without this a fast double-Enter — or an
  // Enter during the risk check — slips through and starts an overlapping run.
  const turnStartingRef = useRef(false)

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

  const env = props.getEnv()

  // Deep handlers (slash commands, provider fallback) still call writeNotice/
  // writeError. Route that text into the transcript instead of stdout while the
  // Ink frame owns the screen.
  useEffect(() => {
    setInkSink((kind, text) => {
      if (kind === 'error') store.error(text)
      // elia's notes to itself about the model ("told the model to stop
      // re-reading files") would only overwrite what is really happening.
      else if (isInternalNudge(text)) return
      // A tool line or progress title from a deep layer: the status row only.
      else if (kind === 'status') {
        if (busyRef.current) setStatus(text.split('\n', 1)[0] ?? '')
      }
      // Mid-turn, a one-liner is progress; a multi-line notice is content.
      else if (busyRef.current && !text.includes('\n')) setStatus(text)
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
    // Ink dispatches every keystroke to every mounted `useInput` hook, so
    // without this guard these two "global" shortcuts still fire underneath
    // an open modal/overlay — e.g. Shift+Tab meant to dismiss the help
    // overlay (HelpOverlay closes on any key) would also silently cycle the
    // agent mode in the background.
    const modalOrOverlayOpen = confirm !== null || approval !== null || picker !== null || textPrompt !== null || showHelp
    if (key.ctrl && input === 'o' && !modalOrOverlayOpen) setExpandedAll((v) => !v)
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
    if (key.shift && key.tab && !modalOrOverlayOpen) setMode((m) => (m === 'manual' ? 'auto' : m === 'auto' ? 'plan' : 'manual'))
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
      const carried = carriedTurnStart.current
      carriedTurnStart.current = undefined
      const startedAt = carried ?? Date.now()
      busyRef.current = true
      setBusy(true)
      setStatus('')
      setRunningTools([])
      setChecks([])
      setPlanEvidence(new Map())
      setStreamMode(null)
      if (carried === undefined) beginProgress(startedAt)
      abortedRef.current = false
      setTurnStartedAt(startedAt)
      // onSubmit echoes the message the instant Enter is pressed so it never
      // waits behind the risk check; the other callers (queue drain, plan
      // execution) still echo here.
      if (opts?.echo !== false) store.appendUser(text)
      lastUserText.current = text
      turnPlan.current = []
      const controller = new AbortController()
      abortRef.current = controller
      // Every streamed chunk and every tool boundary is a sign of life.
      const alive = (chunk = '') => {
        progress.current.lastAt = Date.now()
        if (!chunk) return
        produced.current.streamed += streamedTokens(chunk)
        countProduced()
      }
      const hooks: TurnHooks = {
        onText: (d) => {
          alive(d)
          setStatus('')
          setStreamMode('writing')
          store.assistantDelta(d)
        },
        onThinking: (d) => {
          alive(d)
          setStatus('')
          setStreamMode('thinking')
          store.thinkingDelta(d)
        },
        onActivity: (a) => {
          // Only what is still under way names the working line. A finished
          // step ("verified — tests pass") goes to the transcript instead, and
          // clears whatever it was the end of.
          const underway = a.status === undefined || a.status === 'started' || a.status === 'updated'
          if (a.kind !== 'plan' && !isInternalNudge(a.title)) setStatus(underway ? a.title.replace(/^◆\s*/, '') : '')
          if (a.kind === 'plan' && a.evidence && Object.keys(a.evidence).length > 0) {
            const at = Date.now()
            setPlanEvidence((known) => {
              const next = new Map(known)
              for (const [step, proof] of Object.entries(a.evidence!)) if (proof) next.set(stepEvidenceKey(step), { text: proof, at })
              return next
            })
          }
          if (a.kind === 'plan') {
            const parsed = providerPlanItems(a.detail)
            if (parsed.length > 0) {
              turnPlan.current = parsed
              setProviderPlan(parsed)
              // A fresh plan supersedes the last request's todo list, which
              // would otherwise keep the panel (plan wins over providerPlan).
              setPlan([])
            }
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
            turnPlan.current = activeTodoList().read()
            setPlan(turnPlan.current)
            setProviderPlan([])
          }
          if (e.name === 'preview' && !e.isError) {
            const url = /https?:\/\/[^\s)]+/.exec(e.result)?.[0]
            if (url) setPreviewUrl(url)
          }
          alive()
          setRunningTools((running) => {
            const index = e.id ? running.findIndex((tool) => tool.id === e.id) : running.findIndex((tool) => tool.name === e.name)
            return index === -1 ? running : [...running.slice(0, index), ...running.slice(index + 1)]
          })
          store.toolEnd(e)
        },
        onToolStart: (c) => {
          // The call's arguments were written by the model too.
          alive(JSON.stringify(c.input ?? {}))
          setStatus('')
          setStreamMode(null)
          setRunningTools((running) => [...running, { id: c.id, name: c.name, activity: toolActivity(c) }])
          store.toolStart(c)
        },
        onCheck: (event) => {
          alive()
          setChecks((chips) => applyCheckEvent(chips, event))
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
        onRunPlan: (steps) => {
          runStepsRef.current = steps
          setRunSteps(steps)
          setPlan([])
          setProviderPlan([])
        },
      }
      try {
        await props.submitTurn(text, hooks)
      } catch (error) {
        store.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        abortRef.current = null
        // A lesson that landed in the last moment of the turn is still
        // flaring; let it finish before the receipt pushes it into scrollback.
        // Well under a second, and only on a turn that learned something.
        const flareHold = motionReduced || abortedRef.current ? 0 : flareHoldMs(store.turnItems())
        if (flareHold > 0) await new Promise((resolve) => setTimeout(resolve, flareHold))
        // An escalated run's plan, read fresh from the workers as the turn ends.
        if (runStepsRef.current.length > 0) {
          turnPlan.current = runPlanFromWorkers(runStepsRef.current, taskSessions.list(), sessionIdRef.current)
          runStepsRef.current = []
        }
        // A plan-mode turn's plan is a proposal waiting on Enter — it stays up.
        if (turnPlan.current.length > 0 && modeRef.current !== 'plan') {
          store.notice(planReceipt(turnPlan.current))
          setPlan([])
          setProviderPlan([])
        }
        // The closing line: how long, what changed, how much was written. Real
        // usage when the provider reported it, the streamed estimate otherwise.
        const tools = toolsOf(store.turnItems())
        const elapsedMs = Date.now() - startedAt
        const rollup = tools.length > 2 || elapsedMs >= RECEIPT_AFTER_MS ? rollupLine(rollupTools(tools)) : ''
        if (elapsedMs >= RECEIPT_AFTER_MS || rollup) {
          const reported = sessionUsageSnapshot().usage.outputTokens - outputBefore.current
          store.receipt(turnReceipt({ elapsedMs, rollup, tokens: reported > 0 ? reported : Math.round(progress.current.tokens) }))
        }
        turnsRun.current += 1
        setRunSteps([])
        store.commit()
        busyRef.current = false
        setBusy(false)
        setStatus('')
        setRunningTools([])
        setChecks([])
        setStreamMode(null)
        // A plan-mode turn just proposed — offer to run it.
        if (modeRef.current === 'plan') setPlanReady(true)
      }
    },
    [props, store, beginProgress, countProduced],
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
      if (busy || busyRef.current || turnStartingRef.current) {
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

      // Claim the turn synchronously — covers the shell-escape and slash-
      // command branches below too, not just the "real turn" one: without
      // this, a second slash/shell submission fired while a slow one (e.g. a
      // network-hitting marketplace search) is still in flight races it
      // instead of being queued/steered by the busy-check above, and can
      // orphan the first request's still-pending picker/prompt/confirm
      // `resolve`. Reset in `finally` once all of the handling below —
      // whichever branch it takes — completes.
      turnStartingRef.current = true
      try {
        if (trimmed.startsWith('!')) {
          const command = trimmed.slice(1).trim()
          if (command) {
            try {
              const output = await props.runShellLine(command)
              store.shell(command, output)
              store.commit()
            } catch (error) {
              store.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
              store.commit()
            }
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
          const cleared = typeof outcome === 'object' && outcome ? outcome.clear : undefined
          if (cleared) {
            // Erase the screen and scrollback like a fresh launch — Ink repaints
            // its live frame underneath — then drop everything the old
            // conversation put in the transcript and panels.
            writeStdout('\x1b[2J\x1b[3J\x1b[H')
            store.reset()
            printHeader(store)
            setTranscriptEpoch((n) => n + 1)
            setPlan([])
            setProviderPlan([])
            setSessionId(cleared.sessionId)
            lastUserText.current = ''
          }
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
          const checkedAt = Date.now()
          setTurnStartedAt(checkedAt)
          // The working line is up from here, so the turn starts here too —
          // otherwise the pre-check sits under the last turn's leftover total
          // and the classifier's own tokens vanish when the turn proper begins.
          beginProgress(checkedAt)
          carriedTurnStart.current = checkedAt
          setStatus('Checking the request')
          // A pre-check that fails is not a verdict. In manual mode every risky
          // action is still put to you one at a time by the approval menu, so an
          // unreachable classifier lets a harmless message through instead of
          // greeting it with an error and a y/n prompt.
          const { risky, reason } = await props.classifyRisk(trimmed).catch(() => ({ risky: false, reason: undefined }))
          if (risky) {
            setBusy(false)
            setStatus('')
            const ok = await ask('This request looks risky', [reason ?? '', `About to: ${trimmed}`])
            if (!ok) {
              carriedTurnStart.current = undefined
              store.notice('Skipped.')
              store.commit()
              return
            }
          }
        }

        await runOne(trimmed, { echo: false })

        // Drain anything queued while that turn ran — but not after an Esc/
        // Ctrl+C stop: the UI just told the user queued items are kept and
        // need an explicit send ("Send anything to apply, or Esc again to
        // drop them"), so auto-running them here would contradict that. The
        // abort check runs *before* each shift (like the steering drain
        // below) so a stop doesn't silently pop-and-drop an item that was
        // never run.
        while (queueRef.current.length > 0 && !abortedRef.current) {
          const next = shiftQueue()
          if (next === undefined) break
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
      } finally {
        turnStartingRef.current = false
        // Nothing ran after the pre-check (an error, a declined risk prompt):
        // don't leave a stale start time for the next message to inherit.
        carriedTurnStart.current = undefined
      }
    },
    [busy, mode, props, store, runOne, exit, writeStdout, beginProgress],
  )

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
  // An escalated run's plan, ticked from its workers — the report sink never
  // carried step progress, so this panel used to show no plan at all there.
  const runPlan = useMemo(() => runPlanFromWorkers(runSteps, agents, sessionId), [runSteps, agents, sessionId])
  const visiblePlan = runPlan.length > 0 ? runPlan : plan.length > 0 ? plan : providerPlan
  // An approval / confirm is a modal state: freeze the live panels behind it so
  // a background repaint can't corrupt the menu and the user sees only what the
  // decision is about. The transcript (append-only) and the menu itself stay.
  const modalOpen = confirm !== null || approval !== null || picker !== null || textPrompt !== null

  // The working line: the most specific thing known about what elia is doing.
  const planStep = visiblePlan.find((item) => item.status === 'in_progress')?.content
  const workingText = workingLabel({
    runningTools: runningTools.map((tool) => tool.activity),
    // The chips name each check, so "Verifying — bunx tsc --noEmit, bun test"
    // only needs to say it is verifying (and where).
    // A check running with nothing else named is the work being verified —
    // not "Thinking it through", which is what the search path left it at.
    activity: checks.length > 0
      ? status.startsWith('Verifying') ? status.replace(/^(Verifying.*?) — .*$/, '$1') : checks.some((chip) => chip.state === 'running') ? 'Verifying' : status
      : status,
    thinking: streamMode === 'thinking',
    writing: streamMode === 'writing',
    planStep,
    verb: turnVerb(Math.floor(turnStartedAt / 1000)),
  })
  // A tip only when nothing else is sitting above the line.
  const workersLive = agents.some(
    (agent) => agent.role !== undefined && agent.role !== 'lead' && (agent.status === 'running' || agent.status === 'pending') && (!sessionId || agent.sessionId === sessionId),
  )
  const tip = tipsEnabled() && visiblePlan.length === 0 && !workersLive ? tipFor(turnsRun.current) : undefined

  // A render throw anywhere below used to kill the whole Ink tree and drop the
  // user to a bare shell mid-turn (Devin audit #1). Boundaries keep the rest of
  // the frame — crucially the input — alive, and log what broke to scrollback.
  const boundaryError = useCallback((error: Error, area: string) => {
    store.error(`UI: the ${area} failed to render — ${error.message}`)
  }, [store])

  // Never let a row reach the terminal's last column. A line that fills it
  // exactly leaves the cursor in the "pending wrap" state, which Windows
  // consoles resolve differently from how Ink counts rows — the next repaint
  // then erases one row too few and the frame smears into scrollback.
  const frameWidth = Math.max(20, termSize.columns - 1)

  return (
    <ClockProvider>
    <FrameWidth.Provider value={frameWidth}>
    <Box flexDirection="column" width={frameWidth}>
      <ErrorBoundary area="transcript" onError={boundaryError}>
        <Transcript
          key={transcriptEpoch}
          committed={snap.committed}
          live={clampedLive?.items ?? snap.live}
          hiddenRows={clampedLive?.hiddenRows ?? 0}
          expandedAll={expandedAll}
          width={frameWidth}
        />
      </ErrorBoundary>

      {/* The plan and the workers are "right now" — once the turn is over the
          receipt in scrollback is the record, and a leftover "3 workers · 3
          done" parked above the input only competes with it. */}
      {!modalOpen && (busy || planReady || visiblePlan.length > 0) && (
        <ErrorBoundary area="workspace panel" onError={boundaryError}>
          <WorkspacePanel plan={visiblePlan} agents={agents} since={sessionStartedAt} sessionId={sessionId} expanded={expandedAll} evidence={planEvidence} />
        </ErrorBoundary>
      )}
      {previewUrl && !modalOpen && (
        <Box marginTop={1}>
          <Text wrap="truncate-end">
            <Text color={palette.muted}>Preview </Text>
            <Text underline color={palette.code}>
              {previewUrl}
            </Text>
            <Text color={palette.muted}> · reloads as files change</Text>
          </Text>
        </Box>
      )}
      {busy && !modalOpen && (
        <WorkingIndicator
          startedAt={turnStartedAt}
          label={workingText}
          progress={progress}
          thinking={streamMode === 'thinking'}
          waitingOnModel={runningTools.length === 0 && !checks.some((chip) => chip.state === 'running')}
          steeringPending={steeringCount}
          tip={tip}
          checks={checks}
        />
      )}
      {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}
      {confirm && <Confirm request={confirm} />}
      {approval && <ApprovalMenu request={approval} />}
      {picker && <Picker request={picker} />}
      {textPrompt && <TextPrompt request={textPrompt} />}
      {planReady && !busy && (
        <Box marginTop={1}>
          <Text>
            <Text color={palette.plan}>● </Text>
            <Text bold>Plan ready</Text>
            <Text color={palette.muted}> — enter to run it · esc to keep planning</Text>
          </Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <ErrorBoundary area="input box" onError={boundaryError}>
        <InputBox
          commands={props.commands}
          mode={mode}
          onTabEmpty={() => setMode((m) => (m === 'plan' ? 'manual' : 'plan'))}
          onHelp={() => setShowHelp(true)}
          onMenuChange={setInputMenuOpen}
          disabled={confirm !== null || approval !== null || picker !== null || textPrompt !== null || planReady || showHelp}
          placeholder={
            busy
              ? 'Type to steer elia · esc to stop'
              : mode === 'plan'
                ? 'Describe the task — elia will research and propose a plan first'
                : 'Ask anything, or type / for commands'
          }
          onSubmit={onSubmit}
          onInterrupt={() => {
            if (busy) abortRef.current?.abort()
            else exit()
          }}
          onEof={() => exit()}
        />
        </ErrorBoundary>
        {!inputMenuOpen && (
        <ErrorBoundary area="status bar" onError={boundaryError}>
          <StatusBar
            model={env.model}
            mode={mode}
            contextTokens={contextTokens}
            contextLimit={contextLimit}
            providerName={env.providerName}
            routing={env.routing}
            busy={busy}
            queued={queue.length}
            steering={steeringCount}
            repo={repo}
            narrow={termSize.narrow}
            selfEdit={selfEditGuard()?.allowed}
          />
        </ErrorBoundary>
        )}
      </Box>
    </Box>
    </FrameWidth.Provider>
    </ClockProvider>
  )
}

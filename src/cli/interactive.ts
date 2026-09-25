/**
 * The interactive session — `elia` with no subcommand.
 *
 * This was 2,811 lines of index.ts, 60% of a file that exported nothing, so
 * the REPL could not be read, tested or imported apart from the dispatcher
 * that launches it. It moves in one piece: after the shared helpers went to
 * `runtime.ts` it referenced nothing else in index.ts's module scope, which is
 * what made the lift safe to do at all.
 */
import * as pathModule from 'node:path'
import type { ConversationMessage, AgentMode } from '../agent.ts'
import { writeNotice, writeError, writeUsageLine } from '../ui/stream.ts'
import { sessionTranscript, transcriptFromMessages, withSessionTranscript } from '../ui/transcript.ts'
import { colorizeDiffBlock } from '../ui/render.ts'
import { approvalPreviewLines } from '../ui/approvalPreview.ts'
import { ruleFor, ruleLabel } from '../autonomy/allowStore.ts'
import { lastAssistantText } from '../agentLoop.ts'
import { setProcessProvenance, eliaVersion } from '../provenance.ts'
import { consumeLastPreviewedUrl } from '../tools/preview.ts'
import type { SlashOutcome as InkSlashOutcome } from '../ui/app/index.tsx'
import type { PackageKind } from '../marketplace/registry.ts'
import { playIntro } from '../ui/character.ts'
import { ZERO_USAGE, addUsage, getSessionSummaryLine, sessionUsageSnapshot, setCurrentUsageModel, type SessionUsageSnapshot } from '../usage.ts'
import { createSlashPrompt } from '../ui/slashPrompt.ts'
import { resolveCustomCommand } from '../commands/loader.ts'
import { collectPromptInjects, fireLifecycleEvent } from '../autonomy/lifecycleHooks.ts'
import { confirmOnce } from '../ui/confirm.ts'
import { gold, dim } from '../ui/theme.ts'
import { box, table } from '../ui/layout.ts'
import { pick } from '../ui/picker.ts'
import { formatQuickchatResult } from '../quickchat/present.ts'
import type { ParsedQuickchatCommand } from '../quickchat/quickchat.ts'
import type { SessionHandle } from '../session/types.ts'
import { openTaskDashboard, renderTaskSummary } from '../ui/taskDashboard.ts'
import { inferTaskKind, taskSessions } from '../taskSessions.ts'
import { isAgentPersona, type AgentPersona } from '../agents/types.ts'
import { CAPABILITIES } from '../capabilities.ts'
import { type ActionApproval } from '../autonomy/governor.ts'
import { routeTurn } from '../autonomy/escalation.ts'
import { emitEvent, interactiveTerminal, machineReadable, plainOutput, quietOutput } from '../ui/runtime.ts'
import { renderWorkspacePanel } from '../ui/workspacePanel.ts'
import { registerShutdownCleanup } from '../ui/shutdown.ts'
import { redactText } from '../ui/redact.ts'
import { writeUserConfig } from '../userConfig.ts'
import { removeProviderConfiguration, savedProviderNames } from '../providerSettings.ts'
import { flagValue, hasFlag, positionals } from './argv.ts'
import { ensureFirstRunProviderSetup, interactiveProviderSetup, prewarmActiveProvider, runCodexLogin } from './providerSetup.ts'
import { actionApprovalPrompt, allSlashCommands, approvalTitle, classifyCommandRisk, loadRuntimeSkills, printTurnProfileReport, requestedAgentMode, userMessage, warnIfAtFilesystemRoot } from './runtime.ts'
import type { ProviderActivity } from '../providers/types.ts'
import { type ToolEvent } from '../agentLoop.ts'

interface TurnUiHooks {
  onText?: (delta: string) => void
  onThinking?: (delta: string) => void
  onActivity?: (activity: ProviderActivity) => void
  onTool?: (event: ToolEvent) => void
  onToolStart?: (call: { id: string; name: string; input: Record<string, unknown> }) => void
  /** Each verification check as it queues, runs and lands — the working line shows them. */
  onCheck?: (event: import('../autonomy/verify.ts').CheckEvent) => void
  /** External cancellation (the Ink app's Esc handler). */
  signal?: AbortSignal
  /** Read-only "propose a plan first" turn. */
  planMode?: boolean
  /** Mid-run steering: drained at each step boundary and spliced into the turn. */
  drainSteering?: () => string[]
  /** Ink approval menu — used for the plan gate when a turn escalates into the autonomous pipeline. */
  approve?: (req: { title: string; lines: string[]; preview?: string[]; ruleLabel: string; variant?: 'action' | 'plan' }) => Promise<import('../autonomy/governor.ts').ApprovalResult>
  /** An escalated run's approved plan — the Ink plan panel tracks its steps. */
  onRunPlan?: (steps: { id: string; title: string }[]) => void
}

export async function runInteractive(): Promise<void> {
  const continueFlag = hasFlag('--continue', '-c')
  // `--resume` on its own offers the list; `--resume <id>` (or an unambiguous
  // prefix) goes straight there. Resolved before anything else starts, because
  // an unresolvable one should fail here rather than after the provider check,
  // the MCP handshake and the intro animation.
  let resumeId: string | undefined
  let resumeHeldByPid: number | undefined
  if (hasFlag('--resume') || flagValue('--resume') !== undefined) {
    const { chooseSessionToResume } = await import('./sessions.ts')
    const target = await chooseSessionToResume(flagValue('--resume'))
    if (!target) {
      process.exitCode = 1
      return
    }
    resumeId = target.id
    resumeHeldByPid = target.heldByPid
  }

  // Start connecting to MCP servers now, before the first-run check, the intro
  // animation, and session loading — every stdio server spawns a child process
  // and does a JSON-RPC handshake, and awaiting that serially was dead air on
  // the REPL. loadRuntimeSkills() below awaits the same in-flight pass, by which
  // point it has been running concurrently with all of the above.
  void (await import('../mcp/registry.ts')).beginMcpLoad()

  if (!(await ensureFirstRunProviderSetup({ interactive: true }))) return
  warnIfAtFilesystemRoot()
  // The live REPL routes late notices into the transcript (setInkSink), so MCP
  // can finish connecting in the background instead of gating the prompt.
  await loadRuntimeSkills({ deferMcp: interactiveTerminal })
  const { runTurn } = await import('../agent.ts')
  const { config, describeThinking, describeReviewers, getThinking, switchModel } = await import('../config.ts')
  setCurrentUsageModel(config.model)
  const { PROVIDER_PRESET_NAMES, isProviderPresetConfigured, providerPresetDefaultModel, providerReadiness, listProviderModels } = await import('../providers/registry.ts')
  const { detectOllama } = await import('../providers/ollama.ts')
  /** The picker's right-hand column for a provider: readiness, then its default model. */
  const providerDetail = (name: string) => `${providerReadiness(name)} · ${providerPresetDefaultModel(name) ?? (name === 'ollama' ? 'models on this machine' : 'custom')}`
  const { newSessionId, loadSession, loadLatestSession, saveSession } = await import('../session.ts')
  const { createFileTracker, setActiveTracker, loadCheckpoints, saveCheckpoints, restoreCheckpoint, renderCheckpointList, snapshotMessages, messagesForRestore } =
    await import('../checkpoint.ts')
  const { setActiveLedgerSession, countEpisodes } = await import('../ledger.ts')
  const { renderContextStatus, estimateTokens } = await import('../compaction.ts')
  const { compactionThresholdFor, contextWindowFor, contextWindowOverride } = await import('../contextWindow.ts')
  const { writeSessionHeartbeat, writeSessionEnded } = await import('../sessionRegistry.ts')

  const oneShotPrompt = positionals(['--resume', '--beta']).join(' ').trim()

  let mode: AgentMode = requestedAgentMode()

  let persona: AgentPersona | undefined
  let selectedSkillNames: string[] | undefined

  const renderTeamStatus = (): string => {
    const roles = Object.entries(config.roleOverrides).flatMap(([role, route]) => route ? [`${role.padEnd(13)} ${route.providerName}/${route.model}`] : [])
    return [
      `deep          ${config.tiers.deep.providerName}/${config.tiers.deep.model}`,
      `fast          ${config.tiers.fast.providerName}/${config.tiers.fast.model}${config.cascadeEnabled ? '' : ' (same as deep)'}`,
      ...(roles.length > 0 ? ['', 'role routes', ...roles] : ['', 'role routes   none configured; roles use their fast/deep tier']),
      '',
      describeReviewers(),
      'Independent dependency-wave workers run concurrently; shared-provider capacity is bounded and file collisions are serialized.',
    ].join('\n')
  }
  let messages: ConversationMessage[] = []
  let sessionId = newSessionId()
  // Every commit this session makes carries the run that wrote it
  // (provenance.ts). One CLI process is one session, so this is set once
  // instead of wrapping the whole loop in a scope.
  setProcessProvenance({ sessionId, surface: 'interactive', model: config.model, version: eliaVersion() })
  let priorUsage: SessionUsageSnapshot = { usage: ZERO_USAGE, turns: 0, elapsedMs: 0 }
  /** Where the current conversation begins in this process's own usage counters — see cumulativeSessionUsage. */
  let usageBaseline: SessionUsageSnapshot = { usage: ZERO_USAGE, turns: 0, elapsedMs: 0 }
  // manual (default): a cheap risk check runs before each command — only
  // commands flagged risky (deletes, sends, spend, publishing, system
  // changes, ...) get an "About to: ... run it?" prompt; everything else just
  // runs. auto (--yolo, or "/settings" → Risk checks): skips the pre-flight prompt while the
  // shared governor still blocks or requests approval for critical actions.
  // Safe and reversible work runs end to end without interruption.
  let replMode: 'manual' | 'auto' = hasFlag('--yolo', '-y') ? 'auto' : 'manual'
  // After a turn that changed code, run the project's own checks and repair any
  // failure before reporting done. On by default; --no-verify or /verify off.
  let autoVerify = !hasFlag('--no-verify')
  // When the first line of a request reads as a whole new project ("build me an
  // end-to-end X"), route it through the autonomous pipeline — plan, parallel
  // workers, adversarial review, verify, repair — instead of letting the plain
  // turn wing a twenty-file scaffold. On by default in dev mode; --no-escalate
  // or /auto off. Targeted edits and questions always stay on the fast path.
  let autoEscalate = !hasFlag('--no-escalate')
  // Answer work that has something executable to check by trying it several
  // different ways at once — each in its own worktree — and keeping the one a
  // real check passes, instead of committing to whichever line of attack the
  // model happened to open with. See src/reason/. The library decides how wide
  // to go per kind of work and starts at a single attempt, so this costs what a
  // plain turn costs until it has evidence that going wider pays. On by
  // default; --no-search or /search off.
  let reasonSearch = !hasFlag('--no-search')
  // Started inside elia's own checkout, a session asks before it changes elia —
  // see autonomy/selfEdit.ts. --self, ELIA_SELF_EDIT=1, or /self on skip the
  // question. Anywhere else this arms nothing.
  const selfEdit = await import('../autonomy/selfEdit.ts')
  selfEdit.armSelfEditGuard(process.cwd(), hasFlag('--self') || selfEdit.selfEditFromEnv())
  // Output from `!cmd` lines, held until the next real prompt so the model sees
  // what the user just ran without an extra round-trip.
  const carriedShellContext: string[] = []
  // Images queued by `/attach <path>`, folded into the next prompt as `image`
  // content blocks. Inline paths pasted/dragged straight into a prompt line are
  // resolved separately, in runRecordedTurn.
  const pendingAttachments: import('../attachments.ts').ImageAttachment[] = []

  if (continueFlag || resumeId) {
    const loaded = resumeId ? await loadSession(resumeId) : await loadLatestSession()
    if (loaded) {
      messages = loaded.messages
      sessionId = loaded.id
      sessionTranscript.restore(loaded.recording ?? transcriptFromMessages(loaded.messages))
      if (!loaded.recording) sessionTranscript.notice('Legacy session: only previously retained messages are available; earlier discarded activity cannot be recovered.')
      if (loaded.usage) priorUsage = loaded.usage

      // Both processes save the whole conversation after every turn, so the
      // second one to write wins and the other's turns are gone. Continue from
      // the same history under a new id instead: nothing is lost on either side,
      // and the one still running keeps its own file.
      const holder = resumeHeldByPid ?? (continueFlag ? (await import('../sessionCatalog.ts')).sessionHolder(loaded.id)?.pid : undefined)
      if (holder !== undefined) {
        const copyOf = loaded.id
        sessionId = newSessionId()
        priorUsage = { usage: ZERO_USAGE, turns: 0, elapsedMs: 0 }
        writeNotice(
          `Session ${copyOf} is open in another elia (pid ${holder}), so this one continues its ${messages.length} messages as a separate session ${sessionId}. ` +
            'Both keep their own history; neither overwrites the other.',
        )
      } else {
        writeNotice(`Resumed session ${sessionId} (${messages.length} messages)`)
      }

      if (loaded.providerName && (loaded.providerName !== config.providerName || loaded.model !== config.model)) {
        writeNotice(
          `This session was created on ${loaded.providerName} (${loaded.model ?? 'unknown model'}); ` +
            `it is now resuming on ${config.providerLabel}.`,
        )
      }
    } else {
      writeNotice(
        resumeId ? `No session found with id "${resumeId}" — starting fresh.` : 'No previous session found — starting fresh.',
      )
    }
  }

  const checkpoints = await loadCheckpoints(sessionId)
  const sessionStartedAt = Date.now()
  // From here on, every task session (interactive turns, escalated autonomous
  // workers, `task`-tool sub-agents) is stamped with this id. The live fleet
  // panel shows only workers carrying it — tasks reloaded from a previous
  // process keep their old id and stay in history where they belong.
  taskSessions.setActiveSession(sessionId)

  // Opportunistically tidy the cross-session brain: merge duplicate lessons and
  // drop stale ones so every future prompt isn't paying to carry them. Fire and
  // forget — it is one cheap fast-tier call, gated to run at most once a day and
  // only once there is enough to be worth it, and a failure changes nothing.
  if (mode === 'dev') {
    void import('../brain/consolidate.ts')
      .then(({ consolidateBrain }) => consolidateBrain())
      .catch(() => {})
  }

  /**
   * Lets every other elia process running in this project see this one's
   * live status via sessionRegistry.ts (`/sessions`) — separate from and in
   * addition to taskSessions.ts's own in-process dashboard (`/task`).
   */
  function sessionStatus(busy: boolean, lastAction: string) {
    return {
      sessionId,
      pid: process.pid,
      mode: persona ?? mode,
      providerLabel: config.providerLabel,
      model: config.model,
      startedAt: sessionStartedAt,
      busy,
      lastAction,
      taskSummary: renderTaskSummary(taskSessions),
      messageCount: messages.length,
    }
  }

  function pushHeartbeat(busy: boolean, lastAction: string): void {
    writeSessionHeartbeat(sessionStatus(busy, lastAction))
  }

  /**
   * What this process has spent *on the session it is in now*.
   *
   * The usage counters are per-process and never reset, so after `/clear` or
   * `/resume` swaps the conversation underneath them their running total still
   * includes the previous one. `usageBaseline` marks where the current session
   * started in that total; everything before it belongs to a conversation that
   * has already been saved with its own figures.
   */
  function cumulativeSessionUsage(): SessionUsageSnapshot {
    const live = sessionUsageSnapshot()
    const snapshot: SessionUsageSnapshot = {
      usage: {
        inputTokens: live.usage.inputTokens - usageBaseline.usage.inputTokens,
        outputTokens: live.usage.outputTokens - usageBaseline.usage.outputTokens,
        cacheReadTokens: live.usage.cacheReadTokens - usageBaseline.usage.cacheReadTokens,
        cacheWriteTokens: live.usage.cacheWriteTokens - usageBaseline.usage.cacheWriteTokens,
      },
      turns: live.turns - usageBaseline.turns,
      elapsedMs: live.elapsedMs - usageBaseline.elapsedMs,
    }
    return { usage: addUsage(priorUsage.usage, snapshot.usage), turns: priorUsage.turns + snapshot.turns, elapsedMs: priorUsage.elapsedMs + snapshot.elapsedMs }
  }

  async function persistInteractiveSession(): Promise<void> {
    await saveSession(sessionId, messages, undefined, {
      recording: sessionTranscript.snapshot(),
      usage: cumulativeSessionUsage(),
      providerName: config.providerName,
      model: config.model,
    })
  }

  function currentEliaBookSession() {
    const snapshot = cumulativeSessionUsage()
    return {
      sessionId,
      messages: structuredClone(messages),
      transcriptMarkdown: sessionTranscript.toMarkdown(`elia session ${sessionId}`),
      recording: sessionTranscript.snapshot(),
      checkpoints: checkpoints.map((checkpoint) => ({
        turn: checkpoint.turn,
        at: checkpoint.at,
        label: checkpoint.label,
        files: Object.keys(checkpoint.files),
      })),
      usage: { ...snapshot.usage, turns: snapshot.turns, elapsedMs: snapshot.elapsedMs },
      providerLabel: config.providerLabel,
      model: config.model,
      mode: persona ?? mode,
    }
  }
  pushHeartbeat(false, 'Idle at prompt')
  // The single source of truth for "this session ended," covering every exit
  // path at once — normal completion (one-shot prompts return before ever
  // reaching the interactive loop's own Goodbye code below), Ctrl+C, and
  // signals — since registerShutdownCleanup's callbacks run on process 'exit'
  // regardless of why the process is exiting (see ui/shutdown.ts).
  registerShutdownCleanup(() => writeSessionEnded(sessionStatus(false, 'Session ended')))

  /**
   * A build whose run died before it built anything.
   *
   * The goal was asked for and never answered, so "continue" has to mean the
   * pipeline again, not a plain turn: a plain turn has no approved plan, no
   * verification and no acceptance criteria, and writes into the session's
   * working directory rather than the run's own workspace. Cleared as soon as
   * it is picked up, so a provider that is simply down cannot loop.
   */
  let pendingBuild: { goal: string; reason: string } | undefined

  /** Snapshots messages + touched files around one turn, then records a rewind point. */
  /**
   * A request that reads as "build a whole new project" runs through the
   * autonomous pipeline (orient → plan → parallel workers → verify → repair)
   * instead of a plain turn. Report output routes into the REPL transcript via
   * the report sink; the plan gate uses the Ink approval menu. Follow-up turns
   * see a one-line summary of the run.
   */
  async function runEscalatedTurn(
    goal: string,
    reason: string,
    approveAction: ActionApproval | undefined,
    signal: AbortSignal,
    uiHooks?: TurnUiHooks,
  ): Promise<import('../autonomy/outcome.ts').CompletionState | undefined> {
    const { runAutonomousTask, autoApprove } = await import('../autonomy/loop.ts')
    const { setReportSink } = await import('../ui/report.ts')
    const { renderProposalSummary } = await import('../autonomy/proposal.ts')

    const note = (title: string, detail?: string, status: 'updated' | 'completed' = 'updated') => {
      if (uiHooks?.onActivity) uiHooks.onActivity({ kind: 'status', status, title, detail })
      else writeNotice(detail ? `${title}\n${detail}` : title)
    }
    // Said once and kept in scrollback: the pipeline starts by researching, so
    // without this the first thing on screen was subagents nobody asked for.
    note(
      uiHooks
        ? 'This reads as a new project, so elia will research it first and show you a plan to approve before building anything.'
        : `This looks like a full build (${reason}) — planning it properly.`,
      uiHooks ? '/auto off answers requests like this in a single reply instead.' : undefined,
      'completed',
    )

    if (uiHooks) {
      const { friendlyPhase } = await import('../ui/app/phases.ts')
      setReportSink((kind, text) => {
        if (kind === 'block' || kind === 'summary') {
          const [title = text, ...body] = text.split('\n')
          // The approval menu shows the plan and the receipt closes the run, so
          // those two stay transient. Everything else a block carries — issues
          // found, a decision elia needs from you — belongs in scrollback; it
          // used to flash past as a status line and vanish.
          const transient = /^(?:Plan · awaiting approval|Run complete)\b/.test(title)
          const needsYou = /^(?:Needs a decision|Issues found)/.test(title)
          uiHooks.onActivity?.({ kind: 'status', status: transient ? 'updated' : needsYou ? 'warning' : 'completed', title, detail: body.join('\n') || undefined })
        } else if (kind === 'phase') {
          uiHooks.onActivity?.({ kind: 'status', status: 'updated', title: friendlyPhase(text) })
        } else if (kind === 'substep' && /^learned:\s*/i.test(text)) {
          // Learning is elia's strongest "getting smarter" signal — give it the
          // ✦ mark and make it durable in scrollback, not an ephemeral status.
          uiHooks.onActivity?.({ kind: 'status', status: 'completed', title: `✦ ${text.replace(/^learned:\s*/i, '')}` })
        } else if (kind === 'pass' || kind === 'fail') {
          // A review verdict joins every reviewer with " | " — one row per
          // reviewer, each kept to a line, instead of a seven-row wall.
          const [head = text, ...rest] = text.split(' | ')
          const clip = (line: string) => (line.length > 140 ? `${line.slice(0, 139)}…` : line)
          uiHooks.onActivity?.({
            kind: 'status',
            status: kind === 'pass' ? 'completed' : 'warning',
            title: clip(head),
            detail: rest.length > 0 ? rest.map((line) => `  ${clip(line.trim())}`).join('\n') : undefined,
          })
        } else {
          uiHooks.onActivity?.({ kind: 'status', status: 'updated', title: text })
        }
      })
    }

    const ttyApprover = !uiHooks && process.stdin.isTTY && !hasFlag('--yolo', '-y')
    const approvalRl = ttyApprover ? createSlashPrompt([]) : undefined
    const approve: import('../autonomy/loop.ts').Approver = uiHooks?.approve
      ? async (proposal) => {
          const preview = renderProposalSummary(proposal)
          const res = await uiHooks.approve!({ title: 'Run this plan?', lines: [], preview, ruleLabel: 'this plan', variant: 'plan' })
          const outcome = typeof res === 'boolean' ? { approved: res, feedback: undefined } : res
          if (outcome.approved) {
            // The live plan panel follows these steps; each ticks off as the
            // worker carrying its step id finishes.
            uiHooks.onRunPlan?.(proposal.steps.map((step) => ({ id: step.id, title: step.title })))
            return { action: 'approve' }
          }
          if ('feedback' in outcome && outcome.feedback) return { action: 'amend', feedback: outcome.feedback }
          return { action: 'reject' }
        }
      : approvalRl
        ? () => confirmOnce(approvalRl, 'Approve this plan? [y]es / [n]o / [e]dit <what to change>: ')
        : autoApprove

    try {
      const result = await runAutonomousTask({
        goal,
        approve,
        approveAction,
        // An escalated turn reasons on screen exactly as a chat turn does: the
        // pipeline's opening thinking, and any reasoning the model returns while
        // it orients, stream into the Ink transcript instead of being dropped.
        onThinking: uiHooks?.onThinking,
        mode,
        profile: 'balanced',
        governanceMode: 'supervised',
        signal,
        polish: true,
        // A build asked for from the chat stays local unless the request itself
        // mentions GitHub — the run's own commits are still made either way.
        publish: /\b(?:git\s*hub|repo(?:sitory)?|publish|push)\b/i.test(goal),
      })
      const { formatAutonomousRunReceipt, formatAutonomousRunSummary } = await import('../autonomy/runSummary.ts')
      const summary = formatAutonomousRunSummary(goal, result)
      messages.push({ role: 'assistant', content: [{ type: 'text', text: summary }] })
      sessionTranscript.notice(summary)
      // The model gets the summary above; the person gets the outcome, not an
      // instruction addressed to the next turn.
      note(formatAutonomousRunReceipt(goal, result), undefined, 'completed')
      pendingBuild = undefined
      return result.completion.state
    } catch (error) {
      // `messages` is only appended on the success path above, so a run that
      // threw left the conversation holding the request and elia's own planning
      // with no outcome at all — which the next turn read as a build already in
      // progress and carried on ungoverned. Record the failure for the model
      // before rethrowing; the turn-level handler still marks the turn failed.
      const { formatAutonomousRunCrash } = await import('../autonomy/runSummary.ts')
      const crash = formatAutonomousRunCrash(goal, error)
      messages.push({ role: 'assistant', content: [{ type: 'text', text: crash }] })
      sessionTranscript.notice(crash)
      // Telling the model the run died is not enough on its own — it can read
      // that and carry on building anyway. Holding the goal here is what makes
      // "continue" mean the pipeline rather than a plain turn.
      pendingBuild = { goal, reason }
      note('The run failed before it could build anything — no plan was approved and nothing was written. Say "continue" to run it again.', undefined, 'completed')
      throw error
    } finally {
      setReportSink(undefined)
      approvalRl?.close()
    }
  }

  /**
   * Whether this request is worth answering by search rather than by one
   * attempt, and with what to check the attempts against.
   *
   * Runs on every turn, so it never calls a model: `taskSignature` is regexes
   * over the request and `detectChecks` is a look at the project's manifest.
   * Undefined means "answer it the ordinary way", which is the answer for
   * questions, for work with nothing executable to check, and for anything the
   * classifier is unsure of — a search that cannot be judged is just a
   * three-times-more-expensive guess.
   */
  async function planSearch(requestText: string): Promise<{ signature: import('../reason/signature.ts').TaskSignature; checks: import('../reason/reason.ts').ProjectChecks } | undefined> {
    const { detectChecks } = await import('../autonomy/detectChecks.ts')
    const { decideSearch } = await import('../reason/decide.ts')
    // Nothing has changed yet, so there are no changed paths to infer a project
    // from the way the post-turn gate does — the project that would check this
    // turn's work is simply the one owning the working tree.
    return decideSearch(requestText, detectChecks(process.cwd())).plan
  }

  /**
   * Answers a request by searching: several genuinely different attempts, each
   * in its own git worktree, each checked by something that ran, and only the
   * winner merged into the user's tree.
   *
   * Modelled on `runEscalatedTurn` above, which is the existing precedent for a
   * turn handled by a different engine: it owns the whole turn, pushes the
   * reply into `messages` itself so the conversation stays coherent, and hands
   * back a verify verdict for the turn record.
   *
   * The verdict it returns is the search's own, and the caller must not run the
   * post-turn verify gate over the top of it — the winner was chosen *by* that
   * check, so re-running it would spend the same commands to learn the same
   * thing.
   */
  async function runSearchedTurn(
    requestText: string,
    plan: { signature: import('../reason/signature.ts').TaskSignature; checks: import('../reason/reason.ts').ProjectChecks },
    /** This turn's file tracker, so the merged files land in the turn record and in a rewind. */
    tracker: { capture(path: string): Promise<void> },
    signal: AbortSignal,
    uiHooks?: TurnUiHooks,
  ): Promise<{ verify: import('../autonomy/outcomes.ts').VerifyResult; attempts: number }> {
    const { isolatedSearch } = await import('../reason/attempt.ts')
    const { subAgentRunner } = await import('../reason/runner.ts')
    const { reason } = await import('../reason/reason.ts')

    const note = (title: string, detail?: string, status: 'updated' | 'completed' | 'warning' = 'updated') => {
      if (uiHooks?.onActivity) uiHooks.onActivity({ kind: 'status', status, title, detail })
      else writeNotice(detail ? `${title}\n${detail}` : title)
    }

    const runId = `search-${Date.now().toString(36)}`
    const search = isolatedSearch({
      runId,
      sourceRoot: process.cwd(),
      run: subAgentRunner({ request: requestText, runId }),
    })

    // With nothing executable in the project, the search writes its own check
    // first — and only trusts it once it fails on the unchanged tree (§7.4,
    // reason/probe.ts). Without this the "elia will write the check" promise fell
    // back to attempts agreeing with each other.
    const { createProbeSynthesizer, probeWriterPrompt, probeWriterTools } = await import('../reason/probe.ts')
    const synthesizeProbe = createProbeSynthesizer({
      request: requestText,
      sourceRoot: process.cwd(),
      signal,
      write: async ({ request, probeDir, sourceRoot, signal: probeSignal }) => {
        const { runSubAgent } = await import('../subagent.ts')
        const { allWorkerTools } = await import('../tools/registry.ts')
        note('writing the check before the attempts', 'no project tests cover this, so elia writes a probe and confirms it fails first')
        await runSubAgent({
          role: 'builder',
          name: 'builder#probe',
          runId,
          prompt: probeWriterPrompt(request, probeDir),
          ...(probeSignal ? { signal: probeSignal } : {}),
          tools: probeWriterTools(allWorkerTools(), sourceRoot, probeDir),
        })
      },
      onDecision: (admission) => note(admission.admitted ? 'check admitted' : 'check refused', admission.reason, admission.admitted ? 'completed' : 'warning'),
    })

    try {
      const outcome = await reason({
        request: requestText,
        checks: plan.checks,
        produce: search.produce,
        synthesizeProbe,
        signal,
        onCheck: uiHooks?.onCheck,
        onAttempt: (record) => {
          note(
            `${record.verdict.passed ? '✓' : '✗'} attempt "${record.candidate.approach}" — ${record.verdict.detail}`,
            record.verdict.passed ? undefined : record.verdict.evidence.split('\n')[0],
            record.verdict.passed ? 'completed' : 'warning',
          )
        },
      })

      // `searched: false` can still happen here — the library may have found no
      // harness for this signature — and the caller falls back to a plain turn.
      if (!outcome.searched || !outcome.result) {
        await search.settle(undefined)
        return { verify: 'none', attempts: 0 }
      }

      // Snapshot what the winner touched *before* the merge overwrites it —
      // afterwards the tracker would capture the new content and a rewind would
      // restore nothing. See `changedBy` in reason/attempt.ts.
      if (outcome.result.best) {
        const { resolve } = await import('node:path')
        for (const relative of await search.changedBy(outcome.result.best)) {
          await tracker.capture(resolve(process.cwd(), relative)).catch(() => {})
        }
      }
      const merged = await search.settle(outcome.result.best)
      const report = outcome.result.best?.text ?? 'The search produced no answer.'
      // The model sees the winning attempt's own report, so a follow-up turn
      // knows what was done; the receipt is for the person and says plainly
      // whether it was proved or merely chosen.
      messages.push({ role: 'assistant', content: [{ type: 'text', text: report }] })
      sessionTranscript.appendAssistant(report)
      sessionTranscript.notice(`Search: ${outcome.receipt} · ${outcome.choice ?? ''} · merged ${merged.length} file(s)`)
      note(
        `${outcome.harness?.id} search over ${outcome.result.attempts.length} attempt(s) — ${outcome.receipt}`,
        merged.length > 0 ? `merged ${merged.length} file(s) from the winning attempt` : 'nothing was merged',
        outcome.result.verified ? 'completed' : 'warning',
      )
      if (uiHooks?.onText) uiHooks.onText(report)
      else writeUsageLine(report)

      return {
        verify: outcome.result.verified ? 'pass' : outcome.result.bestVerdict?.passed ? 'skipped' : 'fail',
        attempts: outcome.result.attempts.length,
      }
    } finally {
      // A thrown search must not leave worktrees behind holding the user's
      // branch namespace; settle is safe to call twice.
      await search.settle(undefined).catch(() => {})
    }
  }

  /**
   * The default answer check (reason/answer.ts), after a question's ordinary
   * turn has answered it. That answer is the first attempt; one read-only
   * challenger answers the same question independently, and more are opened
   * only when the two disagree. The challengers get the conversation before
   * this question, so a follow-up still makes sense to them, but never this
   * turn's answer, so their vote stays their own.
   *
   * It is quiet when it agrees: one status line. When the independent attempts
   * contradict the answer, the reply gets a note saying what they answered.
   */
  async function runAnswerCheck(
    question: string,
    reply: string,
    earlier: ConversationMessage[],
    signal: AbortSignal,
    uiHooks?: TurnUiHooks,
  ): Promise<import('../trajectory/record.ts').TrajectoryAnswerCheck | undefined> {
    const { answerSearch, arithmeticCheck, citationCheck, conversationContext, covers, overturned } = await import('../reason/answer.ts')
    const { runSubAgent } = await import('../subagent.ts')
    const { totalTokens } = await import('../usage.ts')
    const note = (title: string, status: 'updated' | 'completed' | 'warning' = 'updated') => {
      if (uiHooks?.onActivity) uiHooks.onActivity({ kind: 'status', status, title })
      else writeNotice(title)
    }
    const runId = `answer-check-${Date.now().toString(36)}`
    const context = conversationContext(earlier)
    note('checking the answer with an independent attempt')
    const result = await answerSearch({
      first: { text: reply },
      checks: [arithmeticCheck(), citationCheck(process.cwd())],
      signal,
      produce: async ({ approach, round, briefing, signal: attemptSignal }) => {
        const report = await runSubAgent({
          role: 'scout',
          name: `check/${approach.id}${round > 0 ? `#${round + 1}` : ''}`,
          runId,
          prompt: question,
          briefing: context ? `${context}\n\n${briefing}` : briefing,
          ...(attemptSignal ? { signal: attemptSignal } : {}),
        })
        return { text: report.report, cost: totalTokens(report.usage) }
      },
    })
    if (result.status === 'aborted') return undefined
    const attempts = result.attempts.length
    const tokens = `${result.cost.toLocaleString('en-US')} tokens`
    const replaced = overturned(result)
    const given = result.attempts[0]
    const leader = result.clusters[0]
    const challengers = result.attempts.slice(1).filter((attempt) => attempt.rejected.length === 0 && attempt.key !== undefined)
    const givenClean = given?.key !== undefined && given.rejected.length === 0
    sessionTranscript.notice(`Answer check: ${result.status} over ${attempts} attempt(s), ${tokens}${replaced ? ', overturned' : ''}`)
    if (replaced && result.best && leader) {
      // The independent attempts agree with each other and not with the answer
      // already shown. What they said goes into the reply itself, so a
      // follow-up turn sees it rather than only the terminal does — as a
      // disagreement, not a correction: the challengers are cheaper attempts,
      // and agreeing with each other does not make them right.
      const others = leader.count === 1 ? 'An independent attempt' : `${leader.count} independent attempts`
      const text = `**Independent check disagrees.** ${others} answered "${leader.answer}" where this reply answered "${given?.answer ?? 'something else'}". Agreement is not proof; check which is right.\n\n${result.best.text.trim()}`
      const last = messages[messages.length - 1]
      if (last?.role === 'assistant') last.content.push({ type: 'text', text: `\n\n${text}` })
      else messages.push({ role: 'assistant', content: [{ type: 'text', text }] })
      sessionTranscript.appendAssistant(text)
      note(`⚠ independent attempts answered differently (${result.status}, ${attempts} attempts)`, 'warning')
      if (uiHooks?.onText) uiHooks.onText(`\n\n${text}`)
      else writeUsageLine(text)
    } else if (givenClean && challengers.length > 0 && challengers.every((attempt) => attempt.key === given.key)) {
      note(`✓ answer checked: an independent attempt reached the same answer · ${tokens}`, 'completed')
    } else if (givenClean && challengers.length > 0 && challengers.every((attempt) => covers(given.key!, attempt.key!))) {
      note(`✓ answer checked: an independent attempt found part of this answer ("${challengers[0]!.answer}") and contradicted none of it · ${tokens}`, 'completed')
    } else {
      note(`answer check: ${result.receipt}`, 'warning')
    }
    return { status: result.status, attempts, overturned: replaced, tokens: result.cost }
  }

  /**
   * `/attach <path>` — queue an image for the next prompt. No arg lists what's
   * queued; `/attach clear` empties the queue. Pasting or dragging an image
   * path straight into a prompt works too and doesn't need this command.
   */
  async function runAttachCommand(arg: string | undefined): Promise<string> {
    const { loadImageAttachment, formatBytes } = await import('../attachments.ts')
    if (!arg) {
      if (pendingAttachments.length === 0) return 'No images queued. Use /attach <path>, or just paste/drag an image into your message.'
      return ['Queued for your next message:', ...pendingAttachments.map((a) => `  📎 ${a.alt} (${formatBytes(a.bytes)}, ${a.mediaType})`)].join('\n')
    }
    if (arg === 'clear') {
      const n = pendingAttachments.length
      pendingAttachments.length = 0
      return n === 0 ? 'Nothing was queued.' : `Cleared ${n} queued image${n === 1 ? '' : 's'}.`
    }
    if (config.providerName === 'codex') {
      return 'The ChatGPT-subscription (Codex) provider has no image input — it runs in a sandbox with no vision channel. Switch to an API provider with /model to send images.'
    }
    const loaded = await loadImageAttachment(arg)
    if (typeof loaded === 'string') return `Could not attach — ${loaded}`
    pendingAttachments.push(loaded)
    return `📎 Attached ${loaded.alt} (${formatBytes(loaded.bytes)}, ${loaded.mediaType}) — sent with your next message. /attach clear to undo.`
  }

  /** After `/clear` or `/compact` rewrote `messages`, drop any copy of the conversation a provider keeps on its side. */
  function resetProviderConversations(): void {
    const providers = new Set([config.tiers.deep.provider, config.tiers.fast.provider, ...Object.values(config.roleOverrides).map((route) => route?.provider)])
    for (const provider of providers) provider?.resetConversation?.()
  }

  /**
   * `/compact [focus]` — summarise the whole conversation into one recallable
   * episode now, rather than waiting for the automatic threshold, and continue
   * from the summary.
   */
  async function compactNow(focus: string | undefined): Promise<string> {
    const { compactConversation } = await import('../compaction.ts')
    const { formatTokenCount } = await import('../usage.ts')
    if (messages.length > 0) writeNotice('Compacting the conversation…')
    // Persist the archived turns as an episode of this session, so the recall
    // tool can still reach the detail the summary leaves out.
    setActiveLedgerSession({ id: sessionId, turn: checkpoints.length })
    const result = await compactConversation(messages, focus)
    if (!result.compacted) return result.reason
    resetProviderConversations()
    const text = `Compacted ${result.archivedMessages} messages into a summary — context ${formatTokenCount(result.tokensBefore)} → ${formatTokenCount(result.tokensAfter)} tokens. The full detail stays recallable from this session's archive.`
    sessionTranscript.notice(text)
    await persistInteractiveSession()
    return text
  }

  /**
   * `/clear` — start a fresh conversation, as if elia had just been launched
   * here. The current one is saved first under its own id, so
   * `elia --resume <id>` brings it back; nothing is deleted.
   */
  async function clearConversation(): Promise<string> {
    const previousId = sessionId
    const hadConversation = messages.length > 0
    if (hadConversation) await persistInteractiveSession()
    writeSessionEnded(sessionStatus(false, 'Cleared — continued in a new session'))

    sessionId = newSessionId()
    // /clear starts a new session; commits after it belong to that one.
    setProcessProvenance({ sessionId, surface: 'interactive', model: config.model, version: eliaVersion() })
    messages.length = 0
    checkpoints.length = 0
    sessionTranscript.clear()
    pendingAttachments.length = 0
    carriedShellContext.length = 0
    taskSessions.setActiveSession(sessionId)
    setActiveLedgerSession(undefined)
    const { resetActiveTodoList } = await import('../autonomy/todoList.ts')
    resetActiveTodoList()
    resetProviderConversations()
    usageBaseline = sessionUsageSnapshot()
    pushHeartbeat(false, 'Idle at prompt')

    return hadConversation
      ? `Started a fresh conversation. The previous one is saved — elia --resume ${previousId} reopens it.`
      : 'Started a fresh conversation.'
  }

  /**
   * `/resume <id>` — leave this conversation for another one without restarting.
   *
   * The same swap `--resume` does at launch, done in place: this conversation is
   * saved under its own id first, so switching is always reversible, and the
   * rewind points, usage figures and transcript that come back are the target's
   * own. A session another live elia is holding is opened as a copy under a new
   * id rather than shared, for the reason in the CLI path above.
   */
  async function resumeIntoSession(targetId: string): Promise<{ text: string; sessionId?: string }> {
    if (targetId === sessionId) return { text: 'Already in that conversation.' }
    const loaded = await loadSession(targetId)
    if (!loaded) return { text: `No saved conversation with id "${targetId}" in this directory. See them with /sessions.` }

    const { sessionHolder, relativeTime } = await import('../sessionCatalog.ts')
    const holder = sessionHolder(targetId)
    const leaving = sessionId
    const hadConversation = messages.length > 0
    if (hadConversation) await persistInteractiveSession()
    writeSessionEnded(sessionStatus(false, `Switched to session ${targetId}`))

    sessionId = holder ? newSessionId() : loaded.id
    messages.length = 0
    messages.push(...loaded.messages)
    checkpoints.length = 0
    checkpoints.push(...(await loadCheckpoints(sessionId)))
    sessionTranscript.restore(loaded.recording ?? transcriptFromMessages(loaded.messages))
    priorUsage = holder ? { usage: ZERO_USAGE, turns: 0, elapsedMs: 0 } : loaded.usage ?? { usage: ZERO_USAGE, turns: 0, elapsedMs: 0 }
    usageBaseline = sessionUsageSnapshot()
    pendingAttachments.length = 0
    carriedShellContext.length = 0
    taskSessions.setActiveSession(sessionId)
    setActiveLedgerSession(undefined)
    const { resetActiveTodoList } = await import('../autonomy/todoList.ts')
    resetActiveTodoList()
    resetProviderConversations()
    // Writes the new id's file immediately, so a copy exists on disk from the
    // moment it is offered rather than only after the first turn.
    await persistInteractiveSession()
    pushHeartbeat(false, 'Idle at prompt')

    const turns = loaded.messages.filter((message) => message.role === 'user').length
    const header = holder
      ? `${targetId} is open in another elia (pid ${holder.pid}), so its ${loaded.messages.length} messages continue here as a separate session ${sessionId}.`
      : `Resumed ${sessionId} — ${turns} turn${turns === 1 ? '' : 's'}, last active ${relativeTime(loaded.updatedAt)}${loaded.model ? ` on ${loaded.model}` : ''}.`
    const provider = loaded.providerName && (loaded.providerName !== config.providerName || loaded.model !== config.model)
      ? `\nIt was built on ${loaded.providerName} (${loaded.model ?? 'unknown model'}); it continues here on ${config.providerLabel}.`
      : ''
    const back = hadConversation ? `\nThe conversation you left is saved — /resume ${leaving} goes back.` : ''
    return { text: `${header}${provider}${back}${renderResumedContext()}`, sessionId }
  }

  /** The tail of a resumed conversation, so the switch lands somewhere recognisable. */
  function renderResumedContext(limit = 4): string {
    const lines = sessionTranscript
      .items()
      .filter((item): item is import('../ui/transcript.ts').TranscriptUserItem | import('../ui/transcript.ts').TranscriptAssistantItem =>
        item.kind === 'user' || item.kind === 'assistant')
      .slice(-limit)
      .map((item) => {
        const text = item.text.replace(/\s+/g, ' ').trim()
        const clipped = text.length > 110 ? `${text.slice(0, 109)}…` : text
        return `  ${item.kind === 'user' ? '›' : '·'} ${clipped}`
      })
    return lines.length > 0 ? `\n\nwhere it left off:\n${lines.join('\n')}` : ''
  }

  /**
   * The `/resume` picker's options: every conversation here except this one,
   * newest first. Shared by the Ink and readline REPLs.
   */
  async function resumablePickerOptions(): Promise<{ label: string; detail: string; value: string }[]> {
    const { describeSession, listSessionSummaries, sessionDetail } = await import('../sessionCatalog.ts')
    const sessions = await listSessionSummaries()
    return sessions
      .filter((session) => session.id !== sessionId && session.hasConversation)
      .map((session) => ({ label: describeSession(session, 64), detail: sessionDetail(session), value: session.id }))
  }

  async function runCheckpointedTurn(userText: string, approveAction?: ActionApproval, skillNames = selectedSkillNames, uiHooks?: TurnUiHooks): Promise<void> {
    try {
      await withSessionTranscript(sessionTranscript, () => runRecordedTurn(userText, approveAction, skillNames, uiHooks))
    } finally {
      await persistInteractiveSession()
    }
  }

  async function runRecordedTurn(submittedText: string, approveAction?: ActionApproval, skillNames = selectedSkillNames, uiHooks?: TurnUiHooks): Promise<void> {
    // Fold in any images: ones queued with `/attach`, plus image-file paths the
    // user pasted or dragged straight into this line (stripped from the text).
    const { resolveInlineAttachments } = await import('../attachments.ts')
    // Only scan what the user actually typed — `!cmd` output carried into the
    // turn can contain filenames from a directory listing that aren't attachments.
    const typedRegion = submittedText.replace(/<local-command>[\s\S]*?<\/output>/g, '')
    const resolved = await resolveInlineAttachments(submittedText, process.cwd(), typedRegion)
    const attachments = [...pendingAttachments.splice(0), ...resolved.images]
    for (const error of resolved.errors) writeNotice(`Attachment skipped — ${error}`)
    if (attachments.length > 0) {
      writeNotice(`📎 ${attachments.length} image${attachments.length === 1 ? '' : 's'} attached to this message: ${attachments.map((a) => a.alt).join(', ')}`)
    }
    let userText = resolved.text || (attachments.length > 0 ? `[image attached: ${attachments.map((a) => a.alt).join(', ')}]` : submittedText)
    // The request itself, before any operator-context inject is prepended.
    const requestText = userText
    const inject = collectPromptInjects()
    if (inject) userText = `<operator-context>\n${inject}\n</operator-context>\n\n${userText}`

    const tracker = createFileTracker()
    const turnStartedAt = Date.now()
    // Classify on the request (title) and what was actually typed (prompt).
    // Passing the inject-prefixed userText as both let operator-context text
    // (a "deploy" note, say) decide the task kind — and titled the task with it.
    const task = taskSessions.create(inferTaskKind(requestText, submittedText), redactText(requestText, 160), 'Starting request')
    taskSessions.update(task.id, { status: 'running', action: 'Thinking', detail: 'Planning the next action' })
    pushHeartbeat(true, redactText(userText, 160))
    const controller = new AbortController()
    let stopRequested = false
    // Skip the post-turn auto-preview when the model already opened one itself.
    let previewedThisTurn = false
    // …but keep the page it opened, so the render check still verifies the turn.
    let previewedUrl: string | undefined
    // Signals for the per-turn outcome record (competence map + regret nudge).
    let toolErrorCount = 0
    let editRetryCount = 0
    // Ordered tool calls for this turn's trajectory row (the training dataset).
    const toolTrace: { name: string; ok: boolean }[] = []
    let verifyResult: import('../autonomy/outcomes.ts').VerifyResult = 'none'
    // The fast-path verify gate further down only runs for non-escalated
    // turns — an escalated (autonomous-pipeline) run maps its own completion
    // verdict into verifyResult/escalatedAborted instead, so that outcomes.jsonl
    // and lesson-efficacy no longer record every autonomous build as
    // verify:"none"/clean regardless of what actually happened.
    let escalatedAborted = false
    let repairAttempts = 0
    let grounding: import('../trajectory/record.ts').TrajectoryGrounding | undefined
    let arithmetic: import('../trajectory/record.ts').TrajectoryArithmetic | undefined
    let answerCheck: import('../trajectory/record.ts').TrajectoryAnswerCheck | undefined
    const unregisterControls = taskSessions.registerControls(task.id, {
      cancel: () => {
        stopRequested = true
        controller.abort()
        taskSessions.update(task.id, { status: 'paused', action: 'Stopping', detail: 'Cancellation requested by operator' })
      },
    })
    const unregisterShutdown = registerShutdownCleanup(() => controller.abort())
    if (uiHooks?.signal) {
      if (uiHooks.signal.aborted) controller.abort()
      else uiHooks.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    emitEvent('turn_started', { taskId: task.id, sessionId, prompt: redactText(userText, 2000) })
    setActiveTracker(tracker)
    // Lets compaction (mid-loop, several call frames down) and the recall tool
    // find this session's ledger — see ledger.ts's setActiveLedgerSession doc.
    setActiveLedgerSession({ id: sessionId, turn: checkpoints.length })
    // Shared per-message copies, not a deep clone of the whole history per turn — see snapshotMessages.
    const messagesBefore = snapshotMessages(messages)
    messages.push(userMessage(userText, attachments))
    sessionTranscript.appendUser(userText)

    // A build whose run died is picked up again only by a message that carries
    // no instruction of its own ("continue", "try again"). Anything else — a
    // question, a new subject, a different build — is answered on its own
    // terms, and drops the pending goal rather than talking past the person.
    const { escalation, resumedGoal } = routeTurn(userText, pendingBuild)
    // One shot: whether or not it was picked up, the held build does not
    // survive this turn. A stale project build firing on a bare "ok" many
    // turns later is the worse failure of the two.
    pendingBuild = undefined
    let escalated = false

    // Decided before the turn runs, because it decides *how* the turn runs.
    // Costs nothing when it declines — regexes over the request and one look at
    // the project manifest — and declines for everything that a second attempt
    // could not be told apart from a first.
    // A search merges its winning attempt by copying files straight into this
    // tree, past the governor and the file tools' self-edit check, so it does
    // not run while elia's own source still needs asking about.
    const selfEditClosed = selfEdit.selfEditGuard()?.allowed === false
    const searchPlan =
      reasonSearch && !selfEditClosed && mode === 'dev' && !persona && !uiHooks?.planMode && !(autoEscalate && escalation.escalate)
        ? await planSearch(userText)
        : undefined
    // A searched turn already chose its winner with the project's own checks;
    // the post-turn gate must not run them a second time to learn the same thing.
    let searched = false
    // A question gets the answer check by default (reason/answer.ts, decided in
    // reason/decide.ts): the turn is asked to end in an `Answer:` line, and if
    // it does, one independent attempt checks it. --no-search or /search off
    // turns it off with the rest of the reasoning search.
    const answerCheckPlanned =
      reasonSearch && mode === 'dev' && !persona && !uiHooks?.planMode && !searchPlan && !(autoEscalate && escalation.escalate)
        ? (await import('../reason/decide.ts')).decideAnswerCheck(userText).check
        : false
    const { ANSWER_GUIDANCE } = await import('../reason/answer.ts')

    // `opening` marks the call that answers the user's request itself — the one
    // that thinks it through and plans up front. Repair and self-review passes
    // continue that work and must not re-plan it.
    const runModelTurn = (opening = false) =>
      runTurn(messages, {
        mode,
        approveAction,
        skillNames,
        signal: controller.signal,
        silent: Boolean(uiHooks),
        planMode: uiHooks?.planMode,
        upfrontPlan: opening,
        ...(opening && answerCheckPlanned ? { turnGuidance: ANSWER_GUIDANCE } : {}),
        drainSteering: uiHooks?.drainSteering,
        onText: uiHooks?.onText,
        onThinking: uiHooks?.onThinking,
        onToolStart: uiHooks?.onToolStart,
        onActivity: (activity) => {
          const action = redactText(activity.title, 120)
          taskSessions.update(task.id, { status: 'running', action, detail: redactText(activity.detail ?? activity.title, 500) })
          uiHooks?.onActivity?.(activity)
          pushHeartbeat(true, action)
        },
        onTool: (event) => {
          const action = event.isError ? `Retrying after ${event.name}` : event.name
          toolTrace.push({ name: event.name, ok: !event.isError })
          if (event.name === 'preview' && !event.isError) {
            previewedThisTurn = true
            previewedUrl = consumeLastPreviewedUrl() ?? previewedUrl
          }
          if (event.isError) {
            toolErrorCount += 1
            if (event.name === 'edit_file' || event.name === 'write_file') editRetryCount += 1
          }
          taskSessions.update(task.id, {
            status: 'running',
            action,
            detail: event.isError ? redactText(event.result, 500) : 'Action completed successfully',
            stepsCompleted: (taskSessions.get(task.id)?.stepsCompleted ?? 0) + 1,
          })
          uiHooks?.onTool?.(event)
          pushHeartbeat(true, action)
        },
      })

    try {
      if (persona) {
        const { runPersonaTurn } = await import('../agents/orchestrator.ts')
        // Forward the same Ink `uiHooks` a normal turn gets (see `runModelTurn`
        // above) so a persona turn renders into the live Ink store instead of
        // writing raw ANSI to stdout while Ink's reconciler independently
        // repaints the frame — the raw writes and Ink's own repaint race and
        // corrupt the terminal.
        await runPersonaTurn(messages, persona, skillNames, controller.signal, uiHooks)
      } else if (autoEscalate && mode === 'dev' && !uiHooks?.planMode && escalation.escalate) {
        escalated = true
        // "continue" is not the goal — the build the dead run never finished is.
        const completionState = await runEscalatedTurn(resumedGoal ?? userText, escalation.reason, approveAction, controller.signal, uiHooks)
        const { mapCompletionToVerify } = await import('../autonomy/outcome.ts')
        const mapped = mapCompletionToVerify(completionState)
        if (mapped.verify) verifyResult = mapped.verify
        escalatedAborted = mapped.aborted
      } else if (searchPlan) {
        // The search owns the whole turn: it runs the attempts, picks the
        // winner by a check that ran, and merges only that one. A search that
        // declined (no harness for this signature) falls through to the plain
        // turn rather than leaving the request unanswered.
        const outcome = await runSearchedTurn(userText, searchPlan, tracker, controller.signal, uiHooks)
        if (outcome.attempts === 0) {
          const turnResult = await runModelTurn(true)
          if (turnResult.stopReason === 'aborted') stopRequested = true
        } else {
          searched = true
          verifyResult = outcome.verify
        }
      } else {
        const turnResult = await runModelTurn(true)
        if (turnResult.stopReason === 'aborted') stopRequested = true
      }
      if (stopRequested || controller.signal.aborted) {
        taskSessions.update(task.id, { status: 'paused', action: 'Stopped', detail: 'Stopped by operator; no further tool calls will run' })
        emitEvent('turn_finished', { taskId: task.id, sessionId, outcome: 'aborted' })
        return
      }

      // Domain-aware self-defense: if this change touched an area elia has a poor
      // track record in on this project, force one hard self-review of the diff
      // before it can claim done — it reviews itself harder exactly where it has
      // proven unreliable.
      if (!persona && !escalated && !uiHooks?.planMode && !controller.signal.aborted) {
        const { touchedWeakDomain } = await import('../autonomy/outcomes.ts')
        const weak = touchedWeakDomain(Object.keys(tracker.snapshot()))
        // elia builds the diff from the turn's own before-images. Asking the
        // model to "run `git diff`" in a project that is not a repository got
        // `git init` + `git add .` with no .gitignore, 200 KB outputs, and a
        // context overflow that killed the session — see autonomy/turnDiff.ts.
        const { buildTurnDiff } = await import('../autonomy/turnDiff.ts')
        const diff = weak.length > 0 ? buildTurnDiff(tracker.snapshot()) : undefined
        if (weak.length > 0 && diff && diff.files.length > 0) {
          const label = `Self-reviewing ${weak.join('/')} change (weak area)`
          taskSessions.update(task.id, { status: 'running', action: 'Self-review', detail: label })
          uiHooks?.onActivity?.({ kind: 'status', status: 'updated', title: label })
          if (!uiHooks) writeNotice(label)
          const { writeSecureFile } = await import('../securePersistence.ts')
          const { paths } = await import('../statePaths.ts')
          const diffPath = pathModule.join(paths.state, 'review', `${task.id}.diff`)
          writeSecureFile(diffPath, diff.text)
          const inline = diff.text.length <= 6_000 ? `\n\nThe diff:\n\`\`\`diff\n${diff.text}\n\`\`\`` : ''
          messages.push(
            userMessage(
              `This change is in "${weak.join('/')}", an area where past turns on this project landed clean less than 75% of the time. Before you finish:\n`
                + `1. elia saved the diff of this turn to ${diffPath} (paths inside it are relative to ${process.cwd()}). Do not run \`git init\` or \`git add\` to produce one. The changed files, by absolute path:\n${diff.absolute.slice(0, 12).map((file) => `   - ${file}`).join('\n')}${diff.absolute.length > 12 ? `\n   - … and ${diff.absolute.length - 12} more in the diff` : ''}\n`
                + `2. In one message, make two \`task\` calls in parallel — one with role "critic", one with role "bughunter". Each call MUST include a short \`description\` and a non-empty \`prompt\` that says what the change is for and tells the reviewer to read_file ${diffPath} first, then the changed files in full by the absolute paths above; the sub-agents cannot see this conversation.\n`
                + `3. Reviewers are often wrong. Before changing anything they raise, check it against the code and fix only what is actually broken — skip style opinions and anything you cannot confirm. Then verify. Do not skip the review.${inline}`,
            ),
          )
          await runModelTurn()
        }
      }

      // Green-by-construction: a turn that changed code isn't done until the
      // project's own checks pass. Detect them, run them, and hand any failure
      // back for a bounded repair — the "done!" that isn't is the single most
      // common way an autonomous agent wastes your time.
      if (!persona && !escalated && !searched && autoVerify && !uiHooks?.planMode) {
        const { changedCodeFiles, detectChecks, verificationRoot } = await import('../autonomy/detectChecks.ts')
        const { runVerification, describeVerification } = await import('../autonomy/verify.ts')
        const changedAll = Object.keys(tracker.snapshot())
        const changed = changedCodeFiles(changedAll)
        // `verificationRoot` returns undefined when no project owns the changed
        // code — a freshly scaffolded folder with no manifest yet. Passing that straight
        // into `detectChecks` would silently fall back to `process.cwd()` and
        // run *elia's own* typecheck and test suite against the new project, so
        // the undefined case has to be handled here rather than defaulted away.
        const root = verificationRoot(changedAll, process.cwd())
        const checks = root ? detectChecks(root) : []
        // Jev, when configured, predicts whether this change passes — in
        // parallel with the checks, scored against them afterwards. See
        // reason/systemOne.ts for when that prediction is allowed to matter.
        const askSystemOne = async () => {
          if (changed.length === 0) return undefined
          const { jevEnabled } = await import('../providers/jev.ts')
          if (!jevEnabled()) return undefined
          const { predict } = await import('../reason/systemOne.ts')
          const { buildTurnDiff } = await import('../autonomy/turnDiff.ts')
          const state = {
            request: requestText.slice(0, 4_000),
            agent_closing_report: lastAssistantText(messages, '(none)').slice(0, 2_000),
            change_diff: buildTurnDiff(tracker.snapshot()).text.slice(0, 12_000),
          }
          // The agent stopping is its own claim that the change is done.
          return predict('turn-verify', state, {
            instructions: 'The change in change_diff is correct: it would pass the project\'s typecheck and tests, and it does what the request asked.',
            criteria: {
              true: 'The diff is complete and consistent — no syntax or type errors, no broken references, no missing pieces the request needs',
              false: 'The diff has a bug, a type or syntax error, a broken reference, or leaves part of the request undone',
            },
          }, { local: true, signal: controller.signal })
        }
        if (checks.length === 0 && changed.length > 0) {
          // Code changed and no command could check it. Saying so was already
          // honest — "none" used to mean both "nothing to check" and "we never
          // looked" — but it left a third of elia's file-changing turns with
          // nothing having read the bytes at all. A parse is what is left when
          // every other check is unavailable: no project, no server, no network,
          // no model. It cannot say the code is right; it catches the writes
          // that arrived broken, which currently ship in silence.
          //
          // A clean parse is deliberately NOT recorded as a pass — see
          // reason/structural.ts. It can fail a turn and it can never pass one,
          // so the unverified count it was built to reduce cannot be reduced by
          // this gate scoring itself.
          const { describeStructural, parseChangedFiles, repairBriefing } = await import('../reason/structural.ts')
          const why = root
            ? `no typecheck or test command could be inferred in ${root}`
            : 'the changed files are not inside a project (no package.json, Cargo.toml, go.mod, …)'
          let structural = parseChangedFiles(changedAll)
          for (let attempt = 1; structural.broken.length > 0 && attempt <= 2 && !controller.signal.aborted; attempt += 1) {
            repairAttempts = attempt
            const summary = `A changed file does not parse (repair ${attempt}/2)`
            uiHooks?.onActivity?.({ kind: 'status', status: 'warning', title: summary })
            if (!uiHooks) writeNotice(`${summary} — ${describeStructural(structural, why)}`)
            messages.push(userMessage(repairBriefing(structural)))
            await runModelTurn()
            structural = parseChangedFiles(Object.keys(tracker.snapshot()))
          }
          const stillBroken = structural.broken.length > 0
          verifyResult = stillBroken ? 'fail' : 'skipped'
          const line = stillBroken
            ? `⚠ ${describeStructural(structural, why)} — still broken after ${repairAttempts} repair attempt(s)`
            : describeStructural(structural, why)
          uiHooks?.onActivity?.({ kind: 'status', status: 'warning', title: line })
          if (!uiHooks) writeNotice(`▸ ${line}`)
          sessionTranscript.notice(line)
          // Nothing executable checked this change, which is exactly where a
          // second judge is worth the most. Jev earns the right to act here on
          // the turns that *were* checked (the prediction above is scored
          // there), and even then it only buys one self-review — it never marks
          // a turn passed or failed.
          const systemOne = !stillBroken && !controller.signal.aborted ? await askSystemOne().catch(() => undefined) : undefined
          if (systemOne?.actionable && systemOne.ok === false) {
            const note = `Jev doubts this change (${Math.round((systemOne.confidence ?? 0) * 100)}% confident it is wrong) — self-reviewing`
            uiHooks?.onActivity?.({ kind: 'status', status: 'warning', title: note })
            if (!uiHooks) writeNotice(`▸ ${note}`)
            sessionTranscript.notice(note)
            messages.push(
              userMessage(
                'An independent checker predicts, with high confidence, that this change is broken or does not do what was asked — and nothing executable was available to check it. It gives no reason and is sometimes wrong. Re-read each changed file in full against the request, fix only what you can confirm is actually wrong, and say plainly what you checked.',
              ),
            )
            await runModelTurn()
          }
        }
        if (checks.length > 0) {
          const where = root === process.cwd() ? '' : ` in ${root}`
          taskSessions.update(task.id, { status: 'running', action: 'Verifying', detail: `${checks.join(' && ')}${where}` })
          uiHooks?.onActivity?.({ kind: 'status', status: 'updated', title: `Verifying${where} — ${checks.join(', ')}` })
          if (!uiHooks) writeNotice(`Verifying${where}: ${checks.join(' && ')}`)
          // The gate runs after runTurn has returned, outside the turn's own
          // governor, so it used to fall through to the default unattended one
          // with no approver: anything off the read-only list — a Vite app's
          // `bun run build` — was refused even when the user had just allowed
          // the model to run that exact command. Ask the way the turn asks.
          const { createActionGovernor } = await import('../autonomy/governor.ts')
          const gateGovernor = createActionGovernor({ mode: approveAction ? 'supervised' : 'unattended', approve: approveAction })
          const [systemOne, firstOutcome] = await Promise.all([
            askSystemOne().catch(() => undefined),
            runVerification(checks, root, controller.signal, gateGovernor, { onCheck: uiHooks?.onCheck }),
          ])
          let outcome = firstOutcome
          if (systemOne && !outcome.blocked && !outcome.inconclusive) {
            const { resolvePrediction } = await import('../reason/systemOne.ts')
            resolvePrediction(systemOne.id, outcome.passed)
          }
          sessionTranscript.notice(describeVerification(outcome))
          for (let attempt = 1; !outcome.passed && !outcome.blocked && !outcome.inconclusive && attempt <= 2 && !controller.signal.aborted; attempt += 1) {
            repairAttempts = attempt
            const summary = `Verification failed (repair ${attempt}/2)`
            uiHooks?.onActivity?.({ kind: 'status', status: 'warning', title: summary })
            if (!uiHooks) writeNotice(`${summary} — ${describeVerification(outcome).split('\n')[0]}`)
            messages.push(
              userMessage(
                `The project's checks fail after your changes — the task is not done:\n\n${describeVerification(outcome)}\n\nFix what broke. Run the check yourself to confirm before you stop.`,
              ),
            )
            await runModelTurn()
            outcome = await runVerification(checks, root, controller.signal, gateGovernor, { onCheck: uiHooks?.onCheck })
            sessionTranscript.notice(describeVerification(outcome))
          }
          // A check the governor would not run proved nothing either way, and no
          // repair can change a policy — record the turn as unverified, not failed.
          // Same for a test runner with no tests to run.
          verifyResult = outcome.passed ? 'pass' : outcome.blocked || outcome.inconclusive ? 'skipped' : 'fail'
          const passedChecks = outcome.results
            .filter((result) => result.exitCode === 0 && !result.timedOut && !result.command.startsWith('[skipped]'))
            .map((result) => result.command)
          const verdict = outcome.passed
            ? `✓ verified — ${(passedChecks.length > 0 ? passedChecks : checks).join(', ')} pass${outcome.inconclusive ? ` (${outcome.inconclusive})` : ''}`
            : outcome.blocked
              ? `Not verified — ${checks.join(', ')} was not allowed to run: ${outcome.blocked}`
              : outcome.inconclusive
                ? `Not verified — ${outcome.inconclusive}`
                : `⚠ checks still failing after 2 repair attempts — ${describeVerification(outcome).split('\n')[0]}`
          uiHooks?.onActivity?.({ kind: 'status', status: outcome.passed ? 'completed' : 'warning', title: verdict })
          if (!uiHooks) writeNotice(verdict)
          if (outcome.blocked || outcome.inconclusive) sessionTranscript.notice(verdict)
        }
      }

      // Grounding: an answer that cites a file or line that does not exist is
      // sent back once to look it up (reason/grounding.ts). Checking costs no
      // model call; the repair turn is spent only when a citation is provably
      // wrong, and a clean check is never recorded as a pass.
      if (!persona && !escalated && !searched && autoVerify && !uiHooks?.planMode && !controller.signal.aborted) {
        const { checkGrounding, describeGrounding, extractCitations, groundingBriefing } = await import('../reason/grounding.ts')
        const ground = () => checkGrounding(extractCitations(lastAssistantText(messages, '')), process.cwd(), { touched: Object.keys(tracker.snapshot()) })
        const first = ground()
        grounding = { checked: first.checked, ungrounded: first.ungrounded.length }
        if (first.ungrounded.length > 0) {
          const summary = `The answer cites locations that do not exist — checking them (${describeGrounding(first)})`
          uiHooks?.onActivity?.({ kind: 'status', status: 'warning', title: summary })
          if (!uiHooks) writeNotice(`▸ ${summary}`)
          sessionTranscript.notice(summary)
          messages.push(userMessage(groundingBriefing(first)))
          await runModelTurn()
          const after = ground()
          grounding.afterRepair = after.ungrounded.length
          if (after.ungrounded.length > 0) {
            const line = `⚠ ${describeGrounding(after)} — still, after one correction`
            uiHooks?.onActivity?.({ kind: 'status', status: 'warning', title: line })
            if (!uiHooks) writeNotice(line)
            sessionTranscript.notice(line)
          }
        }
      }

      // Arithmetic: the same shape as grounding. A calculation the answer states
      // that does not hold is sent back once (reason/arithmetic.ts). Recomputing
      // costs no model call, and a clean check is never recorded as a pass.
      if (!persona && !escalated && !searched && autoVerify && !uiHooks?.planMode && !controller.signal.aborted) {
        const { calculationBriefing, checkArithmetic, describeCalculations } = await import('../reason/arithmetic.ts')
        const first = checkArithmetic(lastAssistantText(messages, ''))
        if (first.checked > 0) arithmetic = { checked: first.checked, wrong: first.wrong.length }
        if (first.wrong.length > 0) {
          const summary = `The answer's arithmetic does not hold — correcting it (${describeCalculations(first)})`
          uiHooks?.onActivity?.({ kind: 'status', status: 'warning', title: summary })
          if (!uiHooks) writeNotice(`▸ ${summary}`)
          sessionTranscript.notice(summary)
          messages.push(userMessage(calculationBriefing(first)))
          await runModelTurn()
          const after = checkArithmetic(lastAssistantText(messages, ''))
          if (arithmetic) arithmetic.afterRepair = after.wrong.length
          if (after.wrong.length > 0) {
            const line = `⚠ ${describeCalculations(after)} — still, after one correction`
            uiHooks?.onActivity?.({ kind: 'status', status: 'warning', title: line })
            if (!uiHooks) writeNotice(line)
            sessionTranscript.notice(line)
          }
        }
      }

      // The answer check: only for a question whose reply committed to a short
      // answer, and only when the turn changed nothing — a turn that edited
      // files was work, whatever it was phrased as.
      if (answerCheckPlanned && !escalated && !searched && !controller.signal.aborted && Object.keys(tracker.snapshot()).length === 0) {
        const { checkableAnswer } = await import('../reason/answer.ts')
        const reply = lastAssistantText(messages, '')
        if (checkableAnswer(reply) !== undefined) {
          answerCheck = await runAnswerCheck(userText, reply, messagesBefore, controller.signal, uiHooks).catch((error: unknown) => {
            // A check that could not run is not a verdict on the answer.
            const message = error instanceof Error ? error.message : String(error)
            sessionTranscript.notice(`Answer check could not run: ${redactText(message, 300)}`)
            return undefined
          })
        }
      }

      // Auto-preview: a turn that just scaffolded a static site under workspace/
      // should offer the live URL without the user asking — this also covers
      // ChatGPT-subscription turns, whose file writes never reach the `preview`
      // tool (Codex writes directly, and its own browser launch is sandboxed).
      if (!previewedThisTurn && !uiHooks?.planMode && !controller.signal.aborted && interactiveTerminal && !machineReadable) {
        try {
          const { findFreshPreviewTarget } = await import('../preview/autoPreview.ts')
          const target = findFreshPreviewTarget(turnStartedAt - 3_000)
          if (target) {
            const { prepareAutoPreview } = await import('../preview/prepare.ts')
            const { waitForHttp, checkRendered } = await import('../preview/readiness.ts')
            const prep = prepareAutoPreview(target)
            if (prep.kind === 'skip') {
              const line = `Preview skipped — ${prep.reason}`
              if (uiHooks) uiHooks.onActivity?.({ kind: 'status', status: 'warning', title: line })
              else writeNotice(`▸ ${line}`)
            } else {
              const { ensurePreviewServer } = await import('../preview/server.ts')
              const server = ensurePreviewServer(prep.serveRoot)
              const url = `${server.baseUrl}/${prep.servePath.split('/').map(encodeURIComponent).join('/')}`
              // Don't announce "ready" until the server actually answers and the
              // root paints something — a blank page is worse than no preview.
              const up = await waitForHttp(url, 8_000, controller.signal)
              let rendered = up.ok ? await checkRendered(url, controller.signal) : up
              // For a static page, *this* is the verification: it serves and it
              // paints. `detectChecks` only ever looked for typecheck/test
              // commands, and its CODE_EXT filter excludes .html/.css entirely,
              // so every static site elia built was reported done with nothing
              // having checked it. Don't overwrite a real command result.
              const ownsVerification = verifyResult === 'none' || verifyResult === 'skipped'

              // A page that does not paint is a broken deliverable, and for a
              // static site this render check is the *only* gate there is. The
              // command path has repaired its own failures for a long time;
              // this path only ever reported them, so a broken page was handed
              // over as "done" with a warning line and nothing else. The whole
              // recorded history shows it: every turn that ended verify:"fail"
              // had repairAttempts 0, because not one of them failed on a
              // command — they all failed here, where nothing repaired.
              if (!rendered.ok && ownsVerification && !persona && !escalated && autoVerify) {
                for (let attempt = 1; !rendered.ok && attempt <= 2 && !controller.signal.aborted; attempt += 1) {
                  repairAttempts = attempt
                  const summary = `Page did not render (repair ${attempt}/2)`
                  uiHooks?.onActivity?.({ kind: 'status', status: 'warning', title: summary })
                  if (!uiHooks) writeNotice(`${summary} — ${rendered.reason ?? 'the page did not paint'}`)
                  messages.push(
                    userMessage(
                      `The page you just built does not render — the task is not done.\n\nServed from: ${url}\nFailure: ${rendered.reason ?? 'the page loaded but painted nothing'}\n\nThis is the only check this deliverable has, so treat it as a failing test. Open the files you wrote and find the actual cause — a script error, a bad path to a stylesheet or module, markup that closes wrong, or a root element the script never fills. Fix it in the files that already exist; do not rebuild the page somewhere else.`,
                    ),
                  )
                  await runModelTurn()
                  const retry = await waitForHttp(url, 8_000, controller.signal)
                  rendered = retry.ok ? await checkRendered(url, controller.signal) : retry
                }
                const verdict = rendered.ok
                  ? '✓ page renders after repair'
                  : `⚠ page still not rendering after 2 repair attempts — ${rendered.reason ?? 'it painted nothing'}`
                uiHooks?.onActivity?.({ kind: 'status', status: rendered.ok ? 'completed' : 'warning', title: verdict })
                if (!uiHooks) writeNotice(verdict)
              }

              if (ownsVerification) {
                verifyResult = rendered.ok ? 'pass' : 'fail'
                sessionTranscript.notice(rendered.ok ? `Render check passed — ${url}` : `Render check failed — ${rendered.reason ?? 'it painted nothing'} (${url})`)
              }
              if (rendered.ok) {
                const detail = url
                if (uiHooks) uiHooks.onActivity?.({ kind: 'status', status: 'completed', title: 'Preview ready', detail })
                else writeNotice(`▸ Preview ready — ${url}${prep.note ? ` (${prep.note})` : ''} · live-reloading as files change`)
              } else {
                const line = `Preview not ready — ${rendered.reason ?? 'the page did not render'}`
                if (uiHooks) uiHooks.onActivity?.({ kind: 'status', status: 'warning', title: line })
                else writeNotice(`▸ ${line}`)
              }
            }
          }
        } catch {
          // Preview is a convenience; never fail a completed turn over it.
        }
      } else if (previewedUrl && !persona && !escalated && !uiHooks?.planMode && !controller.signal.aborted && (verifyResult === 'none' || verifyResult === 'skipped')) {
        // The model opened the page itself, so the auto-preview above stood
        // down — but that render check is the only verification a static page
        // has, and a page the model previewed used to leave the turn recorded
        // "verification: none". Check the page as the turn left it: preview
        // checked it when it opened it, and a later edit can still break it.
        try {
          const { checkRendered } = await import('../preview/readiness.ts')
          // The model chose this URL, so it may well be a dev server rather than
          // elia's static server — don't fail it on the unbuilt-bundler
          // heuristic, which is only ever a real failure for a static server.
          const rendered = await checkRendered(previewedUrl, AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]), { staticServer: false })
          verifyResult = rendered.ok ? 'pass' : 'fail'
          // Status lines reach only the live UI. Without this, a turn recorded
          // "verification: fail" and nothing anywhere said what had failed.
          sessionTranscript.notice(rendered.ok ? `Render check passed — ${previewedUrl}` : `Render check failed — ${rendered.reason ?? 'it painted nothing'} (${previewedUrl})`)
          if (!rendered.ok && !machineReadable) {
            const line = `Page no longer renders — ${rendered.reason ?? 'it painted nothing'}`
            if (uiHooks) uiHooks.onActivity?.({ kind: 'status', status: 'warning', title: line })
            else writeNotice(`▸ ${line}`)
          }
        } catch {
          // Preview is a convenience; never fail a completed turn over it.
        }
      }

      // A failure this turn hit and then put right — a command that only worked
      // another way, checks that failed until a fix — becomes a lesson every
      // later session starts with, and the user sees it land. Interactive turns
      // used to forget these: note_lesson is voluntary and almost never called.
      if (!persona && !escalated && !uiHooks?.planMode && !controller.signal.aborted) {
        const { learnFromTurn } = await import('../autonomy/turnLearning.ts')
        const learned = await learnFromTurn({
          provider: config.tiers.fast.provider,
          messages,
          fromIndex: messagesBefore.length,
          request: requestText,
          outcome: { verify: verifyResult, repairAttempts },
          cwd: process.cwd(),
          signal: controller.signal,
          // Output of a `!cmd` run is carried into the request; it is not the user's words.
          userWords: requestText.replace(/<local-command>[\s\S]*?<\/output>/g, ''),
          onReflecting: () => uiHooks?.onActivity?.({ kind: 'status', status: 'updated', title: 'Learning from this turn' }),
        })
        if (learned.usage) {
          const { recordUsage } = await import('../usage.ts')
          recordUsage(learned.usage, config.tiers.fast.model)
        }
        for (const lesson of learned.lessons) {
          const line = `✦ learned: ${lesson}`
          sessionTranscript.notice(line)
          if (uiHooks) uiHooks.onActivity?.({ kind: 'status', status: 'completed', title: line })
          else writeNotice(line)
        }
      }

      taskSessions.update(task.id, { status: 'done', action: 'Finished', detail: 'Request completed and session saved' })
      emitEvent('turn_finished', { taskId: task.id, sessionId, outcome: 'completed' })
    } catch (error) {
      const detail = redactText(error instanceof Error ? error.message : String(error), 2000)
      sessionTranscript.error(detail)
      if (stopRequested || controller.signal.aborted) {
        taskSessions.update(task.id, { status: 'paused', action: 'Stopped', detail: 'Stopped by operator; no further tool calls will run' })
        emitEvent('turn_finished', { taskId: task.id, sessionId, outcome: 'aborted' })
      } else {
        taskSessions.update(task.id, { status: 'failed', action: 'Failed', detail, error: detail })
        emitEvent('turn_finished', { taskId: task.id, sessionId, outcome: 'failed', error: redactText(detail, 2000) })
        throw error
      }
    } finally {
      unregisterControls()
      unregisterShutdown()
      setActiveTracker(undefined)
      // A turn that threw or was stopped never reached the verify gate, so its
      // writes went unchecked and unmentioned. Say what it left, and how to undo
      // it — the rewind point below is recorded for every ending, not just success.
      const endStatus = taskSessions.get(task.id)?.status
      if (endStatus === 'failed' || endStatus === 'paused') {
        try {
          const touched = Object.keys(tracker.snapshot())
          const { parseChangedFiles } = await import('../reason/structural.ts')
          const { describeInterruptedTurn } = await import('../autonomy/interruptedTurn.ts')
          const line = describeInterruptedTurn({
            ending: endStatus === 'failed' ? 'failed' : 'stopped',
            touched,
            rewindIndex: checkpoints.length,
            structural: touched.length > 0 ? parseChangedFiles(touched) : undefined,
            cwd: process.cwd(),
          })
          if (line) {
            sessionTranscript.notice(line)
            if (uiHooks) uiHooks.onActivity?.({ kind: 'status', status: 'warning', title: line })
            else writeNotice(`▸ ${line}`)
          }
        } catch {
          // Reporting what a dead turn left must never replace the error that killed it.
        }
      }
      sessionTranscript.notice(`Turn outcome: ${taskSessions.get(task.id)?.status ?? 'unknown'}; verification: ${verifyResult}; touched files: ${Object.keys(tracker.snapshot()).join(', ') || 'none'}`)
      sessionTranscript.endTurn()
      pushHeartbeat(false, taskSessions.get(task.id)?.action ?? 'Idle at prompt')
      if (!persona) {
        const { recordOutcome, domainsOf } = await import('../autonomy/outcomes.ts')
        const changedPaths = Object.keys(tracker.snapshot())
        // A turn that threw (a provider error, a context overflow) used to be
        // recorded with no trace of it: zero tool errors, verify "none", not
        // aborted — so it counted as *clean*, credited every lesson it saw, and
        // earned a positive trajectory reward. Seen live: the prompt after a
        // context overflow died before generating a token and was logged
        // `clean: true`. Learning from that teaches the wrong thing.
        const turnFailed = taskSessions.get(task.id)?.status === 'failed'
        recordOutcome({
          corr: task.id,
          prompt: redactText(userText, 120),
          filesChanged: changedPaths.length,
          domains: domainsOf(changedPaths),
          editRetries: editRetryCount,
          toolErrors: toolErrorCount,
          verify: verifyResult,
          repairAttempts,
          aborted: stopRequested || controller.signal.aborted || escalatedAborted,
          ...(turnFailed ? { failed: true } : {}),
        })
        const cleanTurn = !turnFailed && toolErrorCount === 0 && editRetryCount === 0 && (verifyResult === 'pass' || verifyResult === 'none' || verifyResult === 'skipped') && !(stopRequested || controller.signal.aborted || escalatedAborted)
        try {
          const { recordLessonExposure } = await import('../autonomy/lessonEfficacy.ts')
          const { consumeInjectedLessonKeys, consumeHeldOutLessonKeys } = await import('../autonomy/lessons.ts')
          recordLessonExposure(task.id, consumeInjectedLessonKeys(), { verify: verifyResult, clean: cleanTurn, heldOut: consumeHeldOutLessonKeys() })
        } catch {
          // best-effort
        }
        try {
          const { recordTrajectory, deriveReward, refSystemPrompt } = await import('../trajectory/record.ts')
          const { ELIA_ROOT } = await import('../config.ts')
          const snap = tracker.snapshot()
          const touched = await Promise.all(
            Object.entries(snap).map(async ([p, before]) => {
              const file = Bun.file(p)
              const after = (await file.exists()) ? await file.text() : null
              return { path: p, before, after }
            }),
          )
          recordTrajectory({
            corr: task.id,
            kind: 'interactive',
            prompt: userText,
            // Grouping key only — the base interactive prompt varies by mode, not per turn.
            systemPromptRef: refSystemPrompt(mode),
            tools: toolTrace,
            touched,
            verify: verifyResult,
            cwdIsEliaRoot: process.cwd() === ELIA_ROOT,
            ...(grounding ? { grounding } : {}),
            ...(arithmetic ? { arithmetic } : {}),
            ...(answerCheck ? { answerCheck } : {}),
            reward: deriveReward({
              toolErrors: toolErrorCount,
              editRetries: editRetryCount,
              verify: verifyResult,
              repairAttempts,
              aborted: stopRequested || controller.signal.aborted || escalatedAborted,
              ...(turnFailed ? { completionState: 'failed' as const } : {}),
            }),
          })
        } catch {
          // Trajectory capture is best-effort; recordTrajectory also guards itself.
        }
      }
      // Every ending gets a rewind point. It used to be recorded after this
      // try/finally, so a turn that threw or was stopped — the ones most likely
      // to leave files half-written — was the one `/rewind` could not undo.
      checkpoints.push({
        turn: checkpoints.length,
        at: Date.now(),
        label: userText.length > 60 ? `${userText.slice(0, 59)}…` : userText,
        messagesBefore,
        files: tracker.snapshot(),
      })
      try {
        await saveCheckpoints(sessionId, checkpoints)
      } catch (error) {
        // Never let a failed save replace the error that ended the turn.
        if (endStatus !== 'failed') throw error
      }
    }
  }

  if (oneShotPrompt) {
    let commandToRun = oneShotPrompt

    // Non-TTY (piped/scripted) runs can't answer a prompt, so they skip straight
    // to execution — same as today. A real terminal gets the same risk-gated
    // ask as the interactive loop below, unless --yolo skips it.
    if (!hasFlag('--yolo', '-y') && process.stdin.isTTY) {
      const { risky, reason } = await classifyCommandRisk(commandToRun)
      if (risky) {
        const confirmPrompt = createSlashPrompt([])
        const label = `${reason ? `${redactText(reason, 500)}\n` : ''}About to: "${redactText(commandToRun, 500)}" — run it? [y]es / [n]o / [e]dit: `
        const result = await confirmOnce(confirmPrompt, label)
        confirmPrompt.close()
        if (result.action === 'reject') {
          writeNotice('Skipped.')
          return
        }
        if (result.action === 'amend') commandToRun = result.feedback
      }
    }

    try {
      await runCheckpointedTurn(commandToRun, process.stdin.isTTY ? async (assessment, request) => {
        const actionPrompt = createSlashPrompt([])
        try {
          const result = await confirmOnce(actionPrompt, actionApprovalPrompt(assessment, request))
          return result.action === 'approve'
        } finally {
          actionPrompt.close()
        }
      } : undefined)
    } catch (err) {
      writeError(`Error: ${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
    }
    await persistInteractiveSession()
    const taskSummary = renderTaskSummary(taskSessions)
    const contextLine = renderContextStatus(messages, await countEpisodes(sessionId), compactionThresholdFor(config.model))
    writeUsageLine(taskSummary ? `${contextLine}  ·  ${dim(taskSummary)}` : contextLine)
    await printTurnProfileReport()
    return
  }

  if (process.stdout.isTTY && !plainOutput && !machineReadable && !interactiveTerminal) await playIntro()
  // The live Ink REPL renders its own header/greeting; the classic readline path
  // keeps the workspace-panel snapshot.
  if (!machineReadable && !quietOutput && !interactiveTerminal) {
    process.stdout.write(`${renderWorkspacePanel({ sessionId, mode, providerLabel: config.providerLabel, model: config.model })}\n`)
  }
  if (!interactiveTerminal && !machineReadable && !plainOutput && !process.stdin.isTTY && !process.stdout.isTTY && (process.env.MSYSTEM || process.env.TERM_PROGRAM === 'mintty')) {
    // Git Bash's mintty hands Bun pipes, not a console, so the live UI can't
    // start and the line-mode REPL takes over — say why, once.
    writeNotice('This terminal (Git Bash / mintty) is not a real console, so elia is in line mode. For the full UI run `winpty elia`, or use Windows Terminal / PowerShell.')
  }
  if (!interactiveTerminal) {
    writeNotice(
      mode === 'cyber'
        ? 'cyber mode on — authorized security testing, vuln research, and CTFs only. type a prompt, "/" to see commands, or "exit" to quit'
        : mode === 'sports'
          ? 'sports mode on — evidence-aware match, scouting, performance, league, event, and sports-business analysis. type a prompt, "/" to see commands, or "exit" to quit'
          : mode === 'fitness'
            ? 'fitness mode on — conservative training, habit, recovery, and wellbeing support; not medical advice. type a prompt, "/" to see commands, or "exit" to quit'
            : mode === 'battmann'
              ? 'Battmann mode on — strategic risk intelligence across trade, geopolitics, markets, supply chain, policy, and commodities. type a prompt, "/" to see commands, or "exit" to quit'
              : 'dev mode on — building, debugging, testing, browser, and task workflows available. type a prompt, "/" to see commands, or "exit" to quit (Ctrl+C also works)',
    )
    writeNotice(
      replMode === 'auto'
        ? 'auto mode (--yolo) — preliminary risk checks are skipped; safe work runs immediately, while governed irreversible actions still require explicit approval. "/settings" → Risk checks to turn checks back on.'
        : 'manual mode — elia flags risky commands and asks before running them; safe commands just run. "/settings" → Risk checks for zero prompts.',
    )
    if (mode === 'dev') {
      try {
        const { detectGitHubContext, renderGitHubBanner } = await import('../github/context.ts')
        const line = renderGitHubBanner(await detectGitHubContext(process.cwd()))
        if (line) writeNotice(line)
      } catch {
        // GitHub context is a convenience readout, never a startup blocker.
      }
    }
  }

  async function applyModelChoice(providerName: string, model?: string, options: { anyway?: boolean } = {}): Promise<void> {
    const previous = { providerName: config.providerName, model: config.model, routingMode: config.routingMode }
    const result = switchModel({ providerName, model })
    if (!result.ok) writeError(result.error)
    else {
      // What gets picked is saved for every later launch, so it has to answer
      // first. A rate-limited free model used to be saved as readily as a
      // working one, and every restart then came back on it.
      if (providerName !== 'auto' && !options.anyway) {
        const chosen = { providerName: config.providerName, model: config.model }
        // A local model is read from disk into memory on its first request, which
        // can take minutes for a large one — that is loading, not failing to answer.
        const local = config.providerName === 'ollama'
        writeNotice(local ? `Loading ${config.model} in Ollama and checking it answers (the first load can take a minute)…` : `Checking that ${result.label} answers…`)
        const { describeProbeFailure, probeModel } = await import('../providers/probe.ts')
        const probe = await probeModel(config.provider, local ? { timeoutMs: 300_000 } : {})
        if (!probe.ok) {
          const failure = describeProbeFailure(result.label, probe)
          const anyway = `/model ${chosen.providerName} ${chosen.model} --anyway`
          const restored = switchModel({ providerName: previous.providerName, model: previous.model })
          if (restored.ok) {
            config.routingMode = previous.routingMode
            setCurrentUsageModel(config.model)
            prewarmActiveProvider()
            writeError(`Not switched: ${failure}. Still on ${restored.label}. To use it anyway: ${anyway}`)
          } else {
            setCurrentUsageModel(config.model)
            writeError(`${failure}. Using it for this session only (not saved), since ${previous.providerName} (${previous.model}) could not be restored either.`)
          }
          return
        }
      }
      setCurrentUsageModel(config.model)
      if (providerName !== 'auto') {
        // Persist the switch so it survives a restart, mirroring the codex
        // subscription path and `elia config set --provider`. Without this a
        // `/model` change silently reverted to the .env / config-file value on
        // the next launch.
        writeUserConfig({
          ELIA_PROVIDER: config.providerName,
          ELIA_MODEL: config.model,
          ELIA_BASE_URL: config.providerName === 'custom' ? process.env.ELIA_BASE_URL : undefined,
        })
        process.env.ELIA_PROVIDER = config.providerName
        process.env.ELIA_MODEL = config.model
        if (config.providerName !== 'custom') delete process.env.ELIA_BASE_URL
      }
      writeNotice(`Model switched: ${result.label}`)
      // The newly resolved provider is a cold client — warm it before the next turn.
      prewarmActiveProvider()
    }
  }

  function activateCodexSubscription(model = 'default'): void {
    const switched = switchModel({ providerName: 'codex', model })
    if (!switched.ok) {
      writeError(switched.error)
      return
    }
    setCurrentUsageModel(config.model)
    writeUserConfig({ ELIA_PROVIDER: 'codex', ELIA_MODEL: model, ELIA_BASE_URL: undefined })
    process.env.ELIA_PROVIDER = 'codex'
    process.env.ELIA_MODEL = model
    delete process.env.ELIA_BASE_URL
    writeNotice(`Model switched: ${switched.label}`)
    // Bring the Codex app-server up now so the first subscription turn does not
    // pay process spawn + initialize on its critical path.
    prewarmActiveProvider()
  }

  async function handleModelCommand(argLine: string): Promise<void> {
    const words = argLine.split(/\s+/).filter(Boolean)
    // `--anyway` skips the check that the model answers (see applyModelChoice).
    const anyway = words.includes('--anyway')
    const args = words.filter((word) => word !== '--anyway')

    async function chooseModelForProvider(providerName: string): Promise<void> {
      const discovery = await listProviderModels(providerName)
      const fallbackModel = providerName === config.providerName ? config.model : providerPresetDefaultModel(providerName)
      if (discovery.models.length === 0) {
        if (providerName === 'ollama') {
          // Only a pulled model can run; there is no default to fall back to.
          writeNotice(discovery.error ?? 'Ollama has no models on this machine — pull one first, e.g. `ollama pull qwen3`.')
          return
        }
        if (discovery.error) writeNotice(`Could not list ${providerName} models: ${discovery.error}`)
        if (fallbackModel) await applyModelChoice(providerName, fallbackModel, { anyway })
        else writeNotice(`No model list or default model is available for ${providerName}. Use /model ${providerName} <model-id>.`)
        return
      }
      const currentModel = providerName === config.providerName
        ? config.model
        : discovery.models.find((model) => model.isDefault)?.id ?? fallbackModel
      const modelOptions = discovery.models.map((model) => ({
        label: model.id === currentModel ? `${model.id} (current)` : model.id,
        detail: model.detail ?? model.name ?? model.ownedBy ?? 'available model',
        value: model.id,
      }))
      const result = await pick(`Models for ${providerName} (${modelOptions.length})`, modelOptions, Math.max(0, modelOptions.findIndex((option) => option.value === currentModel)))
      if (result.type === 'select') {
        const warning = discovery.models.find((model) => model.id === result.value)?.warning
        if (warning) writeNotice(warning)
        if (providerName === 'codex') activateCodexSubscription(result.value)
        else await applyModelChoice(providerName, result.value, { anyway })
      }
      else if (result.type === 'unavailable') writeNotice(`${providerName} exposes ${discovery.models.length} selectable model(s).`)
    }

    if (args.length === 0) {
      await detectOllama()
      const selectableProviderNames = PROVIDER_PRESET_NAMES.filter((name) => name !== 'codex')
      const currentIndex = config.routingMode === 'auto'
        ? 0
        : config.providerName === 'codex'
          ? 1
          : selectableProviderNames.indexOf(config.providerName) + 2
      const autoRouting = config.routingMode === 'auto'
      const options = [
        {
          label: autoRouting ? 'auto (current)' : 'auto',
          detail: autoRouting
            ? `leads with ${config.providerLabel}, falls back across every ready provider`
            : 'transparent fallback across every ready provider',
          value: 'auto',
        },
        {
          label: 'ChatGPT subscription (Codex)',
          detail: 'use your signed-in ChatGPT plan as Elia’s active model',
          value: 'codex-subscription',
        },
        ...selectableProviderNames.map((name) => ({
        label: name !== config.providerName ? name : autoRouting ? `${name} (leading auto)` : `${name} (current)`,
        detail: providerDetail(name),
          value: name,
        })),
      ]
      const result = await pick('Switch model', options, Math.max(0, currentIndex))
      if (result.type === 'select') {
        if (result.value === 'auto') await applyModelChoice('auto')
        else if (result.value === 'codex-subscription') {
          await chooseModelForProvider('codex')
        }
        else await chooseModelForProvider(result.value)
        return
      }
      if (result.type === 'unavailable') {
        const rows = [
          [config.routingMode === 'auto' ? `${gold('●')} auto` : '  auto', 'transparent fallback', dim(config.providerLabel)],
          ...PROVIDER_PRESET_NAMES.map((name) => [
            name === config.providerName && config.routingMode !== 'auto' ? `${gold('●')} ${name}` : `  ${name}`,
            isProviderPresetConfigured(name) ? providerReadiness(name) : dim(providerReadiness(name)),
            dim(providerPresetDefaultModel(name) ?? ''),
          ]),
        ]
        for (const line of table([{ header: 'provider' }, { header: 'status' }, { header: 'default model' }], rows)) {
          writeUsageLine(`  ${line}`)
        }
        writeNotice(`Current: ${config.providerLabel}${config.routingMode === 'auto' ? ' · auto fallback on' : ''}. Use "/model auto" to enable transparent failover.`)
      }
      return
    }

    const [first, second] = args
    if (first === 'auto') await applyModelChoice('auto')
    else if (first === 'codex') {
      if (second) activateCodexSubscription(second)
      else await chooseModelForProvider('codex')
    }
    else if (PROVIDER_PRESET_NAMES.includes(first!)) {
      if (second) await applyModelChoice(first!, second, { anyway })
      else await chooseModelForProvider(first!)
    } else await applyModelChoice(config.providerName, first, { anyway })
  }

  const prompt = createSlashPrompt(allSlashCommands())

  async function handleSkillsPicker(): Promise<void> {
    const { listLoadedSkills } = await import('../skills/loader.ts')
    const { tryListSkillBundles } = await import('../skills/bundles.ts')
    const { USER_SKILLS_DIR, PROJECT_SKILLS_DIR } = await import('../skills/paths.ts')
    const skills = listLoadedSkills()
    const bundlesResult = tryListSkillBundles()
    if (bundlesResult.error) writeNotice(`Could not read skill bundles: ${bundlesResult.error}`)
    const bundles = bundlesResult.bundles
    if (skills.length === 0 && bundles.length === 0) {
      writeNotice(`No loaded skills. Add a validated *.skill.ts file to ${PROJECT_SKILLS_DIR} for this project or ${USER_SKILLS_DIR} for all projects, then restart Elia.`)
      return
    }

    const active = new Set(selectedSkillNames ?? skills.map((skill) => skill.name))
    const options = [
      { label: selectedSkillNames === undefined ? 'all loaded skills (current)' : 'all loaded skills', detail: 'make every loaded skill available', value: '__all__' },
      ...bundles.map((bundle) => ({
        label: active.has(bundle.name) ? `${bundle.name} (current)` : `${bundle.name} (bundle)`,
        detail: `${bundle.description ?? 'skill bundle'} · ${bundle.skills.join(', ')}`,
        value: `__bundle:${bundle.name}`,
      })),
      ...skills.map((skill) => ({
        label: active.has(skill.name) && active.size === 1 ? `${skill.name} (current)` : skill.name,
        detail: `${skill.source} · ${skill.file}`,
        value: skill.name,
      })),
    ]
    const result = await pick('Skills for subsequent turns', options)
    if (result.type !== 'select') return
    const selection = result.value as string
    selectedSkillNames = selection === '__all__' ? undefined : [selection.startsWith('__bundle:') ? selection.slice('__bundle:'.length) : selection]
    writeNotice(selectedSkillNames ? `Skill selection for subsequent turns: ${selectedSkillNames[0]}` : 'All loaded skills are available for subsequent turns.')
  }

  /** Shared by the `/mode` and `/betamode` pickers, their direct `<name>` forms, and the /settings mode picker so every path stays in sync. */
  function applyModePersonaChoice(choice: string): void {
    if (choice === 'cyber') {
      mode = 'cyber'
      persona = undefined
      writeNotice(
        'cyber mode on — elia will help with authorized security testing, vuln research, and CTFs. Only point it at systems you own or are explicitly authorized to test.',
      )
      return
    }
    if (choice === 'sports') {
      mode = 'sports'
      persona = undefined
      writeNotice('sports mode (beta) on — evidence-aware match, scouting, performance, league, event, and sports-business analysis. /mode dev to leave.')
      return
    }
    if (choice === 'fitness') {
      mode = 'fitness'
      persona = undefined
      writeNotice('fitness mode (beta) on — conservative training, habit, recovery, and wellbeing support; not medical advice. /mode dev to leave.')
      return
    }
    if (choice === 'battmann') {
      mode = 'battmann'
      persona = undefined
      writeNotice('Battmann mode on — strategic intelligence across trade, geopolitics, financial markets, supply chain, policy, and commodities. Every score and claim is sourced or labelled an estimate; elia surfaces intelligence, you decide.')
      return
    }
    if (choice === 'tech') {
      const hadSpecialist = persona !== undefined || mode !== 'dev'
      mode = 'dev'
      persona = undefined
      writeNotice(hadSpecialist ? "Tech and Dev are the same agent — back to dev mode." : 'dev mode remains active.')
      return
    }
    const requestedPersona = choice === 'cybersecurity' ? 'cyber' : choice
    if (isAgentPersona(requestedPersona)) {
      persona = requestedPersona
      writeNotice(`${persona.charAt(0).toUpperCase()}${persona.slice(1)} agent on — elia will answer in this persona until /mode dev.`)
      return
    }
    const hadSpecialist = persona !== undefined || mode !== 'dev'
    mode = 'dev'
    persona = undefined
    writeNotice(hadSpecialist ? 'Specialist mode/persona off — back to dev mode.' : 'dev mode remains active.')
  }

  // The core modes live in `/mode`. Everything experimental — the beta modes and
  // every agent persona — moves to `/betamode` so the primary picker stays short.
  const MODE_ENTRIES: { label: string; detail: string; value: string }[] = [
    { label: 'Dev', detail: "elia's development mode — building, debugging, testing, browser & task workflows", value: 'dev' },
    { label: 'Cyber', detail: 'authorized security testing, vuln research, CTFs', value: 'cyber' },
    { label: 'Battmann', detail: 'strategic risk intelligence — trade, geopolitics, markets, supply chain', value: 'battmann' },
  ]

  const BETA_MODE_ENTRIES: { label: string; detail: string; value: string }[] = [
    { label: 'Sports', detail: 'beta — evidence-aware sports intelligence and operations', value: 'sports' },
    { label: 'Fitness', detail: 'beta — conservative fitness planning and wellbeing support', value: 'fitness' },
    { label: 'Marketing', detail: 'Marketing agent persona', value: 'marketing' },
    { label: 'Finance', detail: 'Finance agent persona', value: 'finance' },
    { label: 'Business', detail: 'Business Analyst persona', value: 'business' },
    { label: 'Data', detail: 'Data Analyst persona', value: 'data' },
    { label: 'Research', detail: 'Research persona', value: 'research' },
    { label: 'Cybersecurity', detail: 'Cybersecurity persona', value: 'cybersecurity' },
    { label: 'Automation', detail: 'Automation persona', value: 'automation' },
    { label: 'Communications', detail: 'Communications persona', value: 'communications' },
    { label: 'AI / ML', detail: 'AI/ML persona', value: 'ai' },
    { label: 'Production', detail: 'Production Engineering persona', value: 'production' },
  ]

  async function runModePicker(
    title: string,
    entries: { label: string; detail: string; value: string }[],
  ): Promise<void> {
    const currentValue = persona ? (persona === 'cyber' ? 'cybersecurity' : persona) : mode
    const currentIndex = Math.max(0, entries.findIndex((entry) => entry.value === currentValue))
    const options = entries.map((entry) => ({
      ...entry,
      label: entry.value === currentValue ? `${entry.label} (current)` : entry.label,
    }))
    const result = await pick(title, options, currentIndex)
    if (result.type === 'select') applyModePersonaChoice(result.value)
    else if (result.type === 'unavailable') writeNotice(`Current: ${currentValue}`)
  }

  const handleModePersonaPicker = (): Promise<void> => runModePicker('Mode', MODE_ENTRIES)
  const handleBetaModePicker = (): Promise<void> => runModePicker('Beta modes & personas', BETA_MODE_ENTRIES)

  /** Set from the /settings risk-checks picker. */
  function applyReplModeChoice(value: 'auto' | 'manual'): void {
    replMode = value
    writeNotice(
      value === 'auto'
        ? 'Auto mode — preliminary risk checks are skipped. Safe work runs immediately; governed irreversible actions still require explicit approval. "/settings" → Risk checks to re-enable checks.'
        : 'Manual mode — elia flags risky commands and asks first; safe commands just run.',
    )
  }

  async function handleReplModePicker(): Promise<void> {
    const options = [
      { label: replMode === 'manual' ? 'Manual (current)' : 'Manual', detail: 'flags risky commands, asks before running them', value: 'manual' },
      { label: replMode === 'auto' ? 'Auto (current)' : 'Auto', detail: 'skips the pre-flight prompt; governed irreversible actions still require approval', value: 'auto' },
    ]
    const result = await pick('Risk checks', options, replMode === 'auto' ? 1 : 0)
    if (result.type === 'select') applyReplModeChoice(result.value as 'auto' | 'manual')
    else if (result.type === 'unavailable') writeNotice(`Current: ${replMode}`)
  }

  async function handleProviderSettings(): Promise<void> {
    const saved = savedProviderNames()
    const options = [
      { label: 'ChatGPT subscription (Codex)', detail: 'sign in now with your ChatGPT plan; no API key is copied into Elia', value: 'codex-login' },
      { label: 'Add or update provider', detail: 'enter a hidden API key and choose a model', value: 'add' },
      ...saved.map((provider) => ({ label: `Remove ${provider}`, detail: 'delete its saved API key', value: `remove:${provider}` })),
    ]
    const result = await pick('Provider connections', options)
    if (result.type === 'unavailable') {
      writeNotice(saved.length > 0 ? `Saved API providers: ${saved.join(', ')}. ChatGPT subscription sign-in: elia codex-login` : 'No saved API providers. ChatGPT subscription sign-in: elia codex-login')
      return
    }
    if (result.type !== 'select') return
    if (result.value === 'codex-login') {
      // pick() has released its key handler. The dormant REPL prompt does not
      // consume input, so the user-controlled Codex login can own the terminal.
      if (await runCodexLogin()) activateCodexSubscription()
      return
    }
    if (result.value === 'add') {
      const configured = await interactiveProviderSetup('settings')
      if (!configured) return
      const switched = switchModel({ providerName: configured.provider, model: configured.model })
      if (switched.ok) writeNotice(`Active model: ${switched.label} · ${configured.model}`)
      else writeError(`Saved the provider, but could not activate it in this session: ${switched.error}`)
      return
    }
    const provider = result.value.slice('remove:'.length)
    const confirmation = await confirmOnce(prompt, `Remove saved API credentials for ${provider}? This cannot be undone from Elia. [y]es / [n]o: `)
    if (confirmation.action !== 'approve') {
      writeNotice('Kept the saved provider credentials.')
      return
    }
    try {
      const removed = removeProviderConfiguration(provider)
      writeNotice(removed.removed ? `Removed saved credentials for ${provider}.` : `No saved credentials found for ${provider}.`)
      writeNotice('The API key value was never displayed.')
    } catch (error) {
      writeError(error instanceof Error ? error.message : String(error))
    }
  }

  /** The settings-row detail for the compact/clear entries: how much conversation there is, then what the action does. */
  function conversationDetail(action: string): string {
    return `${messages.length} message${messages.length === 1 ? '' : 's'} · ${action}`
  }

  /** Top-level settings screen: every switchable setting in one arrow-key menu, looping until esc/cancel. */
  async function handleSettingsCommand(): Promise<void> {
    while (true) {
      const options = [
        { label: 'Risk checks', detail: replMode, value: 'replMode' },
        { label: 'Model & provider', detail: `${config.routingMode === 'auto' ? 'auto · ' : ''}${config.providerLabel} · ${config.model}`, value: 'model' },
        { label: 'Provider connections', detail: `${savedProviderNames().length} API key(s) · ChatGPT subscription`, value: 'providers' },
        { label: 'Skills', detail: selectedSkillNames ? selectedSkillNames.join(', ') : 'all loaded', value: 'skills' },
        { label: 'Compact conversation', detail: conversationDetail('summarise it to free context'), value: 'compact' },
        { label: 'Clear conversation', detail: conversationDetail('start fresh; this one stays resumable'), value: 'clear' },
      ]
      const result = await pick('Settings', options)
      if (result.type === 'unavailable') {
        for (const option of options) writeUsageLine(`  ${option.label}: ${option.detail}`)
        return
      }
      if (result.type !== 'select') return
      if (result.value === 'replMode') await handleReplModePicker()
      else if (result.value === 'model') await handleModelCommand('')
      else if (result.value === 'providers') await handleProviderSettings()
      else if (result.value === 'skills') await handleSkillsPicker()
      else if (result.value === 'compact') {
        writeNotice(await compactNow(undefined))
        return
      } else if (result.value === 'clear') {
        writeNotice(await clearClassicScreen())
        return
      }
    }
  }

  /** `/clear` for the plain readline REPL: the same fresh conversation, plus a wiped terminal. */
  async function clearClassicScreen(): Promise<string> {
    const text = await clearConversation()
    if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[3J\x1b[H')
    return text
  }

  /** `/resume [id]` for the plain readline REPL — the same switch, with its own picker. */
  async function resumeClassicSession(asked: string | undefined): Promise<string> {
    if (asked) {
      const { listSessionIds, resolveSessionId } = await import('../sessionCatalog.ts')
      const lookup = resolveSessionId(asked, listSessionIds())
      if (lookup.kind === 'ambiguous') return `"${asked}" matches ${lookup.ids.length} sessions: ${lookup.ids.slice(0, 6).join(', ')}. Use more of the id.`
      if (lookup.kind === 'missing') return `No saved conversation starting with "${asked}" in this directory.`
      return (await resumeIntoSession(lookup.id)).text
    }
    const options = await resumablePickerOptions()
    if (options.length === 0) return 'No other saved conversations in this directory yet.'
    const { pick } = await import('../ui/picker.ts')
    const chosen = await pick('Resume a conversation', options, 0, { searchable: true })
    if (chosen.type === 'cancel') return 'Cancelled.'
    if (chosen.type === 'unavailable') return `This terminal cannot draw the picker. Name one instead: /resume <id> — see them with /sessions.`
    return (await resumeIntoSession(chosen.value)).text
  }

  /** Run a read-only command and return its stdout, or '' if it fails / isn't installed. */
  async function runShellQuiet(command: string): Promise<string> {
    try {
      const { runShell } = await import('../shell.ts')
      const result = await runShell(command, 15_000, process.cwd())
      return result.exitCode === 0 ? result.stdout : ''
    } catch {
      return ''
    }
  }

  // Lazy, in-process handle for this REPL so `/quickchat` can ask about the
  // live conversation. Registered on first use — creating it up front would add
  // bus noise to every startup even when nobody runs quickchat.
  let registeredQuickchatHandle: SessionHandle | undefined
  async function registerQuickchatSession(): Promise<SessionHandle | undefined> {
    if (registeredQuickchatHandle) return registeredQuickchatHandle
    try {
      const { getSessionBus } = await import('../session/bus.ts')
      const bus = getSessionBus()
      const existing = bus.resolve(sessionId)
      if (existing) {
        registeredQuickchatHandle = existing
        return existing
      }
      const { makeSessionName } = await import('../session/types.ts')
      const handle = bus.create(makeSessionName('main'))
      bus.setActiveSession(handle.id)
      registeredQuickchatHandle = handle
      return handle
    } catch {
      return undefined
    }
  }

  // Answers the slow quickchat kinds in the background and streams the result
  // into the Ink overlay panel; the active session is never awaited on it.
  async function runQuickchatOverlay(input: string, session: SessionHandle, parsed: ParsedQuickchatCommand): Promise<void> {
    const [{ handleQuickchatCommand }, { quickchatStore }] = await Promise.all([
      import('../quickchat/quickchat.ts'),
      import('../ui/app/quickchatOverlayStore.ts'),
    ])
    const question = parsed.kind === 'session-ask' ? parsed.question : parsed.kind === 'ask' ? parsed.question : 'Risk review of this session'
    const label = parsed.kind === 'session-ask' ? parsed.targetSession : session.name
    quickchatStore.open(question, label)
    try {
      const result = await handleQuickchatCommand(input, session)
      const text = formatQuickchatResult(result.result)
      if (text) quickchatStore.appendText(text)
    } catch (error) {
      quickchatStore.appendText(`quickchat failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    // The overlay stays open until Escape or the store's idle timeout.
  }

  async function handleSlashForInk(input: string): Promise<InkSlashOutcome> {
    const trimmed = input.trim()
    const done = (text?: string): InkSlashOutcome => ({ handled: true, text })

    const attachMatch = /^\/(?:attach|image|img)(?:\s+(.+))?$/.exec(trimmed)
    if (attachMatch) return done(await runAttachCommand(attachMatch[1]?.trim()))

    // --- arrow-key pickers, now native to the Ink UI ---

    if (trimmed === '/model' || trimmed === '/provider') {
      await detectOllama()
      const selectable = PROVIDER_PRESET_NAMES.filter((n) => n !== 'codex')
      const auto = config.routingMode === 'auto'
      const options = [
        {
          label: auto ? 'auto (current)' : 'auto',
          // On auto the selected provider stays the first route, so this row
          // has to say which one — otherwise the only way to read the picker
          // was two rows both claiming to be current.
          detail: auto
            ? `leads with ${config.providerLabel}, falls back across every ready provider`
            : 'transparent fallback across every ready provider',
          value: 'auto',
        },
        { label: 'ChatGPT subscription (Codex)', detail: 'use your signed-in ChatGPT plan', value: 'codex' },
        ...selectable.map((name) => ({
          label: name !== config.providerName ? name : auto ? `${name} (leading auto)` : `${name} (current)`,
          detail: providerDetail(name),
          value: name,
        })),
      ]
      return {
        handled: true,
        picker: {
          title: 'Switch model — provider',
          options,
          onSelect: async (provider) => {
            if (!provider) return
            if (provider === 'auto') {
              await applyModelChoice('auto')
              return
            }
            const discovery = await listProviderModels(provider)
            if (discovery.models.length === 0) {
              if (provider === 'ollama') return discovery.error ?? 'Ollama has no models on this machine — pull one first, e.g. `ollama pull qwen3`.'
              const fallback = provider === config.providerName ? config.model : providerPresetDefaultModel(provider)
              if (provider === 'codex') activateCodexSubscription(fallback ?? 'default')
              else if (fallback) await applyModelChoice(provider, fallback)
              else return `${provider}: no model list available — use /model ${provider} <model-id> in the classic prompt.`
              return
            }
            const current = provider === config.providerName ? config.model : discovery.models.find((m) => m.isDefault)?.id
            return {
              handled: true,
              picker: {
                title: `${provider} — model`,
                searchable: discovery.models.length > 8,
                initialIndex: Math.max(0, discovery.models.findIndex((m) => m.id === current)),
                options: discovery.models.map((m) => ({
                  label: m.id === current ? `${m.id} (current)` : m.id,
                  detail: m.detail ?? m.name ?? m.ownedBy ?? 'available model',
                  value: m.id,
                })),
                onSelect: async (modelId) => {
                  if (!modelId) return
                  const warning = discovery.models.find((m) => m.id === modelId)?.warning
                  if (warning) writeNotice(warning)
                  if (provider === 'codex') activateCodexSubscription(modelId)
                  else await applyModelChoice(provider, modelId)
                },
              },
            }
          },
        },
      }
    }

    const modeArg = /^\/(betamode|mode)(?:\s+(.+))?$/.exec(trimmed)
    if (modeArg) {
      const isBeta = modeArg[1] === 'betamode'
      if (modeArg[2]) {
        applyModePersonaChoice(modeArg[2].trim())
        return done()
      }
      const current = persona ? (persona === 'cyber' ? 'cybersecurity' : persona) : mode
      const entries = isBeta ? BETA_MODE_ENTRIES : MODE_ENTRIES
      return {
        handled: true,
        picker: {
          title: isBeta ? 'Beta modes & personas' : 'Mode',
          initialIndex: Math.max(0, entries.findIndex((e) => e.value === current)),
          options: entries.map((e) => ({
            label: e.value === current ? `${e.label} (current)` : e.label,
            detail: e.detail,
            value: e.value,
          })),
          onSelect: (value) => {
            if (value) applyModePersonaChoice(value)
          },
        },
      }
    }

    const compactMatch = /^\/compact(?:\s+(.+))?$/.exec(trimmed)
    if (compactMatch) return done(await compactNow(compactMatch[1]?.trim()))

    if (trimmed === '/clear' || trimmed === '/reset' || trimmed === '/new') {
      const text = await clearConversation()
      return { handled: true, text, clear: { sessionId } }
    }

    const resumeMatch = /^\/resume(?:\s+(.+))?$/.exec(trimmed)
    if (resumeMatch) {
      // Switching wipes the screen the way /clear does — the frame below the
      // header belongs to the conversation being left — and the outcome's own
      // text then reprints where the resumed one left off.
      const switchTo = async (id: string): Promise<InkSlashOutcome> => {
        const result = await resumeIntoSession(id)
        return result.sessionId ? { handled: true, text: result.text, clear: { sessionId: result.sessionId } } : done(result.text)
      }
      const asked = resumeMatch[1]?.trim()
      if (asked) {
        const { listSessionIds, resolveSessionId } = await import('../sessionCatalog.ts')
        const lookup = resolveSessionId(asked, listSessionIds())
        if (lookup.kind === 'found') return switchTo(lookup.id)
        if (lookup.kind === 'ambiguous') return done(`"${asked}" matches ${lookup.ids.length} sessions: ${lookup.ids.slice(0, 6).join(', ')}. Use more of the id.`)
        return done(`No saved conversation starting with "${asked}" in this directory.`)
      }
      const options = await resumablePickerOptions()
      if (options.length === 0) return done('No other saved conversations in this directory yet.')
      return {
        handled: true,
        picker: {
          title: 'Resume a conversation',
          options,
          searchable: true,
          onSelect: (value) => (value ? switchTo(value) : undefined),
        },
      }
    }

    if (trimmed === '/settings') {
      return {
        handled: true,
        picker: {
          title: 'Settings',
          options: [
            { label: 'Risk checks', detail: replMode, value: 'risk' },
            { label: 'Model & provider', detail: `${config.routingMode === 'auto' ? 'auto · ' : ''}${config.providerLabel} · ${config.model}`, value: 'model' },
            { label: 'Theme', detail: (await import('../ui/app/theme.ts')).themeName, value: 'theme' },
            { label: 'Mode / persona', detail: persona ?? mode, value: 'mode' },
            { label: 'Compact conversation', detail: conversationDetail('summarise it to free context'), value: 'compact' },
            { label: 'Clear conversation', detail: conversationDetail('start fresh; this one stays resumable'), value: 'clear' },
          ],
          onSelect: (value) => {
            if (value === 'risk') {
              return {
                handled: true,
                picker: {
                  title: 'Risk checks',
                  options: [
                    { label: replMode === 'manual' ? 'Manual (current)' : 'Manual', detail: 'flag risky commands, ask first', value: 'manual' },
                    { label: replMode === 'auto' ? 'Auto (current)' : 'Auto', detail: 'skip the pre-flight prompt; governor still gates critical actions', value: 'auto' },
                  ],
                  onSelect: (v) => {
                    if (v === 'manual' || v === 'auto') applyReplModeChoice(v)
                  },
                },
              }
            }
            if (value === 'model') return handleSlashForInk('/model')
            if (value === 'theme') return handleSlashForInk('/theme')
            if (value === 'mode') return handleSlashForInk('/mode')
            if (value === 'compact') return handleSlashForInk('/compact')
            if (value === 'clear') return handleSlashForInk('/clear')
          },
        },
      }
    }

    // /theme — switch the palette now and keep the choice for later sessions.
    if (trimmed === '/theme') {
      const theme = await import('../ui/app/theme.ts')
      return {
        handled: true,
        picker: {
          title: 'Theme',
          initialIndex: Math.max(0, theme.THEME_CHOICES.findIndex((choice) => choice.name === theme.themeName)),
          options: theme.THEME_CHOICES.map((choice) => ({
            label: choice.name === theme.themeName ? `${choice.name} (current)` : choice.name,
            detail: choice.detail,
            value: choice.name,
          })),
          onSelect: (value) => {
            if (value !== 'dark' && value !== 'light' && value !== 'ansi') return
            theme.setTheme(value)
            process.env.ELIA_THEME = value
            try {
              writeUserConfig({ ELIA_THEME: value })
              return `Theme: ${value} — saved for next time.`
            } catch {
              return `Theme: ${value} — for this session (could not save it).`
            }
          },
        },
      }
    }

    if (trimmed === '@skills' || trimmed === '/skills') {
      const { listLoadedSkills } = await import('../skills/loader.ts')
      const skills = listLoadedSkills()
      if (skills.length === 0) return done('No loaded skills.')
      return {
        handled: true,
        picker: {
          title: 'Skills for subsequent turns',
          searchable: skills.length > 8,
          options: [
            { label: selectedSkillNames === undefined ? 'all loaded skills (current)' : 'all loaded skills', detail: 'every loaded skill available', value: '__all__' },
            ...skills.map((s) => ({ label: s.name, detail: `${s.source} · ${s.file}`, value: s.name })),
          ],
          onSelect: (value) => {
            if (!value) return
            selectedSkillNames = value === '__all__' ? undefined : [value]
            return selectedSkillNames ? `Skills: ${selectedSkillNames[0]}` : 'All loaded skills available.'
          },
        },
      }
    }

    const artifactArg = /^\/artifacts?(?:\s+(.+))?$/.exec(trimmed)
    if (artifactArg) {
      const { listArtifacts, readArtifact } = await import('../autonomy/artifacts.ts')
      const view = (name: string): InkSlashOutcome => {
        const a = readArtifact(name)
        return done(a ? `── ${name} ──\n${a.content}` : `No artifact matches "${name}".`)
      }
      if (artifactArg[1]) return view(artifactArg[1].trim())
      const artifacts = listArtifacts()
      if (artifacts.length === 0) return done('No artifacts yet.')
      return {
        handled: true,
        picker: {
          title: `Artifacts (${artifacts.length})`,
          searchable: artifacts.length > 8,
          options: artifacts.map((a) => ({ label: a.name, detail: `${new Date(a.updatedAt).toLocaleString()} · ${Math.max(1, Math.round(a.sizeBytes / 1024))} KB`, value: a.name })),
          onSelect: (value) => (value ? view(value) : undefined),
        },
      }
    }

    if (trimmed === '/task' || trimmed === '/tasks') {
      const list = taskSessions.list()
      if (list.length === 0) return done('No tasks yet this session.')
      return done(
        list
          .slice(-20)
          .map((t) => `${t.status.padEnd(8)} ${t.role ? `${t.role} · ` : ''}${t.title} — ${t.action}`)
          .join('\n'),
      )
    }

    if (trimmed === '/sessions' || trimmed === '/session') {
      // Every conversation in this project, not only the ones a live process is
      // currently holding — the ones worth reopening are usually the ones
      // nothing is holding. Selecting one switches into it.
      const { describeSession, listSessionSummaries, sessionDetail } = await import('../sessionCatalog.ts')
      const others = (await listSessionSummaries()).filter((session) => session.id !== sessionId)
      if (others.length === 0) return done('No other elia sessions in this project.')
      return {
        handled: true,
        picker: {
          title: 'Sessions here — enter to resume one',
          options: others.map((session) => ({
            label: describeSession(session, 64),
            detail: `${session.heldByLiveProcess ? `open · ${session.lastAction || 'working'} · ` : ''}${sessionDetail(session)}`,
            value: session.id,
          })),
          searchable: true,
          onSelect: async (value) => {
            if (!value) return undefined
            const result = await resumeIntoSession(value)
            return result.sessionId ? { handled: true, text: result.text, clear: { sessionId: result.sessionId } } : result.text
          },
        },
      }
    }

    if (trimmed === '/eliaspace') {
      const { collectEliaspaceSnapshot, renderEliaspacePanel, renderEliaspaceView } = await import('../workspace/panel.ts')
      const snap = await collectEliaspaceSnapshot()
      const panel = renderEliaspacePanel(snap)
      if (!snap.configured || !snap.reachable) return { handled: true, text: panel }
      return {
        handled: true,
        picker: {
          title: `${snap.status?.workspace?.name ?? 'workspace'} — drill in`,
          options: [
            { label: 'Feed', detail: 'recent activity', value: 'feed' },
            { label: 'Members', detail: String(snap.status?.members ?? 0), value: 'members' },
            { label: 'Agents', detail: String(snap.status?.agents.total ?? 0), value: 'agents' },
            { label: 'Objectives', detail: String(snap.status?.objectives.total ?? 0), value: 'objectives' },
            { label: 'Tasks', detail: String(snap.status?.tasks.total ?? 0), value: 'tasks' },
            { label: 'Connection', detail: 'how clients attach', value: 'connection' },
          ],
          onSelect: async (value) => {
            if (!value) return panel
            return `${panel}\n\n${await renderEliaspaceView(value as never)}`
          },
        },
      }
    }

    // --- text-only commands ---

    if (trimmed === '/help' || trimmed === '/?') {
      return { handled: true, text: allSlashCommands().map((c) => `${c.name}  —  ${c.description}`).join('\n') }
    }
    if (trimmed === '/status') {
      return { handled: true, text: renderWorkspacePanel({ sessionId, mode, providerLabel: config.providerLabel, model: config.model }) }
    }
    if (trimmed === '/team') return { handled: true, text: renderTeamStatus() }
    const expandMatch = /^\/expand(?:\s+(\d+))?$/.exec(trimmed)
    if (expandMatch) {
      const total = sessionTranscript.toolCount()
      if (total === 0) return { handled: true, text: 'No tool output recorded yet this session.' }
      const item = expandMatch[1] ? sessionTranscript.tool(Number.parseInt(expandMatch[1], 10) - 1) : sessionTranscript.tool()
      if (!item) return { handled: true, text: `No tool call ${expandMatch[1]}. This session has ${total}.` }
      return { handled: true, text: `⎿ ${item.name} · full output (${item.status})\n${colorizeDiffBlock(item.result)}` }
    }
    if (trimmed === '/cost') {
      const { sessionUsageSnapshot, estimateCostUsd, formatCostUsd, formatTokenCount, formatElapsed } = await import('../usage.ts')
      const s = sessionUsageSnapshot()
      return {
        handled: true,
        text: [
          `input       ${formatTokenCount(s.usage.inputTokens)}`,
          `output      ${formatTokenCount(s.usage.outputTokens)}`,
          `cache read  ${formatTokenCount(s.usage.cacheReadTokens)}`,
          `cache write ${formatTokenCount(s.usage.cacheWriteTokens)}`,
          `turns       ${s.turns}`,
          `elapsed     ${formatElapsed(s.elapsedMs)}`,
          `est. cost   ${formatCostUsd(estimateCostUsd(config.model, s.usage))} (${config.model})`,
        ].join('\n'),
      }
    }

    if (trimmed === '/usage' || trimmed === '/limits') {
      const { renderUsageBreakdown, tokenMeter, totalTokens, estimateCostUsd, formatCostUsd, formatTokenCount } = await import('../usage.ts')
      const { codexContextTokens } = await import('../providers/codexSubscription.ts')
      const cum = cumulativeSessionUsage()
      const isCodex = config.providerName === 'codex'
      const costLabel = isCodex ? 'included in ChatGPT plan (subscription turns are not metered in $)' : undefined
      // In subscription mode Elia's `messages` stay near-empty; meter against
      // Codex's reported prompt size and its model's real window.
      const threshold = isCodex ? contextWindowFor(config.model) : compactionThresholdFor(config.model)
      const contextUsed = isCodex ? codexContextTokens() : estimateTokens(messages)
      const ctxPct = threshold > 0 ? Math.min(100, Math.round((contextUsed / threshold) * 100)) : 0

      const contextView = async (): Promise<string> => {
        const override = contextWindowOverride()
        if (isCodex) {
          return [
            `Context window — ${config.model} (ChatGPT subscription)`,
            '',
            `  ${tokenMeter(ctxPct)}  ${ctxPct}%`,
            '',
            `  last turn prompt   ${contextUsed > 0 ? formatTokenCount(contextUsed) : 'no turn yet'} tokens`,
            `  model window       ${formatTokenCount(threshold)} tokens`,
            '',
            '  Codex keeps the working transcript in its own thread and compacts it',
            "  itself — Elia's own context stays small in this mode.",
          ].join('\n')
        }
        return [
          `Context window — ${config.model}`,
          '',
          `  ${tokenMeter(ctxPct)}  ${ctxPct}%`,
          '',
          `  in context     ${formatTokenCount(contextUsed)} tokens (estimated)`,
          `  compact at     ${formatTokenCount(threshold)} tokens`,
          `  model window   ${formatTokenCount(contextWindowFor(config.model))} tokens`,
          `  override       ${override ? `ELIA_CONTEXT_WINDOW=${override}` : 'none (ELIA_CONTEXT_WINDOW unset)'}`,
          '',
          `  ${renderContextStatus(messages, await countEpisodes(sessionId), threshold)}`,
          '',
          '  At the compaction point older turns are summarised into recallable',
          '  episodes, so the effective working memory outlasts this meter.',
        ].join('\n')
      }

      const limitsView = (): string => {
        const thinking = getThinking()
        const runMs = process.env.ELIA_MAX_RUN_MS?.trim()
        const providerLine =
          config.providerName === 'codex'
            ? '  ChatGPT subscription — capacity is capped by your ChatGPT plan and is\n  not metered by Elia. At the cap a turn fails with "usage limit reached\n  — resets ...".'
            : `  ${config.providerLabel} — billed per token by the provider. Elia enforces no\n  spend cap; set limits in your provider dashboard.`
        return [
          'Limits',
          '',
          'Context',
          isCodex
            ? `  model window                ${formatTokenCount(threshold)} tokens (${config.model}; Codex compacts its own thread)`
            : `  compaction threshold        ${formatTokenCount(threshold)} tokens (${config.model})`,
          `  ELIA_CONTEXT_WINDOW         ${contextWindowOverride() ?? 'unset'}`,
          '',
          'Reasoning',
          `  effort                      ${describeThinking()}`,
          `  budget                      ${thinking.enabled ? `${formatTokenCount(thinking.budgetTokens)} tokens / turn` : 'n/a (thinking off)'}`,
          '',
          'Autonomous runs (elia auto)',
          `  wall-clock (ELIA_MAX_RUN_MS) ${runMs ? `${runMs} ms` : 'unset — no default cap; pass --max-run-ms'}`,
          '  action budget               unlimited unless --max-actions is passed',
          '',
          'Provider / plan',
          providerLine,
          '',
          'Elia does not impose a dollar or token spend limit of its own.',
        ].join('\n')
      }

      return {
        handled: true,
        picker: {
          title: 'Usage',
          options: [
            {
              label: 'Tokens this session',
              detail: `${formatTokenCount(totalTokens(cum.usage))} tokens · ${isCodex ? 'ChatGPT plan' : formatCostUsd(estimateCostUsd(config.model, cum.usage))} · ${cum.turns} turn${cum.turns === 1 ? '' : 's'}`,
              value: 'tokens',
            },
            { label: 'Context window', detail: isCodex ? `${ctxPct}% of ${formatTokenCount(threshold)} window (Codex thread)` : `${ctxPct}% of ${formatTokenCount(threshold)} before compaction`, value: 'context' },
            { label: 'Limits', detail: 'context, reasoning, run & provider caps', value: 'limits' },
            { label: 'Usage-affecting settings', detail: `${config.model} · ${describeThinking()}`, value: 'settings' },
          ],
          onSelect: async (value) => {
            if (value === 'tokens') return done(renderUsageBreakdown(cum, config.model, costLabel))
            if (value === 'context') return done(await contextView())
            if (value === 'limits') return done(limitsView())
            if (value === 'settings') return handleSlashForInk('/settings')
          },
        },
      }
    }

    const exportMatch = /^\/export(?:\s+(.+))?$/.exec(trimmed)
    if (exportMatch) {
      const target = exportMatch[1]?.trim() || `.elia/exports/${sessionId}-${Date.now()}.md`
      try {
        await Bun.write(target, sessionTranscript.toMarkdown(`elia session ${sessionId}`))
        return { handled: true, text: `Exported ${sessionTranscript.turns()} turn(s) to ${target}` }
      } catch (error) {
        return { handled: true, text: `Could not write ${target}: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    if (trimmed === 'rewind' || trimmed === '/rewind') {
      return { handled: true, text: renderCheckpointList(checkpoints) }
    }
    const rewindN = /^\/?rewind\s+(\d+)$/.exec(trimmed)
    if (rewindN) {
      const n = Number.parseInt(rewindN[1]!, 10)
      const checkpoint = checkpoints[n]
      if (!checkpoint) return done(`No rewind point ${n}. Type /rewind to list them.`)
      const result = await restoreCheckpoint(checkpoint)
      messages.length = 0
      messages.push(...messagesForRestore(checkpoint))
      checkpoints.length = n
      await saveCheckpoints(sessionId, checkpoints)
      sessionTranscript.notice(`Rewound workspace and model context to checkpoint ${n}. Earlier activity remains in the session recording.`)
      await persistInteractiveSession()
      return done(`Rewound to before turn ${n} ("${checkpoint.label}") — restored ${result.restored} file(s), removed ${result.deleted}.`)
    }
    if (trimmed === '/capabilities') {
      return done(CAPABILITIES.map((c) => `${c.label} [${c.persona}] · risk: ${c.risk} · ${c.summary}`).join('\n'))
    }
    const whyMatch = /^\/why(?:\s+(.+))?$/.exec(trimmed)
    if (whyMatch) {
      const { explainRationale } = await import('../autonomy/rationale.ts')
      return done(whyMatch[1] ? explainRationale(whyMatch[1].trim()) : 'Usage: /why <path or topic>')
    }
    if (trimmed === '/lessons') {
      const { renderLessonsListing } = await import('../autonomy/lessons.ts')
      return done(renderLessonsListing())
    }
    const brainMatch = /^\/brain(?:\s+(.+))?$/.exec(trimmed)
    if (brainMatch) {
      const { runBrainCommand } = await import('../brain/command.ts')
      return done(await runBrainCommand(brainMatch[1] ?? ''))
    }
    if (trimmed === '/track') {
      const { renderCompetence } = await import('../autonomy/outcomes.ts')
      return done(renderCompetence())
    }
    const eliaBookMatch = /^\/eliabook(?:\s+(.*))?$/.exec(trimmed)
    if (eliaBookMatch) {
      const { eliaBookMenu } = await import('../eliaBook.ts')
      return eliaBookMenu(eliaBookMatch[1] ?? '', currentEliaBookSession)
    }

    if (trimmed === '/skills' || trimmed === '@skills-list') {
      const { listLoadedSkills } = await import('../skills/loader.ts')
      const skills = listLoadedSkills()
      if (skills.length === 0) return done('No skills loaded. Add a *.skill.ts file to .elia/skills, or find one with /marketplace.')
      return done(['Loaded skills:', ...skills.map((s) => `  ${s.name}  (${s.source} · ${s.file})`)].join('\n'))
    }

    const marketMatch = /^\/marketplace(?:\s+([a-z]+)?\s*(.*))?$/.exec(trimmed)
    if (marketMatch) {
      const { marketplaceOutcome } = await import('../marketplace/slash.ts')
      return marketplaceOutcome(marketMatch[1], marketMatch[2]?.trim() || undefined)
    }

    if (trimmed === '/packages') {
      const { listInstalled, removeCommand, parsePipList } = await import('../marketplace/registry.ts')
      let items = listInstalled(process.cwd())
      const pip = await runShellQuiet('pip list --format=json')
      if (pip) items = [...items, ...parsePipList(pip)]
      if (items.length === 0) return done('Nothing installed to show (no package.json deps, skills, or pip packages found).')
      return {
        handled: true,
        picker: {
          title: `Installed (${items.length}) — select to remove`,
          searchable: items.length > 8,
          options: items.map((i) => ({ label: `${i.name}`, detail: `${i.kind} · ${i.detail}`, value: `${i.kind}:${i.name}` })),
          onSelect: async (value) => {
            if (!value) return
            const item = items.find((i) => `${i.kind}:${i.name}` === value)
            if (!item) return
            if (item.kind === 'skill' && item.file) {
              return { handled: true, runCommand: { command: process.platform === 'win32' ? `del "${item.file}"` : `rm "${item.file}"`, description: `Delete skill "${item.name}" (${item.file})` } }
            }
            const cmd = removeCommand(item, process.cwd())
            return cmd ? { handled: true, runCommand: { command: cmd, description: `Uninstall ${item.name} (${item.kind}) — removes it from disk` } } : `Cannot remove ${item.name}.`
          },
        },
      }
    }
    const mcpMatch = /^\/mcp(?:\s+(.+))?$/.exec(trimmed)
    if (mcpMatch) {
      const { mcpManageOutcome } = await import('../mcp/slash.ts')
      return mcpManageOutcome(mcpMatch[1] ?? '', false)
    }
    const connectorMatch = /^\/connectors?(?:\s+(.+))?$/.exec(trimmed)
    if (connectorMatch) {
      const { mcpManageOutcome } = await import('../mcp/slash.ts')
      return mcpManageOutcome(connectorMatch[1] ?? '', true)
    }

    const verifyMatch = /^\/verify(?:\s+(on|off))?$/.exec(trimmed)
    if (verifyMatch) {
      if (verifyMatch[1]) {
        autoVerify = verifyMatch[1] === 'on'
        return done(`Automatic post-turn verification ${autoVerify ? 'on' : 'off'}.`)
      }
      const { detectChecks } = await import('../autonomy/detectChecks.ts')
      const { runVerification, describeVerification } = await import('../autonomy/verify.ts')
      const checks = detectChecks(process.cwd())
      if (checks.length === 0) return done('No project checks detected (looked for package.json scripts, Cargo.toml, go.mod, pytest, pom.xml/Gradle, CMake/Makefile).')
      const outcome = await runVerification(checks, process.cwd())
      return done(`${outcome.passed ? '✓ all checks pass' : '✗ checks failing'}\n${describeVerification(outcome)}`)
    }

    const searchMatch = /^\/(?:search|reason)(?:\s+(on|off))?$/.exec(trimmed)
    if (searchMatch) {
      if (searchMatch[1]) {
        reasonSearch = searchMatch[1] === 'on'
        return done(
          `Reasoning search ${reasonSearch ? 'on' : 'off'} — work with something executable to check ${reasonSearch ? 'is attempted several different ways in isolated worktrees, and the one a real check passes is kept; a question with a short answer is checked by an independent attempt' : 'runs as a single attempt, and answers to questions are not checked'}.`,
        )
      }
      // No argument: say what it would do with *this* project, which is the
      // question anyone typing it actually has.
      const { readLibrary, renderLibrary } = await import('../reason/library.ts')
      const { detectChecks } = await import('../autonomy/detectChecks.ts')
      const checks = detectChecks(process.cwd())
      return done(
        [
          `Reasoning search is ${reasonSearch ? 'on' : 'off'}.`,
          checks.length === 0
            ? 'No project checks detected here, so a search would have nothing to judge attempts by and will decline.'
            : `Attempts would be checked with: ${checks.join(', ')}`,
          '',
          renderLibrary(readLibrary()),
        ].join('\n'),
      )
    }

    const escalateMatch = /^\/(?:auto|escalate)(?:\s+(on|off))?$/.exec(trimmed)
    if (escalateMatch) {
      if (escalateMatch[1]) autoEscalate = escalateMatch[1] === 'on'
      return done(
        `Auto-escalation ${autoEscalate ? 'on' : 'off'} — a request that reads as a whole new project ${autoEscalate ? 'routes through the autonomous pipeline (plan → workers → verify → repair)' : 'runs as a plain turn'}. Targeted edits are unaffected.`,
      )
    }

    const selfMatch = /^\/self(?:\s+(on|off))?$/.exec(trimmed)
    if (selfMatch) {
      if (selfMatch[1]) selfEdit.setSelfEditAllowed(selfMatch[1] === 'on')
      return done(selfEdit.describeSelfEdit())
    }

    const quickchatMatch = /^\/quickchat(?:\s+(.*))?$/.exec(trimmed)
    if (quickchatMatch) {
      const session = await registerQuickchatSession()
      if (!session) {
        return done('No session is registered for quickchat here. Start one with: elia sessions new --name <name>')
      }
      const { parseQuickchatCommand } = await import('../quickchat/quickchat.ts')
      const parsed = parseQuickchatCommand(trimmed)
      const answeredInOverlay = parsed.kind === 'ask' || parsed.kind === 'session-ask' || parsed.kind === 'risk'
      if (answeredInOverlay) {
        void runQuickchatOverlay(trimmed, session, parsed).catch(() => undefined)
        return done('Answering in the quickchat overlay — it never blocks this session. (Escape closes it; idle closes it in 60s.)')
      }
      const { handleQuickchatCommand } = await import('../quickchat/quickchat.ts')
      const result = await handleQuickchatCommand(trimmed, session)
      return done(result.handled ? formatQuickchatResult(result.result) : 'quickchat did not handle that input.')
    }

    const custom = resolveCustomCommand(trimmed)
    if (custom) return { handled: true, submitText: custom.expanded }

    return done(`Unknown command: ${trimmed.split(/\s+/)[0]}. Type /help for the list.`)
  }

  if (interactiveTerminal) {
    // Re-run prewarm now that the provider, mode, and session prompt are fully
    // resolved: for the ChatGPT subscription this starts the workspace thread
    // (not just the connection) so the first turn skips cold start. Idempotent —
    // ensureThread dedupes on the resolved instructions.
    prewarmActiveProvider()
    // Before Ink and React load: native text measurement and React's
    // production build — without touching NODE_ENV, which every command elia
    // runs would inherit. See ui/app/fastRender.ts.
    const { installFastRendering } = await import('../ui/app/fastRender.ts')
    installFastRendering()
    const { runInkRepl } = await import('../ui/app/index.tsx')
    const greeting = `${mode} mode`
    const cliVersion = JSON.parse(await Bun.file(new URL('../../package.json', import.meta.url)).text()).version as string

    // Practice while idle: after IDLE_MS with no turn, or when the session
    // closes, one `elia evolve --auto` generation starts in the background
    // (evolve/autoImprove.ts decides whether there is anything worth running).
    const practice = await import('../evolve/autoImprove.ts')
    const practiceHere = !process.env.ELIA_AUTO_IMPROVE_CHILD && practice.autoImproveEnabled()
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const armPractice = (): void => {
      if (!practiceHere) return
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => void practice.maybeStartPractice().catch(() => false), practice.IDLE_MS)
      idleTimer.unref?.()
    }
    const holdPractice = (): void => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = undefined
    }
    armPractice()

    await runInkRepl({
      sessionId,
      version: cliVersion,
      startupNotice: practiceHere ? practice.takePracticeReport() : undefined,
      getEnv: () => ({ model: config.model, providerLabel: config.providerLabel, providerName: config.providerName, routing: config.routingMode }),
      commands: allSlashCommands(),
      initialReplMode: replMode,
      messages,
      greeting,
      // A pre-check that could not answer is not a verdict. Every risky action
      // in this REPL is still gated one at a time by the governor's approval
      // menu, so a classifier outage lets the message through instead of
      // stopping a harmless request behind an error and a y/n prompt.
      classifyRisk: async (command) => {
        try {
          const verdict = await classifyCommandRisk(command)
          return 'unavailable' in verdict && verdict.unavailable ? { risky: false } : verdict
        } catch {
          return { risky: false }
        }
      },
      runShellLine: async (command) => {
        const { runShell, formatShellResult, clampOutput } = await import('../shell.ts')
        const result = await runShell(command, undefined, process.cwd())
        const rendered = clampOutput(formatShellResult(result), 8_000)
        sessionTranscript.shell(command, formatShellResult(result))
        await persistInteractiveSession()
        carriedShellContext.push(`<local-command>${command}</local-command>\n<output>\n${clampOutput(formatShellResult(result), 4_000)}\n</output>`)
        return rendered
      },
      handleSlash: handleSlashForInk,
      submitTurn: async (text, hooks) => {
        holdPractice()
        const turnText = carriedShellContext.length > 0
          ? `${carriedShellContext.splice(0).join('\n\n')}\n\n${text}`
          : text
        await runCheckpointedTurn(
          turnText,
          async (assessment, request) =>
            hooks.approve({
              title: approvalTitle(request.name, assessment.intent),
              lines: [redactText(assessment.reason, 300)],
              preview: approvalPreviewLines(request.name, request.input),
              ruleLabel: ruleLabel(ruleFor(request, assessment)),
              command:
                request.name === 'run_command' && typeof request.input.command === 'string'
                  ? request.input.command
                  : request.name === 'run_program' && typeof request.input.program === 'string'
                    ? [request.input.program, ...(Array.isArray(request.input.args) ? request.input.args.filter((arg): arg is string => typeof arg === 'string').map((arg) => JSON.stringify(arg)) : [])].join(' ')
                  : undefined,
            }),
          undefined,
          {
            onText: hooks.onText,
            onThinking: hooks.onThinking,
            onActivity: hooks.onActivity,
            onTool: hooks.onTool,
            onToolStart: hooks.onToolStart,
            onCheck: hooks.onCheck,
            signal: hooks.signal,
            drainSteering: hooks.drainSteering,
            approve: hooks.approve,
            onRunPlan: hooks.onRunPlan,
          },
        )
        await persistInteractiveSession()
        if (practiceHere) practice.notePracticeTurn()
        armPractice()
      },
    })
    holdPractice()
    if (practiceHere) await practice.maybeStartPractice().catch(() => false)
    prompt.close()
    return
  }

  while (true) {
    const label = persona ? `${dim(`[${persona}]`)} ` : mode !== 'dev' ? `${dim(`[${mode}]`)} ` : ''
    const line = await prompt.question(`${label}${gold('❯')} `)
    if (line === null) break // stdin closed (EOF)

    const trimmed = line.trim()
    if (trimmed === 'exit' || trimmed === 'quit') break
    if (trimmed === '') continue

    // /attach <path> — queue an image for the next prompt. Inline image paths
    // pasted/dragged into a normal prompt are resolved later, inside the turn.
    const attachClassic = /^\/(?:attach|image|img)(?:\s+(.+))?$/.exec(trimmed)
    if (attachClassic) {
      writeUsageLine(await runAttachCommand(attachClassic[1]?.trim()))
      continue
    }

    // !cmd — run a shell command now, print its output, and carry it into the
    // next turn as context. No model round-trip.
    if (trimmed.startsWith('!')) {
      const command = trimmed.slice(1).trim()
      if (!command) continue
      if (replMode === 'manual') {
        const { risky, reason } = await classifyCommandRisk(command)
        if (risky) {
          const decision = await confirmOnce(prompt, `${reason ? `${redactText(reason, 500)}\n` : ''}About to run: "${redactText(command, 500)}" — run it? [y]es / [n]o: `)
          if (decision.action !== 'approve') {
            writeNotice('Skipped.')
            continue
          }
        }
      }
      const { runShell, formatShellResult, clampOutput } = await import('../shell.ts')
      const shellResult = await runShell(command, undefined, process.cwd())
      const rendered = clampOutput(formatShellResult(shellResult), 8_000)
      process.stdout.write(`${dim(`$ ${command}`)}\n${rendered}\n`)
      sessionTranscript.shell(command, formatShellResult(shellResult))
      await persistInteractiveSession()
      carriedShellContext.push(`<local-command>${command}</local-command>\n<output>\n${clampOutput(formatShellResult(shellResult), 4_000)}\n</output>`)
      continue
    }

    // /expand [n] — reprint a tool result that scrollback folded.
    const expandMatch = /^\/expand(?:\s+(\d+))?$/.exec(trimmed)
    if (expandMatch) {
      const toolTotal = sessionTranscript.toolCount()
      if (toolTotal === 0) {
        writeNotice('No tool output has been recorded yet this session.')
        continue
      }
      const item = expandMatch[1]
        ? sessionTranscript.tool(Number.parseInt(expandMatch[1], 10) - 1)
        : sessionTranscript.tool()
      if (!item) {
        writeNotice(`No tool call ${expandMatch[1]}. This session has ${toolTotal}.`)
        continue
      }
      process.stdout.write(`${dim(`⎿ ${item.name} · full output (${item.status})`)}\n${colorizeDiffBlock(item.result)}\n`)
      continue
    }

    // /status — the full workspace panel, on demand.
    if (trimmed === '/status') {
      process.stdout.write(`${renderWorkspacePanel({ sessionId, mode, providerLabel: config.providerLabel, model: config.model })}\n`)
      continue
    }
    if (trimmed === '/team') {
      process.stdout.write(`${renderTeamStatus()}\n`)
      continue
    }

    // /cost — session token and estimated-dollar breakdown.
    if (trimmed === '/cost') {
      const { sessionUsageSnapshot } = await import('../usage.ts')
      const { estimateCostUsd, formatCostUsd, formatTokenCount, formatElapsed } = await import('../usage.ts')
      const snap = sessionUsageSnapshot()
      const rows: string[][] = [
        ['input', formatTokenCount(snap.usage.inputTokens)],
        ['output', formatTokenCount(snap.usage.outputTokens)],
        ['cache read', formatTokenCount(snap.usage.cacheReadTokens)],
        ['cache write', formatTokenCount(snap.usage.cacheWriteTokens)],
        ['turns', String(snap.turns)],
        ['elapsed', formatElapsed(snap.elapsedMs)],
        ['est. cost', `${formatCostUsd(estimateCostUsd(config.model, snap.usage))} (${config.model})`],
      ]
      for (const costLine of table([{ header: 'metric' }, { header: 'value', align: 'right' }], rows)) writeUsageLine(`  ${costLine}`)
      continue
    }

    // /usage — token consumption, context window, and the limits in effect.
    if (trimmed === '/usage' || trimmed === '/limits') {
      const { renderUsageBreakdown, tokenMeter, formatTokenCount } = await import('../usage.ts')
      const { codexContextTokens } = await import('../providers/codexSubscription.ts')
      const isCodexUsage = config.providerName === 'codex'
      const threshold = isCodexUsage ? contextWindowFor(config.model) : compactionThresholdFor(config.model)
      const contextUsed = isCodexUsage ? codexContextTokens() : estimateTokens(messages)
      const ctxPct = threshold > 0 ? Math.min(100, Math.round((contextUsed / threshold) * 100)) : 0
      const thinking = getThinking()
      const runMs = process.env.ELIA_MAX_RUN_MS?.trim()
      writeUsageLine(renderUsageBreakdown(cumulativeSessionUsage(), config.model, isCodexUsage ? 'included in ChatGPT plan (not metered in $)' : undefined))
      writeUsageLine('')
      writeUsageLine(
        isCodexUsage
          ? `Context — ${tokenMeter(ctxPct)} ${ctxPct}%  ·  ${contextUsed > 0 ? formatTokenCount(contextUsed) : 'no turn yet'} / ${formatTokenCount(threshold)} tokens (Codex thread)`
          : `Context — ${tokenMeter(ctxPct)} ${ctxPct}%  ·  ${formatTokenCount(contextUsed)} / ${formatTokenCount(threshold)} tokens before compaction`,
      )
      writeUsageLine(`  model window ${formatTokenCount(contextWindowFor(config.model))} · ELIA_CONTEXT_WINDOW ${contextWindowOverride() ?? 'unset'}`)
      writeUsageLine('')
      writeUsageLine('Limits')
      writeUsageLine(`  reasoning budget   ${thinking.enabled ? `${formatTokenCount(thinking.budgetTokens)} tokens/turn` : 'off'}`)
      writeUsageLine(`  autonomous run     ELIA_MAX_RUN_MS ${runMs ? `${runMs} ms` : 'unset — no default cap'}`)
      writeUsageLine(
        config.providerName === 'codex'
          ? '  provider           ChatGPT plan cap (not metered by Elia)'
          : `  provider           ${config.providerLabel} — per-token billing, no Elia spend cap`,
      )
      continue
    }

    // /export [path] — write the whole conversation to Markdown.
    const exportMatch = /^\/export(?:\s+(.+))?$/.exec(trimmed)
    if (exportMatch) {
      const target = exportMatch[1]?.trim() || `.elia/exports/${sessionId}-${Date.now()}.md`
      try {
        await Bun.write(target, sessionTranscript.toMarkdown(`elia session ${sessionId}`))
        writeNotice(`Exported ${sessionTranscript.turns()} turn(s) to ${target}`)
      } catch (error) {
        writeError(`Could not write ${target}: ${error instanceof Error ? error.message : String(error)}`)
      }
      continue
    }

    if (trimmed === '@skills') {
      await handleSkillsPicker()
      continue
    }

    if (trimmed === '/capabilities') {
      for (const capability of CAPABILITIES) {
        writeUsageLine(`${capability.label} [${capability.persona}] · risk: ${capability.risk} · ${capability.summary}`)
        writeUsageLine(`  output: ${capability.outputContract.join('; ')}`)
      }
      continue
    }
    if (trimmed === '/settings') {
      await handleSettingsCommand()
      continue
    }
    const compactClassic = /^\/compact(?:\s+(.+))?$/.exec(trimmed)
    if (compactClassic) {
      writeNotice(await compactNow(compactClassic[1]?.trim()))
      continue
    }
    if (trimmed === '/clear' || trimmed === '/reset' || trimmed === '/new') {
      writeNotice(await clearClassicScreen())
      continue
    }
    const resumeClassic = /^\/resume(?:\s+(.+))?$/.exec(trimmed)
    if (resumeClassic) {
      writeNotice(await resumeClassicSession(resumeClassic[1]?.trim()))
      continue
    }
    const whyClassic = /^\/why(?:\s+(.+))?$/.exec(trimmed)
    if (whyClassic) {
      const { explainRationale } = await import('../autonomy/rationale.ts')
      writeUsageLine(whyClassic[1] ? explainRationale(whyClassic[1].trim()) : 'Usage: /why <path or topic>')
      continue
    }
    if (trimmed === '/lessons') {
      const { renderLessonsListing } = await import('../autonomy/lessons.ts')
      writeUsageLine(renderLessonsListing())
      continue
    }
    const brainClassic = /^\/brain(?:\s+(.+))?$/.exec(trimmed)
    if (brainClassic) {
      const { runBrainCommand } = await import('../brain/command.ts')
      writeUsageLine(await runBrainCommand(brainClassic[1] ?? ''))
      continue
    }
    if (trimmed === '/track') {
      const { renderCompetence } = await import('../autonomy/outcomes.ts')
      writeUsageLine(renderCompetence())
      continue
    }
    if (trimmed === '/skills') {
      const { listLoadedSkills } = await import('../skills/loader.ts')
      const skills = listLoadedSkills()
      writeUsageLine(skills.length === 0 ? 'No skills loaded.' : ['Loaded skills:', ...skills.map((s) => `  ${s.name}  (${s.source})`)].join('\n'))
      continue
    }
    const marketClassic = /^\/marketplace(?:\s+(npm|bun|pip)\s+(.+))?$/.exec(trimmed)
    if (marketClassic) {
      if (!marketClassic[1]) {
        writeNotice('Usage: /marketplace <npm|pip> <query> — then run the printed install command. Full browse/install UI is in the interactive terminal.')
        continue
      }
      const { searchMarket, installCommand } = await import('../marketplace/registry.ts')
      try {
        const results = await searchMarket(marketClassic[1] as PackageKind, marketClassic[2]!)
        if (results.length === 0) writeNotice('Nothing found.')
        else {
          for (const r of results.slice(0, 12)) writeUsageLine(`  ${r.name}${r.version ? `@${r.version}` : ''}  ${(r.description ?? '').slice(0, 70)}`)
          writeNotice(`Install with: ${installCommand(marketClassic[1] as PackageKind, results[0]!.name)}`)
        }
      } catch (error) {
        writeError(`Search failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      continue
    }
    if (trimmed === '/packages') {
      const { listInstalled } = await import('../marketplace/registry.ts')
      const items = listInstalled(process.cwd())
      writeUsageLine(items.length === 0 ? 'Nothing installed to show.' : items.map((i) => `  ${i.kind.padEnd(6)} ${i.name}  ${i.detail}`).join('\n'))
      writeNotice('Remove packages interactively from the new terminal UI, or with the usual uninstall command.')
      continue
    }
    const mcpClassic = /^\/(mcp|connectors?)(?:\s+(reload))?$/.exec(trimmed)
    if (mcpClassic) {
      const connectorsOnly = mcpClassic[1] !== 'mcp'
      const { mcpStatusReport, reloadMcpTools } = await import('../mcp/registry.ts')
      const report = mcpClassic[2] === 'reload' ? await reloadMcpTools(process.cwd()) : mcpStatusReport()
      const rows = (connectorsOnly ? report.status.filter((s) => s.connector) : report.status)
      if (rows.length === 0) writeNotice(`No ${connectorsOnly ? 'connectors' : 'MCP servers'} configured. Add one from the interactive terminal: /${connectorsOnly ? 'connector' : 'mcp'}.`)
      else writeUsageLine(rows.map((s) => `  ${s.connected ? '●' : '○'} ${s.name}  ${s.transport}${s.connector ? ' connector' : ''}  ${s.disabled ? 'disabled' : s.connected ? `${s.toolCount} tool(s)` : s.error ?? 'offline'}`).join('\n'))
      writeNotice('Add / test / enable / disable / remove interactively in the new terminal UI.')
      continue
    }
    const verifyClassic = /^\/verify(?:\s+(on|off))?$/.exec(trimmed)
    if (verifyClassic) {
      if (verifyClassic[1]) {
        autoVerify = verifyClassic[1] === 'on'
        writeNotice(`Automatic post-turn verification ${autoVerify ? 'on' : 'off'}.`)
        continue
      }
      const { detectChecks } = await import('../autonomy/detectChecks.ts')
      const { runVerification, describeVerification } = await import('../autonomy/verify.ts')
      const checks = detectChecks(process.cwd())
      if (checks.length === 0) writeNotice('No project checks detected.')
      else {
        const outcome = await runVerification(checks, process.cwd())
        writeUsageLine(`${outcome.passed ? '✓ all checks pass' : '✗ checks failing'}\n${describeVerification(outcome)}`)
      }
      continue
    }
    const escalateClassic = /^\/(?:auto|escalate)(?:\s+(on|off))?$/.exec(trimmed)
    if (escalateClassic) {
      if (escalateClassic[1]) autoEscalate = escalateClassic[1] === 'on'
      writeNotice(`Auto-escalation ${autoEscalate ? 'on' : 'off'} — big new-project requests ${autoEscalate ? 'route through the autonomous pipeline' : 'run as a plain turn'}.`)
      continue
    }
    const selfClassic = /^\/self(?:\s+(on|off))?$/.exec(trimmed)
    if (selfClassic) {
      if (selfClassic[1]) selfEdit.setSelfEditAllowed(selfClassic[1] === 'on')
      writeNotice(selfEdit.describeSelfEdit())
      continue
    }

    const modelMatch = /^\/model(?:\s+(.*))?$/.exec(trimmed)
    if (modelMatch) {
      await handleModelCommand(modelMatch[1]?.trim() ?? '')
      continue
    }

    if (trimmed === '/task' || trimmed.startsWith('/task ')) {
      const taskId = trimmed.slice('/task'.length).trim() || undefined
      await openTaskDashboard(taskSessions, taskId)
      continue
    }

    if (trimmed === '/sessions' || trimmed === '/session') {
      const { openSessionsDashboard } = await import('../ui/sessionsDashboard.ts')
      pushHeartbeat(false, 'Browsing /sessions')
      const chosen = await openSessionsDashboard(sessionId)
      if (chosen && chosen !== sessionId) writeNotice((await resumeIntoSession(chosen)).text)
      else pushHeartbeat(false, 'Idle at prompt')
      continue
    }

    if (trimmed === '/eliaspace') {
      const { collectEliaspaceSnapshot, renderEliaspacePanel, renderEliaspaceView } = await import('../workspace/panel.ts')
      const snap = await collectEliaspaceSnapshot()
      process.stdout.write(`\n${renderEliaspacePanel(snap)}\n`)
      if (snap.configured && snap.reachable) {
        const result = await pick('Workspace — drill in', [
          { label: 'Feed', detail: 'recent activity', value: 'feed' },
          { label: 'Members', detail: String(snap.status?.members ?? 0), value: 'members' },
          { label: 'Agents', detail: String(snap.status?.agents.total ?? 0), value: 'agents' },
          { label: 'Objectives', detail: String(snap.status?.objectives.total ?? 0), value: 'objectives' },
          { label: 'Tasks', detail: String(snap.status?.tasks.total ?? 0), value: 'tasks' },
          { label: 'Connection', detail: 'how clients attach', value: 'connection' },
        ], 0)
        if (result.type === 'select') process.stdout.write(`\n${await renderEliaspaceView(result.value as never)}\n`)
      }
      continue
    }

    const artifactMatch = /^\/artifacts?(?:\s+(.*))?$/.exec(trimmed)
    if (artifactMatch) {
      const { listArtifacts, readArtifact } = await import('../autonomy/artifacts.ts')
      const target = artifactMatch[1]?.trim()

      const viewArtifact = async (name: string): Promise<void> => {
        const artifact = readArtifact(name)
        if (!artifact) {
          writeError(`No artifact matches "${name}". Run /artifact to list them.`)
          return
        }
        const { createMarkdownStream } = await import('../ui/markdown.ts')
        const markdown = createMarkdownStream()
        process.stdout.write(`\n${markdown.push(artifact.content)}${markdown.flush()}\n`)
      }

      if (target) {
        await viewArtifact(target)
        continue
      }

      const artifacts = listArtifacts()
      if (artifacts.length === 0) {
        writeNotice('No artifacts yet — approve a plan in "elia auto" to save one to .elia/artifacts.')
        continue
      }

      const options = artifacts.map((artifact) => ({
        label: artifact.name,
        detail: `${new Date(artifact.updatedAt).toLocaleString()} · ${Math.max(1, Math.round(artifact.sizeBytes / 1024))} KB`,
        value: artifact.name,
      }))
      const result = await pick(`Artifacts (${artifacts.length})`, options, 0, { searchable: true })
      if (result.type === 'select') {
        await viewArtifact(result.value)
      } else if (result.type === 'unavailable') {
        // Not an interactive terminal (piped/scripted) — the picker can't render, so fall back to a plain listing.
        const rows = table(
          [{ header: 'name' }, { header: 'updated' }, { header: 'size', align: 'right' }],
          artifacts.slice(0, 15).map((artifact) => [artifact.name, new Date(artifact.updatedAt).toLocaleString(), `${Math.max(1, Math.round(artifact.sizeBytes / 1024))} KB`]),
        )
        process.stdout.write(`\n${rows.join('\n')}\n`)
        writeUsageLine('/artifact <name> to view one, e.g. /artifact plan')
      }
      continue
    }

    let eliaBookRunPrompt: string | undefined
    const eliaBookMatch = /^\/eliabook(?:\s+(.*))?$/.exec(trimmed)
    if (eliaBookMatch) {
      const { ELIA_BOOK_MENU_OPTIONS, handleEliaBookCommand, listEliaBooks, renderEliaBook, eliaBookUsage } = await import('../eliaBook.ts')
      let argument = eliaBookMatch[1]?.trim() ?? ''
      if (!argument) {
        const choice = await pick('Elia Book', [...ELIA_BOOK_MENU_OPTIONS])
        if (choice.type === 'cancel') continue
        if (choice.type === 'unavailable') {
          writeNotice(eliaBookUsage())
          continue
        }
        argument = choice.value
      }
      if (argument === 'saved' || argument === 'list') {
        const books = listEliaBooks()
        if (books.length === 0) {
          writeNotice('No saved Elia Books yet. Use /eliabook save after completing some work.')
          continue
        }
        const choice = await pick(
          `Saved Elia Books (${books.length})`,
          books.map((book) => ({ label: book.title, detail: `${book.id} · ${book.status} · v${book.activeVersion}`, value: book.id })),
          0,
          { searchable: books.length > 8 },
        )
        if (choice.type === 'select') {
          const book = books.find((item) => item.id === choice.value)
          if (book) {
            const { createMarkdownStream } = await import('../ui/markdown.ts')
            const markdown = createMarkdownStream()
            const content = `${renderEliaBook(book)}\nRun it with: /eliabook run ${book.id}`
            process.stdout.write(`\n${markdown.push(content)}${markdown.flush()}\n`)
          }
        } else if (choice.type === 'unavailable') {
          writeNotice(handleEliaBookCommand('saved').text)
        }
        continue
      }
      const result = handleEliaBookCommand(argument, process.cwd(), currentEliaBookSession())
      if (result.submitText) {
        writeNotice(result.text)
        eliaBookRunPrompt = result.submitText
      } else {
        writeNotice(result.text)
        continue
      }
    }

    const modeMatch = /^\/(betamode|mode)(?:\s+(.*))?$/.exec(trimmed)
    if (modeMatch) {
      const modeArg = modeMatch[2]?.trim()
      if (!modeArg) await (modeMatch[1] === 'betamode' ? handleBetaModePicker() : handleModePersonaPicker())
      else applyModePersonaChoice(modeArg)
      continue
    }

    if (trimmed === 'rewind' || trimmed === '/rewind') {
      writeNotice(renderCheckpointList(checkpoints))
      continue
    }

    const rewindMatch = /^\/?rewind\s+(\d+)$/.exec(trimmed)
    if (rewindMatch) {
      const n = Number.parseInt(rewindMatch[1]!, 10)
      const checkpoint = checkpoints[n]
      if (!checkpoint) {
        writeNotice(`No rewind point ${n}. Type "rewind" to list them.`)
        continue
      }
      const result = await restoreCheckpoint(checkpoint)
      messages.length = 0
      messages.push(...messagesForRestore(checkpoint))
      checkpoints.length = n // later rewind points described a future that no longer exists
      await saveCheckpoints(sessionId, checkpoints)
      sessionTranscript.notice(`Rewound workspace and model context to checkpoint ${n}. Earlier activity remains in the session recording.`)
      await persistInteractiveSession()
      writeNotice(
        `Rewound to before turn ${n} ("${checkpoint.label}") — restored ${result.restored} file(s), removed ${result.deleted} file(s) created since.`,
      )
      continue
    }

    const quickchatClassic = /^\/quickchat(?:\s+(.*))?$/.exec(trimmed)
    if (quickchatClassic) {
      const session = await registerQuickchatSession()
      if (!session) {
        writeNotice('No session is registered for quickchat here. Start one with: elia sessions new --name <name>')
        continue
      }
      const { handleQuickchatCommand } = await import('../quickchat/quickchat.ts')
      const result = await handleQuickchatCommand(trimmed, session)
      if (result.handled) writeNotice(formatQuickchatResult(result.result))
      continue
    }

    const customClassic = resolveCustomCommand(trimmed)
    let commandToRun = eliaBookRunPrompt ?? customClassic?.expanded ?? trimmed
    if (customClassic) writeNotice(`Expanded ${customClassic.command.name} → prompt`)
    if (!eliaBookRunPrompt && !customClassic && trimmed.startsWith('/') && !trimmed.startsWith('/attach')) {
      // Unknown built-in-looking slash: prefer an explicit error over sending "/foo" to the model.
      const known = allSlashCommands().some((c) => trimmed === c.name || trimmed.startsWith(`${c.name} `))
      if (!known && /^\/[a-z]/.test(trimmed)) {
        writeNotice(`Unknown command: ${trimmed.split(/\s+/)[0]}. Type /help for the list.`)
        continue
      }
    }
    if (replMode === 'manual') {
      const { risky, reason } = await classifyCommandRisk(commandToRun)
      if (risky) {
        const label = `${reason ? `${redactText(reason, 500)}\n` : ''}About to: "${redactText(commandToRun, 500)}" — run it? [y]es / [n]o / [e]dit: `
        const result = await confirmOnce(prompt, label)
        if (result.action === 'reject') {
          writeNotice('Skipped.')
          continue
        }
        if (result.action === 'amend') commandToRun = result.feedback
      }
    }

    const turnText = carriedShellContext.length > 0
      ? `${carriedShellContext.splice(0).join('\n\n')}\n\n${commandToRun}`
      : commandToRun
    try {
      await runCheckpointedTurn(turnText, async (assessment, request) => {
        const result = await confirmOnce(prompt, actionApprovalPrompt(assessment, request))
        return result.action === 'approve'
      })
    } catch (err) {
      writeError(`Error: ${err instanceof Error ? err.message : String(err)}`)
    }
    await persistInteractiveSession()
    const taskSummary = renderTaskSummary(taskSessions)
    const contextLine = renderContextStatus(messages, await countEpisodes(sessionId), compactionThresholdFor(config.model))
    const { formatCompactUsage } = await import('../usage.ts')
    writeUsageLine([contextLine, dim(formatCompactUsage(config.model)), taskSummary ? dim(taskSummary) : ''].filter(Boolean).join('  ·  '))
    // The full workspace panel is shown once at startup and on demand via
    // /status — reprinting all 14 lines after every turn buried the conversation.
  }

  prompt.close()
  try {
    await fireLifecycleEvent('SessionEnd', { SESSION: sessionId })
  } catch {
    // Session-end hooks are best-effort.
  }
  // The registerShutdownCleanup callback registered above already writes the
  // "ended" heartbeat for this and every other exit path — no separate call
  // needed here.
  if (messages.length > 0 && !machineReadable) process.stdout.write(`${box([getSessionSummaryLine(config.model)])}\n`)
  await printTurnProfileReport()
  if (messages.length > 0 && !machineReadable) writeNotice(`Resume this session later with: elia --resume ${sessionId}`)
  writeNotice('Goodbye!')
}

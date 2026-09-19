/**
 * The pieces the dispatcher and the REPL both need.
 *
 * These sat in index.ts between the commands that use them and the REPL that
 * uses them, which is what pinned `runInteractive` in place: moving the REPL
 * out while `loadRuntimeSkills` and the approval prompts stayed behind would
 * have made index.ts and the REPL import each other. Four of them really are
 * shared (`loadRuntimeSkills` alone has eleven call sites outside the REPL);
 * the rest are REPL-only and come along so the whole cluster lands in one
 * place rather than being split on a technicality.
 */
import * as readline from 'node:readline/promises'
import * as pathModule from 'node:path'
import type { ConversationMessage, AgentMode } from '../agent.ts'
import { writeNotice, writeError, writeUsageLine } from '../ui/stream.ts'
import { type SlashCommand } from '../ui/slashPrompt.ts'
import { customCommandsAsSlashEntries, loadCustomCommands } from '../commands/loader.ts'
import { confirmOnce } from '../ui/confirm.ts'
import { dim } from '../ui/theme.ts'
import { type ActionAssessment, type ActionRequest } from '../autonomy/governor.ts'
import { machineReadable } from '../ui/runtime.ts'
import { redactText } from '../ui/redact.ts'
import { flagValue, hasFlag, subcommand } from './argv.ts'

const REPL_COMMANDS: SlashCommand[] = [
  { name: '/model', description: 'switch model / provider' },
  { name: '/mode', description: 'switch mode: dev, cyber, battmann' },
  { name: '/betamode', description: 'experimental modes & personas — sports, fitness, marketing, finance, …' },
  { name: '/thinking', description: 'set reasoning effort' },
  { name: '/theme', description: 'colours: dark, light, or your terminal\'s own' },
  { name: '/rewind', description: 'restore an earlier checkpoint' },
  { name: '/compact', description: 'summarise the conversation to free context · /compact [focus]' },
  { name: '/clear', description: 'start a fresh conversation (the old one stays resumable)' },
  { name: '/settings', description: 'model, effort, risk checks, compact, clear' },
  { name: '/mcp', description: 'MCP servers — add, test, reload, remove' },
  { name: '/connector', description: 'hosted MCP connectors — add, test, remove' },
  { name: '/marketplace', description: 'packages, skills, MCP: installed · suggested · add' },
  { name: '/packages', description: 'installed packages & skills — remove one' },
  { name: '/skills', description: 'list loaded skills' },
  { name: '/task', description: 'browse tasks and subagents' },
  { name: '/sessions', description: 'other elia sessions in this project' },
  { name: '/eliaspace', description: 'collaborative workspace — status, feed, members, agents' },
  { name: '/artifact', description: 'browse saved plan artifacts' },
  { name: '/verify', description: 'run project checks · /verify on|off' },
  { name: '/auto', description: 'auto-escalate big builds to the autonomous pipeline · /auto on|off' },
  { name: '/self', description: "stop asking before elia changes its own source · /self on|off" },
  { name: '/cost', description: 'token & cost breakdown' },
  { name: '/usage', description: 'live token consumption, context & limits' },
  { name: '/status', description: 'session, plan, subagents, artifacts' },
  { name: '/expand', description: 'reprint the last tool result in full' },
  { name: '/attach', description: 'attach an image to your next message · /attach <path>' },
  { name: '/export', description: 'save the conversation to Markdown' },
  { name: '/brain', description: 'cross-session project memory' },
  { name: '/lessons', description: 'what earlier sessions learned here' },
  { name: '/eliabook', description: 'recorded insights & reusable verified workflows' },
  { name: '/why', description: 'recorded rationale for a file or topic' },
  { name: '/track', description: "elia's track record on this project" },
  { name: '/team', description: 'model tiers & per-role routing' },
  { name: '/capabilities', description: 'specialist capabilities & risk classes' },
  { name: '@skills', description: 'choose active skill tools for the next turn' },
]

/** Built-ins plus project/user `.elia/commands/*.md` prompt macros. */
export function allSlashCommands(): SlashCommand[] {
  return [...REPL_COMMANDS, ...customCommandsAsSlashEntries(loadCustomCommands())]
}

/** Beta (experimental) modes — reached via `--beta <name>` on the CLI and `/betamode` in a session. */
const BETA_MODES = ['sports', 'fitness'] as const

let warnedDeprecatedModeFlag = false

export function requestedAgentMode(): AgentMode {
  if (hasFlag('--cyber')) return 'cyber'
  if (hasFlag('--battmann')) return 'battmann'
  const beta = flagValue('--beta')
  if (beta && (BETA_MODES as readonly string[]).includes(beta)) return beta as AgentMode
  if (beta) {
    if (!warnedDeprecatedModeFlag) {
      warnedDeprecatedModeFlag = true
      writeError(`--beta ${beta} is not a beta mode. Available: ${BETA_MODES.join(', ')}. Starting in dev mode.`)
    }
    return 'dev'
  }
  // Back-compat: the old dedicated flags still work but are deprecated in favour of `--beta`.
  if (hasFlag('--sports') || hasFlag('--fitness')) {
    const legacy: AgentMode = hasFlag('--sports') ? 'sports' : 'fitness'
    if (!warnedDeprecatedModeFlag) {
      warnedDeprecatedModeFlag = true
      writeNotice(`--${legacy} is deprecated; use "--beta ${legacy}".`)
    }
    return legacy
  }
  return 'dev'
}

export function warnIfAtFilesystemRoot(): void {
  const cwd = process.cwd()
  const { root } = pathModule.parse(cwd)
  if (cwd === root || cwd === root.replace(/[\\/]$/, '')) {
    writeError(
      `elia is running at a filesystem root (${cwd}). This works badly — the workspace folder, searches, and project detection all assume a project directory. cd into an actual project first.`,
    )
  }
}

export async function printTurnProfileReport(): Promise<void> {
  const { renderProfileReport } = await import('../profile.ts')
  const report = renderProfileReport()
  if (report && !machineReadable) process.stdout.write(`\n${dim(report)}\n`)
}


export function userMessage(text: string, images: import('../attachments.ts').ImageAttachment[] = []): ConversationMessage {
  if (images.length === 0) return { role: 'user', content: [{ type: 'text', text }] }
  // Images before text — the order every vision model is tuned for. A prompt
  // that was *only* an image path keeps an empty text block so provider
  // adapters that key off "the last text block" still have one.
  const content: ConversationMessage['content'] = images.map((img) => ({
    type: 'image' as const,
    mediaType: img.mediaType,
    data: img.data,
    alt: img.alt,
  }))
  content.push({ type: 'text', text })
  return { role: 'user', content }
}

export async function classifyCommandRisk(command: string): Promise<{ risky: boolean; reason?: string }> {
  // Codex is an autonomous workspace-writing agent, not an Elia tool-calling
  // model — every prompt hands the whole task to it. That hand-off is always
  // worth an explicit confirmation, so flag it risky rather than skipping the
  // check. (The Ink REPL confirms this directly; this covers the classic path.)
  const { config } = await import('../config.ts')
  if (config.providerName === 'codex') {
    return { risky: true, reason: `${config.model} (Codex) will run this task autonomously in your workspace — it can read, edit, and run commands.` }
  }
  const { classifyRisk, looksObviouslySafe } = await import('../autonomy/risk.ts')
  // Skip the fast-tier round-trip for a plain question — it can't be a risky
  // command, and it's the common case sitting between Enter and the turn.
  if (looksObviouslySafe(command)) return { risky: false }
  return classifyRisk(command)
}

/** The plan-approval gate for `elia auto`/`elia fork` — thin wrapper over the shared confirmOnce helper. */
export function createInteractiveApprover(rl: readline.Interface) {
  return () => confirmOnce(rl, 'Approve this plan? [y]es / [n]o / [e]dit <what to change>: ')
}

/** The approval menu's heading — the question, in words, not the tool's id. */
export function approvalTitle(toolName: string, intent?: string): string {
  if (intent === 'self_edit') return toolName === 'delete_file' ? "Delete a file from elia's own source?" : "Change elia's own source?"
  switch (toolName) {
    case 'run_command':
      return 'Run this command?'
    case 'run_program':
      return 'Run this program?'
    case 'edit_file':
      return 'Edit this file?'
    case 'write_file':
      return 'Write this file?'
    case 'task':
      return 'Start a subagent?'
    case 'codex_delegate':
      return 'Hand this task to Codex?'
    default:
      return `Allow ${toolName}?`
  }
}

export function actionApprovalPrompt(assessment: ActionAssessment, request: ActionRequest): string {
  const rawIntent = request.input.command ?? request.input.target ?? request.input.action ?? request.name
  const intent = redactText(typeof rawIntent === 'string' ? rawIntent : JSON.stringify(rawIntent), 500)
  return `\n${redactText(assessment.reason, 500)}\nRisk: ${assessment.risk} · reversible: ${assessment.reversible ? 'yes' : 'no'}\nAbout to run ${request.name}: ${intent}\nApprove this exact action? [y]es / [n]o: `
}

/**
 * @param deferMcp  When true, return as soon as local skills are loaded and let
 *   the MCP connect pass finish in the background — its "N MCP tools" / failure
 *   notices are emitted whenever it settles (routed into the live transcript if
 *   the Ink frame is already up). Used by the interactive REPL so a slow stdio
 *   server can't hold up the prompt. Every non-interactive path leaves it false
 *   and still awaits MCP fully, so a one-shot run has its full toolset on turn 1.
 */
export async function loadRuntimeSkills({ deferMcp = false }: { deferMcp?: boolean } = {}): Promise<void> {
  const { loadSkills } = await import('../skills/loader.ts')
  const skills = await loadSkills()
  if (skills.loaded.length > 0 && subcommand !== 'skills') {
    writeUsageLine(`${skills.loaded.length} learned tool(s): ${skills.loaded.map((skill) => skill.name).join(', ')}`)
  }

  const { beginMcpLoad } = await import('../mcp/registry.ts')
  // beginMcpLoad is idempotent and memoised: if interactive startup already
  // kicked the connect pass off (so it could run during the intro), this awaits
  // that same pass; otherwise it starts and awaits it now.
  const announce = (mcp: Awaited<ReturnType<typeof beginMcpLoad>>): void => {
    if (mcp.loaded.length > 0 && subcommand !== 'skills') {
      // One line, not a wall of tool names — the full list is a `/mcp` away.
      writeUsageLine(`${mcp.loaded.length} MCP tool(s) from ${mcp.servers.join(', ')} · /mcp`)
    }
    for (const failure of mcp.failed) writeNotice(`MCP server "${failure.server}" unavailable: ${failure.reason}`)
    for (const error of mcp.configErrors) writeNotice(`MCP config: ${error}`)
  }

  if (deferMcp) {
    void beginMcpLoad().then(announce).catch(() => {})
    return
  }
  announce(await beginMcpLoad())
}

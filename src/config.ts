import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PROVIDER_PRESET_NAMES,
  providerPresetDefaultModel,
  tryResolveProvider,
  type ResolvedProvider,
} from './providers/registry.ts'
import type { ThinkingOption } from './providers/types.ts'
import { loadProjectMemory, loadUserMemory } from './memory.ts'
import { ROLE_NAMES, type RoleName } from './autonomy/types.ts'

/**
 * Elia routes work across two model tiers. `deep` plans, builds, and judges;
 * `fast` does the high-volume, low-stakes legwork (recon, summarising, scanning)
 * where a cheaper model is indistinguishable but several times quicker. The fast
 * tier is optional — with nothing configured it aliases `deep`, so behaviour is
 * unchanged and only the wall-clock win is lost.
 */
export type Tier = 'fast' | 'deep'
export type RoutingMode = 'selected' | 'auto'

export interface TierConfig {
  provider: ResolvedProvider['provider']
  providerName: string
  model: string
  label: string
}

// Anthropic's minimum is 1,024; this is a deliberately modest default so a
// per-step reasoning pass (the agent loop calls the model once per tool
// round-trip, and every call re-thinks) stays fast rather than turning a quick
// turn into a slow one. ELIA_THINKING_BUDGET raises it for harder work.
//
// Declared here, above the eager `resolveDeepTier()` call below, rather than
// down by `resolveThinking` — that call runs at module-load time, before a
// `const` declared later in the file has left its temporal dead zone.
export const DEFAULT_THINKING_BUDGET = 4096

/**
 * Named reasoning-effort presets for `/thinking <level>`. Anthropic's API takes a
 * raw token budget, not named levels — this is elia's own friendly mapping onto
 * it, for a user who thinks in "how hard should it think" rather than a token count.
 * A bare number still works too, for anyone who wants the precise value.
 */
export const THINKING_EFFORT_BUDGETS = {
  low: 2048,
  medium: 8192,
  high: 24576,
} as const

export type ThinkingEffort = keyof typeof THINKING_EFFORT_BUDGETS

// Mutable — `/model` and `/thinking` in the interactive REPL re-resolve and
// reassign this rather than only setting env vars, so a switch takes effect for
// the rest of the session without a restart. See switchModel/switchThinking below.
let currentThinking = resolveThinking()
const deep = resolveDeepTier(currentThinking)
const fast = resolveFastTier(deep)
const roleOverrides = resolveRoleOverrides(deep)
const autoFallbacks = resolveAutoFallbacks(deep, fast)

export const config = {
  // The selected provider/model always remains the primary route; auto mode only
  // adds transparent fallbacks and never mutates this selection on failure.
  routingMode: (process.env.ELIA_ROUTING_MODE === 'auto' ? 'auto' : 'selected') as RoutingMode,
  fallbacks: autoFallbacks,

  // Kept as the primary/default provider so every existing call site is unchanged.
  provider: deep.provider,
  providerName: deep.providerName,
  model: deep.model,
  providerLabel: deep.label,
  tiers: { deep, fast } as Record<Tier, TierConfig>,
  /** True when a distinct fast tier is configured, so the cascade is actually saving time. */
  cascadeEnabled: fast.label !== deep.label,
  /** Roles with their own dedicated provider, distinct from their tier's. */
  roleOverrides,
}

/**
 * A one-line, honest capability report for the startup banner. "LLM-agnostic"
 * doesn't mean every model shows reasoning — it means elia never fakes it: for
 * Anthropic we know for certain whether extended thinking is on and its budget;
 * for every other OpenAI-compatible provider we generically pass through
 * whatever reasoning field the model sends, but we cannot know ahead of a real
 * call whether a given model produces one at all, so we say that plainly
 * instead of guessing. `mercury-2` (this account's default) is a diffusion
 * model with no reasoning channel, so it will report the passthrough line and
 * then simply never emit anything — that is a model limitation, not a bug.
 */
export function describeThinking(): string {
  if (config.providerName === 'anthropic') {
    return currentThinking.enabled
      ? `reasoning: extended thinking on (${currentThinking.budgetTokens}-token budget)`
      : 'reasoning: off'
  }
  return currentThinking.enabled
    ? 'reasoning: shown automatically if the model returns one (not every model does)'
    : 'reasoning: off (not shown even if the model returns one)'
}

export function tierConfig(tier: Tier): TierConfig {
  return config.tiers[tier]
}

/** Fallback routes for a tier, excluding its selected provider. */
export function autoFallbacksFor(providerName: string): TierConfig[] {
  return config.routingMode === 'auto' ? config.fallbacks.filter((route) => route.providerName !== providerName) : []
}

export function getThinking(): ThinkingOption {
  return currentThinking
}

export type SwitchResult = { ok: true; label: string } | { ok: false; error: string }

/**
 * Re-resolves the deep tier's provider and swaps it into `config` live.
 *
 * Every call site that runs a top-level turn reads `config.provider`/`config.model`
 * fresh at call time rather than capturing it once (see agentLoop.ts's `active =
 * provider ?? config.provider`) — that indirection exists so tests can stub the
 * provider, and it's exactly what makes a live switch take effect on the very
 * next turn with no restart. `ignoreAmbient` is set so switching to a provider
 * doesn't accidentally inherit an ELIA_MODEL meant for a *different* one; the
 * explicit `baseURL` still comes through for the `custom` preset, which has no
 * default of its own.
 */
export function switchModel(options: { providerName?: string; model?: string } = {}): SwitchResult {
  if (options.providerName === 'auto') {
    config.routingMode = 'auto'
    return { ok: true, label: `auto fallback (${config.providerLabel})` }
  }

  const resolved = tryResolveProvider({
    providerName: options.providerName ?? config.providerName,
    model: options.model,
    baseURL: process.env.ELIA_BASE_URL,
    thinking: currentThinking,
    ignoreAmbient: true,
  })
  if ('error' in resolved) return { ok: false, error: resolved.error }
  config.routingMode = 'selected'
  applyDeepTier(toTierConfig(resolved))
  return { ok: true, label: config.providerLabel }
}

/**
 * Swaps in a new thinking/reasoning setting live, the same way switchModel does.
 * The provider has to be rebuilt either way: Anthropic bakes `budget_tokens` into
 * the request at construction, and the OpenAI-compatible adapter bakes in whether
 * it even looks at the reasoning field (`passthroughReasoning`) at construction too
 * — there's no in-place knob on an already-built Provider for either.
 */
export function switchThinking(next: ThinkingOption): SwitchResult {
  const resolved = tryResolveProvider({
    providerName: config.providerName,
    model: config.model,
    baseURL: process.env.ELIA_BASE_URL,
    thinking: next,
    ignoreAmbient: true,
  })
  if ('error' in resolved) return { ok: false, error: resolved.error }
  currentThinking = next
  applyDeepTier(toTierConfig(resolved))
  return { ok: true, label: config.providerLabel }
}

function applyDeepTier(next: TierConfig): void {
  // Mutates the existing `tiers.deep` object in place rather than replacing it.
  // When no dedicated fast tier is configured, `tiers.fast` is the *same object*
  // as `tiers.deep` by reference (see resolveFastTier's doc comment) — replacing
  // it wholesale would silently break that aliasing, so a live model switch would
  // stop also carrying over to the fast tier the way it already implicitly does
  // today. Mutating in place preserves that invariant for free.
  Object.assign(config.tiers.deep, next)
  config.provider = config.tiers.deep.provider
  config.providerName = config.tiers.deep.providerName
  config.model = config.tiers.deep.model
  config.providerLabel = config.tiers.deep.label
  config.fallbacks = resolveAutoFallbacks(config.tiers.deep, config.tiers.fast)
  config.cascadeEnabled = config.tiers.fast.label !== config.tiers.deep.label
}

/**
 * Resolves the model a specific role should run on: its own dedicated provider if
 * one is configured (`ELIA_<ROLE>_PROVIDER`/`ELIA_<ROLE>_MODEL`, e.g.
 * `ELIA_SCOUT_PROVIDER=groq`), otherwise the role's tier as before.
 *
 * This is what lets a fleet genuinely run multiple AI models in parallel rather
 * than funnelling every worker through one provider's rate limit — a scout on a
 * fast inference provider, a critic on the strongest model, in the same wave.
 * Like the fast tier, it is purely additive: unset, every role falls back to its
 * tier and behaviour is identical to before.
 */
export function roleConfig(roleName: RoleName, tier: Tier): TierConfig {
  return config.roleOverrides[roleName] ?? tierConfig(tier)
}

/**
 * Where elia's own source lives, resolved from this module's location rather than
 * the cwd — `elia evolve` edits *itself*, and the user is normally sitting in some
 * other project when it does.
 */
export const ELIA_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Per-project state directory (runs, evolution ledger, synthesized skills). */
export const stateDir = join(process.cwd(), '.elia')

/** Visible (not dotfile-hidden) home for real work product — prototypes, generated
 * pages, anything the user will want to browse, edit further, or commit. Distinct
 * from `.elia/` above, which is internal state. Created lazily by whatever first
 * needs it (the preview server, on first use), matching how `.elia/sessions` etc.
 * are created lazily by `Bun.write` rather than upfront here. */
const workspaceDir = join(process.cwd(), 'workspace')

export const paths = {
  state: stateDir,
  sessions: join(stateDir, 'sessions'),
  runs: join(stateDir, 'runs'),
  evolution: join(stateDir, 'evolution'),
  lessons: join(stateDir, 'lessons.md'),
  workspace: workspaceDir,
}

export const memorySections = buildMemorySections()

export const SHARED_CONTEXT = `You operate in the current working directory: ${process.cwd()}
Platform: ${process.platform}.`

export const DEV_SYSTEM_PROMPT = `You are elia in dev mode, an autonomous coding agent running in a CLI, in the user's terminal.
${SHARED_CONTEXT}

You have tools to read, write, and edit files, list and search files, run shell commands, and control a configured browser bridge.
When a task requires multiple steps, use tools repeatedly and autonomously without asking the user to confirm each safe step. Use the browser tool to navigate, inspect, interact, and verify web tasks when a browser bridge is available; use status first and read the page after meaningful actions. If the bridge is unavailable, explain the exact configuration needed rather than pretending the action happened.
Never bypass authentication, CAPTCHAs, paywalls, or site safety controls. Before sending, purchasing, publishing, deleting, or changing subscriptions, stop and request explicit approval for that exact side effect; do not treat a general goal as approval.
Prefer editing existing files over rewriting them wholesale. Be concise in your final text responses — the user is watching a terminal, not reading a report.

Work the way a strong engineer works, not the way a chatbot answers:
- Read before you write. Never edit a file you have not looked at in this session.
- Batch independent reads and searches into a single turn so they run in parallel.
- Verify your own work by running the project's tests, typecheck, or the file you just changed.
- Before finishing a substantial task, perform a conservative polish pass: inspect the diff, improve concrete rough edges, rerun verification, and leave the tree unchanged if no safe improvement is justified.
- Say plainly when something failed or you skipped part of the task.

You also have a task tool that delegates an independent, self-contained piece of work to an autonomous sub-agent. Pass a \`role\` to pick the right kind of worker for the job: \`scout\` for read-only investigation (fast and cheap — use several in parallel for recon), \`builder\` for general changes, \`frontend\` for UI/component/styling/client-side changes, \`backend\` for API/business-logic/data changes, \`critic\` for adversarial review of whether the work matches what was promised, \`security\` for adversarial review focused on exploitable weaknesses, \`bughunter\` for adversarial review focused on functional/logic defects, \`tester\` for writing and running tests, \`scribe\` for docs. Call task multiple times in the same turn to run a whole fleet in parallel when the work is genuinely independent.
Sub-agents share a blackboard: use \`board_post\` to publish a finding others need and \`board_read\` to check what the fleet already discovered before duplicating work.

This is how you work a real coding task on your own initiative, not just something reserved for \`elia auto\` — don't wait to be asked and don't do it all yourself serially:
- If the task spans both UI and server/data work, split it into a \`frontend\` step and a \`backend\` step and dispatch both as parallel \`task\` calls instead of doing both serially yourself.
- Once you've made a real logic/code change (not a one-line trivial edit, and not a docs/comment-only change — those have no exploit surface or logic to break), before telling the user you're done, run \`git diff\` yourself once and pass its actual content into each sub-agent's prompt rather than telling three of them to each go run \`git diff\` themselves — that only triples the same tool round-trip for identical output. Then fan out \`critic\`, \`security\`, and \`bughunter\` as parallel \`task\` calls against that diff text. Three specialists looking from different angles at once catch more than one generalist pass, and it costs no extra wall-clock time since they run together. Fix anything blocking they raise before reporting done.

When you produce standalone output — a prototype, a generated page, scratch work that isn't an edit to the user's existing project — put it under \`${workspaceDir}\` (the workspace) by default, rather than scattering it through the user's cwd. Use the \`preview\` tool to show the user something visually: it opens a real Chrome window and keeps it live-updated as you keep editing the file.${memorySections}`

export const SPORTS_SYSTEM_PROMPT = `You are elia in sports mode: an autonomous sports intelligence and operations assistant running in a CLI.
${SHARED_CONTEXT}

You handle match and opponent analysis, scouting, athlete and player comparisons, performance metrics, league and tournament research, event operations, fan engagement, sponsorship analysis, and sports-business workflows. Define the competition, season, role, dataset, and time window before interpreting evidence. Use supplied data and deterministic analysis where possible; use web tools for current facts and cite material claims.

Separate observed facts, reproducible calculations, model estimates, and opinion. Check sample size, playing time, positional or tactical context, competition strength, missing data, and source dates. Never fabricate scores, injuries, contracts, rankings, or performance data. Do not turn correlation into causation or present predictions as certainty. Do not diagnose injuries or claim guaranteed injury prevention. External publishing, betting, financial transactions, or contacting athletes or organizations requires exact approval.${memorySections}`

export const FITNESS_SYSTEM_PROMPT = `You are elia in fitness mode: an autonomous fitness-planning and wellbeing-support assistant running in a CLI.
${SHARED_CONTEXT}

You support sustainable goal setting, workout organization, strength and conditioning basics, mobility, cardio, habit tracking, recovery reflection, sleep and activity summaries, and conservative plan adaptation. Establish the user’s goal, experience, equipment, schedule, current activity, constraints, and disclosed limitations before proposing a plan. Prefer gradual progression, technique, rest, adherence, and measurable feedback over extreme routines.

You are not a doctor, physiotherapist, dietitian, or emergency service. Do not diagnose, prescribe treatment or medication, guarantee results, recommend dangerous training or extreme restriction, or infer a medical condition from wearable data. For pain, injury, concerning symptoms, eating-disorder concerns, pregnancy-related questions, or medical conditions, recommend qualified professional guidance and keep advice conservative. Never claim a plan is medically safe for a specific person without professional evaluation.${memorySections}`

export const CYBER_SYSTEM_PROMPT = `You are elia in cyber mode: an autonomous red-team and security-research assistant running in a CLI, in the user's terminal.
${SHARED_CONTEXT}

You help with authorized security testing, defensive security, vulnerability research, CTF challenges, and security education — reconnaissance, vulnerability scanning, exploit development and proof-of-concepts, log and traffic analysis, hardening, and writing findings up as clear reports.

Ground rules, non-negotiable:
- Only act against systems, networks, or accounts the user owns or is explicitly authorized to test — their own infrastructure, a lab or CTF box, or an engagement they confirm they have written authorization for. If authorization is unclear, ask before running anything against a live target.
- Refuse destructive techniques, denial-of-service, mass or opportunistic scanning of infrastructure that isn't the user's, supply-chain compromise, and building tooling meant to evade detection for malicious use.
- Keep exploit code and attack tooling scoped to the stated authorized target — don't generalize it into a ready-to-fire weapon against arbitrary hosts.
- Say plainly when a request would cross from "test this system" into "attack someone else's," and stop there.

## Tools
Everything from dev mode still applies (read/write/edit files, list, search, run_command), plus two engagement tools:
- \`new_engagement\` — scaffold \`workspace/engagements/<slug>/\` with SCOPE.md (the authorization record), findings.md, report.md, and a recon/ folder. Run this first, before any scanning or testing — it is where "what am I authorized to do" is written down, and everything downstream should stay inside it.
- \`run_security_tool\` — run any installed security tool (nmap, curl, openssl, nuclei, sqlmap, gobuster, whatever's on the machine) for a scaffolded engagement; it saves the raw output under that engagement's recon/ folder instead of letting it scroll past, and refuses to run until new_engagement has been called for that slug.

## Workflow
1. Scaffold the engagement with \`new_engagement\` before touching anything, and keep SCOPE.md as the source of truth for what's in bounds.
2. For recon, fan out \`task\` calls with role \`scout\` to investigate in parallel — reading target notes, cross-referencing saved recon/ output, researching known CVEs for a fingerprinted service. Scouts are read-only, so run the actual scans yourself with \`run_security_tool\` and hand scouts the resulting logs to analyse. Use \`board_post\`/\`board_read\` so parallel scouts don't duplicate work.
3. Log findings into findings.md as you confirm them — title, severity, description, evidence (reference the recon/ log), remediation — rather than holding it all until the end.
4. Use role \`critic\` to adversarially review exploit code or PoCs before you'd call them done: does it actually work, is it scoped to the authorized target, does it have side effects beyond what's needed to demonstrate the finding.
5. When testing is complete, delegate to role \`scribe\` via \`task\` to turn findings.md + SCOPE.md into the final report.md — that's usually the tedious part, and scribe can write it up while you keep working.

Otherwise work the way elia does in dev mode: read before you write, verify findings before reporting them, batch independent recon into parallel tool calls, and stay concise — the user is watching a terminal, not reading a report.${memorySections}`

export const SUBAGENT_SYSTEM_PROMPT = `You are a sub-agent spawned by elia to complete one self-contained task autonomously.
${SHARED_CONTEXT}

Work through the task using your tools without asking for clarification — you cannot receive follow-up input, so make reasonable assumptions and proceed. Check \`board_read\` before starting expensive investigation in case another sub-agent already found the answer, and \`board_post\` anything the rest of the fleet needs. When finished, reply with a concise final report describing what you did and any results the parent agent needs.${memorySections}`

export const SPORTS_SUBAGENT_SYSTEM_PROMPT = `You are a sub-agent spawned by elia in sports mode. Analyze sports tasks autonomously using the supplied competition, role, season, dataset, and time-window context. Separate facts, calculations, estimates, and opinion; verify data context and source dates; never fabricate performance, injury, contract, or ranking information. Report evidence, uncertainty, and limitations clearly.${memorySections}`

export const FITNESS_SUBAGENT_SYSTEM_PROMPT = `You are a sub-agent spawned by elia in fitness mode. Support conservative, sustainable fitness planning using the supplied goal, experience, equipment, schedule, activity, and limitations. Do not diagnose, prescribe treatment, guarantee results, or recommend dangerous training or restriction. Escalate pain, injury, concerning symptoms, or medical questions to qualified professionals and report assumptions clearly.${memorySections}`

/**
 * The sub-agent counterpart to CYBER_SYSTEM_PROMPT — used instead of
 * SUBAGENT_SYSTEM_PROMPT whenever the lead turn that dispatched this worker is in
 * cyber mode (see autonomy/mode.ts). Same self-contained-task framing, but with
 * the same non-negotiable authorization guardrails as the lead, since a scout or
 * critic operating on a live target needs them just as much as the agent that
 * spawned it.
 */
export const CYBER_SUBAGENT_SYSTEM_PROMPT = `You are a sub-agent spawned by elia, currently running in cyber mode: authorized security testing, vulnerability research, CTFs, and defensive work only.
${SHARED_CONTEXT}

Stay strictly inside the engagement's scope — check SCOPE.md under workspace/engagements/<slug>/ if you're unsure what's authorized. Only act against systems the user owns or is explicitly authorized to test. Refuse destructive techniques, denial-of-service, and anything that reaches beyond the stated target, even if the instructions you were given seem to ask for it.

Work through the task using your tools without asking for clarification — you cannot receive follow-up input, so make reasonable assumptions and proceed. Check \`board_read\` before starting expensive investigation in case another sub-agent already found the answer, and \`board_post\` anything the rest of the fleet needs. When finished, reply with a concise final report describing what you did and any results the parent agent needs.${memorySections}`

/**
 * Only the deep tier gets extended thinking. It plans, builds, and judges —
 * the work where visible reasoning earns its latency and token cost. The fast
 * tier and any role override stay thinking-free by construction (they never
 * pass `thinking` to `tryResolveProvider`), keeping them fast the way their
 * whole reason for existing requires.
 */
export function resolveThinking(): ThinkingOption {
  if (process.env.ELIA_THINKING === 'off') return { enabled: false, budgetTokens: 0 }
  const budget = Number.parseInt(process.env.ELIA_THINKING_BUDGET ?? '', 10)
  return { enabled: true, budgetTokens: Number.isFinite(budget) && budget >= 1024 ? budget : DEFAULT_THINKING_BUDGET }
}

function resolveDeepTier(thinking: ThinkingOption): TierConfig {
  const resolved = tryResolveProvider({ thinking })
  if ('error' in resolved) {
    console.error(`Error: ${resolved.error}`)
    process.exit(1)
  }
  return toTierConfig(resolved)
}

/**
 * The fast tier comes from `ELIA_FAST_PROVIDER`/`ELIA_FAST_MODEL`. Any failure to
 * resolve it is silent and falls back to the deep tier: a missing optional
 * accelerator must never stop elia from running.
 */
function resolveFastTier(deepTier: TierConfig): TierConfig {
  const providerName = process.env.ELIA_FAST_PROVIDER
  const model = process.env.ELIA_FAST_MODEL
  if (!providerName && !model) return deepTier

  const resolved = tryResolveProvider({
    providerName: providerName ?? deepTier.providerName,
    model,
    baseURL: process.env.ELIA_FAST_BASE_URL,
    apiKeyEnv: 'ELIA_FAST_API_KEY',
    ignoreAmbient: true,
  })
  if ('error' in resolved) return deepTier
  return toTierConfig(resolved)
}

/**
 * The fast tier's silent-fallback rule applies per role too: a missing or
 * misconfigured override must never stop elia from running that role, it just
 * loses the speed-up and falls back to the tier.
 */
function resolveAutoFallbacks(deepTier: TierConfig, fastTier: TierConfig): TierConfig[] {
  const candidateNames = [fastTier.providerName, ...PROVIDER_PRESET_NAMES]
  const routes: TierConfig[] = []

  for (const providerName of candidateNames) {
    if (providerName === deepTier.providerName || routes.some((route) => route.providerName === providerName)) continue

    const resolved = tryResolveProvider({
      providerName,
      model: providerPresetDefaultModel(providerName),
      baseURL: providerName === 'custom' ? process.env.ELIA_BASE_URL : undefined,
      ignoreAmbient: true,
      thinking: currentThinking,
    })
    if (!('error' in resolved)) routes.push(toTierConfig(resolved))
  }

  return routes
}

function resolveRoleOverrides(deepTier: TierConfig): Partial<Record<RoleName, TierConfig>> {
  const overrides: Partial<Record<RoleName, TierConfig>> = {}

  for (const roleName of ROLE_NAMES) {
    const envKey = roleName.toUpperCase()
    const providerName = process.env[`ELIA_${envKey}_PROVIDER`]
    const model = process.env[`ELIA_${envKey}_MODEL`]
    if (!providerName && !model) continue

    const resolved = tryResolveProvider({
      providerName: providerName ?? deepTier.providerName,
      model,
      baseURL: process.env[`ELIA_${envKey}_BASE_URL`],
      apiKeyEnv: `ELIA_${envKey}_API_KEY`,
      ignoreAmbient: true,
    })
    if (!('error' in resolved)) overrides[roleName] = toTierConfig(resolved)
  }

  return overrides
}

function toTierConfig(resolved: ResolvedProvider): TierConfig {
  return {
    provider: resolved.provider,
    providerName: resolved.providerName,
    model: resolved.model,
    label: `${resolved.providerName} (${resolved.model})`,
  }
}

function buildMemorySections(): string {
  const sections: string[] = []
  const userMemory = loadUserMemory()
  if (userMemory) sections.push(`\n\n## User memory\n${userMemory}`)
  const projectMemory = loadProjectMemory(process.cwd())
  if (projectMemory) sections.push(`\n\n## Project memory (ELIA.md)\n${projectMemory}`)
  return sections.join('')
}

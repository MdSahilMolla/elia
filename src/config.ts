import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tryResolveProvider, type ResolvedProvider } from './providers/registry.ts'
import { loadProjectMemory, loadUserMemory } from './memory.ts'

/**
 * Elia routes work across two model tiers. `deep` plans, builds, and judges;
 * `fast` does the high-volume, low-stakes legwork (recon, summarising, scanning)
 * where a cheaper model is indistinguishable but several times quicker. The fast
 * tier is optional — with nothing configured it aliases `deep`, so behaviour is
 * unchanged and only the wall-clock win is lost.
 */
export type Tier = 'fast' | 'deep'

export interface TierConfig {
  provider: ResolvedProvider['provider']
  providerName: string
  model: string
  label: string
}

const deep = resolveDeepTier()
const fast = resolveFastTier(deep)

export const config = {
  // Kept as the primary/default provider so every existing call site is unchanged.
  provider: deep.provider,
  providerName: deep.providerName,
  model: deep.model,
  providerLabel: deep.label,
  tiers: { deep, fast } as Record<Tier, TierConfig>,
  /** True when a distinct fast tier is configured, so the cascade is actually saving time. */
  cascadeEnabled: fast.label !== deep.label,
}

export function tierConfig(tier: Tier): TierConfig {
  return config.tiers[tier]
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

const memorySections = buildMemorySections()

const SHARED_CONTEXT = `You operate in the current working directory: ${process.cwd()}
Platform: ${process.platform}.`

export const SYSTEM_PROMPT = `You are elia, an autonomous coding agent running in a CLI, in the user's terminal.
${SHARED_CONTEXT}

You have tools to read, write, and edit files, list and search files, and run shell commands.
When a task requires multiple steps, use tools repeatedly and autonomously without asking the user to confirm each step.
Prefer editing existing files over rewriting them wholesale. Be concise in your final text responses — the user is watching a terminal, not reading a report.

Work the way a strong engineer works, not the way a chatbot answers:
- Read before you write. Never edit a file you have not looked at in this session.
- Batch independent reads and searches into a single turn so they run in parallel.
- Verify your own work by running the project's tests, typecheck, or the file you just changed.
- Say plainly when something failed or you skipped part of the task.

You also have a task tool that delegates an independent, self-contained piece of work to an autonomous sub-agent. Pass a \`role\` to pick the right kind of worker for the job: \`scout\` for read-only investigation (fast and cheap — use several in parallel for recon), \`builder\` for making changes, \`critic\` for adversarial review, \`tester\` for writing and running tests, \`scribe\` for docs. Call task multiple times in the same turn to run a whole fleet in parallel when the work is genuinely independent.
Sub-agents share a blackboard: use \`board_post\` to publish a finding others need and \`board_read\` to check what the fleet already discovered before duplicating work.

When you produce standalone output — a prototype, a generated page, scratch work that isn't an edit to the user's existing project — put it under \`${workspaceDir}\` (the workspace) by default, rather than scattering it through the user's cwd. Use the \`preview\` tool to show the user something visually: it opens a real Chrome window and keeps it live-updated as you keep editing the file.${memorySections}`

export const SUBAGENT_SYSTEM_PROMPT = `You are a sub-agent spawned by elia to complete one self-contained task autonomously.
${SHARED_CONTEXT}

Work through the task using your tools without asking for clarification — you cannot receive follow-up input, so make reasonable assumptions and proceed. Check \`board_read\` before starting expensive investigation in case another sub-agent already found the answer, and \`board_post\` anything the rest of the fleet needs. When finished, reply with a concise final report describing what you did and any results the parent agent needs.${memorySections}`

function resolveDeepTier(): TierConfig {
  const resolved = tryResolveProvider()
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
